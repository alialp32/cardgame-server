'use strict';

const { OAuth2Client } = require('google-auth-library');

let oauthClient = null;

function parseAudienceList() {
  const raw = [
    process.env.GOOGLE_WEB_CLIENT_ID,
    process.env.GOOGLE_WEB_CLIENT_IDS,
  ]
    .filter(Boolean)
    .join(',');

  const audiences = raw
    .split(',')
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  if (!audiences.length) {
    const error = new Error('google_client_id_not_configured');
    error.status = 500;
    error.publicMessage = 'GOOGLE_WEB_CLIENT_ID ortam değişkeni tanımlı değil.';
    throw error;
  }

  return audiences;
}

function getOauthClient() {
  if (!oauthClient) oauthClient = new OAuth2Client();
  return oauthClient;
}

function normalizeGoogleProfile(payload) {
  return {
    googleSub: String(payload.sub || '').trim(),
    email: String(payload.email || '').trim().toLowerCase(),
    emailVerified: payload.email_verified === true || String(payload.email_verified || '').toLowerCase() === 'true',
    name: String(payload.name || '').trim(),
    givenName: String(payload.given_name || '').trim(),
    familyName: String(payload.family_name || '').trim(),
    picture: String(payload.picture || '').trim(),
    locale: String(payload.locale || '').trim(),
    nonce: String(payload.nonce || '').trim() || null,
    aud: String(payload.aud || '').trim(),
    iss: String(payload.iss || '').trim(),
  };
}

async function verifyGoogleIdentity({ idToken, nonce } = {}) {
  const token = String(idToken || '').trim();
  if (!token) {
    const error = new Error('missing_id_token');
    error.status = 400;
    error.publicMessage = 'Google kimlik tokenı eksik.';
    throw error;
  }

  const audiences = parseAudienceList();
  const ticket = await getOauthClient().verifyIdToken({
    idToken: token,
    audience: audiences,
  });

  const payload = ticket.getPayload();
  if (!payload) {
    const error = new Error('google_payload_missing');
    error.status = 401;
    error.publicMessage = 'Google kimlik doğrulama verisi okunamadı.';
    throw error;
  }

  const profile = normalizeGoogleProfile(payload);
  if (!profile.googleSub) {
    const error = new Error('google_sub_missing');
    error.status = 401;
    error.publicMessage = 'Google kullanıcı kimliği alınamadı.';
    throw error;
  }

  if (!profile.email) {
    const error = new Error('google_email_missing');
    error.status = 401;
    error.publicMessage = 'Google hesabında e-posta bilgisi bulunamadı.';
    throw error;
  }

  if (!profile.emailVerified) {
    const error = new Error('email_not_verified');
    error.status = 401;
    error.publicMessage = 'Google hesabı e-posta doğrulaması geçersiz.';
    throw error;
  }

  if (!['accounts.google.com', 'https://accounts.google.com'].includes(profile.iss)) {
    const error = new Error('issuer_invalid');
    error.status = 401;
    error.publicMessage = 'Google issuer bilgisi geçersiz.';
    throw error;
  }

  const expectedNonce = String(nonce || '').trim();
  if (expectedNonce && profile.nonce && profile.nonce !== expectedNonce) {
    const error = new Error('nonce_mismatch');
    error.status = 401;
    error.publicMessage = 'Google nonce doğrulaması başarısız oldu.';
    throw error;
  }

  return profile;
}

module.exports = {
  verifyGoogleIdentity,
};
