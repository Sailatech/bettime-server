// models/AuthTokenModel.js
const { getPool } = require('../config/db');
const crypto = require('crypto');

function genTokenString(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

class AuthTokenModel {
  // create an opaque token string and row
  static async createToken({ user_id, name = 'admin-session', ttlSeconds = 60 * 60 * 8 }) {
    const db = await getPool();
    const token = genTokenString(32);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const q = `INSERT INTO auth_tokens (user_id, token, expires_at, created_at)
               VALUES (?, ?, ?, NOW())`;
    const [res] = await db.query(q, [user_id, token, expiresAt]);
    return { token, id: res.insertId, expiresAt };
  }

  // find token row joined with user data
  static async findToken(tokenString, { requireActive = false } = {}) {
    const db = await getPool();
    const [rows] = await db.query(
      `SELECT at.id AS token_id, at.user_id, at.token, at.expires_at, at.created_at AS token_created_at, at.revoked,
              u.id AS id, u.username, u.email, u.display_name, u.role, u.status, u.balance,
              u.bank_name, u.account_number, u.account_name
       FROM auth_tokens at
       LEFT JOIN users u ON at.user_id = u.id
       WHERE at.token = ? LIMIT 1`,
      [tokenString]
    );
    const row = rows[0] || null;
    if (!row) return null;
    if (requireActive) {
      if (Number(row.revoked)) return null;
      if (row.expires_at && new Date(row.expires_at) <= new Date()) return null;
      if (!row.user_id) return null;
      if (row.status !== 'active') return null;
    }
    return row;
  }

  static async revokeTokenById(tokenId) {
    const db = await getPool();
    const [res] = await db.query(`UPDATE auth_tokens SET revoked = 1 WHERE id = ?`, [tokenId]);
    return res.affectedRows;
  }

  static async revokeTokensForUser(userId) {
    const db = await getPool();
    const [res] = await db.query(`UPDATE auth_tokens SET revoked = 1 WHERE user_id = ?`, [userId]);
    return res.affectedRows;
  }
}

module.exports = AuthTokenModel;
