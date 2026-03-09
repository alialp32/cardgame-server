'use strict';

/**
 * WS auth helper: verifies JWT and loads user from DB.
 * - Returns {id, username, is_admin, status} or null.
 */

const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');

async function wsAuthUser(token) {
  try {
    const data = jwt.verify(token, process.env.JWT_SECRET);
    const [rows] = await pool.query(
      'SELECT id, username, is_admin, status FROM users WHERE id=? LIMIT 1',
      [data.id]
    );
    const u = rows && rows[0];
    if (!u) return null;
    if (u.status !== 'active') return null;
    return u;
  } catch {
    return null;
  }
}

module.exports = { wsAuthUser };
