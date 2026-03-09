'use strict';
/**
 * DB persistence for in-progress hand state (snapshot) + per-session counters.
 * - Stores the latest JSON snapshot for a session so server restart can restore hands.
 * - Maintains event_seq and hand_no counters for ordered logging.
 *
 * All timestamps are UTC ISO strings.
 */

const { pool } = require('./pool');

function nowUtcIso() {
  return new Date().toISOString();
}

/** Reads latest snapshot for a session. Returns {handNo, eventSeq, version, state} or null. */
async function loadSessionState(sessionId) {
  const sid = Number(sessionId);
  const [rows] = await pool.query(
    `SELECT session_id, table_id, hand_no, event_seq, version, state_json, updated_at_utc
     FROM game_session_state
     WHERE session_id=? LIMIT 1`,
    [sid]
  );
  if (!rows || !rows[0]) return null;
  const r = rows[0];
  let parsed = null;
  try { parsed = r.state_json ? JSON.parse(String(r.state_json)) : null; } catch (_) { parsed = null; }
  return {
    sessionId: Number(r.session_id),
    tableId: Number(r.table_id),
    handNo: Number(r.hand_no || 0),
    eventSeq: Number(r.event_seq || 0),
    version: Number(r.version || 0),
    updatedAtUtc: r.updated_at_utc ? String(r.updated_at_utc) : null,
    state: parsed,
  };
}

/**
 * Increments hand_no and event_seq (optional) and upserts snapshot in a single transaction connection.
 * conn must be a mysql2 connection with an open transaction.
 *
 * Returns {handNo, eventSeq, version}.
 */
async function upsertStateTx(conn, { sessionId, tableId, handNo, nextEventSeq, stateObj }) {
  const sid = Number(sessionId);
  const tid = Number(tableId);
  const hn = Number(handNo || 0);
  const seq = Number(nextEventSeq || 0);
  const stateJson = JSON.stringify(stateObj || null);
  const utc = nowUtcIso();

  // Upsert snapshot; version increments on each write.
  await conn.query(
    `INSERT INTO game_session_state (session_id, table_id, hand_no, event_seq, version, state_json, updated_at_utc)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE
       table_id=VALUES(table_id),
       hand_no=VALUES(hand_no),
       event_seq=VALUES(event_seq),
       version=version+1,
       state_json=VALUES(state_json),
       updated_at_utc=VALUES(updated_at_utc)`,
    [sid, tid, hn, seq, stateJson, utc]
  );

  const [rows] = await conn.query(
    `SELECT hand_no, event_seq, version FROM game_session_state WHERE session_id=? LIMIT 1`,
    [sid]
  );
  const r = rows && rows[0] ? rows[0] : { hand_no: hn, event_seq: seq, version: 1 };
  return { handNo: Number(r.hand_no || 0), eventSeq: Number(r.event_seq || 0), version: Number(r.version || 0) };
}

/**
 * Gets current counters with row lock (FOR UPDATE). Creates a row if missing.
 * conn must be a mysql2 connection with an open transaction.
 * Returns {handNo, eventSeq}.
 */
async function getOrInitCountersForUpdateTx(conn, { sessionId, tableId }) {
  const sid = Number(sessionId);
  const tid = Number(tableId);
  const [rows] = await conn.query(
    `SELECT hand_no, event_seq
     FROM game_session_state
     WHERE session_id=? FOR UPDATE`,
    [sid]
  );
  if (rows && rows[0]) {
    return { handNo: Number(rows[0].hand_no || 0), eventSeq: Number(rows[0].event_seq || 0) };
  }

  await conn.query(
    `INSERT INTO game_session_state (session_id, table_id, hand_no, event_seq, version, state_json, updated_at_utc)
     VALUES (?, ?, 0, 0, 1, NULL, ?)`,
    [sid, tid, nowUtcIso()]
  );
  return { handNo: 0, eventSeq: 0 };
}

module.exports = { loadSessionState, upsertStateTx, getOrInitCountersForUpdateTx };
