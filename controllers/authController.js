// controllers/authController.js
const bcrypt = require('bcrypt');
const { getPool } = require('../config/db');
const { createTokenForUser, revokeToken } = require('../helpers/tokenHelper');

/**
 * Convert internal user row to public-safe payload
 */
function safeUserRowToPublic(userRow) {
  if (!userRow) return null;
  return {
    id: userRow.id,
    username: userRow.username,
    email: userRow.email,
    display_name: userRow.display_name || userRow.displayName || null,
    balance: Number(userRow.balance ?? 0),
    last_login: userRow.last_login || null,
  };
}

/**
 * Register a new user and issue an opaque token
 * POST /api/auth/register
 */
async function register(req, res) {
  try {
    const { username, email, password, displayName } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: 'Missing fields' });

    const db = await getPool();
    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedUsername = String(username).trim();

    const [existsUser] = await db.query(`SELECT id FROM users WHERE username = ? LIMIT 1`, [normalizedUsername]);
    if (existsUser && existsUser.length) return res.status(400).json({ error: 'Username already used' });

    const [existsEmail] = await db.query(`SELECT id FROM users WHERE email = ? LIMIT 1`, [normalizedEmail]);
    if (existsEmail && existsEmail.length) return res.status(400).json({ error: 'Email already used' });

    const passwordHash = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      `INSERT INTO users (username, email, password_hash, display_name, is_bot, bot_type, balance, pending_balance, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, 0.00, 0.00, 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [normalizedUsername, normalizedEmail, passwordHash, displayName || normalizedUsername]
    );

    const insertedId = result && result.insertId;
    if (!insertedId) return res.status(500).json({ error: 'Failed to create user' });

    const [rows] = await db.query(`SELECT * FROM users WHERE id = ? LIMIT 1`, [insertedId]);
    const userRow = rows && rows[0];
    if (!userRow) return res.status(500).json({ error: 'Failed to fetch created user' });

    // Issue opaque token (stored server-side)
    const tk = await createTokenForUser(userRow.id, { expiresInMinutes: 60 * 24 * 7 }); // 7 days
    const safeUser = safeUserRowToPublic(userRow);

    return res.json({ user: safeUser, token: tk.token, expiresAt: tk.expiresAt || null });
  } catch (err) {
    console.error('register error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * Login existing user and issue opaque token
 * POST /api/auth/login
 */
async function login(req, res) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const db = await getPool();
    const [rows] = await db.query(`SELECT * FROM users WHERE email = ? LIMIT 1`, [normalizedEmail]);
    if (!rows || !rows.length) return res.status(400).json({ error: 'Invalid credentials' });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    // Issue opaque token (stored server-side)
    const tk = await createTokenForUser(user.id, { expiresInMinutes: 60 * 24 * 7 }); // 7 days

    // Update last_login but don't fail login if update errors
    try {
      await db.query(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);
    } catch (e) {
      console.debug('Could not update last_login column; continuing. Error:', e && e.message);
    }

    const safeUser = safeUserRowToPublic(user);
    return res.json({ user: safeUser, token: tk.token, expiresAt: tk.expiresAt || null });
  } catch (err) {
    console.error('login error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * Logout (revoke token) — accepts Authorization: Bearer <token> or cookie xo_token
 * POST /api/auth/logout
 */
async function logout(req, res) {
  try {
    let token = null;
    const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (req.cookies && req.cookies.xo_token) {
      token = req.cookies.xo_token;
    }

    if (!token) return res.status(400).json({ error: 'No token provided' });

    try {
      await revokeToken(token);
    } catch (e) {
      console.debug('revokeToken failed', e && e.message);
    }

    // Clear cookie if present
    try {
      res.clearCookie && res.clearCookie('xo_token');
    } catch (_) {}

    return res.json({ ok: true });
  } catch (err) {
    console.error('logout error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * GET /api/me
 * Returns current authenticated user by validating opaque token (header or cookie)
 * Ensures bank_name, account_number, account_name are included in the returned user object.
 */
async function me(req, res) {
  try {
    // If an auth middleware already attached req.user, prefer that
    if (req.user && (req.user.id || req.user.id === 0)) {
      const plain = typeof req.user.get === 'function' ? req.user.get({ plain: true }) : req.user;
      const publicUser = safeUserRowToPublic(plain) || {};
      // Ensure bank fields are present on the returned payload
      publicUser.bank_name = plain.bank_name || null;
      publicUser.account_number = plain.account_number || null;
      publicUser.account_name = plain.account_name || null;
      return res.json({ user: publicUser });
    }

    // Validate opaque token from header or cookie
    let token = null;
    const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (req.cookies && req.cookies.xo_token) {
      token = req.cookies.xo_token;
    }

    if (!token) return res.status(401).json({ error: 'No token' });

    const db = await getPool();
    const [rows] = await db.query(
      `SELECT u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token = ? AND t.revoked = 0
       LIMIT 1`,
      [token]
    );

    if (!rows || !rows.length) return res.status(401).json({ error: 'Invalid token' });

    const userRow = rows[0];
    const publicUser = safeUserRowToPublic(userRow) || {};
    // Attach bank details explicitly to ensure they're available to the client
    publicUser.bank_name = userRow.bank_name || null;
    publicUser.account_number = userRow.account_number || null;
    publicUser.account_name = userRow.account_name || null;

    return res.json({ user: publicUser });
  } catch (err) {
    console.error('me error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = { register, login, logout, me };
