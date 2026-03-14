'use strict';

const https = require('https');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const express = require('express');
const mwAuth = require('./mw_auth');
const { findUser, createUser } = require('../db/queries');
const { pool } = require('../db/pool');

const router = express.Router();

function signAppJwt(userId) {
  return jwt.sign(
    { id: Number(userId) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
}

function hasLocalPassword(user) {
  return !!String(user?.pass_hash || '').trim();
}

function hasGoogleLinked(user) {
  return !!String(user?.google_sub || '').trim();
}

function computeAuthProvider(user) {
  if (hasLocalPassword(user)) return 'local';
  if (hasGoogleLinked(user)) return 'google';
  return String(user?.auth_provider || 'local');
}

function makeUserPayload(user) {
  return {
    id: Number(user.id),
    username: String(user.username),
    email: String(user.email || ''),
    chips_balance: Number(user.chips_balance ?? 0),
    status: String(user.status ?? 'active'),
    is_admin: Number(user.is_admin ?? 0),
    auth_provider: computeAuthProvider(user),
    avatar_url: String(user.avatar_url || '')
  };
}

function normalizeUsernameSeed(seed) {
  let v = String(seed || '').trim().toLowerCase();
  v = v.replace(/[^a-z0-9_]+/g, '');
  if (!v) v = 'player';
  if (v.length < 3) v += '001';
  return v.slice(0, 24);
}

async function usernameExists(username) {
  const [rows] = await pool.query(
    'SELECT 1 FROM users WHERE username=? LIMIT 1',
    [username]
  );
  return !!rows[0];
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

function verifyGoogleIdToken(idToken) {
  return new Promise((resolve, reject) => {
    const token = String(idToken || '').trim();
    if (!token) {
      reject(new Error('missing_id_token'));
      return;
    }

    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`;

    https.get(url, (resp) => {
      let raw = '';
      resp.setEncoding('utf8');
      resp.on('data', (chunk) => { raw += chunk; });
      resp.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(raw || '{}');
        } catch {
          reject(new Error('invalid_google_response'));
          return;
        }

        if (resp.statusCode !== 200 || payload.error) {
          reject(new Error(payload.error_description || payload.error || 'google_token_invalid'));
          return;
        }

        const aud = String(payload.aud || '');
        const iss = String(payload.iss || '');
        const exp = Number(payload.exp || 0);
        const emailVerified = String(payload.email_verified || '').toLowerCase() === 'true';
        const expectedAud = String(process.env.GOOGLE_WEB_CLIENT_ID || '').trim();

        if (!expectedAud) {
          reject(new Error('google_client_id_not_configured'));
          return;
        }
        if (aud !== expectedAud) {
          reject(new Error('audience_mismatch'));
          return;
        }
        if (!['accounts.google.com', 'https://accounts.google.com'].includes(iss)) {
          reject(new Error('issuer_invalid'));
          return;
        }
        if (exp > 0 && exp < Math.floor(Date.now() / 1000)) {
          reject(new Error('token_expired'));
          return;
        }
        if (!emailVerified) {
          reject(new Error('email_not_verified'));
          return;
        }

        resolve({
          google_sub: String(payload.sub || ''),
          email: String(payload.email || '').trim().toLowerCase(),
          name: String(payload.name || '').trim(),
          given_name: String(payload.given_name || '').trim(),
          family_name: String(payload.family_name || '').trim(),
          picture: String(payload.picture || '').trim()
        });
      });
    }).on('error', (err) => reject(err));
  });
}

async function loadUserById(userId) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id=? LIMIT 1', [userId]);
  return rows[0] || null;
}

async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const [rows] = await pool.query('SELECT * FROM users WHERE email=? LIMIT 1', [normalized]);
  return rows[0] || null;
}

async function findUserByGoogleSub(googleSub) {
  const normalized = String(googleSub || '').trim();
  if (!normalized) return null;
  const [rows] = await pool.query('SELECT * FROM users WHERE google_sub=? LIMIT 1', [normalized]);
  return rows[0] || null;
}

async function createGoogleUser(googleUser) {
  const username = await generateUniqueUsernameFromEmail(
    googleUser.email,
    googleUser.given_name || googleUser.name
  );
  const randomPassword = crypto.randomBytes(32).toString('hex');
  const passHash = await bcrypt.hash(randomPassword, 10);

  const [result] = await pool.query(
    `INSERT INTO users (
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
      ) VALUES (?, 'google', ?, ?, 1, ?, ?, 0, 0, 'active', UTC_TIMESTAMP(6))`,
    [username, googleUser.google_sub, googleUser.email, googleUser.picture, passHash]
  );

  return loadUserById(result.insertId);
}

async function updateGoogleUser(userId, googleUser) {
  await pool.query(
    `UPDATE users
        SET auth_provider='google',
            google_sub=?,
            email=?,
            email_verified=1,
            avatar_url=?,
            last_login_at_utc=UTC_TIMESTAMP(6)
      WHERE id=?`,
    [googleUser.google_sub, googleUser.email, googleUser.picture, userId]
  );

  return loadUserById(userId);
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
      return res.status(400).json({
        ok: false,
        message: 'Bu hesap için yerel şifre tanımlı değil.'
      });
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

    return res.json({ ok: true, token, user: makeUserPayload(freshUser || user) });
  } catch (err) {
    console.error('[AUTH][LOGIN][ERROR]', err);
    return res.status(500).json({ ok: false, message: 'Login sırasında sunucu hatası oluştu.' });
  }
});

router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) {
      return res.status(400).json({ ok: false, error: 'missing_id_token' });
    }

    const googleUser = await verifyGoogleIdToken(idToken);

    let user = await findUserByGoogleSub(googleUser.google_sub);

    if (!user) {
      const existingByEmail = await findUserByEmail(googleUser.email);

      if (existingByEmail && !hasGoogleLinked(existingByEmail)) {
        return res.status(409).json({
          ok: false,
          message: 'Bu e-posta ile bir hesap zaten var. Önce kullanıcı adı ve şifre ile giriş yapıp Google hesabını bağlayın.',
          error: 'account_link_required'
        });
      }

      if (existingByEmail && hasGoogleLinked(existingByEmail)) {
        user = await updateGoogleUser(existingByEmail.id, googleUser);
      } else {
        user = await createGoogleUser(googleUser);
      }
    } else {
      user = await updateGoogleUser(user.id, googleUser);
    }

    if (!user) {
      return res.status(500).json({ ok: false, error: 'user_load_failed' });
    }

    if (String(user.status || 'active') !== 'active') {
      return res.status(403).json({ ok: false, error: 'user_not_active' });
    }

    const token = signAppJwt(user.id);
    return res.json({
      ok: true,
      token,
      user: makeUserPayload(user),
      googleEmail: googleUser.email
    });
  } catch (err) {
    console.error('[AUTH][GOOGLE][ERROR]', err);
    return res.status(401).json({
      ok: false,
      error: err.message || 'google_login_failed',
      message: 'Google girişi başarısız.'
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
    const googleEmail = google ? String(user.email || '') : null;

    return res.json({
      ok: true,
      local,
      google,
      googleEmail,
      methods: {
        local,
        google,
        googleEmail
      }
    });
  } catch (err) {
    console.error('[AUTH][METHODS][ERROR]', err);
    return res.status(500).json({
      ok: false,
      message: 'Giriş yöntemleri alınamadı.'
    });
  }
});

router.post('/google/link', mwAuth, async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) {
      return res.status(400).json({ ok: false, message: 'Google token eksik.' });
    }

    const currentUser = await loadUserById(req.user.id);
    if (!currentUser) {
      return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
    }

    const googleUser = await verifyGoogleIdToken(idToken);

    const existingLinked = await findUserByGoogleSub(googleUser.google_sub);
    if (existingLinked && Number(existingLinked.id) !== Number(currentUser.id)) {
      return res.status(409).json({
        ok: false,
        message: 'Bu Google hesabı başka bir kullanıcıya bağlı.'
      });
    }

    await pool.query(
      `UPDATE users
          SET google_sub=?,
              email=?,
              email_verified=1,
              avatar_url=CASE
                WHEN COALESCE(avatar_url, '') = '' THEN ?
                ELSE avatar_url
              END
        WHERE id=?`,
      [googleUser.google_sub, googleUser.email, googleUser.picture, currentUser.id]
    );

    const freshUser = await loadUserById(currentUser.id);

    return res.json({
      ok: true,
      success: true,
      message: 'Google hesabı bağlandı.',
      googleEmail: String(freshUser?.email || googleUser.email || ''),
      user: freshUser ? makeUserPayload(freshUser) : null
    });
  } catch (err) {
    console.error('[AUTH][GOOGLE_LINK][ERROR]', err);
    return res.status(400).json({
      ok: false,
      message: err.message || 'Google hesabı bağlanamadı.'
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
      return res.status(400).json({
        ok: false,
        message: 'Bu hesapta bağlı Google hesabı yok.'
      });
    }

    if (!hasLocalPassword(currentUser)) {
      return res.status(400).json({
        ok: false,
        message: 'Önce bu hesap için bir şifre oluşturmalısınız.'
      });
    }

    await pool.query(
      `UPDATE users
          SET google_sub=NULL,
              auth_provider='local'
        WHERE id=?`,
      [currentUser.id]
    );

    const freshUser = await loadUserById(currentUser.id);

    return res.json({
      ok: true,
      success: true,
      message: 'Google bağlantısı kaldırıldı.',
      user: freshUser ? makeUserPayload(freshUser) : null
    });
  } catch (err) {
    console.error('[AUTH][GOOGLE_UNLINK][ERROR]', err);
    return res.status(500).json({
      ok: false,
      message: 'Google bağlantısı kaldırılamadı.'
    });
  }
});

router.post('/password/change', mwAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    const nextPassword = String(newPassword || '');
    const currentPwd = String(currentPassword || '');
    const confirmPwd = String(confirmPassword || '');

    if (!nextPassword || nextPassword.length < 3) {
      return res.status(400).json({
        ok: false,
        message: 'Yeni şifre en az 3 karakter olmalıdır.'
      });
    }

    if (confirmPwd !== nextPassword) {
      return res.status(400).json({
        ok: false,
        message: 'Yeni şifre tekrarı eşleşmiyor.'
      });
    }

    const currentUser = await loadUserById(req.user.id);
    if (!currentUser) {
      return res.status(404).json({ ok: false, message: 'Kullanıcı bulunamadı.' });
    }

    if (hasLocalPassword(currentUser)) {
      if (!currentPwd) {
        return res.status(400).json({
          ok: false,
          message: 'Mevcut şifre gerekli.'
        });
      }

      const matches = await bcrypt.compare(currentPwd, currentUser.pass_hash);
      if (!matches) {
        return res.status(401).json({
          ok: false,
          message: 'Mevcut şifre hatalı.'
        });
      }
    }

    const newHash = await bcrypt.hash(nextPassword, 10);

    await pool.query(
      `UPDATE users
          SET pass_hash=?,
              auth_provider=CASE
                WHEN COALESCE(google_sub, '') <> '' THEN auth_provider
                ELSE 'local'
              END
        WHERE id=?`,
      [newHash, currentUser.id]
    );

    const freshUser = await loadUserById(currentUser.id);

    return res.json({
      ok: true,
      success: true,
      message: hasLocalPassword(currentUser)
        ? 'Şifre değiştirildi.'
        : 'Şifre oluşturuldu.',
      user: freshUser ? makeUserPayload(freshUser) : null
    });
  } catch (err) {
    console.error('[AUTH][PASSWORD_CHANGE][ERROR]', err);
    return res.status(500).json({
      ok: false,
      message: 'Şifre işlemi başarısız oldu.'
    });
  }
});

module.exports = router;
