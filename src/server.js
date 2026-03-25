'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const http = require('http');
const express = require('express');
const cors = require('cors');
const { testDb } = require('./db/pool');
const { ensurePromoSchema } = require('./db/promo');
const { ensureStoreSchema } = require('./db/store');
const authRouter = require('./http/auth');
const adminRouter = require('./http/admin');
const tablesRouter = require('./http/http_tables');
const adminLiveTable = require('./http/admin_live_table');
const appActionsRouter = require('./http/app_actions');
const { startWsServer } = require('./ws/server');
const { setWsAdminApi } = require('./ws/control');

function envInt(name, fallback) {
  const value = process.env[name];
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nowUtcIso() {
  return new Date().toISOString();
}

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '256kb' }));

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'cardgame-api', utc: nowUtcIso() });
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
app.use('/app', appActionsRouter);
app.use('/admin', adminRouter);
app.use('/admin', adminLiveTable);
app.use('/tables', tablesRouter);

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

const port = envInt('PORT', envInt('HTTP_PORT', 3000));
const httpServer = http.createServer(app);
const ws = startWsServer({ server: httpServer });
setWsAdminApi(ws && ws.admin ? ws.admin : null);
global.WS_SERVER = ws;

Promise.allSettled([ensurePromoSchema(), ensureStoreSchema()])
  .then((results) => {
    for (const result of results) {
      if (result.status === 'fulfilled') {
        console.log('[BOOT] schema ready');
      } else {
        console.warn('[BOOT] schema init skipped:', result.reason && result.reason.message ? result.reason.message : result.reason);
      }
    }
  })
  .catch((err) => {
    console.warn('[BOOT] schema init failure:', err && err.message ? err.message : err);
  });

httpServer.listen(port, '0.0.0.0', () => {
  console.log('[HTTP+WS] listening on :' + port);
});
