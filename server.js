const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const { getDB, initDB } = require('./database');
const { runAutoImporter } = require('./auto_importer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000; // Render uses 10000 by default

// Rate limiting simples para login (in-memory, max 10 tentativas / 15 min por IP)
const loginAttempts = new Map();
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const WINDOW = 15 * 60 * 1000;
  const MAX = 10;
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

/**
 * 📡 API Endpoints
 */

app.get('/api/verify-account', async (req, res) => {
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
    
    // Default credentials if none set
    const savedUser = userRow ? JSON.parse(userRow.value) : (process.env.LOGIN_USER || 'admin');
    const savedPass = passRow ? JSON.parse(passRow.value) : (process.env.LOGIN_PASS || 'admin123');
    
    if (username === savedUser && password === savedPass) {
      const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
      res.json({ success: true, token });
    } else {
      res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/data', async (req, res) => {
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

    res.json({ accounts, scheduledPosts, history, globalConfig });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-account', async (req, res) => {
  const { accountId, username, accessToken, profilePictureUrl } = req.body;
  console.log(`[SAVE-ACCOUNT] Tentando salvar conta: ${username} (${accountId})`);
  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  
  try {
    const params = [accountId, username, accessToken, profilePictureUrl, new Date().toISOString()];
    if (isPostgres) {
      await db.run('INSERT INTO accounts ("accountId", "username", "accessToken", "profilePictureUrl", "createdAt") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("accountId") DO UPDATE SET "username"=EXCLUDED."username", "accessToken"=EXCLUDED."accessToken", "profilePictureUrl"=EXCLUDED."profilePictureUrl"', params);
    } else {
      await db.run('INSERT OR REPLACE INTO accounts ("accountId", "username", "accessToken", "profilePictureUrl", "createdAt") VALUES (?, ?, ?, ?, ?)', params);
    }
    console.log(`[SAVE-ACCOUNT SUCCESS] Conta @${username} salva.`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[SAVE-ACCOUNT ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
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

app.post('/api/save-config', async (req, res) => {
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

app.post('/api/save-post', async (req, res) => {
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

app.delete('/api/posts/:id', async (req, res) => {
  const { id } = req.params;
  const db = await getDB();
  try {
    await db.run('DELETE FROM posts WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/bulk-delete', async (req, res) => {
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

app.post('/api/posts/transfer-all', async (req, res) => {
  const { fromAccountId, toAccountId } = req.body;
  const db = await getDB();
  try {
    await db.run('UPDATE posts SET "accountId" = ? WHERE "accountId" = ? AND "status" = \'pending\'', [toAccountId, fromAccountId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/posts/clear-pending/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const db = await getDB();
  try {
    await db.run('DELETE FROM posts WHERE "accountId" = ? AND "status" = \'pending\'', [accountId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/publish-now', async (req, res) => {
  const { post } = req.body;
  const db = await getDB();
  try {
    await db.run('UPDATE posts SET "status" = \'processing\' WHERE "id" = ?', [post.id]);
    const mediaId = await publishToInstagram(post);
    await db.run('UPDATE posts SET "status" = \'success\', "mediaId" = ?, "publishedAt" = ? WHERE "id" = ?', [mediaId, new Date().toISOString(), post.id]);
    
    // ✅ Notifica Telegram sobre publicação manual
    await sendTelegramNotification(post, 'success');
    
    res.json({ success: true, mediaId });
  } catch (err) {
    await db.run('UPDATE posts SET "status" = \'error\', "publishedAt" = ? WHERE "id" = ?', [new Date().toISOString(), post.id]).catch(() => {});
    
    // ❌ Notifica Telegram sobre erro na publicação manual
    await sendTelegramNotification(post, 'error', err.message);
    
    res.status(500).json({ error: err.message });
  }
});

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
      text = `✅ *Post Publicado!*\n\n📱 Conta: ${accName}\n📝 Legenda: ${post.caption || '(sem legenda)'}\n🕐 Horário: ${time}\n\n_InstaScheduler AI_`;
    } else {
      text = `❌ *Erro ao Publicar*\n\n📱 Conta: ${accName}\n📝 Legenda: ${post.caption || '(sem legenda)'}\n🕐 Horário: ${time}\n⚠️ Erro: ${errorMsg}\n\n_InstaScheduler AI_`;
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
          await sendTelegramNotification(post, 'success');
        } catch (e) {
          console.error(`❌ Falha: ${post.id}`, e.message);
          await db.run('UPDATE posts SET "status" = \'error\', "publishedAt" = ? WHERE "id" = ?', [new Date().toISOString(), post.id]);
          await sendTelegramNotification(post, 'error', e.message);
        }
      }
    }
  } catch (err) {
    console.error('Cron Error:', err.message);
  }
}

// Check every minute
setInterval(cron, 60000);

/**
 * 📁 Manual Import Trigger
 */
app.get('/api/import-local', async (req, res) => {
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

// Initialization with error tracking for Render/Cloud
initDB()
  .then(async () => {
    app.listen(PORT, '0.0.0.0', async () => {
      console.log(`🚀 [ENGINE] InstaScheduler AI online on port ${PORT}`);
      console.log(`🌐 [ENV] Database: ${process.env.DATABASE_URL ? 'PostgreSQL (Cloud)' : 'SQLite (Local)'}`);
      
      // Auto-import on startup and every 5 minutes
      let isImporting = false;
      const autoImport = async () => {
        if (isImporting) return;
        isImporting = true;
        try {
          await runAutoImporter();
        } catch (e) {
          console.error('Auto-import periodic failure:', e.message);
        } finally {
          isImporting = false;
        }
      };

      autoImport(); // Run once at start
      setInterval(autoImport, 300000); // Run every 5 mins
    });
  })
  .catch(err => {
    console.error('####################################################');
    console.error('❌ CRITICAL: SYSTEM FAILED TO START');
    console.error('Reason:', err.message);
    if (err.stack) console.error('Stack:', err.stack);
    console.error('####################################################');
    process.exit(1);
  });
