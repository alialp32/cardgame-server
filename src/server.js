
'use strict';

/**
 * CardGame Server (HTTP + WS) - production-ready bootstrap for MVP.
 * - Loads project-root .env (stable regardless of cwd)
 * - HTTP routes: /health, /db-test, /auth/*, /admin/*, /tables/*
 * - WS server: delegated to src/ws/server.js
 * All timestamps UTC.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const http = require('http');
const express = require('express');
const cors = require('cors');

const { testDb } = require('./db/pool');

const authRouter = require('./http/auth');
const adminRouter = require('./http/admin');
const tablesRouter = require('./http/http_tables');

/* YENİ: canlı masa inspector endpoint */
const adminLiveTable = require('./http/admin_live_table');

const { startWsServer } = require('./ws/server');
const { setWsAdminApi } = require('./ws/control');

function envInt(name, fallback) {
  const v = process.env[name];
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function nowUtcIso() {
  return new Date().toISOString();
}

// -------- HTTP --------
const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, utc: nowUtcIso() });
});

app.get('/db-test', async (req, res) => {
  try {
    const result = await testDb();
    res.status(200).json({ ok: true, db: result, utc: nowUtcIso() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, utc: nowUtcIso() });
  }
});

app.use('/auth', authRouter);
app.use('/admin', adminRouter);

/* YENİ ROUTER */
app.use('/admin', adminLiveTable);

app.use('/tables', tablesRouter);

const httpPort = envInt('HTTP_PORT', 3000);
http.createServer(app).listen(httpPort, '0.0.0.0', () => {
  console.log('[HTTP] listening on :' + httpPort);
});

// -------- WS --------
const wsPort = envInt('WS_PORT', 3001);
const ws = startWsServer({ wsPort });
setWsAdminApi(ws && ws.admin ? ws.admin : null);

/* GLOBAL DEBUG ACCESS */
global.WS_SERVER = ws;
