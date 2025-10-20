const { getPool } = require('../config/db');

/**
 * Create a new user and return the inserted user row.
 * Adds optional bank fields to the inserted row if provided.
 */
async function createUser({
  username,
  email = null,
  passwordHash,
  displayName = null,
  isBot = 0,
  botType = null,
  balance = 0,
  bankName = null,
  accountNumber = null,
  accountName = null
}) {
  if (!username || !passwordHash) {
    throw new Error('username and passwordHash are required');
  }

  const db = await getPool();
  const sql = `
    INSERT INTO users
      (username, email, password_hash, display_name, is_bot, bot_type, balance, bank_name, account_number, account_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    username,
    email,
    passwordHash,
    displayName,
    isBot ? 1 : 0,
    botType,
    Number(balance || 0),
    bankName,
    accountNumber,
    accountName
  ];
  const [res] = await db.query(sql, params);
  return findById(res.insertId);
}

/**
 * Find a user by id.
 * Returns full user row including bank fields.
 */
async function findById(id) {
  if (!id) return null;
  const db = await getPool();
  const [rows] = await db.query(
    `SELECT id, username, email, password_hash AS passwordHash, display_name AS displayName,
            is_bot AS isBot, bot_type AS botType, balance, last_login, created_at, updated_at,
            bank_name, account_number, account_name
     FROM users
     WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows && rows.length ? rows[0] : null;
}

/**
 * Find a user by username.
 * Returns full user row including bank fields.
 */
async function findByUsername(username) {
  if (!username) return null;
  const db = await getPool();
  const [rows] = await db.query(
    `SELECT id, username, email, password_hash AS passwordHash, display_name AS displayName,
            is_bot AS isBot, bot_type AS botType, balance, last_login, created_at, updated_at,
            bank_name, account_number, account_name
     FROM users
     WHERE username = ? LIMIT 1`,
    [username]
  );
  return rows && rows.length ? rows[0] : null;
}

/**
 * Find a user by email.
 * Returns full user row including bank fields.
 */
async function findByEmail(email) {
  if (!email) return null;
  const db = await getPool();
  const [rows] = await db.query(
    `SELECT id, username, email, password_hash AS passwordHash, display_name AS displayName,
            is_bot AS isBot, bot_type AS botType, balance, last_login, created_at, updated_at,
            bank_name, account_number, account_name
     FROM users
     WHERE email = ? LIMIT 1`,
    [email]
  );
  return rows && rows.length ? rows[0] : null;
}

/**
 * Update user's balance (set absolute value).
 * If a connection is provided, uses it (for transactions).
 * Returns the updated user row.
 */
async function updateBalance(id, newBalance, conn = null) {
  if (!id) throw new Error('id is required');
  const db = conn || (await getPool());
  await db.query(`UPDATE users SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
    Number(newBalance || 0),
    id,
  ]);
  return findById(id);
}

/**
 * Atomically change user's balance by delta (positive or negative).
 * If a connection is provided it will be used (for transactions).
 * Returns the updated user row.
 */
async function changeBalanceBy(id, delta, conn = null) {
  if (!id) throw new Error('id is required');
  if (typeof delta !== 'number' && typeof delta !== 'string') throw new Error('delta must be a number');
  const db = conn || (await getPool());
  await db.query(`UPDATE users SET balance = COALESCE(balance,0) + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
    Number(delta),
    id,
  ]);
  return findById(id);
}

/**
 * Mark last_login timestamp to now for the given user id.
 * Returns the user row after update.
 */
async function markLastLogin(id) {
  if (!id) throw new Error('id is required');
  const db = await getPool();
  await db.query(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
  return findById(id);
}

/**
 * Update user's bank info.
 * If a connection is provided it will be used (for transactions).
 * payload may include any of: { bankName, accountNumber, accountName }
 * Returns the updated user row.
 */
async function updateBankInfo(id, { bankName, accountNumber, accountName } = {}, conn = null) {
  if (!id) throw new Error('id is required');
  const updates = [];
  const params = [];
  if (typeof bankName !== 'undefined') { updates.push('bank_name = ?'); params.push(bankName); }
  if (typeof accountNumber !== 'undefined') { updates.push('account_number = ?'); params.push(accountNumber); }
  if (typeof accountName !== 'undefined') { updates.push('account_name = ?'); params.push(accountName); }

  if (updates.length === 0) {
    return findById(id); // nothing to change
  }

  const db = conn || (await getPool());
  params.push(id);
  const sql = `UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
  await db.query(sql, params);
  return findById(id);
}

module.exports = {
  createUser,
  findById,
  findByUsername,
  findByEmail,
  updateBalance,
  changeBalanceBy,
  markLastLogin,
  updateBankInfo,
};
