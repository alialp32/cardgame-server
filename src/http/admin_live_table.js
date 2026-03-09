
'use strict';

/*
Admin Live Table Inspector
Dosya yolu:
cardgame/src/http/admin_live_table.js
*/

const express = require('express');
const router = express.Router();

router.get('/live-table/:tableId', (req, res) => {

    const tableId = Number(req.params.tableId);

    const ws = global.WS_SERVER;

    if (!ws || !ws.tables) {
        return res.json({ ok:false, error:'ws_not_ready' });
    }

    const table = ws.tables.get(tableId);

    if (!table) {
        return res.json({ ok:false, error:'table_not_found' });
    }

    const s = table.state;

    const players = (s.players || []).map(p => ({
        userId:p.userId,
        username:p.username,
        seatIndex:p.seatIndex,
        score:p.score,
        busted:p.busted,
        connected:p.connected,
        handCount:(p.hand || []).length
    }));

    res.json({
        ok:true,
        tableId,
        phase:s.phase,
        step:s.step,
        turnSeatIndex:s.turnSeatIndex,
        handId:s.handId,
        deckCount:(s.deck || []).length,
        discardTop:(s.discard || []).slice(-1)[0] || null,
        players
    });

});

module.exports = router;
