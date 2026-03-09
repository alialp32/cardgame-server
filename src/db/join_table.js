'use strict';
/**
 * join_table DB transaction
 *
 * New rule:
 * - User may enter table as spectator without paying buy-in.
 * - No seat is reserved on HTTP join.
 * - Buy-in + seat reservation happens on WS ready.
 */
const { pool } = require('./pool');
const { EVT, safeLogEvent } = require('./table_run_logger');

async function joinTableTx({ userId, tableId }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [uRows] = await conn.query('SELECT id, status FROM users WHERE id=? FOR UPDATE', [userId]);
    const u = uRows && uRows[0];
    if (!u) { await conn.rollback(); return { ok:false, code:'USER_NOT_FOUND' }; }
    if (String(u.status) !== 'active') { await conn.rollback(); return { ok:false, code:'USER_INACTIVE' }; }

    const [tRows] = await conn.query('SELECT id, status FROM tables WHERE id=? FOR UPDATE', [tableId]);
    const t = tRows && tRows[0];
    if (!t) { await conn.rollback(); return { ok:false, code:'TABLE_NOT_FOUND' }; }
    if (String(t.status) !== 'open') { await conn.rollback(); return { ok:false, code:'TABLE_CLOSED' }; }

    // Kullanıcı aynı anda birden fazla aktif masada kalmasın.
    // Hedef masa dışındaki waiting/active session kayıtlarını spectator da olsa kapatırız.
    await conn.query(
      `UPDATE session_players sp
       JOIN table_sessions ts ON ts.id = sp.session_id
       SET sp.status='left',
           sp.seat_index=NULL,
           sp.buy_in=0,
           sp.disconnected_at_utc=NULL,
           sp.kick_vote_open_utc=NULL,
           sp.left_at_utc=NOW(6),
           sp.updated_at_utc=NOW(6)
       WHERE sp.user_id=?
         AND ts.table_id<>?
         AND ts.status IN ('waiting','active')
         AND sp.status IN ('joined','disconnected_waiting','waiting_next_hand')`,
      [userId, tableId]
    );

    let session;
    {
      const [sRows] = await conn.query(
        `SELECT id, status, pot_total
         FROM table_sessions
         WHERE table_id=? AND status IN ('waiting','active')
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        [tableId]
      );
      session = sRows && sRows[0];
      if (!session) {
        const [ins] = await conn.query(
          `INSERT INTO table_sessions (table_id, status, pot_total, hand_no, created_at_utc, updated_at_utc)
           VALUES (?, 'waiting', 0, 0, NOW(6), NOW(6))`,
          [tableId]
        );
        session = { id: ins.insertId, status: 'waiting', pot_total: 0 };
      }
    }

    const sessionId = Number(session.id);
    const sessionStatus = String(session.status || 'waiting');
    const potTotal = Number(session.pot_total || 0);

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

    if (me && String(me.status) === 'kicked') {
      await conn.rollback();
      return { ok:false, code:'KICKED' };
    }

    if (me && ['joined','disconnected_waiting','waiting_next_hand'].includes(String(me.status))) {
      if (String(me.status) === 'disconnected_waiting') {
        await conn.query(
          `UPDATE session_players
           SET status='joined', disconnected_at_utc=NULL, kick_vote_open_utc=NULL, left_at_utc=NULL, updated_at_utc=NOW(6)
           WHERE session_id=? AND user_id=? LIMIT 1`,
          [sessionId, userId]
        );
      }
      await conn.commit();
      return { ok:true, code:'ALREADY_JOINED', sessionId, seatIndex: me.seat_index == null ? null : Number(me.seat_index), buyIn:Number(me.buy_in || 0), potTotal, sessionStatus };
    }

    if (me && String(me.status) === 'left') {
      await conn.query(
        `UPDATE session_players
         SET status='joined', seat_index=NULL, buy_in=0, total_score=0, busted=0,
             disconnected_at_utc=NULL, kick_vote_open_utc=NULL, left_at_utc=NULL, updated_at_utc=NOW(6)
         WHERE session_id=? AND user_id=? LIMIT 1`,
        [sessionId, userId]
      );
      await conn.commit();
      await safeLogEvent({
        tableId,
        eventType: EVT.PLAYER_JOINED_SPECTATOR,
        userId,
        payload: { sessionId, seatIndex: null, status: 'left_rejoin' }
      });
      return { ok:true, code:'ALREADY_JOINED', sessionId, seatIndex:null, buyIn:0, potTotal, sessionStatus };
    }

    await conn.query(
      `INSERT INTO session_players
       (session_id, user_id, seat_index, buy_in, status, joined_at_utc, total_score, busted)
       VALUES (?, ?, NULL, 0, 'joined', NOW(6), 0, 0)`,
      [sessionId, userId]
    );

    await conn.commit();
    await safeLogEvent({
      tableId,
      eventType: EVT.PLAYER_JOINED_SPECTATOR,
      userId,
      payload: { sessionId, seatIndex: null, status: 'joined' }
    });
    return { ok:true, code:'JOINED', sessionId, seatIndex:null, buyIn:0, potTotal, sessionStatus };
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    return { ok:false, code:'TX_ERROR', error:String(e && e.message ? e.message : e) };
  } finally {
    try { conn.release(); } catch (_) {}
  }
}

module.exports = { joinTableTx };
