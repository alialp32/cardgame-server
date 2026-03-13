
/*
Admin için canlı masa state endpoint
Path: cardgame/src/http/admin_state.js
*/

const express = require("express")
const router = express.Router()

router.get("/admin/table_state/:tableId", (req, res) => {

    const tableId = Number(req.params.tableId)

    const tableManager = global.TABLE_MANAGER
    if (!tableManager || !tableManager.tables) {
        return res.json({ ok:false, error:"table_manager_missing" })
    }

    const table = tableManager.tables.get(tableId)

    if (!table) {
        return res.json({ ok:false, error:"table_not_found" })
    }

    const s = table.state

    const players = (s.players || []).map(p => ({
        userId: p.userId,
        username: p.username,
        seatIndex: p.seatIndex,
        score: p.score,
        busted: p.busted,
        connected: p.connected,
        handCount: (p.hand && p.hand.length) ? p.hand.length : 0
    }))

    res.json({
        ok:true,
        tableId: tableId,
        phase: s.phase,
        step: s.step,
        turnSeatIndex: s.turnSeatIndex,
        handId: s.handId,
        deckCount: (s.deck && s.deck.length) ? s.deck.length : 0,
        discardTop: (s.discard && s.discard.length) ? s.discard[s.discard.length-1] : null,
        players: players
    })
})

module.exports = router
