'use strict';

const express = require('express');
const authMw = require('./mw_auth');
const { redeemPromoCode, ensurePromoSchema } = require('../db/promo');

const router = express.Router();

router.post('/promo/redeem', authMw, async (req, res) => {
  try {
    const result = await redeemPromoCode({
      userId: Number(req.user.id),
      code: req.body && req.body.code
    });
    return res.status(result.status || 200).json(result);
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    console.error('[APP][PROMO][REDEEM][ERROR]', err);
    if (/doesn't exist|does not exist|unknown table|no such table/i.test(message)) {
      return res.status(503).json({ ok: false, message: 'Promosyon tabloları henüz hazır değil.' });
    }
    return res.status(500).json({ ok: false, message: 'Promosyon kodu kullanılırken sunucu hatası oluştu.' });
  }
});

router.post('/promo/bootstrap', authMw, async (req, res) => {
  try {
    if (!Number(req.user.is_admin || 0)) {
      return res.status(403).json({ ok: false, message: 'Yalnızca admin erişebilir.' });
    }
    await ensurePromoSchema();
    return res.status(200).json({ ok: true, message: 'Promosyon tabloları hazır.' });
  } catch (err) {
    console.error('[APP][PROMO][BOOTSTRAP][ERROR]', err);
    return res.status(500).json({ ok: false, message: 'Promosyon tabloları oluşturulamadı.' });
  }
});

module.exports = router;
