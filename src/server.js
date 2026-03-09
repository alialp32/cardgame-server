'use strict';

/*
 CardGame Server
 HTTP + WebSocket shared server
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

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

/* ROOT TEST */
app.get('/', (req, res) => {
  res.send('CardGame server running');
});

/* HEALTH CHECK */
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    utc: nowUtcIso()
  });
});

/* DATABASE TEST */
app.get('/db-test', async (req, res) => {
  try {
    const result = await testDb();
    res.status(200).json({
      ok: true,
      db: result,
      utc: nowUtcIso()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
      utc: nowUtcIso()
    });
  }
});

/* ROUTERS */
app.use('/auth', authRouter);
app.use('/admin', adminRouter);
app.use('/admin', adminLiveTable);
app.use('/tables', tablesRouter);

/* HTTP SERVER */
const httpPort = process.env.PORT || envInt('HTTP_PORT', 3000);
const server = http.createServer(app);

server.listen(httpPort, '0.0.0.0', () => {
  console.log('[HTTP] listening on :' + httpPort);
});

/* WEBSOCKET */
const ws = startWsServer({ server });
setWsAdminApi(ws && ws.admin ? ws.admin : null);

/* DEBUG ACCESS */
global.WS_SERVER = ws;
