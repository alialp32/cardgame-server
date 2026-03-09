'use strict';
/**
 * Append-only event log for debugging/audit.
 * Each WS/HTTP action can insert one row with a per-session seq counter.
 */

function nowUtcIso() {
  return new Date().toISOString();
}

/**
 * Inserts a game event within an existing transaction.
 * conn must be mysql2 connection with open transaction.
 */
async function insertEventTx(conn, { sessionId, tableId, handNo, seq, eventType, actorUserId, payload }) {
  const sid = Number(sessionId);
  const tid = Number(tableId);
  const hn = Number(handNo || 0);
  const s = Number(seq || 0);
  const et = String(eventType || '').slice(0, 48);
  const au = actorUserId === null || actorUserId === undefined ? null : Number(actorUserId);
  const payloadJson = payload === null || payload === undefined ? null : JSON.stringify(payload);
  const utc = nowUtcIso();

  await conn.query(
    `INSERT INTO game_events (session_id, table_id, hand_no, seq, event_type, actor_user_id, payload_json, created_at_utc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sid, tid, hn, s, et, au, payloadJson, utc]
  );
}

module.exports = { insertEventTx };
