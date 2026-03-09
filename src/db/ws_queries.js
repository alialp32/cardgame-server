'use strict';

/**
 * WS DB queries (FIXED)
 * - Uses correct table names from DB schema:
 *   - session_players (NOT table_session_players)
 *   - tables.min_players_to_start (UI shows as min_start)
 */

const { pool } = require('./pool');

function normalizeSeatIndex(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function findLatestSessionForUserTable(userId, tableId) {
  const [rows] = await pool.query(
    `SELECT sp.session_id AS sessionId
     FROM session_players sp
     JOIN table_sessions ts ON ts.id = sp.session_id
     WHERE sp.user_id=?
       AND sp.status IN ('joined','disconnected_waiting','waiting_next_hand')
       AND ts.table_id=?
       AND ts.status IN ('waiting','active')
     ORDER BY sp.id DESC
     LIMIT 1`,
    [userId, tableId]
  );
  return rows && rows[0] ? rows[0] : null;
}

async function getSeatForUserInSession(userId, sessionId) {
  const [rows] = await pool.query(
    `SELECT seat_index FROM session_players WHERE session_id=? AND user_id=? AND status IN ('joined','disconnected_waiting','waiting_next_hand') LIMIT 1`,
    [sessionId, userId]
  );
  return rows && rows[0] ? normalizeSeatIndex(rows[0].seat_index) : null;
}

async function getSessionSnapshot(sessionId) {
  const [sRows] = await pool.query(
    `SELECT
        ts.id AS sessionId,
        ts.table_id AS tableId,
        ts.status AS sessionStatus,
        ts.pot_total AS potTotal,
        t.min_buy_in AS minBuyIn,
        t.max_players AS maxPlayers,
        t.fee_pct AS feePct,
        t.min_players_to_start AS minStart
     FROM table_sessions ts
     JOIN tables t ON t.id = ts.table_id
     WHERE ts.id=?
     LIMIT 1`,
    [sessionId]
  );
  const s = sRows && sRows[0];
  if (!s) return null;

  const [pRows] = await pool.query(
    `SELECT
        sp.user_id AS userId,
        u.username AS username,
        sp.seat_index AS seatIndex,
        sp.status AS joinStatus,
        sp.total_score AS totalScore,
        sp.busted AS busted
     FROM session_players sp
     JOIN users u ON u.id = sp.user_id
     WHERE sp.session_id=?
       AND sp.status IN ('joined','disconnected_waiting')
       AND sp.seat_index IS NOT NULL
     ORDER BY sp.seat_index ASC, sp.user_id ASC`,
    [sessionId]
  );
  const [wRows] = await pool.query(
    `SELECT
        sp.user_id AS userId,
        u.username AS username,
        sp.seat_index AS seatIndex,
        sp.status AS joinStatus,
        sp.total_score AS totalScore,
        sp.busted AS busted
     FROM session_players sp
     JOIN users u ON u.id = sp.user_id
     WHERE sp.session_id=?
       AND (
         sp.status = 'waiting_next_hand'
         OR (sp.status = 'joined' AND sp.seat_index IS NULL)
       )
     ORDER BY CASE WHEN sp.seat_index IS NULL THEN 1 ELSE 0 END ASC, sp.seat_index ASC, sp.user_id ASC`,
    [sessionId]
  );


  return {
    sessionId: Number(s.sessionId),
    tableId: Number(s.tableId),
    sessionStatus: String(s.sessionStatus),
    potTotal: Number(s.potTotal),
    minBuyIn: Number(s.minBuyIn),
    maxPlayers: Number(s.maxPlayers),
    feePct: Number(s.feePct),
    minStart: Number(s.minStart),
    players: (pRows || []).map(r => ({
      userId: Number(r.userId),
      username: String(r.username),
      seatIndex: normalizeSeatIndex(r.seatIndex),
      joinStatus: String(r.joinStatus),
      score: Number(r.totalScore || 0),
      busted: !!r.busted,
      eliminated: !!r.busted,
      statusLabel: r.busted ? 'elendi' : null,
    })),
    waitingPlayers: (wRows || []).map(r => ({
      userId: Number(r.userId),
      username: String(r.username),
      seatIndex: normalizeSeatIndex(r.seatIndex),
      joinStatus: String(r.joinStatus),
      score: Number(r.totalScore || 0),
      busted: !!r.busted,
      eliminated: !!r.busted,
      statusLabel: r.busted ? 'elendi' : null,
    })),
  };
}

module.exports = { findLatestSessionForUserTable, getSeatForUserInSession, getSessionSnapshot };
