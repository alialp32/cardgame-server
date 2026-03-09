'use strict';
/**
 * Admin table-run logger.
 * - Keeps one active run per table.
 * - Append-only events.
 * - Safe helpers never throw to caller.
 * All timestamps UTC.
 */
const { pool } = require('./pool');

const EVT = Object.freeze({
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_CLOSED: 'SESSION_CLOSED',
  WINNER_DECLARED: 'WINNER_DECLARED',
  PAYOUT_DONE: 'PAYOUT_DONE',

  PLAYER_JOINED_SPECTATOR: 'PLAYER_JOINED_SPECTATOR',
  PLAYER_READY_PAID: 'PLAYER_READY_PAID',
  PLAYER_READY_RESTORED: 'PLAYER_READY_RESTORED',
  PLAYER_READY_FAILED_BALANCE: 'PLAYER_READY_FAILED_BALANCE',
  PLAYER_WAITING_NEXT_HAND: 'PLAYER_WAITING_NEXT_HAND',
  PLAYER_JOIN_NEXT_HAND: 'PLAYER_JOIN_NEXT_HAND',
  PLAYER_DISCONNECTED: 'PLAYER_DISCONNECTED',
  PLAYER_RECONNECTED: 'PLAYER_RECONNECTED',
  PLAYER_LEFT_TABLE: 'PLAYER_LEFT_TABLE',

  GAME_START: 'GAME_START',
  HAND_STARTED: 'HAND_STARTED',
  HAND_FINISHED: 'HAND_FINISHED',

  DRAW: 'DRAW',
  DISCARD: 'DISCARD',
  DECLARE_FINISH: 'DECLARE_FINISH',
  FINISH_SUBMIT: 'FINISH_SUBMIT',
  FINISH_INVALID_PENALTY: 'FINISH_INVALID_PENALTY',
  FINISH_ACCEPTED: 'FINISH_ACCEPTED',

  SHOW_FINISH_STARTED: 'SHOW_FINISH_STARTED',
  SCORING_SUBMIT: 'SCORING_SUBMIT',
  SCORING_SAVED_WITH_INVALID_GROUPS: 'SCORING_SAVED_WITH_INVALID_GROUPS',
  SCORING_FINALIZED: 'SCORING_FINALIZED',
});

function nowUtcSql() {
  return new Date().toISOString().slice(0, 23).replace('T', ' ');
}

function suitFace(s) {
  if (s === 'S') return '♠';
  if (s === 'H') return '♥';
  if (s === 'D') return '♦';
  if (s === 'C') return '♣';
  return '?';
}

function rankFace(rank) {
  const n = String(rank || '').padStart(2, '0');
  if (n === '01') return 'A';
  if (n === '11') return 'J';
  if (n === '12') return 'Q';
  if (n === '13') return 'K';
  return String(Number(n));
}

function normalizeCardLogInput(card) {
  if (!card) return null;
  if (typeof card === 'string') {
    const cardId = card.trim();
    return cardId ? { cardId, face: null } : null;
  }
  if (typeof card === 'object') {
    const cardId = typeof card.id === 'string' ? card.id.trim() : '';
    const face = typeof card.face === 'string' ? card.face.trim() : '';
    if (!cardId && !face) return null;
    return { cardId: cardId || face, face: face || null };
  }
  return null;
}

function formatCardLog(card) {
  const normalized = normalizeCardLogInput(card);
  if (!normalized) return { cardId: null, face: null };
  const directFace = normalized.face;
  const cardId = normalized.cardId;
  if (directFace) return { cardId, face: directFace };
  if (cardId === 'X1' || cardId === 'X2') return { cardId, face: cardId };
  const parts = cardId.split('_');
  if (parts.length < 3) return { cardId, face: cardId };
  const suit = String(parts[1] || '');
  const rank = String(parts[2] || '');
  return { cardId, face: `${rankFace(rank)}${suitFace(suit)}` };
}

function formatCardListForLog(cards) {
  if (!Array.isArray(cards)) return [];
  const out = [];
  for (const card of cards) {
    const item = formatCardLog(card);
    if (item.cardId || item.face) out.push(item);
  }
  return out;
}

async function getTableNameById(tableId, conn) {
  const dbc = conn || pool;
  const [rows] = await dbc.query('SELECT name FROM tables WHERE id=? LIMIT 1', [Number(tableId)]);
  return rows && rows[0] ? String(rows[0].name) : null;
}

async function getActiveRunByTableId(tableId, conn) {
  const dbc = conn || pool;
  const [rows] = await dbc.query(
    'SELECT * FROM game_runs WHERE table_id=? AND status="active" ORDER BY id DESC LIMIT 1',
    [Number(tableId)]
  );
  return rows && rows[0] ? rows[0] : null;
}

async function createRun({ tableId, tableName }, conn) {
  const dbc = conn || pool;
  const tname = tableName || await getTableNameById(tableId, conn) || `Table-${Number(tableId)}`;
  const utc = nowUtcSql();
  const [ins] = await dbc.query(
    `INSERT INTO game_runs (table_id, table_name, started_at_utc, ended_at_utc, status, winner_user_id, winner_username, pot_total, fee_total, prize_total)
     VALUES (?, ?, ?, NULL, 'active', NULL, NULL, 0, 0, 0)`,
    [Number(tableId), tname, utc]
  );
  const runId = Number(ins.insertId);
  await dbc.query(
    `INSERT INTO game_run_events (game_run_id, hand_no, hand_id, event_type, user_id, username, payload_json, created_at_utc)
     VALUES (?, NULL, NULL, ?, NULL, NULL, ?, ?)`,
    [runId, EVT.SESSION_CREATED, JSON.stringify({ tableId: Number(tableId), tableName: tname }), utc]
  );
  return { id: runId, table_id: Number(tableId), table_name: tname, started_at_utc: utc, status: 'active' };
}

async function ensureRun({ tableId, tableName }, conn) {
  const active = await getActiveRunByTableId(tableId, conn);
  if (active) return active;
  return createRun({ tableId, tableName }, conn);
}

async function resolveHandNo(runId, eventType, handNo, conn) {
  if (handNo !== undefined && handNo !== null && Number.isFinite(Number(handNo))) return Number(handNo);
  const dbc = conn || pool;
  const [rows] = await dbc.query(
    `SELECT COUNT(*) AS c FROM game_run_events WHERE game_run_id=? AND event_type=?`,
    [Number(runId), EVT.HAND_STARTED]
  );
  const row = rows && rows[0] ? rows[0] : { c: 0 };
  const current = Number(row.c || 0);
  if (eventType === EVT.HAND_STARTED) return current + 1;
  return current > 0 ? current : null;
}

async function logEvent({ tableId, tableName, gameRunId, handNo = null, handId = null, eventType, userId = null, username = null, payload = null }, conn) {
  const dbc = conn || pool;
  let runId = gameRunId ? Number(gameRunId) : null;
  if (!runId) {
    const run = await ensureRun({ tableId, tableName }, conn);
    runId = Number(run.id);
  }
  const resolvedHandNo = await resolveHandNo(runId, eventType, handNo, conn);
  await dbc.query(
    `INSERT INTO game_run_events (game_run_id, hand_no, hand_id, event_type, user_id, username, payload_json, created_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      resolvedHandNo,
      handId == null ? null : String(handId),
      String(eventType).slice(0, 64),
      userId == null ? null : Number(userId),
      username == null ? null : String(username).slice(0, 120),
      payload == null ? null : JSON.stringify(payload),
      nowUtcSql(),
    ]
  );
  return runId;
}

async function closeRun({ tableId, tableName, winnerUserId = null, winnerUsername = null, potTotal = 0, feeTotal = 0, prizeTotal = 0 }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const run = await getActiveRunByTableId(tableId, conn);
    if (!run) {
      await conn.rollback();
      return { ok: false, code: 'NO_ACTIVE_RUN' };
    }
    const runId = Number(run.id);
    if (winnerUserId || winnerUsername) {
      await logEvent({
        gameRunId: runId,
        tableId,
        tableName,
        eventType: EVT.WINNER_DECLARED,
        userId: winnerUserId,
        username: winnerUsername,
        payload: { winnerUserId: winnerUserId == null ? null : Number(winnerUserId), winnerUsername: winnerUsername || null }
      }, conn);
    }
    await logEvent({
      gameRunId: runId,
      tableId,
      tableName,
      eventType: EVT.SESSION_CLOSED,
      payload: { endedAtUtc: nowUtcSql() }
    }, conn);

    await conn.query(
      `UPDATE game_runs
       SET ended_at_utc=?, status='finished', winner_user_id=?, winner_username=?, pot_total=?, fee_total=?, prize_total=?
       WHERE id=? LIMIT 1`,
      [nowUtcSql(), winnerUserId == null ? null : Number(winnerUserId), winnerUsername || null, Number(potTotal || 0), Number(feeTotal || 0), Number(prizeTotal || 0), runId]
    );
    await conn.commit();
    return { ok: true, runId };
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    return { ok: false, code: 'DB_ERROR', error: String(e && e.message ? e.message : e) };
  } finally {
    try { conn.release(); } catch (_) {}
  }
}

async function safeLogEvent(input) {
  try {
    await logEvent(input);
    return true;
  } catch (e) {
    console.warn('[table_run_logger] log failed:', e && e.message ? e.message : e);
    return false;
  }
}

async function safeCloseRun(input) {
  try {
    return await closeRun(input);
  } catch (e) {
    console.warn('[table_run_logger] close failed:', e && e.message ? e.message : e);
    return { ok: false, code: 'DB_ERROR', error: String(e && e.message ? e.message : e) };
  }
}

module.exports = {
  EVT,
  formatCardLog,
  formatCardListForLog,
  getActiveRunByTableId,
  logEvent,
  safeLogEvent,
  closeRun,
  safeCloseRun,
};
