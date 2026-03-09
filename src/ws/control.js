'use strict';
/**
 * WS control singleton.
 * Allows HTTP routes to trigger WS-side actions (broadcasts) in the same Node process.
 */
let adminApi = null;

function setWsAdminApi(api) {
  adminApi = api || null;
}

function getWsAdminApi() {
  return adminApi;
}

module.exports = { setWsAdminApi, getWsAdminApi };
