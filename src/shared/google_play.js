'use strict';

const { JWT } = require('google-auth-library');

const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
let accessTokenCache = {
  token: '',
  expiresAt: 0,
};

function parseServiceAccountConfig() {
  const rawJson = String(
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
      ''
  ).trim();

  if (rawJson) {
    const parsed = JSON.parse(rawJson);
    return {
      clientEmail: String(parsed.client_email || '').trim(),
      privateKey: String(parsed.private_key || '').replace(/\\n/g, '\n').trim(),
      projectId: String(parsed.project_id || '').trim(),
    };
  }

  return {
    clientEmail: String(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
    privateKey: String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim(),
    projectId: String(process.env.GOOGLE_CLOUD_PROJECT || '').trim(),
  };
}

function getExpectedPackageName(requestPackageName) {
  const configured = String(process.env.GOOGLE_PLAY_PACKAGE_NAME || '').trim();
  const incoming = String(requestPackageName || '').trim();
  return configured || incoming;
}

async function getAndroidPublisherAccessToken() {
  const now = Date.now();
  if (accessTokenCache.token && accessTokenCache.expiresAt - 60_000 > now) {
    return accessTokenCache.token;
  }

  const { clientEmail, privateKey } = parseServiceAccountConfig();
  console.log('[GOOGLE_PLAY] service_account_config', {
    clientEmail: clientEmail || null,
    hasPrivateKey: !!privateKey,
  });
  if (!clientEmail || !privateKey) {
    const error = new Error('google_play_service_account_not_configured');
    error.status = 500;
    error.publicMessage =
      'Google Play servis hesabı tanımlı değil. GOOGLE_PLAY_SERVICE_ACCOUNT_JSON veya servis hesabı anahtar alanlarını ekleyin.';
    throw error;
  }

  const jwtClient = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [ANDROID_PUBLISHER_SCOPE],
  });

  const response = await jwtClient.authorize();
  const token = String(response.access_token || '').trim();
  if (!token) {
    const error = new Error('google_play_access_token_missing');
    error.status = 500;
    error.publicMessage = 'Google Play erişim tokenı alınamadı.';
    throw error;
  }

  accessTokenCache = {
    token,
    expiresAt: Number(response.expiry_date || 0) || now + 45 * 60_000,
  };

  return token;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch (_) {
    body = { raw };
  }

  if (!response.ok) {
    const error = new Error(body.error?.message || body.error_description || body.message || 'google_play_request_failed');
    error.status = response.status;
    error.responseBody = body;
    throw error;
  }

  return body;
}

async function getProductPurchase({ packageName, productId, purchaseToken }) {
  const resolvedPackageName = getExpectedPackageName(packageName);
  if (!resolvedPackageName) {
    const error = new Error('google_play_package_not_configured');
    error.status = 500;
    error.publicMessage = 'Google Play paket adı tanımlı değil.';
    throw error;
  }

  const token = await getAndroidPublisherAccessToken();
  console.log('[GOOGLE_PLAY] get_purchase', {
    packageName: resolvedPackageName,
    productId: String(productId || '').trim(),
    purchaseTokenTail: String(purchaseToken || '').trim().slice(-10),
  });
  const url =
    'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
    encodeURIComponent(resolvedPackageName) +
    '/purchases/products/' +
    encodeURIComponent(productId) +
    '/tokens/' +
    encodeURIComponent(purchaseToken);

  const purchase = await fetchJson(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  return {
    packageName: resolvedPackageName,
    raw: purchase,
    productId: String(purchase.productId || '').trim(),
    orderId: String(purchase.orderId || '').trim() || null,
    purchaseTimeMillis: Number(purchase.purchaseTimeMillis || 0) || null,
    purchaseState: Number(purchase.purchaseState),
    consumptionState: Number(purchase.consumptionState),
    acknowledgementState: Number(purchase.acknowledgementState),
    purchaseType: Number.isFinite(Number(purchase.purchaseType)) ? Number(purchase.purchaseType) : null,
    purchaseToken: String(purchase.purchaseToken || purchaseToken || '').trim(),
    quantity: Number(purchase.quantity || 1) || 1,
  };
}

module.exports = {
  getProductPurchase,
  getExpectedPackageName,
};
