'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const mysql = require('mysql2/promise');

function envStr(name, fallback = '') {
  const v = process.env[name];
  return (v && String(v).trim().length > 0) ? String(v).trim() : fallback;
}

function envInt(name, fallback) {
  const v = process.env[name];
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function configFromDatabaseUrl() {
  const databaseUrl = envStr('DATABASE_URL', '');
  if (!databaseUrl) return null;

  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
    database: decodeURIComponent((url.pathname || '').replace(/^\//, '') || 'railway')
  };
}

const cfg = configFromDatabaseUrl() || {
  host: envStr('DB_HOST', '127.0.0.1'),
  port: envInt('DB_PORT', 3306),
  user: envStr('DB_USER', 'root'),
  password: envStr('DB_PASSWORD', ''),
  database: envStr('DB_NAME', 'railway')
};

const pool = mysql.createPool({
  host: cfg.host,
  port: cfg.port,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database,
  waitForConnections: true,
  connectionLimit: envInt('DB_CONNECTION_LIMIT', 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

async function testDb() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT DATABASE() AS db_name, UTC_TIMESTAMP() AS utc');
    return rows && rows[0] ? rows[0] : { ok: 0 };
  } finally {
    conn.release();
  }
}

module.exports = { pool, testDb };
