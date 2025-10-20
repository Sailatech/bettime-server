const crypto = require('crypto');
const { getPool } = require('../config/db');

/**
 * Generate a cryptographically secure opaque token string.
 * Uses base64url encoding to produce URL-safe token (~43 chars from 32 bytes).
 */
function generateTokenString(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Create and persist a token for a user.
 */
async function createTokenForUser(userId, opts = {}) {
  if (!userId) throw new Error('userId is required');
  const pool = await getPool();
  const token = generateTokenString(32);
  const createdAt = new Date();
  const expiresAt = opts.expiresInMinutes ? new Date(Date.now() + Number(opts.expiresInMinutes) * 60000) : null;
  const name = opts.name ? String(opts.name).slice(0, 100) : null;
  const deletePrevious = opts.deletePrevious !== undefined ? Boolean(opts.deletePrevious) : true;

  // Ensure auth_tokens table exists (best-effort)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      token VARCHAR(128) NOT NULL UNIQUE,
      name VARCHAR(100) DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME DEFAULT NULL,
      revoked TINYINT(1) DEFAULT 0,
      INDEX (user_id),
      INDEX (token)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (deletePrevious) {
      await conn.query(`DELETE FROM auth_tokens WHERE user_id = ?`, [userId]);
    }

    await conn.query(
      `INSERT INTO auth_tokens (user_id, token, name, created_at, expires_at, revoked)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [userId, token, name, createdAt, expiresAt]
    );

    await conn.commit();
    conn.release();
    return { token, createdAt, expiresAt };
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    conn.release();
    throw err;
  }
}

/**
 * Revoke a token (mark revoked = 1).
 */
async function revokeToken(token) {
  if (!token) return false;
  const pool = await getPool();
  const [res] = await pool.query(`UPDATE auth_tokens SET revoked = 1 WHERE token = ? AND revoked = 0`, [token]);
  return res && res.affectedRows && res.affectedRows > 0;
}

/**
 * Find token row and optionally enforce not revoked and not expired.
 * Returns token row joined with user fields when found, otherwise null.
 * The SELECT avoids non-standard columns to prevent unknown-column errors.
 */
async function findToken(token, opts = { requireActive: true }) {
  if (!token) return null;
  const pool = await getPool();

  const [rows] = await pool.query(
    `SELECT
       t.id AS token_id,
       t.user_id,
       t.token,
       t.name,
       t.created_at AS token_created_at,
       t.expires_at,
       t.revoked,
       u.id AS id,
       u.username,
       u.email,
       u.display_name,
       u.balance,
       u.status,
       u.role,
       u.bank_name,
       u.account_number,
       u.account_name
     FROM auth_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE t.token = ?
     LIMIT 1`,
    [token]
  );

  if (!rows || !rows.length) return null;
  const row = rows[0];

  if (opts.requireActive) {
    const now = new Date();
    if (row.revoked && Number(row.revoked) === 1) return null;
    if (row.expires_at && new Date(row.expires_at) < now) return null;
    if (row.status && row.status !== 'active') return null;
  }

  return row;
}

/**
 * Revoke all tokens for a user.
 */
async function revokeAllTokensForUser(userId, excludeToken = null) {
  if (!userId) return 0;
  const pool = await getPool();
  if (excludeToken) {
    const [res] = await pool.query(
      `UPDATE auth_tokens SET revoked = 1 WHERE user_id = ? AND token != ? AND revoked = 0`,
      [userId, excludeToken]
    );
    return res.affectedRows || 0;
  } else {
    const [res] = await pool.query(`UPDATE auth_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0`, [userId]);
    return res.affectedRows || 0;
  }
}

/**
 * Prune expired or revoked tokens older than a threshold (days).
 */
async function pruneTokens(olderThanDays = 30) {
  const pool = await getPool();
  const cutoff = new Date(Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000);
  const [res] = await pool.query(
    `DELETE FROM auth_tokens WHERE (revoked = 1 OR (expires_at IS NOT NULL AND expires_at < ?)) AND created_at < ?`,
    [new Date(), cutoff]
  );
  return res.affectedRows || 0;
}

module.exports = {
  createTokenForUser,
  revokeToken,
  findToken,
  revokeAllTokensForUser,
  pruneTokens,
};
