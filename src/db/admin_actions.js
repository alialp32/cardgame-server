'use strict';
/**
 * Admin DB actions (transactional).
 * - kick player in a session
 * - reset + refund table session
 *
 * All timestamps are UTC.
 */
const { pool } = require('./pool');

function nowUtcIso() {
  return new Date().toISOString();
}

/**
 * Marks a player as kicked in session_players (if currently joined).
 * This does NOT adjust pot/chips automatically (kick is a seat action).
 */
async function kickPlayerTx({ sessionId, userId, reason }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [spRows] = await conn.query(
      `SELECT id, status
       FROM session_players
       WHERE session_id=? AND user_id=? LIMIT 1
       FOR UPDATE`,
      [sessionId, userId]
    );
    const sp = spRows && spRows[0];
    if (!sp) {
      await conn.rollback();
      return { ok: false, code: 'PLAYER_NOT_IN_SESSION' };
    }

    // Allow kicking a disconnected_waiting player as well (admin/vote kick).
    if (!['joined', 'disconnected_waiting'].includes(String(sp.status))) {
      await conn.commit();
      return { ok: true, code: 'ALREADY_NOT_JOINED' };
    }

    await conn.query(
      `UPDATE session_players
       SET status='kicked', left_at_utc=?
       WHERE session_id=? AND user_id=? LIMIT 1`,
      [nowUtcIso(), sessionId, userId]
    );

    await conn.commit();
    return { ok: true, code: 'KICKED', reason: String(reason || 'kicked') };
  } catch (err) {
    try { await conn.rollback(); } catch {}
    return { ok: false, code: 'TX_ERROR', error: err && err.message ? err.message : String(err) };
  } finally {
    conn.release();
  }
}

/**
 * Resets the latest waiting/active session of a table:
 * - refunds each joined player's buy_in back to chips_balance
 * - writes chip_ledger entries (reason: admin_refund)
 * - marks session_players as kicked and sets left_at_utc
 * - sets table_sessions status finished and pot_total=0
 *
 * Returns: { ok:true, tableId, sessionId, refunded:[{userId, amount}] }
 */
async function resetRefundTableTx({ tableId, adminUserId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock table
    const [tRows] = await conn.query('SELECT id FROM tables WHERE id=? FOR UPDATE', [tableId]);
    if (!tRows || !tRows[0]) {
      await conn.rollback();
      return { ok: false, code: 'TABLE_NOT_FOUND' };
    }

    // Lock latest waiting/active session
    const [sRows] = await conn.query(
      `SELECT id, pot_total, status
       FROM table_sessions
       WHERE table_id=? AND status IN ('waiting','active')
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [tableId]
    );
    const s = sRows && sRows[0];
    if (!s) {
      await conn.rollback();
      return { ok: false, code: 'NO_ACTIVE_SESSION' };
    }

    const sessionId = Number(s.id);

    // Lock joined players
    const [pRows] = await conn.query(
      `SELECT sp.user_id AS userId, sp.buy_in AS buyIn, u.chips_balance AS chips
       FROM session_players sp
       JOIN users u ON u.id = sp.user_id
       WHERE sp.session_id=? AND sp.status='joined'
       FOR UPDATE`,
      [sessionId]
    );

    const refunded = [];
    const utc = nowUtcIso();

    for (const r of (pRows || [])) {
      const userId = Number(r.userId);
      const buyIn = Number(r.buyIn);
      const chips = Number(r.chips);

      // refund chips
      await conn.query('UPDATE users SET chips_balance = chips_balance + ? WHERE id=? LIMIT 1', [buyIn, userId]);

      // ledger
      await conn.query(
        `INSERT INTO chip_ledger (user_id, delta, reason, ref_type, ref_id, balance_after, created_at_utc)
         VALUES (?,?,?,?,?,?,?)`,
        [userId, buyIn, 'admin_refund', 'table_session', sessionId, chips + buyIn, utc]
      );

      refunded.push({ userId, amount: buyIn });
    }

    // mark players kicked/left
    await conn.query(
      `UPDATE session_players
       SET status='kicked', left_at_utc=?
       WHERE session_id=? AND status='joined'`,
      [utc, sessionId]
    );

    // finish session and reset pot
    await conn.query(
      `UPDATE table_sessions
       SET status='finished', pot_total=0, updated_at_utc=?
       WHERE id=? LIMIT 1`,
      [utc, sessionId]
    );

    await conn.commit();

    return { ok: true, tableId: Number(tableId), sessionId, refunded, byAdminUserId: Number(adminUserId || 0) };
  } catch (err) {
    try { await conn.rollback(); } catch {}
    return { ok: false, code: 'TX_ERROR', error: err && err.message ? err.message : String(err) };
  } finally {
    conn.release();
  }
}

module.exports = { kickPlayerTx, resetRefundTableTx };
