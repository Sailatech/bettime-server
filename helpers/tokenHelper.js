// helpers/tokenHelper.js
const crypto = require("crypto");
const { getPool } = require("../config/db");

/**
 * Generate a secure random token string (base64url encoded).
 */
function generateTokenString(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

/**
 * Ensure the auth_tokens table exists and includes all required columns.
 * This runs once per connection and silently upgrades schema if needed.
 */
async function ensureAuthTokensTable(pool) {
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

  // Ensure the table has all columns (for older schema versions)
  const [columns] = await pool.query(`SHOW COLUMNS FROM auth_tokens`);
  const existing = columns.map((c) => c.Field);
  const missing = [];

  if (!existing.includes("name"))
    missing.push("ADD COLUMN name VARCHAR(100) DEFAULT NULL");
  if (!existing.includes("revoked"))
    missing.push("ADD COLUMN revoked TINYINT(1) DEFAULT 0");

  if (missing.length > 0) {
    await pool.query(`ALTER TABLE auth_tokens ${missing.join(", ")}`);
    console.log("✅ Fixed missing auth_tokens columns:", missing.join(", "));
  }
}

/**
 * Create and persist a token for a user.
 * Returns { token, createdAt, expiresAt } on success or throws on failure.
 */
async function createTokenForUser(userId, opts = {}) {
  if (!userId) throw new Error("userId is required");

  const pool = await getPool();
  await ensureAuthTokensTable(pool);

  const token = generateTokenString(32);
  const createdAt = new Date();
  const expiresAt = opts.expiresInMinutes
    ? new Date(Date.now() + Number(opts.expiresInMinutes) * 60000)
    : null;
  const name = opts.name ? String(opts.name).slice(0, 100) : null;
  const deletePrevious =
    opts.deletePrevious !== undefined ? Boolean(opts.deletePrevious) : true;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (deletePrevious) {
      await conn.query(`DELETE FROM auth_tokens WHERE user_id = ?`, [userId]);
    }

    const [result] = await conn.query(
      `INSERT INTO auth_tokens (user_id, token, name, created_at, expires_at, revoked)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [userId, token, name, createdAt, expiresAt]
    );

    if (!result || !result.insertId) {
      await conn.rollback();
      throw new Error("Failed to insert auth token");
    }

    await conn.commit();
    conn.release();
    return { token, createdAt, expiresAt };
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    conn.release();
    throw err;
  }
}

/**
 * Revoke a specific token.
 */
async function revokeToken(token) {
  if (!token) return false;
  const pool = await getPool();
  await ensureAuthTokensTable(pool);

  const [res] = await pool.query(
    `UPDATE auth_tokens SET revoked = 1 WHERE token = ? AND revoked = 0`,
    [token]
  );
  return res && res.affectedRows > 0;
}

/**
 * Find a token and optionally ensure it’s active (not revoked, not expired, user active).
 * Returns joined token+user row or null.
 */
async function findToken(token, opts = { requireActive: true }) {
  if (!token) return null;
  const pool = await getPool();
  await ensureAuthTokensTable(pool);

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
       u.last_login,
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
    if (row.status && row.status !== "active") return null;
  }

  // Normalize numeric/date fields to safe JS types
  return {
    ...row,
    balance: Number(row.balance ?? 0),
    token_created_at: row.token_created_at ? new Date(row.token_created_at) : null,
    expires_at: row.expires_at ? new Date(row.expires_at) : null,
    last_login: row.last_login ? new Date(row.last_login) : null,
  };
}

/**
 * Revoke all tokens for a given user (optionally excluding one).
 */
async function revokeAllTokensForUser(userId, excludeToken = null) {
  if (!userId) return 0;
  const pool = await getPool();
  await ensureAuthTokensTable(pool);

  if (excludeToken) {
    const [res] = await pool.query(
      `UPDATE auth_tokens SET revoked = 1 WHERE user_id = ? AND token != ? AND revoked = 0`,
      [userId, excludeToken]
    );
    return res.affectedRows || 0;
  } else {
    const [res] = await pool.query(
      `UPDATE auth_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0`,
      [userId]
    );
    return res.affectedRows || 0;
  }
}

/**
 * Clean up old or revoked tokens older than the given threshold (default 30 days).
 */
async function pruneTokens(olderThanDays = 30) {
  const pool = await getPool();
  await ensureAuthTokensTable(pool);

  const cutoff = new Date(
    Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000
  );
  const [res] = await pool.query(
    `DELETE FROM auth_tokens
     WHERE (revoked = 1 OR (expires_at IS NOT NULL AND expires_at < ?))
     AND created_at < ?`,
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
