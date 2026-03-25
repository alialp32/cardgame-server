'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const express = require('express');
const mwAuth = require('./mw_auth');
const { findUser, createUser } = require('../db/queries');
const { pool } = require('../db/pool');
const { verifyGoogleIdentity } = require('../shared/google_identity');

const router = express.Router();

function signAppJwt(userId) {
  return jwt.sign({ id: Number(userId) }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

function hasGoogleLinked(user) {
  return !!String(user?.google_sub || '').trim();
}

function hasLocalPassword(user) {
  const provider = String(user?.auth_provider || '').trim().toLowerCase();
  const hasHash = !!String(user?.pass_hash || '').trim();
  if (!hasHash) return false;

  if ((provider === 'google' || provider === 'google_only') && hasGoogleLinked(user)) {
    return false;
  }

  return true;
}

function computeAuthProvider(user) {
  const local = hasLocalPassword(user);
  const google = hasGoogleLinked(user);
  if (local && google) return 'hybrid';
  if (google) return 'google';
  if (local) return 'local';
  return String(user?.auth_provider || 'local');
}

function makeUserPayload(user) {
  const provider = computeAuthProvider(user);
  return {
    id: Number(user.id),
    username: String(user.username),
    email: String(user.email || ''),
    chips_balance: Number(user.chips_balance ?? 0),
    status: String(user.status ?? 'active'),
    is_admin: Number(user.is_admin ?? 0),
    auth_provider: provider,
    google_email: hasGoogleLinked(user) ? String(user.email || '') : '',
    avatar_url: String(user.avatar_url || ''),
  };
}

function normalizeUsernameSeed(seed) {
  let value = String(seed || '').trim().toLowerCase();
  value = value.replace(/[^a-z0-9_]+/g, '');
  if (!value) value = 'player';
  if (value.length < 3) value += '001';
  return value.slice(0, 24);
}

async function loadUserById(userId) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id=? LIMIT 1', [userId]);
  return rows[0] || null;
}

async function usernameExists(username) {
  const [rows] = await pool.query('SELECT 1 FROM users WHERE username=? LIMIT 1', [username]);
  return !!rows[0];
}

async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const [rows] = await pool.query('SELECT * FROM users WHERE LOWER(email)=? LIMIT 1', [normalized]);
  return rows[0] || null;
}

async function findUserByGoogleSub(googleSub) {
  const normalized = String(googleSub || '').trim();
  if (!normalized) return null;
  const [rows] = await pool.query('SELECT * FROM users WHERE google_sub=? LIMIT 1', [normalized]);
  return rows[0] || null;
}

async function generateUniqueUsernameFromEmail(email, fallbackName) {
  const localPart = String(email || '').includes('@')
    ? String(email).split('@')[0]
    : String(fallbackName || 'player');
  const base = normalizeUsernameSeed(localPart || fallbackName || 'player');

  if (!(await usernameExists(base))) return base;

  for (let i = 0; i < 50; i += 1) {
    const candidate = `${base.slice(0, 18)}${Math.floor(1000 + Math.random() * 899999)}`;
    if (!(await usernameExists(candidate))) return candidate;
  }

  return `player${Date.now().toString().slice(-6)}`;
}

async function createGoogleUser(googleUser) {
  const username = await generateUniqueUsernameFromEmail(
    googleUser.email,
    googleUser.givenName || googleUser.name
  );

  try {
    const [result] = await pool.query(
      `
        INSERT INTO users (
          username,
          auth_provider,
          google_sub,
          email,
          email_verified,
          avatar_url,
          pass_hash,
          chips_balance,
          is_admin,
          status,
          last_login_at_utc
        ) VALUES (?, 'google', ?, ?, 1, ?, NULL, 0, 0, 'active', UTC_TIMESTAMP(6))
      `,
      [username, googleUser.googleSub, googleUser.email, googleUser.picture]
    );

    return loadUserById(result.insertId);
  } catch (err) {
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const passHash = await bcrypt.hash(randomPassword, 10);
    const [result] = await pool.query(
      `
        INSERT INTO users (
          username,
          auth_provider,
          google_sub,
          email,
          email_verified,
          avatar_url,
          pass_hash,
          chips_balance,
          is_admin,
          status,
          last_login_at_utc
        ) VALUES (?, 'google', ?, ?, 1, ?, ?, 0, 0, 'active', UTC_TIMESTAMP(6))
      `,
      [username, googleUser.googleSub, googleUser.email, googleUser.picture, passHash]
    );

    return loadUserById(result.insertId);
  }
}

async function attachGoogleToUser(userId, googleUser) {
  const user = await loadUserById(userId);
  if (!user) return null;

  const nextProvider = hasLocalPassword(user) ? 'hybrid' : 'google';
  await pool.query(
    `
      UPDATE users
      SET
        auth_provider=?,
        google_sub=?,
        email=?,
        email_verified=1,
        avatar_url=CASE WHEN COALESCE(avatar_url, '') = '' THEN ? ELSE avatar_url END,
        last_login_at_utc=UTC_TIMESTAMP(6)
      WHERE id=?
    `,
    [nextProvider, googleUser.googleSub, googleUser.email, googleUser.picture, userId]
  );

  return loadUserById(userId);
}

function envFlag(name, fallback) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function googleLoginConflictMessage() {
  return 'Bu e-posta ile bir hesap zaten var. Önce normal giriş yapıp Google hesabını bağlayın.';
}

router.post('/register', async (req, res) => {
  try {
    const { u, p } = req.body || {};
    if (!u || !p) {
      return res.status(400).json({ ok: false, error: 'missing_credentials' });
    }

    const hash = await bcrypt.hash(p, 10);
    const id = await createUser(u, hash);
    return res.json({ ok: true, id });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'register_failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { u, p } = req.body || {};
    if (!u || !p) {
      return res.status(400).json({ ok: false, message: 'Eksik kullanıcı adı veya şifre.' });
    }

    const user = await findUser(u);
    if (!user) {
      return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
    }

    if (!hasLocalPassword(user)) {
      return res.status(400).json({ ok: false, message: 'Bu hesap için yerel şifre tanımlı değil.' });
    }

    const ok = await bcrypt.compare(p, user.pass_hash);
    if (!ok) {
      return res.status(401).json({ ok: false, message: 'Şifre hatalı.' });
    }

    if (String(user.status || 'active') !== 'active') {
      return res.status(403).json({ ok: false, message: 'Kullanıcı aktif değil.' });
    }

    await pool.query('UPDATE users SET last_login_at_utc=UTC_TIMESTAMP(6) WHERE id=?', [user.id]);
    const token = signAppJwt(user.id);
    const freshUser = await loadUserById(user.id);

    return res.json({
      ok: true,
      token,
      user: makeUserPayload(freshUser || user),
      googleEmail: hasGoogleLinked(freshUser || user) ? String((freshUser || user).email || '') : '',
    });
  } catch (err) {
    console.error('[AUTH][LOGIN][ERROR]', err);
    return res.status(500).json({ ok: false, message: 'Login sırasında sunucu hatası oluştu.' });
  }
});

router.post('/google', async (req, res) => {
  try {
    const { idToken, nonce } = req.body || {};
    const googleUser = await verifyGoogleIdentity({ idToken, nonce });

    let user = await findUserByGoogleSub(googleUser.googleSub);
    if (!user) {
      const existingByEmail = await findUserByEmail(googleUser.email);
      if (existingByEmail) {
        if (hasGoogleLinked(existingByEmail) && String(existingByEmail.google_sub || '') !== googleUser.googleSub) {
          return res.status(409).json({
            ok: false,
            error: 'google_email_conflict',
            message: 'Bu e-posta başka bir Google hesabına bağlı.',
          });
        }

        if (!hasGoogleLinked(existingByEmail)) {
          const autoLink = envFlag('GOOGLE_AUTO_LINK_EXISTING_EMAIL', true);
          if (!autoLink) {
            return res.status(409).json({
              ok: false,
              error: 'account_link_required',
              message: googleLoginConflictMessage(),
            });
          }
        }

        user = await attachGoogleToUser(existingByEmail.id, googleUser);
      } else {
        user = await createGoogleUser(googleUser);
      }
    } else {
      user = await attachGoogleToUser(user.id, googleUser);
    }

    if (!user) {
      return res.status(500).json({ ok: false, error: 'user_load_failed', message: 'Kullanıcı yüklenemedi.' });
    }

    if (String(user.status || 'active') !== 'active') {
      return res.status(403).json({ ok: false, error: 'user_not_active', message: 'Kullanıcı aktif değil.' });
    }

    const token = signAppJwt(user.id);
    return res.json({
      ok: true,
      success: true,
      token,
      message: 'Google girişi başarılı.',
      googleEmail: googleUser.email,
      user: makeUserPayload(user),
    });
  } catch (err) {
    console.error('[AUTH][GOOGLE][ERROR]', err);
    return res.status(Number(err.status || 401)).json({
      ok: false,
      error: err.message || 'google_login_failed',
      message: err.publicMessage || 'Google girişi başarısız.',
    });
  }
});

router.get('/methods', mwAuth, async (req, res) => {
  try {
    const user = await loadUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
    }

    const local = hasLocalPassword(user);
    const google = hasGoogleLinked(user);
    const googleEmail = google ? String(user.email || '') : '';

    return res.json({
      ok: true,
      success: true,
      message: 'Giriş yöntemleri alındı.',
      local,
      google,
      googleEmail,
      methods: { local, google, googleEmail },
      user: makeUserPayload(user),
    });
  } catch (err) {
    console.error('[AUTH][METHODS][ERROR]', err);
    return res.status(500).json({ ok: false, message: 'Giriş yöntemleri alınamadı.' });
  }
});

router.post('/google/link', mwAuth, async (req, res) => {
  try {
    const { idToken, nonce } = req.body || {};
    const currentUser = await loadUserById(req.user.id);
    if (!currentUser) {
      return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
    }

    const googleUser = await verifyGoogleIdentity({ idToken, nonce });
    const existingLinked = await findUserByGoogleSub(googleUser.googleSub);
    if (existingLinked && Number(existingLinked.id) !== Number(currentUser.id)) {
      return res.status(409).json({ ok: false, message: 'Bu Google hesabı başka bir kullanıcıya bağlı.' });
    }

    const conflictingByEmail = await findUserByEmail(googleUser.email);
    if (conflictingByEmail && Number(conflictingByEmail.id) !== Number(currentUser.id) && hasGoogleLinked(conflictingByEmail)) {
      return res.status(409).json({ ok: false, message: 'Bu e-posta başka bir Google hesabına bağlı.' });
    }

    const freshUser = await attachGoogleToUser(currentUser.id, googleUser);
    return res.json({
      ok: true,
      success: true,
      message: 'Google hesabı bağlandı.',
      googleEmail: String(freshUser?.email || googleUser.email || ''),
      user: freshUser ? makeUserPayload(freshUser) : null,
    });
  } catch (err) {
    console.error('[AUTH][GOOGLE_LINK][ERROR]', err);
    return res.status(Number(err.status || 400)).json({
      ok: false,
      error: err.message || 'google_link_failed',
      message: err.publicMessage || 'Google hesabı bağlanamadı.',
    });
  }
});

router.post('/google/unlink', mwAuth, async (req, res) => {
  try {
    const currentUser = await loadUserById(req.user.id);
    if (!currentUser) {
      return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
    }

    if (!hasGoogleLinked(currentUser)) {
      return res.status(400).json({ ok: false, message: 'Bu hesapta bağlı Google hesabı yok.' });
    }

    if (!hasLocalPassword(currentUser)) {
      return res.status(400).json({ ok: false, message: 'Önce bu hesap için bir şifre oluşturmalısınız.' });
    }

    await pool.query(
      `
        UPDATE users
        SET google_sub=NULL, auth_provider='local'
        WHERE id=?
      `,
      [currentUser.id]
    );

    const freshUser = await loadUserById(currentUser.id);
    return res.json({
      ok: true,
      success: true,
      message: 'Google bağlantısı kaldırıldı.',
      user: freshUser ? makeUserPayload(freshUser) : null,
    });
  } catch (err) {
    console.error('[AUTH][GOOGLE_UNLINK][ERROR]', err);
    return res.status(500).json({ ok: false, message: 'Google bağlantısı kaldırılamadı.' });
  }
});

router.post('/password/change', mwAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    const nextPassword = String(newPassword || '');
    const currentPwd = String(currentPassword || '');
    const confirmPwd = String(confirmPassword || '');

    if (!nextPassword || nextPassword.length < 3) {
      return res.status(400).json({ ok: false, message: 'Yeni şifre en az 3 karakter olmalıdır.' });
    }

    if (confirmPwd !== nextPassword) {
      return res.status(400).json({ ok: false, message: 'Yeni şifre tekrarı eşleşmiyor.' });
    }

    const currentUser = await loadUserById(req.user.id);
    if (!currentUser) {
      return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
    }

    if (hasLocalPassword(currentUser)) {
      if (!currentPwd) {
        return res.status(400).json({ ok: false, message: 'Mevcut şifre gerekli.' });
      }

      const matches = await bcrypt.compare(currentPwd, currentUser.pass_hash);
      if (!matches) {
        return res.status(401).json({ ok: false, message: 'Mevcut şifre hatalı.' });
      }
    }

    const newHash = await bcrypt.hash(nextPassword, 10);
    await pool.query(
      `
        UPDATE users
        SET
          pass_hash=?,
          auth_provider=CASE
            WHEN COALESCE(google_sub, '') <> '' THEN 'hybrid'
            ELSE 'local'
          END
        WHERE id=?
      `,
      [newHash, currentUser.id]
    );

    const freshUser = await loadUserById(currentUser.id);
    return res.json({
      ok: true,
      success: true,
      message: hasLocalPassword(currentUser) ? 'Şifre değiştirildi.' : 'Şifre oluşturuldu.',
      user: freshUser ? makeUserPayload(freshUser) : null,
    });
  } catch (err) {
    console.error('[AUTH][PASSWORD_CHANGE][ERROR]', err);
    return res.status(500).json({ ok: false, message: 'Şifre işlemi başarısız oldu.' });
  }
});

module.exports = router;
