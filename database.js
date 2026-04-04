const path = require('path');
require('dotenv').config();

let db;
const isPostgres = !!process.env.DATABASE_URL;

/**
 * Initializes the database connection (PostgreSQL in production/Render, SQLite locally).
 */
async function initDB() {
  if (isPostgres) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

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
