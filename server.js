const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const { getDB, initDB } = require('./database');
const { runAutoImporter } = require('./auto_importer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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
    const r = await fetch(`${baseUrl}/${id}?fields=username&access_token=${token}`);
    const data = await r.json();

    if (data.error) {
      console.error('[META ERROR]', data.error);
      return res.status(400).json({ 
        error: `Erro da Meta: ${data.error.message}`,
        details: data.error
      });
    }

    console.log(`[VERIFY SUCCESS] Conta @${data.username} validada.`);
    res.json({ username: data.username });
  } catch (err) {
    console.error('[SERVER ERROR]', err);
    res.status(500).json({ error: `Erro interno no servidor: ${err.message}` });
  }
});

// Login
app.post('/api/login', async (req, res) => {
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
    const scheduledPosts = await db.all('SELECT * FROM posts WHERE "status" = \'pending\' ORDER BY "scheduledAt" ASC');
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
  const { accountId, username, accessToken } = req.body;
  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  
  try {
    const params = [accountId, username, accessToken, new Date().toISOString()];
    if (isPostgres) {
      await db.run('INSERT INTO accounts ("accountId", "username", "accessToken", "createdAt") VALUES (?, ?, ?, ?) ON CONFLICT ("accountId") DO UPDATE SET "username"=EXCLUDED."username", "accessToken"=EXCLUDED."accessToken"', params);
    } else {
      await db.run('INSERT OR REPLACE INTO accounts ("accountId", "username", "accessToken", "createdAt") VALUES (?, ?, ?, ?)', params);
    }
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
    await db.run('DELETE FROM posts WHERE "id" = ?', [id]);
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
  try {
    const mediaId = await publishToInstagram(post);
    const db = await getDB();
    await db.run('UPDATE posts SET "status" = \'success\', "mediaId" = ?, "publishedAt" = ? WHERE "id" = ?', [mediaId, new Date().toISOString(), post.id]);
    res.json({ success: true, mediaId });
  } catch (err) {
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

  const graphReq = async (path, method = 'GET', body = null) => {
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
    if (data.error) throw new Error(data.error.message);
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

  const container = await graphReq(`/${post.accountId}/media`, 'POST', payload);
  const containerId = container.id;

  // 2. Wait for Reels processing
  if (post.mediaType === 'REELS') {
    let finished = false;
    let attempts = 0;
    while (!finished && attempts < 20) {
      const status = await graphReq(`/${containerId}?fields=status_code`);
      if (status.status_code === 'FINISHED') finished = true;
      else if (status.status_code === 'ERROR') throw new Error('Instagram failed to process video.');
      else {
        attempts++;
        await new Promise(r => setTimeout(r, 6000));
      }
    }
    if (!finished) throw new Error('Instagram processing timeout.');
  }

  // 3. Publish
  const result = await graphReq(`/${post.accountId}/media_publish`, 'POST', { creation_id: containerId });
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
        try {
          const mediaId = await publishToInstagram(post);
          await db.run('UPDATE posts SET "status" = \'success\', "mediaId" = ?, "publishedAt" = ? WHERE "id" = ?', [mediaId, new Date().toISOString(), post.id]);
          console.log(`✅ Posted: ${post.id}`);
          await sendTelegramNotification(post, 'success');
        } catch (e) {
          console.error(`❌ Fail: ${post.id}`, e.message);
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

// Initialization
initDB().then(async () => {
  app.listen(PORT, async () => {
    console.log(`🚀 InstaScheduler Engine online on port ${PORT}`);
    
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
});
