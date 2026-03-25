'use strict';

const { pool } = require('./pool');
const { getProductPurchase, getExpectedPackageName } = require('../shared/google_play');

let ensureStoreSchemaPromise = null;

const DEFAULT_STORE_PACKAGES = [
  {
    id: 'pkg_chips_100',
    productId: 'chips_100',
    title: '100 Çip',
    chips: 100,
    priceTl: 0,
    priceText: 'Google Play fiyatı',
    badge: 'Başlangıç',
    note: 'Tek kullanımlık çip paketi',
  },
  {
    id: 'pkg_chips_500',
    productId: 'chips_500',
    title: '500 Çip',
    chips: 500,
    priceTl: 0,
    priceText: 'Google Play fiyatı',
    badge: 'Popüler',
    note: 'Tek kullanımlık çip paketi',
  },
  {
    id: 'pkg_chips_2500',
    productId: 'chips_2500',
    title: '2500 Çip',
    chips: 2500,
    priceTl: 0,
    priceText: 'Google Play fiyatı',
    badge: 'Avantaj',
    note: 'Tek kullanımlık çip paketi',
  },
  {
    id: 'pkg_chips_10000',
    productId: 'chips_10000',
    title: '10000 Çip',
    chips: 10000,
    priceTl: 0,
    priceText: 'Google Play fiyatı',
    badge: 'En İyi Teklif',
    note: 'Tek kullanımlık çip paketi',
  },
];

function normalizeStorePackage(item, index) {
  const chips = Number(item && item.chips);
  const productId = String(item && item.productId ? item.productId : '').trim();
  if (!productId) throw new Error(`STORE_PACKAGES_JSON[${index}].productId zorunlu.`);
  if (!Number.isFinite(chips) || chips <= 0) {
    throw new Error(`STORE_PACKAGES_JSON[${index}].chips geçerli bir sayı olmalı.`);
  }

  return {
    id: String(item && item.id ? item.id : `pkg_${productId}`).trim(),
    productId,
    title: String(item && item.title ? item.title : `${chips} Çip`).trim(),
    chips,
    priceTl: Number.isFinite(Number(item && item.priceTl)) ? Number(item.priceTl) : 0,
    priceText: String(item && item.priceText ? item.priceText : 'Google Play fiyatı').trim(),
    badge: String(item && item.badge ? item.badge : '').trim() || null,
    note: String(item && item.note ? item.note : '').trim() || null,
  };
}

function getStoreCatalog() {
  const raw = String(process.env.STORE_PACKAGES_JSON || '').trim();
  if (!raw) return DEFAULT_STORE_PACKAGES.map((item) => ({ ...item }));

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('STORE_PACKAGES_JSON boş bir dizi olamaz.');
  }

  return parsed.map(normalizeStorePackage);
}

function resolveStorePackage(productId) {
  const normalized = String(productId || '').trim();
  if (!normalized) return null;
  return getStoreCatalog().find((item) => item.productId === normalized) || null;
}

async function ensureStoreSchema() {
  if (!ensureStoreSchemaPromise) {
    ensureStoreSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS google_play_purchases (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          purchase_token VARCHAR(255) NOT NULL,
          user_id BIGINT UNSIGNED NOT NULL,
          package_name VARCHAR(255) NOT NULL,
          product_id VARCHAR(128) NOT NULL,
          order_id VARCHAR(255) NULL,
          purchase_time_ms BIGINT UNSIGNED NULL,
          purchase_state VARCHAR(24) NOT NULL DEFAULT 'PENDING',
          granted_chips INT NOT NULL DEFAULT 0,
          balance_after BIGINT NOT NULL DEFAULT 0,
          google_order_id VARCHAR(255) NULL,
          google_purchase_state VARCHAR(32) NULL,
          google_consumption_state INT NULL,
          google_acknowledgement_state INT NULL,
          google_purchase_type INT NULL,
          raw_response_json LONGTEXT NULL,
          created_at_utc DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          updated_at_utc DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
          PRIMARY KEY (id),
          UNIQUE KEY uq_google_play_purchases_token (purchase_token),
          KEY idx_google_play_purchases_user_id (user_id),
          KEY idx_google_play_purchases_order_id (order_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    })().catch((err) => {
      ensureStoreSchemaPromise = null;
      throw err;
    });
  }

  return ensureStoreSchemaPromise;
}

async function getPurchaseRecordByToken(purchaseToken) {
  const [rows] = await pool.query(
    'SELECT * FROM google_play_purchases WHERE purchase_token=? LIMIT 1',
    [purchaseToken]
  );
  return rows[0] || null;
}

async function getUserChipBalance(conn, userId) {
  const [[row]] = await conn.query('SELECT chips_balance FROM users WHERE id=? LIMIT 1', [userId]);
  return Number(row && row.chips_balance ? row.chips_balance : 0);
}

function purchaseStateToText(purchaseState) {
  if (purchaseState === 0) return 'PURCHASED';
  if (purchaseState === 1) return 'CANCELLED';
  if (purchaseState === 2) return 'PENDING';
  return 'UNKNOWN';
}

async function verifyAndGrantGooglePlayPurchase({
  userId,
  packageName,
  productId,
  purchaseToken,
  orderId,
  purchaseTime,
}) {
  await ensureStoreSchema();

  const normalizedToken = String(purchaseToken || '').trim();
  const normalizedProductId = String(productId || '').trim();
  const normalizedPackageName = getExpectedPackageName(packageName);

  if (!normalizedToken) {
    return { ok: false, status: 400, message: 'purchaseToken zorunlu.' };
  }
  if (!normalizedProductId) {
    return { ok: false, status: 400, message: 'productId zorunlu.' };
  }
  if (!normalizedPackageName) {
    return { ok: false, status: 400, message: 'packageName zorunlu.' };
  }

  const storePackage = resolveStorePackage(normalizedProductId);
  if (!storePackage) {
    return { ok: false, status: 400, message: 'Bilinmeyen ürün kimliği gönderildi.' };
  }

  const existing = await getPurchaseRecordByToken(normalizedToken);
  if (existing) {
    if (Number(existing.user_id) !== Number(userId)) {
      return { ok: false, status: 409, message: 'Bu satın alma başka bir kullanıcıya ait.' };
    }

    if (String(existing.purchase_state || '').toUpperCase() === 'GRANTED') {
      const conn = await pool.getConnection();
      try {
        const currentBalance = await getUserChipBalance(conn, userId);
        return {
          ok: true,
          success: true,
          status: 200,
          message: 'Satın alma daha önce işlendi.',
          chipsAdded: Number(existing.granted_chips || 0),
          newBalance: currentBalance,
          ticketCode: String(existing.purchase_token || ''),
          alreadyProcessed: true,
        };
      } finally {
        conn.release();
      }
    }
  }

  let googlePurchase;
  try {
    googlePurchase = await getProductPurchase({
      packageName: normalizedPackageName,
      productId: normalizedProductId,
      purchaseToken: normalizedToken,
    });
  } catch (err) {
    const publicMessage = err.publicMessage || err.message || 'Google Play doğrulaması başarısız.';
    const status = Number(err.status || 502) || 502;
    return {
      ok: false,
      status,
      message: status === 404 ? 'Google Play satın alma kaydı bulunamadı.' : publicMessage,
      error: err.message || 'google_play_verify_failed',
      details: err.responseBody || null,
    };
  }

  if (googlePurchase.productId && googlePurchase.productId !== normalizedProductId) {
    return { ok: false, status: 409, message: 'Google Play ürün kimliği uyuşmuyor.' };
  }

  if (googlePurchase.orderId && orderId && String(orderId).trim() !== googlePurchase.orderId) {
    return { ok: false, status: 409, message: 'Sipariş numarası Google Play kaydıyla uyuşmuyor.' };
  }

  if (googlePurchase.purchaseState === 2) {
    return { ok: false, status: 409, message: 'Satın alma henüz beklemede. Ödeme tamamlanınca tekrar dene.' };
  }

  if (googlePurchase.purchaseState === 1) {
    return { ok: false, status: 409, message: 'Satın alma iptal edilmiş görünüyor.' };
  }

  if (googlePurchase.purchaseState !== 0) {
    return { ok: false, status: 409, message: 'Satın alma durumu geçerli değil.' };
  }

  if (googlePurchase.consumptionState === 1 && !existing) {
    return {
      ok: false,
      status: 409,
      message: 'Satın alma daha önce tüketilmiş görünüyor. Tekrar çip yüklenmedi.',
    };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [lockedRows] = await conn.query(
      'SELECT * FROM google_play_purchases WHERE purchase_token=? LIMIT 1 FOR UPDATE',
      [normalizedToken]
    );
    const locked = lockedRows[0] || null;

    if (locked) {
      if (Number(locked.user_id) !== Number(userId)) {
        await conn.rollback();
        return { ok: false, status: 409, message: 'Bu satın alma başka bir kullanıcıya ait.' };
      }

      if (String(locked.purchase_state || '').toUpperCase() === 'GRANTED') {
        const currentBalance = await getUserChipBalance(conn, userId);
        await conn.commit();
        return {
          ok: true,
          success: true,
          status: 200,
          message: 'Satın alma daha önce işlendi.',
          chipsAdded: Number(locked.granted_chips || 0),
          newBalance: currentBalance,
          ticketCode: String(locked.purchase_token || ''),
          alreadyProcessed: true,
        };
      }
    } else {
      await conn.query(
        `
          INSERT INTO google_play_purchases (
            purchase_token,
            user_id,
            package_name,
            product_id,
            order_id,
            purchase_time_ms,
            purchase_state,
            google_order_id,
            google_purchase_state,
            google_consumption_state,
            google_acknowledgement_state,
            google_purchase_type,
            raw_response_json
          ) VALUES (?, ?, ?, ?, ?, ?, 'VERIFYING', ?, ?, ?, ?, ?, ?)
        `,
        [
          normalizedToken,
          userId,
          normalizedPackageName,
          normalizedProductId,
          orderId ? String(orderId).trim() : null,
          Number(purchaseTime || googlePurchase.purchaseTimeMillis || 0) || null,
          googlePurchase.orderId,
          purchaseStateToText(googlePurchase.purchaseState),
          Number.isFinite(googlePurchase.consumptionState) ? googlePurchase.consumptionState : null,
          Number.isFinite(googlePurchase.acknowledgementState) ? googlePurchase.acknowledgementState : null,
          Number.isFinite(googlePurchase.purchaseType) ? googlePurchase.purchaseType : null,
          JSON.stringify(googlePurchase.raw || {}),
        ]
      );
    }

    const grantedChips = Number(storePackage.chips || 0);
    const [userUpdate] = await conn.query(
      'UPDATE users SET chips_balance = chips_balance + ? WHERE id=? LIMIT 1',
      [grantedChips, userId]
    );

    if (!userUpdate.affectedRows) {
      await conn.rollback();
      return { ok: false, status: 404, message: 'Kullanıcı bulunamadı.' };
    }

    const newBalance = await getUserChipBalance(conn, userId);
    await conn.query(
      `
        UPDATE google_play_purchases
        SET
          user_id=?,
          package_name=?,
          product_id=?,
          order_id=?,
          purchase_time_ms=?,
          purchase_state='GRANTED',
          granted_chips=?,
          balance_after=?,
          google_order_id=?,
          google_purchase_state=?,
          google_consumption_state=?,
          google_acknowledgement_state=?,
          google_purchase_type=?,
          raw_response_json=?
        WHERE purchase_token=?
      `,
      [
        userId,
        normalizedPackageName,
        normalizedProductId,
        orderId ? String(orderId).trim() : null,
        Number(purchaseTime || googlePurchase.purchaseTimeMillis || 0) || null,
        grantedChips,
        newBalance,
        googlePurchase.orderId,
        purchaseStateToText(googlePurchase.purchaseState),
        Number.isFinite(googlePurchase.consumptionState) ? googlePurchase.consumptionState : null,
        Number.isFinite(googlePurchase.acknowledgementState) ? googlePurchase.acknowledgementState : null,
        Number.isFinite(googlePurchase.purchaseType) ? googlePurchase.purchaseType : null,
        JSON.stringify(googlePurchase.raw || {}),
        normalizedToken,
      ]
    );

    await conn.commit();

    return {
      ok: true,
      success: true,
      status: 200,
      message: `${grantedChips.toLocaleString('tr-TR')} çip hesabına yüklendi.`,
      chipsAdded: grantedChips,
      newBalance,
      ticketCode: normalizedToken,
      shouldConsume: true,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  ensureStoreSchema,
  getStoreCatalog,
  resolveStorePackage,
  verifyAndGrantGooglePlayPurchase,
};
