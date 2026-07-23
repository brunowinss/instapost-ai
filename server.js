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

function createToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
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

  if (!token || !verifyToken(token)) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
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
    if (!tokenData.access_token) {
      const errMsg = parseIgError(tokenData);
      console.error('[OAUTH] Falha ao obter token:', errMsg);
      throw new Error('Falha ao obter token: ' + errMsg);
    }

    const shortToken = tokenData.access_token;
    const igUserId = tokenData.user_id;
    console.log(`[OAUTH] Token obtido para user_id=${igUserId}`);

    // 2. Trocar por long-lived token (60 dias)
    const llRes = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_id=${IG_APP_ID}&client_secret=${IG_APP_SECRET}&access_token=${shortToken}`);
    const llData = await llRes.json();
    if (llData.error) {
      console.warn('[OAUTH] Aviso: falha ao obter long-lived token, usando short-lived.', parseIgError(llData));
    }
    const finalToken = llData.access_token || shortToken;

    // 3. Buscar username via /me com versão (Instagram Business Login API)
    // Busca id,username SEM profile_picture_url para evitar erros em contas que não suportam esse campo
    let profile = null;
    const profileAttempts = [
      `https://graph.instagram.com/${IG_API_VERSION}/me?fields=id,username&access_token=${finalToken}`,
      `https://graph.instagram.com/${IG_API_VERSION}/${igUserId}?fields=id,username&access_token=${finalToken}`,
      `https://graph.facebook.com/${IG_API_VERSION}/me?fields=instagram_business_account{id,username}&access_token=${finalToken}`,
    ];
    for (const url of profileAttempts) {
      const r = await fetch(url);
      const data = await r.json();
      console.log(`[OAUTH] Profile attempt ${url}: ${JSON.stringify(data).substring(0, 120)}`);
      if (data.username) { profile = data; break; }
      if (data.instagram_business_account?.username) {
        profile = { id: data.instagram_business_account.id, username: data.instagram_business_account.username };
        break;
      }
    }
    if (!profile || !profile.username) {
      throw new Error('Não foi possível obter perfil do Instagram. Verifique permissões do app.');
    }
    const finalUserId = profile.id || String(igUserId);

    // 3b. Buscar foto de perfil separadamente (não bloqueia se falhar)
    let profilePictureUrl = '';
    try {
      const picRes = await fetch(`https://graph.instagram.com/${IG_API_VERSION}/me?fields=profile_picture_url&access_token=${finalToken}`);
      const picData = await picRes.json();
      profilePictureUrl = picData.profile_picture_url || '';
    } catch (e) {
      console.warn('[OAUTH] Não foi possível obter foto de perfil:', e.message);
    }

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
    res.redirect('/?connected=' + encodeURIComponent(profile.username));
  } catch (err) {
    console.error('[OAUTH ERROR]', err.message);
    res.redirect('/?error=' + encodeURIComponent(err.message));
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
    const baseUrl = token.startsWith('IGAA') ? 'https://graph.instagram.com/v21.0' : 'https://graph.facebook.com/v21.0';
    const r = await fetch(`${baseUrl}/${id}?fields=username,profile_picture_url&access_token=${token}`);
    const data = await r.json();

    if (data.error) {
      console.error('[META ERROR]', data.error);
      return res.status(400).json({ 
        error: `Erro da Meta: ${data.error.message}`,
        details: data.error
      });
    }

    console.log(`[VERIFY SUCCESS] Conta @${data.username} validada.`);
    res.json({ username: data.username, profilePictureUrl: data.profile_picture_url });
  } catch (err) {
    console.error('[SERVER ERROR]', err);
    res.status(500).json({ error: `Erro interno no servidor: ${err.message}` });
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
    const allowedKeys = ['imgbbKey', 'cloudinaryName', 'cloudinaryPreset', 'telegramToken', 'telegramChatId', 'loginUser', 'loginPass'];
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
      throw new Error(`[IG ${data.error.code || '?'}] ${data.error.message}`);
    }
    return data;
  };

  // 1. Create Media Container
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

  // 2. Aguardar processamento do container (REELS e IMAGE)
  //    Para REELS: Instagram pode levar 3-5+ minutos para processar o vídeo.
  //    Para IMAGE: Instagram também precisa baixar a imagem antes de publicar.
  //    Sem este check, media_publish retorna [IG 9007] "Media ID is not available".
  const initialDelay = post.mediaType === 'REELS' ? 10000 : 3000; // 10s Reels / 3s imagem
  const MAX_ATTEMPTS = post.mediaType === 'REELS' ? 30 : 10;       // 5min Reels / 30s imagem
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
      finished = true; // edge case: já publicado
    } else {
      // IN_PROGRESS ou desconhecido — aguarda
      attempts++;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
  }

  if (!finished) {
    const timeoutSecs = (initialDelay + MAX_ATTEMPTS * POLL_INTERVAL) / 1000;
    throw new Error(`Timeout após ${timeoutSecs}s aguardando o Instagram processar a mídia. Container: ${containerId}`);
  }

  // 3. Publish
  console.log(`[PUBLISH] Publicando container ${containerId}...`);
  let result;
  try {
    result = await graphReq(`/${post.accountId}/media_publish`, 'POST', { creation_id: containerId });
  } catch (err) {
    // Erro 9007 = token sem permissão de publicação ou conta não é Business/Creator
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
