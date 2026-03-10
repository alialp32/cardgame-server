'use strict';

/**
 * MySQL pool bootstrap (mysql2/promise).
 * Railway + Render uyumlu.
 * Tüm zamanlar UTC kabul edilir.
 */

const mysql = require('mysql2/promise');

function envStr(name, fallback) {
  const v = process.env[name];
  return (v && String(v).trim().length > 0) ? String(v) : fallback;
}

function envInt(name, fallback) {
  const v = process.env[name];
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

const pool = mysql.createPool({
  host: envStr('DB_HOST', '127.0.0.1'),
  port: envInt('DB_PORT', 3306),
  user: envStr('DB_USER', 'root'),
  password: envStr('DB_PASSWORD', ''),
  database: envStr('DB_NAME', 'railway'),

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  charset: 'utf8mb4',
  connectTimeout: 20000,

  enableKeepAlive: true,
  keepAliveInitialDelay: 0,

  ssl: {
    rejectUnauthorized: false
  }
});

async function testDb() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT 1 AS ok, UTC_TIMESTAMP() AS utc');
    return rows && rows[0] ? rows[0] : { ok: 0 };
  } finally {
    conn.release();
  }
}

module.exports = { pool, testDb };