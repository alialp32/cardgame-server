'use strict';
/**
 * buyin_next_hand DB transaction
 *
 * Purpose:
 * - While a hand is already running, allow a new user to pay buy-in and reserve a seat,
 *   but NOT participate in the current dealt hand.
 * - The user will become active (status 'joined') when the current hand finishes and the next hand starts.
 *
 * Requires DB:
 * - session_players.status ENUM includes 'waiting_next_hand'
 * - session_players.seat_index is NULLABLE (recommended)
 *
 * Returns:
 *  { ok:true, code:'WAITING_NEXT_HAND', sessionId, seatIndex, buyIn, potTotal, startScore }
 *  { ok:false, code:'...' }
 */

const { pool } = require('./pool');

async function buyinNextHandTx({ userId, tableId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock user
    const [uRows] = await conn.query(
      'SELECT id, chips_balance, status FROM users WHERE id=? FOR UPDATE',
      [userId]
    );
    const u = uRows && uRows[0];
    if (!u) { await conn.rollback(); return { ok:false, code:'USER_NOT_FOUND' }; }
    if (String(u.status) !== 'active') { await conn.rollback(); return { ok:false, code:'USER_INACTIVE' }; }

    // Lock table
    const [tRows] = await conn.query(
      'SELECT id, min_buy_in, max_players, status FROM tables WHERE id=? FOR UPDATE',
      [tableId]
    );
    const t = tRows && tRows[0];
    if (!t) { await conn.rollback(); return { ok:false, code:'TABLE_NOT_FOUND' }; }
    if (String(t.status) !== 'open') { await conn.rollback(); return { ok:false, code:'TABLE_CLOSED' }; }

    const buyIn = Number(t.min_buy_in);
    const maxPlayers = Number(t.max_players);

    // Lock current session (waiting/active only)
    const [sRows] = await conn.query(
      `SELECT id, status, pot_total
       FROM table_sessions
       WHERE table_id=? AND status IN ('waiting','active')
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [tableId]
    );
    const session = sRows && sRows[0];
    if (!session) { await conn.rollback(); return { ok:false, code:'NO_SESSION' }; }
    const sessionId = Number(session.id);
    const sessionStatus = String(session.status || '');

    // If finished, do not allow new entry
    if (sessionStatus === 'finished') { await conn.rollback(); return { ok:false, code:'SESSION_FINISHED' }; }

    // Already in session?
    const [meRows] = await conn.query(
      `SELECT id, seat_index, buy_in, status
       FROM session_players
       WHERE session_id=? AND user_id=?
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [sessionId, userId]
    );
    const me = meRows && meRows[0];
    if (me && ['joined','disconnected_waiting','waiting_next_hand'].includes(String(me.status))) {
      await conn.commit();
      return { ok:true, code:'ALREADY_IN_SESSION', sessionId, seatIndex:Number(me.seat_index), buyIn:Number(me.buy_in||buyIn), potTotal:Number(session.pot_total||0) };
    }
    if (me && String(me.status)==='kicked') { await conn.rollback(); return { ok:false, code:'KICKED' }; }

    // Find a free seat among ALL reserved/active seats
    const used = new Set();
    const [seatRows] = await conn.query(
      `SELECT seat_index
       FROM session_players
       WHERE session_id=?
         AND status IN ('joined','disconnected_waiting','waiting_next_hand')
         AND seat_index IS NOT NULL
       FOR UPDATE`,
      [sessionId]
    );
    for (const r of seatRows || []) used.add(Number(r.seat_index));

    let seatIndex = null;
    for (let i = 0; i < maxPlayers; i++) { if (!used.has(i)) { seatIndex = i; break; } }
    if (seatIndex === null) { await conn.rollback(); return { ok:false, code:'TABLE_FULL' }; }

    // Balance check + charge
    const balance = Number(u.chips_balance);
    if (balance < buyIn) { await conn.rollback(); return { ok:false, code:'INSUFFICIENT_CHIPS' }; }

    // Start score = max total_score among active players (joined/disconnected/waiting)
    const [mxRows] = await conn.query(
      `SELECT COALESCE(MAX(total_score), 0) AS mx
       FROM session_players
       WHERE session_id=?
         AND status IN ('joined','disconnected_waiting')`,
      [sessionId]
    );
    const startScore = mxRows && mxRows[0] ? Number(mxRows[0].mx || 0) : 0;

    // Insert waiting row
    try {
      await conn.query(
        `INSERT INTO session_players
         (session_id, user_id, seat_index, buy_in, status, joined_at_utc, total_score, busted)
         VALUES (?, ?, ?, ?, 'waiting_next_hand', NOW(6), ?, 0)`,
        [sessionId, userId, seatIndex, buyIn, startScore]
      );
    } catch (e) {
      const em = String(e && e.message ? e.message : e);
      // If enum missing, surface clearly
      if (em.includes("'waiting_next_hand'") || em.toLowerCase().includes('enum')) {
        await conn.rollback();
        return { ok:false, code:'DB_MIGRATION_REQUIRED', error:'Add waiting_next_hand to session_players.status ENUM.' };
      }
      throw e;
    }

    // Update user balance
    const newBalance = balance - buyIn;
    await conn.query('UPDATE users SET chips_balance=? WHERE id=? LIMIT 1', [newBalance, userId]);

    // Update pot
    const potTotal = Number(session.pot_total || 0) + buyIn;
    await conn.query('UPDATE table_sessions SET pot_total=?, updated_at_utc=NOW(6) WHERE id=? LIMIT 1', [potTotal, sessionId]);

    // Ledger
    await conn.query(
      `INSERT INTO chip_ledger (user_id, delta, reason, ref_type, ref_id, balance_after, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, NOW(6))`,
      [userId, -buyIn, 'table_buy_in_next_hand', 'table_session', sessionId, newBalance]
    );

    await conn.commit();
    return { ok:true, code:'WAITING_NEXT_HAND', sessionId, seatIndex, buyIn, potTotal, startScore };
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    return { ok:false, code:'DB_ERROR', error: String(e && e.message ? e.message : e) };
  } finally {
    try { conn.release(); } catch (_) {}
  }
}

module.exports = { buyinNextHandTx };
