const { getDB } = require('./database');

async function test() {
  try {
    const db = await getDB();
    const accountId = 'test_id_' + Date.now();
    const username = 'test_user';
    const accessToken = 'test_token';
    const profilePictureUrl = undefined; // This is what happens in index.html
    const createdAt = new Date().toISOString();

    const params = [accountId, username, accessToken, profilePictureUrl, createdAt];
    console.log('Parameters:', params);

    await db.run('INSERT OR REPLACE INTO accounts ("accountId", "username", "accessToken", "profilePictureUrl", "createdAt") VALUES (?, ?, ?, ?, ?)', params);
    console.log('Success!');
    
    const row = await db.get('SELECT * FROM accounts WHERE accountId = ?', [accountId]);
    console.log('Saved row:', row);
  } catch (err) {
    console.error('Error:', err);
  }
}

test();
