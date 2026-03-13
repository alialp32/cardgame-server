'use strict';

const https = require('https');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const express = require('express');
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

function makeUserPayload(user) {
  return {
    id: Number(user.id),
    username: String(user.username),
    email: String(user.email || ''),
    chips_balance: Number(user.chips_balance ?? 0),
    status: String(user.status ?? 'active'),
    is_admin: Number(user.is_admin ?? 0),
    auth_provider: String(user.auth_provider || 'local'),
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
  const [rows] = await pool.query('SELECT 1 FROM users WHERE username=? LIMIT 1', [username]);
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

async function findUserByGoogle(googleUser) {
  const [rows] = await pool.query(
    `SELECT *
       FROM users
      WHERE google_sub = ?
         OR (? <> '' AND email = ?)
      LIMIT 1`,
    [googleUser.google_sub, googleUser.email, googleUser.email]
  );
  return rows[0] || null;
}

async function createGoogleUser(googleUser) {
  const username = await generateUniqueUsernameFromEmail(googleUser.email, googleUser.given_name || googleUser.name);
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

  const [rows] = await pool.query('SELECT * FROM users WHERE id=? LIMIT 1', [result.insertId]);
  return rows[0] || null;
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

  const [rows] = await pool.query('SELECT * FROM users WHERE id=? LIMIT 1', [userId]);
  return rows[0] || null;
}

router.post('/register', async (req, res) => {
  try {
    const { u, p } = req.body || {};
    if (!u || !p) return res.status(400).json({ ok: false, error: 'missing_credentials' });

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

    const ok = await bcrypt.compare(p, user.pass_hash);
    if (!ok) {
      return res.status(401).json({ ok: false, message: 'Şifre hatalı.' });
    }

    if (String(user.status || 'active') !== 'active') {
      return res.status(403).json({ ok: false, message: 'Kullanıcı aktif değil.' });
    }

    await pool.query('UPDATE users SET last_login_at_utc=UTC_TIMESTAMP(6) WHERE id=?', [user.id]);
    const token = signAppJwt(user.id);
    const [freshRows] = await pool.query('SELECT * FROM users WHERE id=? LIMIT 1', [user.id]);
    const freshUser = freshRows[0] || user;

    return res.json({ ok: true, token, user: makeUserPayload(freshUser) });
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
    let user = await findUserByGoogle(googleUser);

    if (!user) {
      user = await createGoogleUser(googleUser);
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
    return res.json({ ok: true, token, user: makeUserPayload(user) });
  } catch (err) {
    console.error('[AUTH][GOOGLE][ERROR]', err);
    return res.status(401).json({ ok: false, error: err.message || 'google_login_failed' });
  }
});

module.exports = router;
