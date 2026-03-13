'use strict';
const express=require('express');
const {grantChips}=require('../db/queries');
const auth=require('./mw_auth');
const { getWsAdminApi } = require('../ws/control');
const { pool } = require('../db/pool');
const router=express.Router();

router.post('/grant',auth,async(req,res)=>{
 if(!req.user.is_admin) return res.status(403).json({ok:false,error:'admin only'});
 const {userId,amount}=req.body;
 await grantChips(userId,amount);
 res.json({ok:true});
});


/**
 * Update table config (fee_pct, min_players_to_start).
 * Admin only.
 */
router.post('/tables/:id/update',auth,async(req,res)=>{
 if(!req.user.is_admin) return res.status(403).json({ok:false,error:'admin only'});

 const tableId = Number(req.params.id);
 if(!Number.isFinite(tableId) || tableId<=0) return res.status(400).json({ok:false,error:'bad table id'});

 const feePct = Number((req.body||{}).fee_pct);
 const minStart = Number((req.body||{}).min_start);

 if(!Number.isFinite(feePct) || feePct<0 || feePct>100) return res.status(400).json({ok:false,error:'fee_pct must be 0..100'});
 if(!Number.isFinite(minStart) || minStart<2 || minStart>6) return res.status(400).json({ok:false,error:'min_start must be 2..6'});

 const { pool } = require('../db/pool');
 await pool.query('UPDATE tables SET fee_pct=?, min_players_to_start=? WHERE id=? LIMIT 1',[feePct, Math.trunc(minStart), tableId]);
 res.json({ok:true});
});


/**
 * Reset table: refund + close current session (waiting/active).
 * Admin only.
 * POST /admin/tables/:id/reset_refund
 */
router.post('/tables/:id/reset_refund',auth,async(req,res)=>{
  if(!req.user.is_admin) return res.status(403).json({ok:false,error:'admin only'});
  const tableId = Number(req.params.id);
  if(!Number.isFinite(tableId) || tableId<=0) return res.status(400).json({ok:false,error:'bad table id'});
  const { resetRefundTableTx } = require('../db/admin_actions');
  const r = await resetRefundTableTx({ tableId, adminUserId: req.user.id });
  if (!r || !r.ok) return res.status(400).json(r || {ok:false,error:'reset failed'});
  res.json(r);
});


/**
 * Close table (prevents new joins). Does not force-finish active sessions.
 * POST /admin/tables/:id/close
 */
router.post('/tables/:id/close',auth,async(req,res)=>{
  if(!req.user.is_admin) return res.status(403).json({ok:false,error:'admin only'});
  const tableId = Number(req.params.id);
  if(!Number.isFinite(tableId) || tableId<=0) return res.status(400).json({ok:false,error:'bad table id'});
  await pool.query('UPDATE tables SET status="closed" WHERE id=? LIMIT 1',[tableId]);
  res.json({ok:true, tableId});
});

/**
 * Kick player from a session (admin only, no vote required).
 * POST /admin/sessions/:id/kick_player  { userId:number, reason?:string }
 */
router.post('/sessions/:id/kick_player',auth,async(req,res)=>{
  if(!req.user.is_admin) return res.status(403).json({ok:false,error:'admin only'});
  const sessionId = Number(req.params.id);
  const userId = Number((req.body||{}).userId);
  const reason = (typeof (req.body||{}).reason === 'string') ? String(req.body.reason).slice(0,64) : 'admin_kick';
  if(!Number.isFinite(sessionId) || sessionId<=0) return res.status(400).json({ok:false,error:'bad session id'});
  if(!Number.isFinite(userId) || userId<=0) return res.status(400).json({ok:false,error:'bad userId'});

  // Lookup tableId for broadcast
  const [sRows] = await pool.query('SELECT table_id AS tableId FROM table_sessions WHERE id=? LIMIT 1',[sessionId]);
  const tableId = sRows && sRows[0] ? Number(sRows[0].tableId) : null;

  const api = getWsAdminApi();
  if (api && typeof api.kickPlayer === 'function' && tableId) {
    await api.kickPlayer({ sessionId, tableId, targetUserId: userId, byUserId: req.user.id, reason });
    return res.json({ ok:true, sessionId, tableId, userId, via:'ws' });
  }

  // Fallback: DB-only kick (no WS broadcast)
  const { kickPlayerTx } = require('../db/admin_actions');
  const r = await kickPlayerTx({ sessionId, userId, reason });
  if (!r || !r.ok) return res.status(400).json(r || {ok:false,error:'kick failed'});
  res.json({ ok:true, sessionId, userId, via:'db' });
});



router.get('/table-runs',auth,async(req,res)=>{
  if(!req.user.is_admin) return res.status(403).json({ok:false,error:'admin only'});
  try{
    const tableId = req.query.tableId ? Number(req.query.tableId) : null;
    const status = typeof req.query.status === 'string' ? String(req.query.status).trim() : '';
    const params = [];
    const where = [];
    if (Number.isFinite(tableId) && tableId > 0) {
      where.push('gr.table_id=?');
      params.push(tableId);
    }
    if (status === 'active' || status === 'finished') {
      where.push('gr.status=?');
      params.push(status);
    }
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const [rows] = await pool.query(
      `SELECT
         gr.id,
         gr.table_id,
         gr.table_name,
         gr.started_at_utc,
         gr.ended_at_utc,
         gr.status,
         gr.winner_user_id,
         gr.winner_username,
         gr.pot_total,
         gr.fee_total,
         gr.prize_total,
         (
           SELECT COUNT(*)
           FROM game_run_events gre
           WHERE gre.game_run_id=gr.id
         ) AS event_count,
         (
           SELECT MAX(gre2.created_at_utc)
           FROM game_run_events gre2
           WHERE gre2.game_run_id=gr.id
         ) AS last_activity_utc
       FROM game_runs gr
       ${whereSql}
       ORDER BY gr.id DESC
       LIMIT 500`,
      params
    );
    res.json({ok:true, rows});
  }catch(err){
    console.error('GET /admin/table-runs error:', err);
    res.status(500).json({ok:false,error:'table runs fetch failed'});
  }
});

router.get('/table-runs/:id',auth,async(req,res)=>{
  if(!req.user.is_admin) return res.status(403).json({ok:false,error:'admin only'});
  try{
    const runId = Number(req.params.id);
    if(!Number.isFinite(runId) || runId<=0) return res.status(400).json({ok:false,error:'bad run id'});

    const [runRows] = await pool.query('SELECT * FROM game_runs WHERE id=? LIMIT 1',[runId]);
    const run = runRows && runRows[0] ? runRows[0] : null;
    if(!run) return res.status(404).json({ok:false,error:'run not found'});

    const where = ['game_run_id=?'];
    const params = [runId];

    if (typeof req.query.eventType === 'string' && req.query.eventType.trim()) {
      where.push('event_type=?');
      params.push(req.query.eventType.trim());
    }
    if (typeof req.query.username === 'string' && req.query.username.trim()) {
      where.push('username=?');
      params.push(req.query.username.trim());
    }
    if (req.query.handNo !== undefined && req.query.handNo !== null && String(req.query.handNo).trim() !== '') {
      const handNo = Number(req.query.handNo);
      if (Number.isFinite(handNo)) {
        where.push('hand_no=?');
        params.push(handNo);
      }
    }

    const [events] = await pool.query(
      `SELECT id, game_run_id, hand_no, hand_id, event_type, user_id, username, payload_json, created_at_utc
       FROM game_run_events
       WHERE ${where.join(' AND ')}
       ORDER BY id DESC
       LIMIT 200`,
      params
    );

    const [players] = await pool.query(
      `SELECT user_id, username, COUNT(*) AS event_count,
              MIN(created_at_utc) AS first_seen_utc,
              MAX(created_at_utc) AS last_seen_utc
       FROM game_run_events
       WHERE game_run_id=? AND user_id IS NOT NULL
       GROUP BY user_id, username
       ORDER BY username ASC`,
      [runId]
    );

    const [hands] = await pool.query(
      `SELECT hand_no,
              MIN(created_at_utc) AS started_at_utc,
              MAX(created_at_utc) AS ended_at_utc,
              COUNT(*) AS event_count
       FROM game_run_events
       WHERE game_run_id=? AND hand_no IS NOT NULL
       GROUP BY hand_no
       ORDER BY hand_no ASC`,
      [runId]
    );

    res.json({ok:true, run, events, players, hands});
  }catch(err){
    console.error('GET /admin/table-runs/:id error:', err);
    res.status(500).json({ok:false,error:'table run detail fetch failed'});
  }
});

module.exports=router;
