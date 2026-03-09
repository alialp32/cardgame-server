#!/usr/bin/env node
/**
 * cardgame_test_flow.js
 * Amaç: HTTP login (u/p) → tables list → join table → WS join_room → ready akışını uçtan uca test etmek.
 * Kullanım: node cardgame_test_flow.js
 * Ortam: .env içinde HOST, HTTP_PORT, WS_PORT, TEST_U, TEST_P, TABLE_ID (opsiyonel)
 */
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

function log(...args) {
  /** ISO zaman damgalı log. */
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function die(msg) {
  /** Hata basıp çıkar. */
  log('FAIL', msg);
  process.exit(1);
}

function readEnv(name, fallback) {
  /** ENV oku. */
  const v = process.env[name];
  return (v === undefined || v === null || String(v).trim() === '') ? fallback : String(v);
}

function toInt(name, fallback) {
  /** ENV int. */
  const v = readEnv(name, String(fallback));
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function httpRequestJson({ method, url, headers, bodyObj, timeoutMs }) {
  /** JSON HTTP request. */
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;

    const body = bodyObj ? JSON.stringify(bodyObj) : null;

    const req = lib.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + (u.search || ''),
      headers: Object.assign(
        { Accept: 'application/json' },
        body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
        headers || {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode || 0, json, text });
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs || 15000, () => req.destroy(new Error('HTTP timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  /** Uçtan uca akış. */
  try { require('dotenv').config(); } catch {}

  const host = readEnv('HOST', '127.0.0.1');
  const httpPort = toInt('HTTP_PORT', 3000);
  const wsPort = toInt('WS_PORT', 3001);

  const u = readEnv('TEST_U', 'ali');
  const p = readEnv('TEST_P', '123');

  const tableIdEnv = readEnv('TABLE_ID', '');
  const tableId = tableIdEnv ? Number.parseInt(tableIdEnv, 10) : null;
  const hasTableId = Number.isFinite(tableId);

  const httpBase = `http://${host}:${httpPort}`;
  const wsUrl = `ws://${host}:${wsPort}`;

  log('CONFIG', JSON.stringify({ host, httpPort, wsPort, u, hasTableId }));

  const health = await httpRequestJson({ method: 'GET', url: `${httpBase}/health`, timeoutMs: 10000 });
  log('HTTP /health status=', health.status);
  if (health.status !== 200) die(`/health failed: status=${health.status} body=${health.text}`);

  // LOGIN: SUNUCU u/p BEKLİYOR (senin curl örneği)
  const login = await httpRequestJson({
    method: 'POST',
    url: `${httpBase}/auth/login`,
    bodyObj: { u, p },
    timeoutMs: 15000,
  });
  log('HTTP /auth/login status=', login.status);
  if (login.status !== 200) die(`/auth/login HTTP status=${login.status} body=${login.text}`);
  if (!(login.json && login.json.ok === true)) die(`Login failed: ${login.text}`);

  const token = login.json.token || login.json.t || login.json.jwt || null;
  if (!token) die(`Login ok=true ama token yok: ${login.text}`);
  log('LOGIN ok tokenLen=', String(token).length);

  const tables = await httpRequestJson({
    method: 'GET',
    url: `${httpBase}/tables`,
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 15000,
  });
  log('HTTP GET /tables status=', tables.status);
  if (tables.status !== 200) die(`/tables failed: status=${tables.status} body=${tables.text}`);

  const list = Array.isArray(tables.json) ? tables.json : (tables.json && Array.isArray(tables.json.tables) ? tables.json.tables : null);
  if (!list) die(`/tables JSON bekleneni değil: ${tables.text}`);
  if (list.length === 0) die(`/tables boş geldi`);

  const pick = hasTableId ? list.find((x) => Number(x.id) === tableId) : list[0];
  if (!pick) die(`TABLE_ID=${tableId} listede yok.`);
  const pickedTableId = Number(pick.id);
  if (!Number.isFinite(pickedTableId)) die(`Seçilen table.id sayı değil: ${JSON.stringify(pick)}`);
  log('TABLE picked id=', pickedTableId, 'name=', pick.name || pick.table_name || '');

  const join = await httpRequestJson({
    method: 'POST',
    url: `${httpBase}/tables/${pickedTableId}/join`,
    headers: { Authorization: `Bearer ${token}` },
    bodyObj: {},
    timeoutMs: 20000,
  });
  log('HTTP POST /tables/:id/join status=', join.status);
  if (join.status !== 200) die(`Join failed: status=${join.status} body=${join.text}`);
  if (!(join.json && join.json.ok === true)) die(`Join ok değil: ${join.text}`);

  const sessionId = join.json.sessionId || join.json.session_id || join.json.roomId || join.json.room_id || join.json.session || null;
  const seatIndex = (join.json.seatIndex !== undefined) ? join.json.seatIndex : (join.json.seat_index !== undefined ? join.json.seat_index : null);
  log('JOIN ok sessionId=', sessionId, 'seatIndex=', seatIndex);

  let WebSocket;
  try { WebSocket = require('ws'); } catch { die('ws paketi yok. "npm i ws" çalıştır.'); }

  const ws = new WebSocket(wsUrl);

  const sendJson = (obj) => {
    /** WS JSON gönder. */
    ws.send(JSON.stringify(obj));
  };

  ws.on('open', () => {
    log('WS open', wsUrl);
    sendJson({ type: 'hello', utc: new Date().toISOString() });
    // Senin WS: join_room içinde token bekliyor (SS)
    sendJson({ type: 'join_room', tableId: pickedTableId, token });
  });

  ws.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    let j = null;
    try { j = JSON.parse(text); } catch {}

    if (j && j.type) log('WS <=', j.type, JSON.stringify(j));
    else log('WS <=', text);

    if (j && (j.type === 'joined' || j.type === 'state_snapshot')) {
      sendJson({ type: 'ready', ready: true, utc: new Date().toISOString() });
    }
  });

  ws.on('close', (code, reason) => log('WS close', code, reason ? reason.toString() : ''));
  ws.on('error', (err) => log('WS error', String(err && err.message ? err.message : err)));

  await new Promise((r) => setTimeout(r, 20000));
  try { ws.close(); } catch {}
  log('DONE (20s monitor).');
  process.exit(0);
}

main().catch((e) => die(String(e && e.stack ? e.stack : e)));
