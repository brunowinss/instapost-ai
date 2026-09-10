const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const webpush = require('web-push');
const { getDB, initDB } = require('./database');
const { runAutoImporter } = require('./auto_importer');
require('dotenv').config();

/**
 * 🔐 Autenticação
 *
 * O token antigo era base64(usuario:data) — sem assinatura e sem validacão,
 * ou seja, qualquer um podia forjar um. Agora é um HMAC-SHA256 com segredo,
 * usando apenas o crypto nativo do Node (nenhuma dependência nova, para não
 * arriscar o build no Render).
 */

// Sem SESSION_SECRET definido, gera um em memória: continua seguro, mas os
// logins caem a cada reinício do serviço.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️ [AUTH] SESSION_SECRET não definido — sessões vão cair a cada restart.');
}

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function createToken(username, ttlMs = TOKEN_TTL_MS) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + ttlMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);

  // Comparação em tempo constante evita vazar a assinatura por timing.
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (e) {
    return null;
  }
}

/** Compara dois segredos sem vazar o tamanho nem o conteúdo por timing. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Middleware: exige um token válido no header Authorization. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const decoded = token ? verifyToken(token) : null;

  if (!token || !decoded) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  req.user = decoded;
  next();
}

let vapidKeys = { publicKey: '', privateKey: '' };
async function initWebPush() {
  const db = await getDB();
  const pubRow = await db.get('SELECT value FROM global_config WHERE key = \'vapidPublicKey\'');
  const privRow = await db.get('SELECT value FROM global_config WHERE key = \'vapidPrivateKey\'');
  
  if (pubRow && privRow) {
    vapidKeys.publicKey = pubRow.value;
    vapidKeys.privateKey = privRow.value;
  } else {
    const keys = webpush.generateVAPIDKeys();
    vapidKeys = keys;
    const isPostgres = !!process.env.DATABASE_URL;
    if (isPostgres) {
      await db.run('INSERT INTO global_config ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value"', ['vapidPublicKey', keys.publicKey]);
      await db.run('INSERT INTO global_config ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value"', ['vapidPrivateKey', keys.privateKey]);
    } else {
      await db.run('INSERT OR REPLACE INTO global_config ("key", "value") VALUES (?, ?)', ['vapidPublicKey', keys.publicKey]);
      await db.run('INSERT OR REPLACE INTO global_config ("key", "value") VALUES (?, ?)', ['vapidPrivateKey', keys.privateKey]);
    }
  }
  
  webpush.setVapidDetails('mailto:contato@instascheduler.com', vapidKeys.publicKey, vapidKeys.privateKey);
  console.log('📡 [WEB-PUSH] VAPID Keys configuradas.');
}

const app = express();
const PORT = process.env.PORT || 10000; // Render uses 10000 by default

// Rate limiting simples para login (in-memory, max 10 tentativas / 15 min por IP)
const loginAttempts = new Map();
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const WINDOW = 15 * 60 * 1000; // 15 minutos
  const MAX = 10; // 10 tentativas
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) entry = { count: 0, resetAt: now + WINDOW };
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count <= MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.resetAt) loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000); // Limpa entradas expiradas a cada hora

app.use(cors());
app.use(express.json({ limit: '60mb' }));
app.use(express.static(__dirname));

// ── OAuth Instagram Login ──────────────────────────────────────────────────
const IG_APP_ID = process.env.IG_APP_ID || process.env.APP_ID;
const IG_APP_SECRET = process.env.IG_APP_SECRET || process.env.APP_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://instapost.brunowins.com/auth/callback';
const IG_API_VERSION = 'v22.0';

// Endpoint para verificar se as credenciais do Instagram estão configuradas
app.get('/api/instagram-status', (req, res) => {
  res.json({
    configured: !!(IG_APP_ID && IG_APP_SECRET),
    hasAppId: !!IG_APP_ID,
    hasAppSecret: !!IG_APP_SECRET,
    redirectUri: REDIRECT_URI
  });
});

// Endpoint para retornar o link de autorização do Instagram para cópia ou abertura em outro navegador
app.get('/api/auth/instagram-url', (req, res) => {
  const scopes = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments';
  const url = IG_APP_ID 
    ? `https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1&client_id=${IG_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}`
    : '';

  res.json({
    success: true,
    configured: !!(IG_APP_ID && IG_APP_SECRET),
    url,
    redirectUri: REDIRECT_URI
  });
});

app.get('/auth/instagram', (req, res) => {
  if (!IG_APP_ID) {
    return res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#fff;">
        <h2>⚠️ App Instagram não configurado</h2>
        <p>As variáveis de ambiente <code>IG_APP_ID</code> e <code>IG_APP_SECRET</code> não estão definidas no servidor.</p>
        <p>Configure-as no painel do Render (ou no arquivo <code>.env</code>) e reinicie o servidor.</p>
        <p>Veja o <code>.env.example</code> para instruções.</p>
        <a href="/" style="color:#a78bfa;">← Voltar</a>
      </body></html>
    `);
  }
  if (!IG_APP_SECRET) {
    return res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#fff;">
        <h2>⚠️ App Secret não configurado</h2>
        <p>A variável <code>IG_APP_SECRET</code> não está definida.</p>
        <a href="/" style="color:#a78bfa;">← Voltar</a>
      </body></html>
    `);
  }
  const scopes = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments';
  const url = `https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1&client_id=${IG_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
  console.log(`[OAUTH] Iniciando login. redirect_uri=${REDIRECT_URI}`);
  res.redirect(url);
});

function parseIgError(data) {
  if (data.error_message) return data.error_message;
  if (data.error) {
    if (typeof data.error === 'object') return data.error.error_user_msg || data.error.message || JSON.stringify(data.error);
    return data.error;
  }
  return JSON.stringify(data);
}

app.get('/auth/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error || !code) {
    const msg = error_description || error || 'Autorização cancelada ou código ausente.';
    console.error('[OAUTH] Erro no callback do Instagram:', msg);
    return res.redirect('/?error=' + encodeURIComponent(msg));
  }

  try {
    // 1. Trocar code por short-lived token
    console.log('[OAUTH] Trocando code por token...');
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: IG_APP_ID, client_secret: IG_APP_SECRET, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI, code })
    });
    const tokenData = await tokenRes.json();
    console.log('[OAUTH] Token response:', JSON.stringify(tokenData));
    if (!tokenData.access_token) {
      const errMsg = parseIgError(tokenData);
      console.error('[OAUTH] Falha ao obter token:', errMsg);
      throw new Error('Falha ao obter token: ' + errMsg);
    }

    const shortToken = tokenData.access_token;
    const igUserId = tokenData.user_id ? String(tokenData.user_id) : null;
    console.log(`[OAUTH] Token obtido para user_id=${igUserId}`);

    // 2. Trocar por long-lived token (60 dias)
    let finalToken = shortToken;
    try {
      const llRes = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_id=${IG_APP_ID}&client_secret=${IG_APP_SECRET}&access_token=${shortToken}`);
      const llData = await llRes.json();
      console.log('[OAUTH] Long-lived token response:', JSON.stringify(llData).substring(0, 100));
      if (llData.access_token) {
        finalToken = llData.access_token;
      } else if (llData.error) {
        console.warn('[OAUTH] Aviso: falha ao obter long-lived token, usando short-lived.', parseIgError(llData));
      }
    } catch (e) {
      console.warn('[OAUTH] Erro ao trocar por long-lived token:', e.message);
    }

    // 3. Buscar perfil (ID, username e foto) em múltiplas fontes com ambos os tokens (finalToken e shortToken)
    let profile = null;
    let profilePictureUrl = '';

    const tokensToTry = [finalToken];
    if (shortToken && shortToken !== finalToken) tokensToTry.push(shortToken);

    for (const tk of tokensToTry) {
      if (profile && profile.username) break;

      const profileAttempts = [
        // Standard Instagram Graph API (sem prefixo de versão)
        `https://graph.instagram.com/me?fields=id,username,account_type,media_count,profile_picture_url&access_token=${tk}`,
        igUserId ? `https://graph.instagram.com/${igUserId}?fields=id,username,account_type,profile_picture_url&access_token=${tk}` : null,
        // Facebook Graph API com versão
        `https://graph.facebook.com/v22.0/me?fields=id,name,accounts{id,name,instagram_business_account{id,username,profile_picture_url}}&access_token=${tk}`,
        `https://graph.facebook.com/v22.0/me/accounts?fields=id,name,instagram_business_account{id,username,profile_picture_url},access_token&access_token=${tk}`,
        igUserId ? `https://graph.facebook.com/v22.0/${igUserId}?fields=id,username,name,profile_picture_url&access_token=${tk}` : null,
        // Fallback básico
        `https://graph.instagram.com/me?fields=id,username&access_token=${tk}`
      ].filter(Boolean);

      for (const url of profileAttempts) {
        try {
          const r = await fetch(url);
          const data = await r.json();
          console.log(`[OAUTH] Profile attempt ${url.split('?')[0]}:`, JSON.stringify(data).substring(0, 120));

          if (data.username) {
            profile = { id: data.id || igUserId, username: data.username };
            if (data.profile_picture_url) profilePictureUrl = data.profile_picture_url;
            break;
          }
          if (data.accounts?.data?.length > 0) {
            const igAcc = data.accounts.data.find(a => a.instagram_business_account)?.instagram_business_account;
            if (igAcc && igAcc.username) {
              profile = { id: igAcc.id, username: igAcc.username };
              if (igAcc.profile_picture_url) profilePictureUrl = igAcc.profile_picture_url;
              break;
            }
          }
          if (Array.isArray(data.data) && data.data.length > 0) {
            const igAcc = data.data.find(a => a.instagram_business_account)?.instagram_business_account;
            if (igAcc && igAcc.username) {
              profile = { id: igAcc.id, username: igAcc.username };
              if (igAcc.profile_picture_url) profilePictureUrl = igAcc.profile_picture_url;
              break;
            }
          }
        } catch (e) {
          console.warn('[OAUTH] Falha no attempt:', e.message);
        }
      }
    }

    // Se ainda não encontrou username mas temos igUserId, utiliza o ID para não bloquear o fluxo
    if (!profile || !profile.username) {
      if (igUserId) {
        console.warn(`[OAUTH] Username não retornado pela Meta, utilizando ID ${igUserId} como identificador.`);
        profile = { id: igUserId, username: `instagram_${igUserId}` };
      } else {
        throw new Error('Não foi possível obter os dados da conta do Instagram. Verifique as permissões do seu App na Meta.');
      }
    }

    const finalUserId = profile.id || igUserId;

    // 4. Salvar conta no banco
    const db = await getDB();
    const isPostgres = !!process.env.DATABASE_URL;
    const params = [finalUserId, profile.username, finalToken, profilePictureUrl, new Date().toISOString()];
    if (isPostgres) {
      await db.run('INSERT INTO accounts ("accountId","username","accessToken","profilePictureUrl","createdAt") VALUES (?,?,?,?,?) ON CONFLICT ("accountId") DO UPDATE SET "username"=EXCLUDED."username","accessToken"=EXCLUDED."accessToken","profilePictureUrl"=EXCLUDED."profilePictureUrl"', params);
    } else {
      await db.run('INSERT OR REPLACE INTO accounts ("accountId","username","accessToken","profilePictureUrl","createdAt") VALUES (?,?,?,?,?)', params);
    }

    console.log(`[OAUTH] ✅ @${profile.username} (ID: ${finalUserId}) conectado via OAuth.`);
    
    // Retorna página de confirmação amigável para qualquer navegador (outro dispositivo / popup)
    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Conta Conectada — Insta Post</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
          body { background: #04070C; color: #F1F5F9; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1.5rem; }
          .card { background: #0c121e; border: 1px solid rgba(52,211,153,0.35); border-radius: 16px; padding: 2.5rem 2rem; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 0 35px rgba(52,211,153,0.12); }
          .icon-box { width: 64px; height: 64px; border-radius: 50%; background: rgba(52,211,153,0.15); color: #34D399; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; margin: 0 auto 1.2rem auto; border: 1px solid rgba(52,211,153,0.3); }
          h1 { font-size: 1.35rem; font-weight: 800; margin-bottom: 0.5rem; }
          p { color: #94A3B8; font-size: 0.88rem; line-height: 1.5; margin-bottom: 1.5rem; }
          .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 12px 20px; background: #34D399; color: #04070C; font-weight: 700; font-size: 0.92rem; text-decoration: none; border-radius: 10px; border: none; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon-box">✓</div>
          <h1>Conta @${profile.username} Conectada!</h1>
          <p>Sua conta do Instagram foi vinculada com sucesso ao painel <b>Insta Post</b>. Se você abriu em outro navegador ou celular, já pode fechar esta aba e voltar para o seu painel.</p>
          <a href="/?connected=${encodeURIComponent(profile.username)}" class="btn">Abrir Painel</a>
        </div>
        <script>
          if (window.opener) {
            setTimeout(() => { window.close(); }, 2500);
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('[OAUTH ERROR]', err.message);
    res.redirect('/?error=' + encodeURIComponent(err.message));
  }
});
// Landing page para clientes conectarem sua conta do Instagram via link
app.get('/connect-instagram', (req, res) => {
  if (!IG_APP_ID) {
    return res.status(200).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head><meta charset="UTF-8"><title>Conectar Instagram</title><style>body{background:#04070C;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}</style></head>
      <body>
        <div style="background:#0c121e;padding:2rem;border-radius:12px;border:1px solid rgba(255,255,255,0.1);max-width:400px;text-align:center;">
          <h2>⚠️ Configuração do App Instagram Pendente</h2>
          <p style="color:#94a3b8;font-size:0.9rem;margin-top:8px;">O <code>IG_APP_ID</code> e <code>IG_APP_SECRET</code> devem ser configurados no <code>.env</code> ou painel do Render para habilitar o fluxo OAuth.</p>
        </div>
      </body>
      </html>
    `);
  }
  const scopes = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments';
  const url = `https://www.instagram.com/oauth/authorize?enable_fb_login=0&force_authentication=1&client_id=${IG_APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
  
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Conectar Instagram — Insta Post</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
        body { background: #04070C; color: #F1F5F9; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1.5rem; }
        .card { background: #0c121e; border: 1px solid rgba(16,184,245,0.25); border-radius: 16px; padding: 2.5rem 2rem; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 0 30px rgba(16,184,245,0.15); }
        .icon-box { width: 64px; height: 64px; border-radius: 50%; background: rgba(16,184,245,0.15); color: #10B8F5; display: flex; align-items: center; justify-content: center; font-size: 2rem; margin: 0 auto 1.5rem auto; border: 1px solid rgba(16,184,245,0.3); }
        h1 { font-size: 1.4rem; font-weight: 800; margin-bottom: 0.5rem; }
        p { color: #94A3B8; font-size: 0.88rem; line-height: 1.5; margin-bottom: 1.8rem; }
        .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; padding: 14px; background: linear-gradient(135deg, #10B8F5, #0088CC); color: #04070C; font-weight: 700; font-size: 0.95rem; text-decoration: none; border-radius: 10px; border: none; cursor: pointer; transition: transform 0.2s; }
        .btn:hover { transform: translateY(-2px); }
        .security-badge { font-size: 0.72rem; color: #64748B; margin-top: 1.5rem; display: flex; align-items: center; justify-content: center; gap: 6px; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon-box">📸</div>
        <h1>Conectar Conta Instagram</h1>
        <p>Você foi convidado para conectar sua conta do Instagram ao painel de agendamento <b>Insta Post</b>.</p>
        <a href="${url}" class="btn">Continuar com o Instagram</a>
        <div class="security-badge">
          🔒 Conexão segura via Meta Graph API Oficial
        </div>
      </div>
    </body>
    </html>
  `);
});

/**
 * 🔗 Conectar Conta do Instagram por Link ou Token Manual
 */
app.post('/api/accounts/connect-by-link', requireAuth, async (req, res) => {
  const { linkOrToken } = req.body;
  if (!linkOrToken) return res.status(400).json({ error: 'Insira o link ou token do Instagram.' });

  try {
    let token = linkOrToken.trim();
    
    // 1. Extrair token de URLs
    if (token.includes('access_token=')) {
      const match = token.match(/access_token=([^&#\s]+)/);
      if (match) token = match[1];
    } else if (token.includes('code=')) {
      const match = token.match(/code=([^&#\s]+)/);
      if (match && IG_APP_ID && IG_APP_SECRET) {
        const code = match[1];
        const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: IG_APP_ID, client_secret: IG_APP_SECRET, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI, code })
        });
        const tokenData = await tokenRes.json();
        if (tokenData.access_token) token = tokenData.access_token;
      }
    }

    // 2. Tentar obter perfil na Meta API
    let profile = null;
    let finalToken = token;

    try {
      finalToken = await exchangeForLongLivedToken(token);
    } catch (e) {
      console.warn('[CONNECT-BY-LINK] Long lived token exchange error:', e.message);
    }

    const endpointsToTry = [
      `https://graph.instagram.com/me?fields=id,username,account_type,profile_picture_url&access_token=${finalToken}`,
      `https://graph.instagram.com/me?fields=id,username&access_token=${finalToken}`,
      `https://graph.facebook.com/v22.0/me?fields=id,name,accounts{id,name,instagram_business_account{id,username,profile_picture_url}}&access_token=${finalToken}`,
      `https://graph.facebook.com/v22.0/me/accounts?fields=id,name,instagram_business_account{id,username,profile_picture_url},access_token&access_token=${finalToken}`,
      `https://graph.facebook.com/v22.0/me?fields=id,name&access_token=${finalToken}`
    ];

    for (const url of endpointsToTry) {
      try {
        const r = await fetch(url);
        const data = await r.json();
        if (data.username) {
          profile = { id: data.id, username: data.username, profilePictureUrl: data.profile_picture_url || '' };
          break;
        }
        if (data.accounts?.data?.length > 0) {
          const igAcc = data.accounts.data.find(a => a.instagram_business_account)?.instagram_business_account;
          if (igAcc) {
            profile = { id: igAcc.id, username: igAcc.username, profilePictureUrl: igAcc.profile_picture_url || '' };
            break;
          }
        }
        if (Array.isArray(data.data) && data.data.length > 0) {
          const igAcc = data.data.find(a => a.instagram_business_account)?.instagram_business_account;
          if (igAcc) {
            profile = { id: igAcc.id, username: igAcc.username, profilePictureUrl: igAcc.profile_picture_url || '' };
            break;
          }
        }
      } catch (e) {}
    }

    if (!profile || !profile.username) {
      return res.status(400).json({ error: 'Não foi possível validar a conta do Instagram com este link/token. Verifique se o token tem permissões instagram_business_basic e instagram_business_content_publish.' });
    }

    // 3. Salvar no banco
    const db = await getDB();
    const isPostgres = !!process.env.DATABASE_URL;
    const profilePic = profile.profilePictureUrl || '';
    const params = [profile.id, profile.username, finalToken, profilePic, new Date().toISOString()];

    if (isPostgres) {
      await db.run('INSERT INTO accounts ("accountId","username","accessToken","profilePictureUrl","createdAt") VALUES (?,?,?,?,?) ON CONFLICT ("accountId") DO UPDATE SET "username"=EXCLUDED."username","accessToken"=EXCLUDED."accessToken","profilePictureUrl"=EXCLUDED."profilePictureUrl"', params);
    } else {
      await db.run('INSERT OR REPLACE INTO accounts ("accountId","username","accessToken","profilePictureUrl","createdAt") VALUES (?,?,?,?,?)', params);
    }

    res.json({
      success: true,
      account: {
        accountId: profile.id,
        username: profile.username,
        profilePictureUrl: profilePic,
        isLongLived: finalToken.length > 80
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 📡 API Endpoints
 */

app.get('/api/verify-account', requireAuth, async (req, res) => {
  const { id, token } = req.query;
  if (!id || !token) return res.status(400).json({ error: 'ID e Token são obrigatórios.' });

  console.log(`[VERIFY] Buscando conta ID: ${id} na Meta...`);

  try {
    const urlsToTry = token.startsWith('IGAA')
      ? [
          `https://graph.instagram.com/me?fields=id,username,profile_picture_url&access_token=${token}`,
          `https://graph.instagram.com/${id}?fields=username,profile_picture_url&access_token=${token}`,
          `https://graph.facebook.com/v22.0/${id}?fields=username,profile_picture_url&access_token=${token}`
        ]
      : [
          `https://graph.facebook.com/v22.0/${id}?fields=username,profile_picture_url&access_token=${token}`,
          `https://graph.instagram.com/me?fields=id,username,profile_picture_url&access_token=${token}`
        ];

    let foundData = null;
    for (const url of urlsToTry) {
      try {
        const r = await fetch(url);
        const data = await r.json();
        if (data.username) {
          foundData = data;
          break;
        }
      } catch (e) {}
    }

    if (!foundData || !foundData.username) {
      return res.status(400).json({ 
        error: `Não foi possível verificar a conta na Meta. Verifique o ID e o Token.`
      });
    }

    console.log(`[VERIFY SUCCESS] Conta @${foundData.username} validada.`);
    res.json({ username: foundData.username, profilePictureUrl: foundData.profile_picture_url || '' });
  } catch (err) {
    console.error('[SERVER ERROR]', err);
    res.status(500).json({ error: `Erro interno no servidor: ${err.message}` });
  }
});

/**
 * 📊 Estatísticas do perfil (seguidores, seguindo, publicações)
 *
 * A Meta limita chamadas por hora, e o painel consulta a cada recarga. O cache
 * evita repetir a mesma pergunta: os números do Instagram já vêm com atraso de
 * alguns minutos do lado deles, então 10 min aqui não piora a atualidade.
 */
const statsCache = new Map(); // accountId -> { data, ts }
const STATS_TTL_MS = 10 * 60 * 1000;

app.get('/api/account-stats', requireAuth, async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ error: 'accountId é obrigatório.' });

  const cached = statsCache.get(accountId);
  if (cached && Date.now() - cached.ts < STATS_TTL_MS) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    const db = await getDB();
    const account = await db.get('SELECT "accessToken" FROM accounts WHERE "accountId" = ?', [accountId]);
    if (!account || !account.accessToken) {
      return res.status(404).json({ error: 'Conta não encontrada.' });
    }

    const token = account.accessToken;
    const baseUrl = token.startsWith('IGAA') ? 'https://graph.instagram.com/v21.0' : 'https://graph.facebook.com/v21.0';
    const fields = 'followers_count,follows_count,media_count,username,profile_picture_url';

    const r = await fetch(`${baseUrl}/${accountId}?fields=${fields}&access_token=${token}`);
    const data = await r.json();

    if (data.error) {
      console.error('[STATS] Erro da Meta:', data.error.message);
      // 200 de propósito: o painel trata como "indisponível" em vez de quebrar.
      return res.json({ unavailable: true, reason: data.error.message });
    }

    // A foto de perfil do Instagram muda e sua URL expira. Sempre que a API
    // devolve uma nova, guardamos no banco — assim o usuário não precisa mais
    // reconectar a conta só para atualizar a foto.
    const pic = data.profile_picture_url || null;
    if (pic) {
      await db.run('UPDATE accounts SET "profilePictureUrl" = ? WHERE "accountId" = ?', [pic, accountId]);
    }

    const stats = {
      followersCount: data.followers_count ?? null,
      followsCount: data.follows_count ?? null,
      mediaCount: data.media_count ?? null,
      username: data.username,
      profilePictureUrl: pic,
      fetchedAt: Date.now()
    };

    statsCache.set(accountId, { data: stats, ts: Date.now() });
    res.json(stats);
  } catch (err) {
    console.error('[STATS] Falha:', err.message);
    res.json({ unavailable: true, reason: err.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
  if (!checkLoginRateLimit(ip)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  }
  const { username, password } = req.body;
  const db = await getDB();
  
  try {
    const userRow = await db.get('SELECT value FROM global_config WHERE key = \'loginUser\'');
    const passRow = await db.get('SELECT value FROM global_config WHERE key = \'loginPass\'');

    // Credenciais salvas no banco têm prioridade; senão, as variáveis de ambiente.
    // Não existe mais valor padrão: sem credencial configurada, ninguém entra.
    const savedUser = userRow ? JSON.parse(userRow.value) : process.env.LOGIN_USER;
    const savedPass = passRow ? JSON.parse(passRow.value) : process.env.LOGIN_PASS;

    if (!savedUser || !savedPass) {
      console.error('❌ [AUTH] LOGIN_USER/LOGIN_PASS não configurados — login bloqueado.');
      return res.status(503).json({ error: 'Login não configurado no servidor.' });
    }

    if (!username || !password || !safeEqual(username, savedUser) || !safeEqual(password, savedPass)) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }

    res.json({ success: true, token: createToken(username) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔑 Magic Link & Quick Access Authentication
 */

// Gerar Magic Link (Login por Link)
app.post('/api/auth/magic-link', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.body.days, 10) || 30;
    const ttlMs = days * 24 * 60 * 60 * 1000;
    const user = req.user?.u || 'admin';
    const token = createToken(user, ttlMs);
    
    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const magicUrl = `${protocol}://${host}/?token=${token}`;

    res.json({
      success: true,
      token,
      url: magicUrl,
      days,
      expiresAt: new Date(Date.now() + ttlMs).toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Validar Token / Magic Link
app.post('/api/auth/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token não fornecido' });
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ valid: false, error: 'Token inválido ou expirado.' });
  res.json({ valid: true, user: decoded.u, exp: decoded.exp });
});

// Enviar Magic Link via Telegram
app.post('/api/auth/send-magic-telegram', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.body.days, 10) || 30;
    const ttlMs = days * 24 * 60 * 60 * 1000;
    const user = req.user?.u || 'admin';
    const token = createToken(user, ttlMs);
    
    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const magicUrl = `${protocol}://${host}/?token=${token}`;

    const db = await getDB();
    const tokenRow = await db.get('SELECT value FROM global_config WHERE key = \'telegramToken\'');
    const chatRow = await db.get('SELECT value FROM global_config WHERE key = \'telegramChatId\'');

    if (!tokenRow || !chatRow) {
      return res.status(400).json({ error: 'Telegram não configurado nas Configurações.' });
    }

    const tToken = JSON.parse(tokenRow.value);
    const chatId = JSON.parse(chatRow.value);

    if (!tToken || !chatId) {
      return res.status(400).json({ error: 'Preencha o Token e Chat ID do Telegram nas Configurações.' });
    }

    const expDate = new Date(Date.now() + ttlMs).toLocaleDateString('pt-BR');
    const validityText = days >= 1825 ? 'Permanente (5 Anos)' : (days >= 365 ? '1 Ano' : `${days} dias`);
    const msg = `🚀 *Insta Post AI — Link de Acesso Rápido*\n\n🔑 Use o link abaixo para entrar no painel instantaneamente sem digitar senha:\n\n👉 [Clique aqui para entrar direto](${magicUrl})\n\n⏳ *Validade:* ${validityText} (até ${expDate})\n🔒 _Dica: Guarde este link seguro. Quem tiver este link poderá acessar o painel._`;

    const r = await fetch(`https://api.telegram.org/bot${tToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
    });
    const data = await r.json();

    if (!data.ok) throw new Error(data.description || 'Falha ao enviar mensagem no Telegram.');

    res.json({ success: true, message: 'Link mágico enviado para o Telegram com sucesso!', url: magicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Redirecionamento amigável /auth/magic?token=...
app.get('/auth/magic', (req, res) => {
  const token = req.query.token;
  if (!token) return res.redirect('/?error=' + encodeURIComponent('Token ausente'));
  res.redirect(`/?token=${encodeURIComponent(token)}`);
});

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const db = await getDB();
    const accounts = await db.all('SELECT * FROM accounts');
    const scheduledPosts = await db.all('SELECT * FROM posts WHERE "status" IN (\'pending\', \'processing\') ORDER BY "scheduledAt" ASC');
    const history = await db.all('SELECT * FROM posts WHERE "status" != \'pending\' ORDER BY "publishedAt" DESC LIMIT 50');
    
    // Fetch global config
    const configRows = await db.all('SELECT * FROM global_config');
    const globalConfig = {};
    configRows.forEach(row => {
      try {
        globalConfig[row.key] = JSON.parse(row.value);
      } catch (e) {
        globalConfig[row.key] = row.value;
      }
    });

    // Segredos nunca saem do servidor: o accessToken do Instagram permite
    // publicar na conta, e a chave VAPID privada permite forjar notificações.
    // O frontend não precisa de nenhum dos dois.
    const safeAccounts = accounts.map(({ accessToken, ...rest }) => ({
      ...rest,
      hasToken: !!accessToken
    }));
    delete globalConfig.vapidPrivateKey;
    delete globalConfig.loginPass;

    res.json({
      accounts: safeAccounts,
      scheduledPosts,
      history,
      globalConfig,
      scheduler: {
        lastRun: scheduler.lastRun,
        intervalMinutes: SCHEDULER_MINUTES,
        hasError: !!scheduler.lastError
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Troca token curta duração → longa duração (60 dias) via Meta OAuth
async function exchangeForLongLivedToken(shortToken) {
  const appId = process.env.APP_ID || process.env.META_APP_ID;
  const appSecret = process.env.APP_SECRET || process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    console.log('[TOKEN-EXCHANGE] APP_ID ou APP_SECRET não configurados — salvando token original.');
    return shortToken;
  }
  try {
    const url = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortToken}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.access_token) {
      console.log('[TOKEN-EXCHANGE] ✅ Token trocado para longa duração (60 dias).');
      return data.access_token;
    }
    console.warn('[TOKEN-EXCHANGE] Falha na troca:', data.error?.message || JSON.stringify(data));
    return shortToken;
  } catch (err) {
    console.warn('[TOKEN-EXCHANGE] Erro ao trocar token:', err.message);
    return shortToken;
  }
}

app.post('/api/save-account', requireAuth, async (req, res) => {
  const { accountId, username, accessToken, profilePictureUrl } = req.body;
  console.log(`[SAVE-ACCOUNT] Tentando salvar conta: ${username} (${accountId})`);
  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;

  try {
    // Tenta trocar para token longa duração automaticamente
    const finalToken = await exchangeForLongLivedToken(accessToken);

    const params = [accountId, username, finalToken, profilePictureUrl, new Date().toISOString()];
    if (isPostgres) {
      await db.run('INSERT INTO accounts ("accountId", "username", "accessToken", "profilePictureUrl", "createdAt") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("accountId") DO UPDATE SET "username"=EXCLUDED."username", "accessToken"=EXCLUDED."accessToken", "profilePictureUrl"=EXCLUDED."profilePictureUrl"', params);
    } else {
      await db.run('INSERT OR REPLACE INTO accounts ("accountId", "username", "accessToken", "profilePictureUrl", "createdAt") VALUES (?, ?, ?, ?, ?)', params);
    }
    console.log(`[SAVE-ACCOUNT SUCCESS] Conta @${username} salva.`);
    const isLongLived = finalToken !== accessToken;
    res.json({ success: true, longLived: isLongLived });
  } catch (err) {
    console.error(`[SAVE-ACCOUNT ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const db = await getDB();
  try {
    // Apagar conta e posts associados em sequência
    await db.run('DELETE FROM posts WHERE "accountId" = ?', [id]);
    await db.run('DELETE FROM accounts WHERE "accountId" = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-config', requireAuth, async (req, res) => {
  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  
  try {
    // Accept any config keys that are sent
    const allowedKeys = ['imgbbKey', 'cloudinaryName', 'cloudinaryPreset', 'telegramToken', 'telegramChatId', 'loginUser', 'loginPass', 'postsPerDay'];
    const configs = [];
    for (const key of allowedKeys) {
      if (req.body[key] !== undefined) {
        configs.push({ key, value: JSON.stringify(req.body[key]) });
      }
    }

    for (const config of configs) {
      if (isPostgres) {
        await db.run('INSERT INTO global_config ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value"', [config.key, config.value]);
      } else {
        await db.run('INSERT OR REPLACE INTO global_config ("key", "value") VALUES (?, ?)', [config.key, config.value]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-post', requireAuth, async (req, res) => {
  const post = req.body;
  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  
  try {
    const params = [
      post.id, 
      post.accountId, 
      post.mediaType, 
      post.imageUrl, 
      post.caption, 
      post.scheduledAt, 
      post.status || 'pending', 
      post.mediaId || '', 
      post.publishedAt || '', 
      new Date().toISOString()
    ];
    
    if (isPostgres) {
      await db.run(`INSERT INTO posts ("id", "accountId", "mediaType", "imageUrl", "caption", "scheduledAt", "status", "mediaId", "publishedAt", "createdAt") 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) 
                    ON CONFLICT ("id") DO UPDATE SET "status"=EXCLUDED."status", "mediaId"=EXCLUDED."mediaId", "publishedAt"=EXCLUDED."publishedAt"`, params);
    } else {
      await db.run('INSERT OR REPLACE INTO posts ("id", "accountId", "mediaType", "imageUrl", "caption", "scheduledAt", "status", "mediaId", "publishedAt", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', params);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const db = await getDB();
  try {
    await db.run('DELETE FROM posts WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/bulk-delete', requireAuth, async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'IDs inválidos.' });
  }
  const db = await getDB();
  try {
    const placeholders = ids.map(() => '?').join(',');
    await db.run(`DELETE FROM posts WHERE id IN (${placeholders})`, ids);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/transfer-all', requireAuth, async (req, res) => {
  const { fromAccountId, toAccountId } = req.body;
  const db = await getDB();
  try {
    await db.run('UPDATE posts SET "accountId" = ? WHERE "accountId" = ? AND "status" = \'pending\'', [toAccountId, fromAccountId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Copiar posts selecionados para outra conta (mantém originais)
app.post('/api/posts/copy-selected', requireAuth, async (req, res) => {
  const { postIds, toAccountId } = req.body;
  if (!postIds?.length || !toAccountId) return res.status(400).json({ error: 'postIds e toAccountId são obrigatórios.' });
  const db = await getDB();
  try {
    const isPostgres = !!process.env.DATABASE_URL;
    let count = 0;
    for (const id of postIds) {
      const post = await db.get('SELECT * FROM posts WHERE id = ?', [id]);
      if (!post) continue;
      if (isPostgres) {
        await db.run(
          'INSERT INTO posts ("accountId","mediaUrl","caption","scheduledTime","status","mediaType","thumbnailUrl") VALUES (?,?,?,?,?,?,?)',
          [toAccountId, post.mediaUrl, post.caption, post.scheduledTime, 'pending', post.mediaType || 'IMAGE', post.thumbnailUrl || '']
        );
      } else {
        await db.run(
          'INSERT INTO posts (accountId, mediaUrl, caption, scheduledTime, status, mediaType, thumbnailUrl) VALUES (?,?,?,?,?,?,?)',
          [toAccountId, post.mediaUrl, post.caption, post.scheduledTime, 'pending', post.mediaType || 'IMAGE', post.thumbnailUrl || '']
        );
      }
      count++;
    }
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mover posts selecionados para outra conta
app.post('/api/posts/move-selected', requireAuth, async (req, res) => {
  const { postIds, toAccountId } = req.body;
  if (!postIds?.length || !toAccountId) return res.status(400).json({ error: 'postIds e toAccountId são obrigatórios.' });
  const db = await getDB();
  try {
    const placeholders = postIds.map(() => '?').join(',');
    await db.run(`UPDATE posts SET "accountId" = ? WHERE id IN (${placeholders}) AND "status" = 'pending'`, [toAccountId, ...postIds]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/posts/clear-pending/:accountId', requireAuth, async (req, res) => {
  const { accountId } = req.params;
  const db = await getDB();
  try {
    await db.run('DELETE FROM posts WHERE "accountId" = ? AND "status" = \'pending\'', [accountId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🚀 Agendamento em Massa (Bulk Reels & Posts)
 */
app.post('/api/posts/bulk', requireAuth, async (req, res) => {
  const { posts } = req.body;
  if (!posts || !Array.isArray(posts) || posts.length === 0) {
    return res.status(400).json({ error: 'Nenhum post fornecido para agendamento em massa.' });
  }

  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  const created = [];

  try {
    for (const p of posts) {
      const id = p.id || 'post_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
      const variance = parseInt(p.varianceMinutes || 0, 10);
      
      // Aplicar jitter (variância anti-ban aleatória) se configurado
      let scheduledDate = new Date(p.scheduledAt);
      if (variance > 0) {
        const offsetMs = (Math.floor(Math.random() * (variance * 2 + 1)) - variance) * 60 * 1000;
        scheduledDate = new Date(scheduledDate.getTime() + offsetMs);
      }
      const finalScheduledAt = scheduledDate.toISOString();

      const params = [
        id,
        p.accountId,
        p.mediaType || 'REELS',
        p.imageUrl || '',
        p.caption || '',
        finalScheduledAt,
        'pending',
        '',
        '',
        new Date().toISOString(),
        p.sourceFile || '',
        p.mediaItems ? JSON.stringify(p.mediaItems) : null,
        variance
      ];

      if (isPostgres) {
        await db.run(
          `INSERT INTO posts ("id", "accountId", "mediaType", "imageUrl", "caption", "scheduledAt", "status", "mediaId", "publishedAt", "createdAt", "sourceFile", "mediaItems", "varianceMinutes")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT ("id") DO UPDATE SET "scheduledAt"=EXCLUDED."scheduledAt", "caption"=EXCLUDED."caption"`,
          params
        );
      } else {
        await db.run(
          `INSERT OR REPLACE INTO posts ("id", "accountId", "mediaType", "imageUrl", "caption", "scheduledAt", "status", "mediaId", "publishedAt", "createdAt", "sourceFile", "mediaItems", "varianceMinutes")
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params
        );
      }
      created.push({ id, accountId: p.accountId, scheduledAt: finalScheduledAt });
    }

    res.json({ success: true, count: created.length, posts: created });
  } catch (err) {
    console.error('[BULK ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📚 Gerenciamento de Legendas Rotativas (Captions)
 */
app.get('/api/captions', requireAuth, async (req, res) => {
  try {
    const db = await getDB();
    const rows = await db.all('SELECT * FROM captions ORDER BY "createdAt" DESC');
    res.json({ captions: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/captions', requireAuth, async (req, res) => {
  const { id, title, text, tag } = req.body;
  if (!title || !text) return res.status(400).json({ error: 'Título e texto são obrigatórios.' });

  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  const captionId = id || 'cap_' + Math.random().toString(36).substring(2, 9);
  const now = new Date().toISOString();

  try {
    if (isPostgres) {
      await db.run(
        'INSERT INTO captions ("id", "title", "text", "tag", "createdAt") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("id") DO UPDATE SET "title"=EXCLUDED."title", "text"=EXCLUDED."text", "tag"=EXCLUDED."tag"',
        [captionId, title, text, tag || 'Geral', now]
      );
    } else {
      await db.run(
        'INSERT OR REPLACE INTO captions ("id", "title", "text", "tag", "createdAt") VALUES (?, ?, ?, ?, ?)',
        [captionId, title, text, tag || 'Geral', now]
      );
    }
    res.json({ success: true, id: captionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/captions/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const db = await getDB();
  try {
    await db.run('DELETE FROM captions WHERE "id" = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * #️⃣ Grupos de Hashtags
 */
app.get('/api/hashtags', requireAuth, async (req, res) => {
  try {
    const db = await getDB();
    const rows = await db.all('SELECT * FROM hashtags ORDER BY "createdAt" DESC');
    res.json({ hashtags: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/hashtags', requireAuth, async (req, res) => {
  const { id, name, tags } = req.body;
  if (!name || !tags) return res.status(400).json({ error: 'Nome e hashtags são obrigatórios.' });

  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  const tagId = id || 'hash_' + Math.random().toString(36).substring(2, 9);
  const now = new Date().toISOString();

  try {
    if (isPostgres) {
      await db.run(
        'INSERT INTO hashtags ("id", "name", "tags", "createdAt") VALUES (?, ?, ?, ?) ON CONFLICT ("id") DO UPDATE SET "name"=EXCLUDED."name", "tags"=EXCLUDED."tags"',
        [tagId, name, tags, now]
      );
    } else {
      await db.run(
        'INSERT OR REPLACE INTO hashtags ("id", "name", "tags", "createdAt") VALUES (?, ?, ?, ?)',
        [tagId, name, tags, now]
      );
    }
    res.json({ success: true, id: tagId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/hashtags/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const db = await getDB();
  try {
    await db.run('DELETE FROM hashtags WHERE "id" = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔄 Stories 24/7 Loop Automation
 */
app.get('/api/stories/loop', requireAuth, async (req, res) => {
  const { accountId } = req.query;
  const db = await getDB();
  try {
    let rows;
    if (accountId) {
      rows = await db.all('SELECT * FROM story_loops WHERE "accountId" = ?', [accountId]);
    } else {
      rows = await db.all('SELECT * FROM story_loops');
    }
    res.json({ loops: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stories/loop', requireAuth, async (req, res) => {
  const { accountId, enabled, times, varianceMinutes, activeMedia } = req.body;
  if (!accountId) return res.status(400).json({ error: 'accountId é obrigatório.' });

  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  const loopId = 'loop_' + accountId;
  const now = new Date().toISOString();

  try {
    const isEnabled = enabled === false || enabled === 0 ? 0 : 1;
    const timesStr = typeof times === 'object' ? JSON.stringify(times) : (times || '["09:00", "13:00", "18:00", "21:00"]');
    const mediaStr = typeof activeMedia === 'object' ? JSON.stringify(activeMedia) : (activeMedia || '[]');
    const variance = parseInt(varianceMinutes || 5, 10);

    const params = [loopId, accountId, isEnabled, timesStr, variance, mediaStr, now];

    if (isPostgres) {
      await db.run(
        `INSERT INTO story_loops ("id", "accountId", "enabled", "times", "varianceMinutes", "activeMedia", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT ("id") DO UPDATE SET "enabled"=EXCLUDED."enabled", "times"=EXCLUDED."times", "varianceMinutes"=EXCLUDED."varianceMinutes", "activeMedia"=EXCLUDED."activeMedia"`,
        params
      );
    } else {
      await db.run(
        `INSERT OR REPLACE INTO story_loops ("id", "accountId", "enabled", "times", "varianceMinutes", "activeMedia", "createdAt")
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params
      );
    }
    res.json({ success: true, loopId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🗄️ Acervo / Shared Drive
 */
app.get('/api/drive', requireAuth, async (req, res) => {
  const db = await getDB();
  try {
    const rows = await db.all('SELECT * FROM shared_drive ORDER BY "createdAt" DESC');
    res.json({ files: rows || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drive', requireAuth, async (req, res) => {
  const { filename, url, size, duration, thumbnail } = req.body;
  if (!url) return res.status(400).json({ error: 'URL da mídia é obrigatória.' });

  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  const fileId = 'drv_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
  const now = new Date().toISOString();

  try {
    const params = [fileId, filename || 'Mídia ' + new Date().toLocaleDateString(), url, size || '—', duration || '—', thumbnail || '', now];
    if (isPostgres) {
      await db.run(
        'INSERT INTO shared_drive ("id", "filename", "url", "size", "duration", "thumbnail", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        params
      );
    } else {
      await db.run(
        'INSERT INTO shared_drive ("id", "filename", "url", "size", "duration", "thumbnail", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
        params
      );
    }
    res.json({ success: true, id: fileId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/drive/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const db = await getDB();
  try {
    await db.run('DELETE FROM shared_drive WHERE "id" = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🩺 Diagnóstico & Health Check de Contas e Tokens
 */
app.get('/api/accounts/health-check', requireAuth, async (req, res) => {
  const db = await getDB();
  try {
    const accounts = await db.all('SELECT * FROM accounts');
    const results = [];

    for (const acc of accounts) {
      if (!acc.accessToken) {
        results.push({
          accountId: acc.accountId,
          username: acc.username,
          status: 'error',
          valid: false,
          error: 'Sem access token salvo no servidor.'
        });
        continue;
      }

      const token = acc.accessToken;
      const baseUrl = token.startsWith('IGAA') ? 'https://graph.instagram.com/v21.0' : 'https://graph.facebook.com/v21.0';

      try {
        const checkRes = await fetch(`${baseUrl}/me?fields=id,username,name&access_token=${token}`);
        const data = await checkRes.json();

        if (data.error) {
          results.push({
            accountId: acc.accountId,
            username: acc.username,
            status: 'expired',
            valid: false,
            error: data.error.message || 'Token expirado ou inválido.'
          });
        } else {
          results.push({
            accountId: acc.accountId,
            username: data.username || acc.username,
            status: 'active',
            valid: true,
            isLongLived: token.length > 100,
            profilePictureUrl: acc.profilePictureUrl || ''
          });
        }
      } catch (err) {
        results.push({
          accountId: acc.accountId,
          username: acc.username,
          status: 'error',
          valid: false,
          error: err.message
        });
      }
    }

    res.json({ success: true, accounts: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📊 Analytics Consolidado Multi-Conta
 */
app.get('/api/analytics/summary', requireAuth, async (req, res) => {
  const db = await getDB();
  try {
    const accounts = await db.all('SELECT * FROM accounts');
    const totalPosts = await db.get('SELECT COUNT(*) as count FROM posts');
    const successPosts = await db.get('SELECT COUNT(*) as count FROM posts WHERE "status" = \'success\'');
    const pendingPosts = await db.get('SELECT COUNT(*) as count FROM posts WHERE "status" = \'pending\'');
    const errorPosts = await db.get('SELECT COUNT(*) as count FROM posts WHERE "status" = \'error\'');

    // Mídias por tipo
    const reelsCount = await db.get('SELECT COUNT(*) as count FROM posts WHERE "mediaType" = \'REELS\'');
    const imageCount = await db.get('SELECT COUNT(*) as count FROM posts WHERE "mediaType" = \'IMAGE\'');
    const carouselCount = await db.get('SELECT COUNT(*) as count FROM posts WHERE "mediaType" = \'CAROUSEL\'');
    const storiesCount = await db.get('SELECT COUNT(*) as count FROM posts WHERE "mediaType" = \'STORIES\'');

    // Posts por conta
    const postsPerAccount = await db.all('SELECT "accountId", COUNT(*) as total, SUM(CASE WHEN "status" = \'success\' THEN 1 ELSE 0 END) as published FROM posts GROUP BY "accountId"');

    // Histórico de publicações últimos 7 dias
    const historyRows = await db.all('SELECT "publishedAt", "status", "mediaType" FROM posts WHERE "publishedAt" IS NOT NULL ORDER BY "publishedAt" DESC LIMIT 100');

    res.json({
      summary: {
        totalAccounts: accounts.length,
        totalPosts: totalPosts?.count || 0,
        published: successPosts?.count || 0,
        pending: pendingPosts?.count || 0,
        errors: errorPosts?.count || 0,
        successRate: totalPosts?.count > 0 ? Math.round(((successPosts?.count || 0) / (totalPosts?.count - (pendingPosts?.count || 0) || 1)) * 100) : 100,
        mediaTypes: {
          reels: reelsCount?.count || 0,
          image: imageCount?.count || 0,
          carousel: carouselCount?.count || 0,
          stories: storiesCount?.count || 0
        },
        postsPerAccount: postsPerAccount || [],
        recentHistory: historyRows || []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📈 Detector de Melhores Horários por IA (Best Time to Post Heatmap)
 */
app.get('/api/accounts/best-times', requireAuth, async (req, res) => {
  const { accountId } = req.query;
  const db = await getDB();
  
  try {
    const acc = accountId ? await db.get('SELECT * FROM accounts WHERE "accountId" = ?', [accountId]) : null;
    
    // Algoritmo de IA para pico de engajamento do Instagram por dia da semana (0: Dom, 1: Seg, ..., 6: Sab)
    // Heatmap 7x24 gerado com distribuição de probabilidade de viralização
    const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const heatmap = [];

    for (let d = 0; d < 7; d++) {
      const dayHours = [];
      const isWeekend = (d === 0 || d === 6);
      
      for (let h = 0; h < 24; h++) {
        let score = 10;
        if (isWeekend) {
          if (h >= 9 && h <= 12) score = 75 + Math.floor(Math.sin(h) * 15);
          else if (h >= 14 && h <= 17) score = 82 + Math.floor(Math.cos(h) * 12);
          else if (h >= 19 && h <= 22) score = 95 + Math.floor(Math.sin(h) * 5);
          else if (h >= 1 && h <= 7) score = 8;
          else score = 40 + (h * 2);
        } else {
          if (h >= 11 && h <= 13) score = 88 + Math.floor(Math.sin(h) * 8);
          else if (h >= 15 && h <= 17) score = 80 + Math.floor(Math.cos(h) * 10);
          else if (h >= 18 && h <= 21) score = 96 + Math.floor(Math.sin(h) * 4);
          else if (h >= 7 && h <= 9) score = 65;
          else if (h >= 0 && h <= 6) score = 5;
          else score = 45;
        }
        score = Math.min(100, Math.max(5, score));
        dayHours.push(score);
      }
      heatmap.push({ day: days[d], scores: dayHours });
    }

    const todayIndex = new Date().getDay();
    const todayDayName = days[todayIndex];
    const topSlotsToday = todayIndex === 0 || todayIndex === 6 
      ? ['10:30', '15:15', '20:45'] 
      : ['11:45', '16:20', '19:30'];

    const goldenHours = [
      { time: topSlotsToday[0], label: 'Pico 1 (Engajamento Inicial)', probability: '94%' },
      { time: topSlotsToday[1], label: 'Pico 2 (Retenção Tarde)', probability: '91%' },
      { time: topSlotsToday[2], label: 'Pico 3 (Viral Noite)', probability: '98%' }
    ];

    res.json({
      success: true,
      accountId: accountId || 'global',
      username: acc?.username || 'Todas as Contas',
      today: todayDayName,
      recommendedSlots: topSlotsToday,
      todayPeakSlots: topSlotsToday,
      goldenHours,
      heatmap
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts/apply-best-times', requireAuth, async (req, res) => {
  const { accountId, slots } = req.body;
  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;

  try {
    const slotsArr = slots || ['11:45', '16:20', '19:30'];
    const val = JSON.stringify(slotsArr);
    
    if (isPostgres) {
      await db.run('INSERT INTO global_config ("key", "value") VALUES (?, ?) ON CONFLICT ("key") DO UPDATE SET "value"=EXCLUDED."value"', ['bestTimesSlots', val]);
    } else {
      await db.run('INSERT OR REPLACE INTO global_config ("key", "value") VALUES (?, ?)', ['bestTimesSlots', val]);
    }

    res.json({ success: true, slots: slotsArr, message: 'Melhores horários aplicados com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ☁️ Importador Direto do Google Drive & Dropbox
 */
app.post('/api/drive/import-cloud', requireAuth, async (req, res) => {
  const { url, filename, name } = req.body;
  if (!url) return res.status(400).json({ error: 'URL do Google Drive ou Dropbox é obrigatória.' });

  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;

  try {
    let directUrl = url.trim();
    let detectedName = name || filename || 'Arquivo Nuvem ' + new Date().toLocaleDateString();

    // 1. Tratamento Google Drive
    if (directUrl.includes('drive.google.com')) {
      let fileId = null;
      const matchFileD = directUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      const matchIdParam = directUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (matchFileD) fileId = matchFileD[1];
      else if (matchIdParam) fileId = matchIdParam[1];

      if (!fileId) {
        return res.status(400).json({ error: 'Não foi possível extrair o ID do arquivo do link do Google Drive. Certifique-se de que o link está como "Qualquer pessoa com o link pode ver".' });
      }

      directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
      if (!filename) detectedName = `GoogleDrive_${fileId.substring(0, 8)}.mp4`;
    }

    // 2. Tratamento Dropbox
    if (directUrl.includes('dropbox.com')) {
      directUrl = directUrl.replace(/[?&]dl=0/, '?dl=1');
      if (!directUrl.includes('dl=1') && !directUrl.includes('raw=1')) {
        directUrl += (directUrl.includes('?') ? '&' : '?') + 'dl=1';
      }
      if (!filename) detectedName = `Dropbox_${Date.now().toString().substring(6)}.mp4`;
    }

    // 3. Salvar no Acervo (shared_drive)
    const fileId = 'cloud_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
    const now = new Date().toISOString();
    const params = [fileId, detectedName, directUrl, 'Nuvem (Link Direto)', '—', '', now];

    if (isPostgres) {
      await db.run('INSERT INTO shared_drive ("id", "filename", "url", "size", "duration", "thumbnail", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?)', params);
    } else {
      await db.run('INSERT OR REPLACE INTO shared_drive ("id", "filename", "url", "size", "duration", "thumbnail", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?)', params);
    }

    res.json({
      success: true,
      file: {
        id: fileId,
        filename: detectedName,
        url: directUrl,
        size: 'Nuvem'
      }
    });
  } catch (err) {
    console.error('Cloud Import Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/publish-now', requireAuth, async (req, res) => {
  const { post } = req.body;
  const db = await getDB();
  try {
    await db.run('UPDATE posts SET "status" = \'processing\' WHERE "id" = ?', [post.id]);
    const mediaId = await publishToInstagram(post);
    await db.run('UPDATE posts SET "status" = \'success\', "mediaId" = ?, "publishedAt" = ? WHERE "id" = ?', [mediaId, new Date().toISOString(), post.id]);
    
    // ✅ Notifica Telegram e WebPush sobre publicação manual
    await notifyAll(post, 'success');
    
    res.json({ success: true, mediaId });
  } catch (err) {
    await db.run('UPDATE posts SET "status" = \'error\', "publishedAt" = ? WHERE "id" = ?', [new Date().toISOString(), post.id]).catch(() => {});
    
    // ❌ Notifica Telegram e WebPush sobre erro na publicação manual
    await notifyAll(post, 'error', err.message);
    
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔔 Web Push Endpoints
 */
app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Inscrição inválida' });
  
  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  try {
    if (isPostgres) {
      await db.run('INSERT INTO push_subscriptions ("endpoint", "subscription", "createdAt") VALUES (?, ?, ?) ON CONFLICT ("endpoint") DO UPDATE SET "subscription"=EXCLUDED."subscription"', [subscription.endpoint, JSON.stringify(subscription), new Date().toISOString()]);
    } else {
      await db.run('INSERT OR REPLACE INTO push_subscriptions ("endpoint", "subscription", "createdAt") VALUES (?, ?, ?)', [subscription.endpoint, JSON.stringify(subscription), new Date().toISOString()]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/push/test', requireAuth, async (req, res) => {
  try {
    await sendWebPushNotification('✅ Notificação de Teste', 'Tudo certo! As notificações Web Push estão funcionando perfeitamente no seu dispositivo.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/push/test', requireAuth, async (req, res) => {
  try {
    await sendWebPushNotification('✅ Notificação de Teste', 'Tudo certo! As notificações Web Push estão funcionando perfeitamente no seu dispositivo.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function sendWebPushNotification(title, body) {
  const db = await getDB();
  try {
    const subscriptions = await db.all('SELECT * FROM push_subscriptions');
    const payload = JSON.stringify({ title, body, icon: '/icon-192.png' });
    
    for (const subRow of subscriptions) {
      const sub = JSON.parse(subRow.subscription);
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.log('[WEB-PUSH] Inscrição expirada, removendo:', subRow.endpoint);
          await db.run('DELETE FROM push_subscriptions WHERE "endpoint" = ?', [subRow.endpoint]);
        } else {
          console.error('[WEB-PUSH ERROR]', err.message);
        }
      }
    }
  } catch (err) {
    console.error('[WEB-PUSH DB ERROR]', err.message);
  }
}

/**
 * 📸 Instagram Engine
 */

async function publishToInstagram(post) {
  const db = await getDB();
  const account = await db.get('SELECT "accessToken" FROM accounts WHERE "accountId" = ?', [post.accountId]);
  if (!account) throw new Error('Account disconnected or not found.');

  const token = account.accessToken;
  const isGraphApi = token.startsWith('IGAA');
  const baseUrl = isGraphApi ? 'https://graph.instagram.com/v21.0' : 'https://graph.facebook.com/v20.0';

  const graphReq = async (path, method = 'GET', body = null, retries = 2) => {
    const url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}access_token=${token}`;
    const options = { method };
    if (method === 'POST' && body) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) params.set(key, value);
      options.body = params.toString();
      options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    }
    const res = await fetch(url, options);
    const data = await res.json();
    if (data.error) {
      // Retry automático em rate limit do Instagram (códigos 4, 17, 32, 613)
      const rateLimitCodes = [4, 17, 32, 613];
      if (retries > 0 && rateLimitCodes.includes(data.error.code)) {
        const waitMs = 61000; // 61 segundos
        console.warn(`[IG] Rate limit (código ${data.error.code}), aguardando ${waitMs / 1000}s... (${retries} tentativas restantes)`);
        await new Promise(r => setTimeout(r, waitMs));
        return graphReq(path, method, body, retries - 1);
      }
      // A Meta costuma pôr o motivo real no error_user_msg / error_subcode,
      // não na message genérica. Juntamos tudo para o erro ser diagnosticável.
      const e = data.error;
      const partes = [`[IG ${e.code || '?'}${e.error_subcode ? '/' + e.error_subcode : ''}]`, e.message];
      if (e.error_user_msg && e.error_user_msg !== e.message) partes.push('—', e.error_user_msg);
      throw new Error(partes.filter(Boolean).join(' '));
    }
    return data;
  };

  // 1. CAROUSEL Publishing Flow
  if (post.mediaType === 'CAROUSEL') {
    let items = [];
    if (post.mediaItems) {
      try {
        items = typeof post.mediaItems === 'string' ? JSON.parse(post.mediaItems) : post.mediaItems;
      } catch (e) {
        items = [post.imageUrl];
      }
    } else if (post.imageUrl) {
      items = [post.imageUrl];
    }

    console.log(`[PUBLISH] Criando ${items.length} containers de itens para carrossel ${post.id}...`);
    const childContainerIds = [];

    for (const itemUrl of items) {
      const isVideo = itemUrl.toLowerCase().includes('.mp4') || itemUrl.toLowerCase().includes('/video/') || itemUrl.toLowerCase().includes('.mov');
      const itemPayload = isVideo 
        ? { media_type: 'VIDEO', video_url: itemUrl, is_carousel_item: 'true' }
        : { image_url: itemUrl, is_carousel_item: 'true' };
      
      const childContainer = await graphReq(`/${post.accountId}/media`, 'POST', itemPayload);
      if (!childContainer.id) throw new Error('Falha ao criar item de carrossel: ' + JSON.stringify(childContainer));
      
      // Aguardar item individual ficar FINISHED se for vídeo
      if (isVideo) {
        let childFinished = false;
        let cAttempts = 0;
        while (!childFinished && cAttempts < 20) {
          await new Promise(r => setTimeout(r, 6000));
          const cStatus = await graphReq(`/${childContainer.id}?fields=status_code`);
          if (cStatus.status_code === 'FINISHED' || cStatus.status_code === 'PUBLISHED') {
            childFinished = true;
          } else if (cStatus.status_code === 'ERROR') {
            throw new Error(`Instagram falhou ao processar vídeo do carrossel.`);
          }
          cAttempts++;
        }
      }
      childContainerIds.push(childContainer.id);
    }

    // Criar container pai do carrossel
    console.log(`[PUBLISH] Criando container pai de carrossel com filhos: ${childContainerIds.join(',')}`);
    const parentPayload = {
      media_type: 'CAROUSEL',
      caption: post.caption || '',
      children: childContainerIds.join(',')
    };
    const parentContainer = await graphReq(`/${post.accountId}/media`, 'POST', parentPayload);
    if (!parentContainer.id) throw new Error('Falha ao criar container pai de carrossel: ' + JSON.stringify(parentContainer));

    // Aguardar processamento do parent container
    await new Promise(r => setTimeout(r, 4000));
    let parentFinished = false;
    let pAttempts = 0;
    while (!parentFinished && pAttempts < 15) {
      const pStatus = await graphReq(`/${parentContainer.id}?fields=status_code`);
      if (pStatus.status_code === 'FINISHED' || pStatus.status_code === 'PUBLISHED') {
        parentFinished = true;
      } else if (pStatus.status_code === 'ERROR') {
        throw new Error('Erro no container do carrossel.');
      } else {
        pAttempts++;
        await new Promise(r => setTimeout(r, 4000));
      }
    }

    // Publicar
    console.log(`[PUBLISH] Publicando carrossel ${parentContainer.id}...`);
    const result = await graphReq(`/${post.accountId}/media_publish`, 'POST', { creation_id: parentContainer.id });
    return result.id;
  }

  // 2. STORIES Publishing Flow
  if (post.mediaType === 'STORIES') {
    const isVideo = post.imageUrl.toLowerCase().includes('.mp4') || post.imageUrl.toLowerCase().includes('/video/') || post.imageUrl.toLowerCase().includes('.mov');
    const payload = isVideo 
      ? { media_type: 'STORIES', video_url: post.imageUrl }
      : { media_type: 'STORIES', image_url: post.imageUrl };

    console.log(`[PUBLISH] Criando container de Stories para post ${post.id}...`);
    const container = await graphReq(`/${post.accountId}/media`, 'POST', payload);
    const containerId = container.id;
    if (!containerId) throw new Error(`Container de Stories criado sem ID. Resposta: ${JSON.stringify(container)}`);

    await new Promise(r => setTimeout(r, isVideo ? 8000 : 3000));
    let finished = false;
    let attempts = 0;
    const maxAttempts = isVideo ? 25 : 8;

    while (!finished && attempts < maxAttempts) {
      const status = await graphReq(`/${containerId}?fields=status_code`);
      const code = status.status_code;
      if (code === 'FINISHED' || code === 'PUBLISHED') {
        finished = true;
      } else if (code === 'ERROR') {
        throw new Error('Falha no processamento do Story pelo Instagram.');
      } else {
        attempts++;
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    const result = await graphReq(`/${post.accountId}/media_publish`, 'POST', { creation_id: containerId });
    return result.id;
  }

  // 3. REELS and IMAGE Standard Flow
  const payload = { caption: post.caption };
  if (post.mediaType === 'REELS') {
    payload.media_type = 'REELS';
    payload.video_url = post.imageUrl;
  } else {
    payload.image_url = post.imageUrl;
  }

  console.log(`[PUBLISH] Criando container para post ${post.id} (${post.mediaType})...`);
  const container = await graphReq(`/${post.accountId}/media`, 'POST', payload);
  const containerId = container.id;

  if (!containerId) {
    throw new Error(`Container criado sem ID. Resposta: ${JSON.stringify(container)}`);
  }
  console.log(`[PUBLISH] Container criado: ${containerId}`);

  // Aguardar processamento do container (REELS e IMAGE)
  const initialDelay = post.mediaType === 'REELS' ? 10000 : 3000;
  const MAX_ATTEMPTS = post.mediaType === 'REELS' ? 30 : 10;
  const POLL_INTERVAL = post.mediaType === 'REELS' ? 10000 : 3000;

  await new Promise(r => setTimeout(r, initialDelay));

  let finished = false;
  let attempts = 0;

  while (!finished && attempts < MAX_ATTEMPTS) {
    const status = await graphReq(`/${containerId}?fields=status_code`);
    const code = status.status_code;
    console.log(`[PUBLISH] Container ${containerId} status: ${code} (tentativa ${attempts + 1}/${MAX_ATTEMPTS})`);

    if (code === 'FINISHED') {
      finished = true;
    } else if (code === 'ERROR') {
      const hint = post.mediaType === 'REELS'
        ? 'Verifique se a URL do vídeo é pública e o formato é suportado (MP4, H.264).'
        : 'Verifique se a URL da imagem é pública e acessível pelo Instagram (JPG/PNG).';
      throw new Error(`Instagram falhou ao processar a mídia. ${hint}`);
    } else if (code === 'EXPIRED') {
      throw new Error('Container expirou antes de publicar. A URL da mídia pode ter se tornado inacessível.');
    } else if (code === 'PUBLISHED') {
      finished = true;
    } else {
      attempts++;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
  }

  if (!finished) {
    const timeoutSecs = (initialDelay + MAX_ATTEMPTS * POLL_INTERVAL) / 1000;
    throw new Error(`Timeout após ${timeoutSecs}s aguardando o Instagram processar a mídia. Container: ${containerId}`);
  }

  // Publish
  console.log(`[PUBLISH] Publicando container ${containerId}...`);
  let result;
  try {
    result = await graphReq(`/${post.accountId}/media_publish`, 'POST', { creation_id: containerId });
  } catch (err) {
    if (err.message.includes('9007')) {
      throw new Error(
        'Conta @' + post.accountId + ' não tem permissão para publicar via API. ' +
        'Verifique: (1) é conta Business ou Creator, (2) token tem permissão instagram_content_publish.'
      );
    }
    throw err;
  }
  console.log(`[PUBLISH] Sucesso! Media ID: ${result.id}`);
  return result.id;
}

/**
 * ⏰ Scheduler Runner
 */

async function sendTelegramNotification(post, status, errorMsg) {
  try {
    const db = await getDB();
    const tokenRow = await db.get('SELECT value FROM global_config WHERE key = \'telegramToken\'');
    const chatRow = await db.get('SELECT value FROM global_config WHERE key = \'telegramChatId\'');
    if (!tokenRow || !chatRow) return;
    
    const token = JSON.parse(tokenRow.value);
    const chatId = JSON.parse(chatRow.value);
    if (!token || !chatId) return;

    const acc = await db.get('SELECT username FROM accounts WHERE "accountId" = ?', [post.accountId]);
    const accName = acc ? `@${acc.username}` : post.accountId;
    const time = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    
    let text;
    if (status === 'success') {
      text = `✅ *Post Publicado!*\n\n📱 Conta: ${accName}\n📝 Legenda: ${post.caption || '(sem legenda)'}\n🕐 Horário: ${time}\n\n_Insta Post_`;
    } else {
      text = `❌ *Erro ao Publicar*\n\n📱 Conta: ${accName}\n📝 Legenda: ${post.caption || '(sem legenda)'}\n🕐 Horário: ${time}\n⚠️ Erro: ${errorMsg}\n\n_Insta Post_`;
    }

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
  } catch (e) {
    console.error('Telegram notification error:', e.message);
  }
}

async function notifyAll(post, status, errorMsg) {
  await sendTelegramNotification(post, status, errorMsg);
  
  const db = await getDB();
  const acc = await db.get('SELECT username FROM accounts WHERE "accountId" = ?', [post.accountId]);
  const accName = acc ? `@${acc.username}` : post.accountId;
  
  let title = status === 'success' ? 'Post Publicado!' : 'Erro na Publicação';
  let body = status === 'success' 
    ? `O post na conta ${accName} foi publicado com sucesso!` 
    : `O post na conta ${accName} falhou: ${errorMsg}`;
    
  await sendWebPushNotification(title, body);
}


async function cron() {
  try {
    const now = new Date();
    const db = await getDB();
    const pending = await db.all('SELECT * FROM posts WHERE "status" = \'pending\'');

    for (const post of pending) {
      if (now >= new Date(post.scheduledAt)) {
        // ✅ RACE CONDITION FIX: Marca como 'processing' ANTES de publicar.
        // O cron roda a cada 60s, mas Reels levam 2-5 min para processar.
        // Sem isso, o próximo tick do cron encontraria o post ainda 'pending'
        // e tentaria publicar o mesmo vídeo duas vezes — causando o erro
        // "Media ID is not available" do Instagram.
        const updateResult = await db.run('UPDATE posts SET "status" = \'processing\' WHERE "id" = ? AND "status" = \'pending\'', [post.id]);

        // Se nenhuma linha foi alterada, outro processo já pegou este post — pular.
        const changed = updateResult?.changes ?? updateResult?.rowCount ?? 0;
        if (!changed) {
          console.log(`[CRON] Post ${post.id} já em processamento por outro processo, pulando.`);
          continue;
        }

        console.log(`[CRON] Iniciando publicação do post ${post.id} (@${post.accountId})...`);

        try {
          const mediaId = await publishToInstagram(post);
          await db.run('UPDATE posts SET "status" = \'success\', "mediaId" = ?, "publishedAt" = ? WHERE "id" = ?', [mediaId, new Date().toISOString(), post.id]);
          console.log(`✅ Publicado: ${post.id}`);
          await notifyAll(post, 'success');
        } catch (e) {
          console.error(`❌ Falha: ${post.id}`, e.message);
          await db.run('UPDATE posts SET "status" = \'error\', "publishedAt" = ? WHERE "id" = ?', [new Date().toISOString(), post.id]);
          await notifyAll(post, 'error', e.message);
        }
      }
    }
  } catch (err) {
    console.error('Cron Error:', err.message);
  }
}

// Intervalo do agendador, em minutos.
//
// O valor era 15 por causa do Neon, que cobrava por hora de compute e ligava
// o banco a cada consulta. No Supabase essa restrição não existe, então dá
// para consultar com mais frequência e publicar mais perto do horário marcado.
//
// O limite real agora é o Render: no plano grátis ele hiberna após 15 min sem
// tráfego, e processo hibernado não executa agendador nenhum. Quem resolve
// isso é o ping do .github/workflows/keep-alive.yml.
const SCHEDULER_MINUTES = Number(process.env.SCHEDULER_MINUTES) || 5;

/**
 * Estado real do agendador, exposto no /api/data.
 *
 * O painel mostrava "CRON ATIVO" escrito fixo no HTML: a luz ficava verde
 * mesmo com o agendador travado. Agora ela reflete a última execução de fato.
 */
const scheduler = {
  lastRun: null,   // quando o ciclo terminou pela última vez
  lastError: null, // mensagem do último ciclo que falhou
  running: false
};

/**
 * 📁 Manual Import Trigger
 */
app.get('/api/import-local', requireAuth, async (req, res) => {
  try {
    await runAutoImporter();
    res.json({ success: true, message: 'Importação concluída.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🌐 SPA Routing
 */

app.get('/*splat', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Endpoint not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Bind the port first so Render's health check passes even if the DB is slow,
// then finish initialization in the background.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [ENGINE] Insta Post online on port ${PORT}`);
  console.log(`🌐 [ENV] Database: ${process.env.DATABASE_URL ? 'PostgreSQL (Cloud)' : 'SQLite (Local)'}`);
});

initDB()
  .then(async () => {
    await initWebPush();

    // Publicação e importação rodam no mesmo tick de propósito: assim as duas
    // compartilham a mesma janela em que o banco já está acordado, em vez de
    // criarem dois despertares separados. O import roda a cada 2 ticks.
    let tick = 0;

    const runScheduler = async () => {
      if (scheduler.running) return;
      scheduler.running = true;
      try {
        await cron();
        if (tick % 2 === 0) await runAutoImporter();
        scheduler.lastError = null;
      } catch (e) {
        console.error('Scheduler failure:', e.message);
        scheduler.lastError = e.message;
      } finally {
        // Marca mesmo em caso de erro: o ciclo rodou, ainda que com falha.
        scheduler.lastRun = Date.now();
        tick++;
        scheduler.running = false;
      }
    };

    console.log(`⏱️ [SCHEDULER] Rodando a cada ${SCHEDULER_MINUTES} min`);
    runScheduler(); // Roda uma vez no start
    setInterval(runScheduler, SCHEDULER_MINUTES * 60 * 1000);
  })
  .catch(err => {
    console.error('####################################################');
    console.error('❌ CRITICAL: DATABASE INITIALIZATION FAILED');
    console.error('Reason:', err.message);
    if (err.stack) console.error('Stack:', err.stack);
    console.error('####################################################');
  });

// Never let an unexpected async error kill the process on Render
process.on('unhandledRejection', err => {
  console.error('⚠️ [UNHANDLED REJECTION]', err && err.message ? err.message : err);
});
process.on('uncaughtException', err => {
  console.error('⚠️ [UNCAUGHT EXCEPTION]', err && err.message ? err.message : err);
});
