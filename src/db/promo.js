'use strict';

const { pool } = require('./pool');

let ensurePromoSchemaPromise = null;

function normalizePromoCode(code) {
  return String(code || '').trim().toUpperCase();
}

async function ensurePromoSchema() {
  if (!ensurePromoSchemaPromise) {
    ensurePromoSchemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS promo_codes (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          code VARCHAR(64) NOT NULL,
          reward_type VARCHAR(24) NOT NULL DEFAULT 'chips',
          reward_amount INT NOT NULL,
          max_total_uses INT NULL,
          per_user_limit INT NOT NULL DEFAULT 1,
          total_uses INT NOT NULL DEFAULT 0,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          starts_at_utc DATETIME(6) NULL,
          expires_at_utc DATETIME(6) NULL,
          created_by_user_id BIGINT UNSIGNED NULL,
          created_at_utc DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          last_claim_at_utc DATETIME(6) NULL,
          PRIMARY KEY (id),
          UNIQUE KEY uq_promo_codes_code (code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS promo_code_claims (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          promo_code_id BIGINT UNSIGNED NOT NULL,
          user_id BIGINT UNSIGNED NOT NULL,
          claimed_reward_amount INT NOT NULL,
          claimed_at_utc DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
          PRIMARY KEY (id),
          KEY idx_promo_claims_promo_user (promo_code_id, user_id),
          KEY idx_promo_claims_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    })().catch((err) => {
      ensurePromoSchemaPromise = null;
      throw err;
    });
  }

  return ensurePromoSchemaPromise;
}

async function redeemPromoCode({ userId, code }) {
  await ensurePromoSchema();

  const normalizedCode = normalizePromoCode(code);
  if (!normalizedCode) {
    return { ok: false, status: 400, message: 'Promosyon kodu boş olamaz.' };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [promoRows] = await conn.query(
      `SELECT *
         FROM promo_codes
        WHERE code = ?
        LIMIT 1
        FOR UPDATE`,
      [normalizedCode]
    );

    const promo = promoRows[0];
    if (!promo) {
      await conn.rollback();
      return { ok: false, status: 404, message: 'Promosyon kodu bulunamadı.' };
    }

    if (!Number(promo.is_active || 0)) {
      await conn.rollback();
      return { ok: false, status: 409, message: 'Bu promosyon kodu aktif değil.' };
    }

    if (String(promo.reward_type || 'chips') !== 'chips') {
      await conn.rollback();
      return { ok: false, status: 500, message: 'Bu promosyon kodunun ödül tipi desteklenmiyor.' };
    }

    const now = Date.now();
    if (promo.starts_at_utc && new Date(promo.starts_at_utc).getTime() > now) {
      await conn.rollback();
      return { ok: false, status: 409, message: 'Bu promosyon kodu henüz aktif değil.' };
    }

    if (promo.expires_at_utc && new Date(promo.expires_at_utc).getTime() < now) {
      await conn.rollback();
      return { ok: false, status: 409, message: 'Bu promosyon kodunun süresi dolmuş.' };
    }

    const maxTotalUses = promo.max_total_uses == null ? null : Number(promo.max_total_uses);
    if (maxTotalUses != null && Number(promo.total_uses || 0) >= maxTotalUses) {
      await conn.rollback();
      return { ok: false, status: 409, message: 'Bu promosyon kodunun kullanım limiti dolmuş.' };
    }

    const perUserLimit = Math.max(1, Number(promo.per_user_limit || 1));
    const [[claimCountRow]] = await conn.query(
      'SELECT COUNT(*) AS claim_count FROM promo_code_claims WHERE promo_code_id=? AND user_id=?',
      [promo.id, userId]
    );
    const claimCount = Number(claimCountRow && claimCountRow.claim_count ? claimCountRow.claim_count : 0);
    if (claimCount >= perUserLimit) {
      await conn.rollback();
      return {
        ok: false,
        status: 409,
        message: perUserLimit <= 1
          ? 'Bu promosyon kodunu daha önce kullandın.'
          : 'Bu promosyon kodu için kullanıcı limiti dolmuş.'
      };
    }

    const rewardAmount = Number(promo.reward_amount || 0);
    if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
      await conn.rollback();
      return { ok: false, status: 500, message: 'Promosyon ödül miktarı geçersiz.' };
    }

    const [userUpdate] = await conn.query(
      'UPDATE users SET chips_balance = chips_balance + ? WHERE id = ? LIMIT 1',
      [rewardAmount, userId]
    );
    if (!userUpdate.affectedRows) {
      await conn.rollback();
      return { ok: false, status: 404, message: 'Kullanıcı bulunamadı.' };
    }

    await conn.query(
      `INSERT INTO promo_code_claims (
         promo_code_id,
         user_id,
         claimed_reward_amount,
         claimed_at_utc
       ) VALUES (?, ?, ?, UTC_TIMESTAMP(6))`,
      [promo.id, userId, rewardAmount]
    );

    await conn.query(
      `UPDATE promo_codes
          SET total_uses = total_uses + 1,
              last_claim_at_utc = UTC_TIMESTAMP(6)
        WHERE id = ?`,
      [promo.id]
    );

    const [[balanceRow]] = await conn.query('SELECT chips_balance FROM users WHERE id=? LIMIT 1', [userId]);
    await conn.commit();

    return {
      ok: true,
      status: 200,
      message: `${rewardAmount.toLocaleString('tr-TR')} çip hesabına yüklendi.`,
      chipsAdded: rewardAmount,
      newBalance: Number(balanceRow && balanceRow.chips_balance ? balanceRow.chips_balance : 0)
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { ensurePromoSchema, redeemPromoCode, normalizePromoCode };
