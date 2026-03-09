'use strict';
/**
 * payout_session DB transaction
 * - Locks session + table config
 * - Computes fee = ceil(pot_total * fee_pct / 100)
 * - Credits winner with (pot_total - fee)
 * - Credits the first admin user (house) with fee (if exists)
 * - Writes chip_ledger rows
 * - Marks session finished
 *
 * Returns: { ok:true, prize, fee, houseUserId } or { ok:false, code, error? }
 */
const { pool } = require('./pool');

function nowUtcIso() { return new Date().toISOString(); }

/** Rounds up to integer (51.5 -> 52). */
function ceilInt(x) { return Math.ceil(Number(x) || 0); }

async function payoutSessionTx({ sessionId, winnerUserId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock session + table
    const [sRows] = await conn.query(
      `SELECT ts.id AS sessionId, ts.table_id AS tableId, ts.status AS status, ts.pot_total AS potTotal,
              t.fee_pct AS feePct
       FROM table_sessions ts
       JOIN tables t ON t.id = ts.table_id
       WHERE ts.id=? FOR UPDATE`,
      [sessionId]
    );
    const s = sRows && sRows[0];
    if (!s) {
      await conn.rollback();
      return { ok: false, code: 'NO_SESSION' };
    }
    if (String(s.status) === 'finished') {
      await conn.rollback();
      return { ok: false, code: 'ALREADY_FINISHED' };
    }

    const potTotal = Number(s.potTotal || 0);
    const feePct = Number(s.feePct || 0);
    const fee = ceilInt((potTotal * feePct) / 100);
    const prize = Math.max(0, potTotal - fee);

    // Lock winner
    const [wRows] = await conn.query(
      'SELECT id, chips_balance FROM users WHERE id=? FOR UPDATE',
      [winnerUserId]
    );
    const w = wRows && wRows[0];
    if (!w) {
      await conn.rollback();
      return { ok: false, code: 'NO_WINNER_USER' };
    }

    // House: first admin user (if exists)
    const [hRows] = await conn.query(
      'SELECT id FROM users WHERE is_admin=1 ORDER BY id ASC LIMIT 1 FOR UPDATE'
    );
    const house = hRows && hRows[0] ? Number(hRows[0].id) : null;

    // Apply balances
    if (prize > 0) {
      await conn.query('UPDATE users SET chips_balance=chips_balance+? WHERE id=?', [prize, winnerUserId]);
      await conn.query(
        'INSERT INTO chip_ledger(user_id, delta, reason, created_at_utc) VALUES(?,?,?,?)',
        [winnerUserId, prize, 'SESSION_WIN', nowUtcIso()]
      );
    }
    if (fee > 0 && house) {
      await conn.query('UPDATE users SET chips_balance=chips_balance+? WHERE id=?', [fee, house]);
      await conn.query(
        'INSERT INTO chip_ledger(user_id, delta, reason, created_at_utc) VALUES(?,?,?,?)',
        [house, fee, 'HOUSE_FEE', nowUtcIso()]
      );
    }

    // Mark session finished
    await conn.query(
      'UPDATE table_sessions SET status="finished", updated_at_utc=? WHERE id=?',
      [nowUtcIso(), sessionId]
    );

    await conn.commit();
    return { ok: true, prize, fee, houseUserId: house };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    return { ok: false, code: 'DB_ERROR', error: String(e && e.message ? e.message : e) };
  } finally {
    conn.release();
  }
}

module.exports = { payoutSessionTx };
