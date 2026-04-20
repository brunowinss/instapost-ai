const path = require('path');
require('dotenv').config();

let db;
const isPostgres = !!process.env.DATABASE_URL;

/**
 * Initializes the database connection (PostgreSQL in production/Render, SQLite locally).
 */
async function initDB() {
  if (isPostgres) {
    console.log(`📡 Attempting to connect to PostgreSQL... (SSL Enabled)`);
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    // Check connection immediately
    try {
      await pool.query('SELECT NOW()');
      console.log('🌐 Connected to PostgreSQL Database (Cloud).');
    } catch (err) {
      console.error('❌ PostgreSQL Connection Failed:', err.message);
      throw err;
    }

    // Polyfill to maintain SQLite-like syntax for simpler backend logic
    db = {};
    db.exec = async (sql) => await pool.query(sql);
    db.run = async (sql, params = []) => {
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      return await pool.query(pgSql, params);
    };
    db.all = async (sql, params = []) => {
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      const res = await pool.query(pgSql, params);
      return res.rows;
    };
    db.get = async (sql, params = []) => {
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      const res = await pool.query(pgSql, params);
      return res.rows[0];
    };

    console.log('🌐 Connected to PostgreSQL Database (Cloud).');
  } else {
    // Local SQLite setup
    const sqlite3 = require('sqlite3').verbose();
    const { open } = require('sqlite');
    
    db = await open({
      filename: path.join(__dirname, 'database.sqlite'),
      driver: sqlite3.Database
    });
    console.log('🏠 Connected to SQLite Database (Local).');
  }

  // Define Schema with quoted identifiers for case-sensitivity consistency
  await db.exec(`
    CREATE TABLE IF NOT EXISTS global_config (
      "key" TEXT PRIMARY KEY,
      "value" TEXT
    );
    CREATE TABLE IF NOT EXISTS accounts (
      "accountId" TEXT PRIMARY KEY,
      "username" TEXT,
      "accessToken" TEXT,
      "profilePictureUrl" TEXT,
      "createdAt" TEXT
    );
    CREATE TABLE IF NOT EXISTS posts (
      "id" TEXT PRIMARY KEY,
      "accountId" TEXT,
      "mediaType" TEXT,
      "imageUrl" TEXT,
      "caption" TEXT,
      "scheduledAt" TEXT,
      "status" TEXT DEFAULT 'pending',
      "mediaId" TEXT,
      "publishedAt" TEXT,
      "createdAt" TEXT,
      "sourceFile" TEXT
    );
  `);

  // --- UNIFIED MIGRATION SYSTEM ---
  try {
    if (isPostgres) {
      // Postgres Migration Logic
      const checkPic = await db.all("SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'profilePictureUrl'");
      if (checkPic.length === 0) {
        console.log('🌐 [MIGRATION] PostgreSQL: Adding "profilePictureUrl" column to accounts...');
        await db.exec('ALTER TABLE accounts ADD COLUMN "profilePictureUrl" TEXT');
      }
      const checkSource = await db.all("SELECT column_name FROM information_schema.columns WHERE table_name = 'posts' AND column_name = 'sourceFile'");
      if (checkSource.length === 0) {
        console.log('🌐 [MIGRATION] PostgreSQL: Adding "sourceFile" column to posts...');
        await db.exec('ALTER TABLE posts ADD COLUMN "sourceFile" TEXT');
      }
    } else {
      // SQLite Migration Logic
      const accColumns = await db.all('PRAGMA table_info(accounts)');
      if (!accColumns.some(c => c.name === 'profilePictureUrl')) {
        console.log('🏠 [MIGRATION] SQLite: Adding "profilePictureUrl" column to accounts...');
        await db.exec('ALTER TABLE accounts ADD COLUMN "profilePictureUrl" TEXT');
      }
      const postColumns = await db.all('PRAGMA table_info(posts)');
      if (!postColumns.some(c => c.name === 'sourceFile')) {
        console.log('🏠 [MIGRATION] SQLite: Adding "sourceFile" column to posts...');
        await db.exec('ALTER TABLE posts ADD COLUMN "sourceFile" TEXT');
      }
    }
  } catch (err) {
    console.warn('⚠️ [MIGRATION WARNING] Database migration check skipped or failed:', err.message);
  }

  return db;
}

/**
 * Returns the active database instance.
 */
async function getDB() {
  if (!db) await initDB();
  return db;
}

module.exports = { getDB, initDB };
