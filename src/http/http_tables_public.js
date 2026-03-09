'use strict';
/**
 * Tables API
 * - GET  /tables              -> list open tables
 * - POST /tables/:id/join     -> join table session (JWT required)
 */
const express = require('express');
const { pool } = require('../db/pool');
const auth = require('./mw_auth');
const { joinTableTx } = require('../db/join_table');

const router = express.Router();

router.get('/', async (req, res) => {
  const [r] = await pool.query(
    'SELECT id, name, min_buy_in, fee_pct, min_players_to_start, max_players, status FROM tables WHERE status="open" ORDER BY min_buy_in ASC, id ASC'
  );
  res.json({ ok: true, tables: r });
});

router.post('/:id/join', auth, async (req, res) => {
  const tableId = Number(req.params.id);
  if (!Number.isFinite(tableId) || tableId <= 0) {
    return res.status(400).json({ ok: false, error: 'bad table id' });
  }

  const result = await joinTableTx({ userId: req.user.id, tableId });
  if (!result.ok) {
    const map = {
      USER_NOT_FOUND: [401, 'user not found'],
      TABLE_NOT_FOUND: [404, 'table not found'],
      TABLE_CLOSED: [409, 'table closed'],
      BAD_TABLE_BUYIN: [500, 'bad table config'],
      INSUFFICIENT_CHIPS: [409, 'insufficient chips'],
      TABLE_FULL: [409, 'table full'],
      TX_ERROR: [500, result.error || 'tx error'],
    };
    const pair = map[result.code] || [500, 'unknown error'];
    return res.status(pair[0]).json({ ok: false, error: pair[1], code: result.code });
  }

  return res.json({
    ok: true,
    sessionId: result.sessionId,
    seatIndex: result.seatIndex,
    buyIn: result.buyIn,
    potTotal: result.potTotal ?? null,
    sessionStatus: result.sessionStatus ?? null,
    note: result.code === 'ALREADY_JOINED' ? 'already_joined' : undefined,
  });
});

module.exports = router;
