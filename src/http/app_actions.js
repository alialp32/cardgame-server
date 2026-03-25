'use strict';

const express = require('express');
const authMw = require('./mw_auth');
const { redeemPromoCode, ensurePromoSchema } = require('../db/promo');
const {
  ensureStoreSchema,
  getStoreCatalog,
  verifyAndGrantGooglePlayPurchase,
} = require('../db/store');

const router = express.Router();

router.get('/store', authMw, async (req, res) => {
  try {
    await ensureStoreSchema();
    const packages = getStoreCatalog();
    return res.status(200).json({
      ok: true,
      success: true,
      chipValueTl: 1,
      packages,
      message: packages.length ? 'Paketler hazır.' : 'Satışta paket bulunamadı.',
    });
  } catch (err) {
    console.error('[APP][STORE][CATALOG][ERROR]', err);
    return res.status(500).json({ ok: false, message: 'Market kataloğu hazırlanamadı.' });
  }
});

router.post('/store/google/verify', authMw, async (req, res) => {
  try {
    console.log('[STORE_VERIFY] incoming', {
      userId: Number(req.user && req.user.id),
      productId: req.body && req.body.productId,
      packageName: req.body && req.body.packageName,
      envPackageName: process.env.GOOGLE_PLAY_PACKAGE_NAME || null,
      purchaseTokenTail: String((req.body && req.body.purchaseToken) || '').slice(-10),
      orderId: req.body && req.body.orderId ? String(req.body.orderId) : null,
    });

    const result = await verifyAndGrantGooglePlayPurchase({
      userId: Number(req.user.id),
      packageName: req.body && req.body.packageName,
      productId: req.body && req.body.productId,
      purchaseToken: req.body && req.body.purchaseToken,
      orderId: req.body && req.body.orderId,
      purchaseTime: req.body && req.body.purchaseTime,
    });

    console.log('[STORE_VERIFY] result', {
      userId: Number(req.user && req.user.id),
      ok: !!result.ok,
      status: Number(result.status || 200),
      message: result.message || null,
      error: result.error || null,
      details: result.details || null,
      alreadyProcessed: !!result.alreadyProcessed,
      shouldConsume: !!result.shouldConsume,
    });

    return res.status(Number(result.status || 200)).json(result);
  } catch (err) {
    console.error('[APP][STORE][VERIFY][ERROR]', {
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
      status: err && err.status ? err.status : null,
      responseBody: err && err.responseBody ? err.responseBody : null,
    });
    return res.status(500).json({
      ok: false,
      message: 'Google Play satın alma doğrulaması sırasında sunucu hatası oluştu.',
    });
  }
});

router.post('/promo/redeem', authMw, async (req, res) => {
  try {
    const result = await redeemPromoCode({
      userId: Number(req.user.id),
      code: req.body && req.body.code,
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

    await Promise.all([ensurePromoSchema(), ensureStoreSchema()]);
    return res.status(200).json({ ok: true, message: 'Promosyon ve market tabloları hazır.' });
  } catch (err) {
    console.error('[APP][PROMO][BOOTSTRAP][ERROR]', err);
    return res.status(500).json({ ok: false, message: 'Promosyon tabloları oluşturulamadı.' });
  }
});

module.exports = router;
