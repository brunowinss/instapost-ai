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

app.get('/api/import-local', async (req, res) => {
  try {
    await runAutoImporter();
    res.json({ success: true, message: 'Processamento de pasta local concluído.' });
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
  const { imgbbKey, cloudinaryName, cloudinaryPreset } = req.body;
  const db = await getDB();
  const isPostgres = !!process.env.DATABASE_URL;
  
  try {
    const configs = [
      { key: 'imgbbKey', value: JSON.stringify(imgbbKey) },
      { key: 'cloudinaryName', value: JSON.stringify(cloudinaryName) },
      { key: 'cloudinaryPreset', value: JSON.stringify(cloudinaryPreset) }
    ];

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
        } catch (e) {
          console.error(`❌ Fail: ${post.id}`, e.message);
          await db.run('UPDATE posts SET "status" = \'error\', "publishedAt" = ? WHERE "id" = ?', [new Date().toISOString(), post.id]);
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
    
    // Auto-import on startup
    try {
      await runAutoImporter();
    } catch (e) {
      console.error('Initial auto-import failed:', e.message);
    }
  });
});
