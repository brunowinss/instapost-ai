const { getDB } = require('../database');

async function dumpPosts() {
  try {
    const db = await getDB();
    const posts = await db.all('SELECT id, imageUrl, status FROM posts');
    console.log(JSON.stringify(posts, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

dumpPosts();
