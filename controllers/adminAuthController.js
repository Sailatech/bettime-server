// controllers/adminAuthController.js
const AdminModel = require('../models/AdminModel');
const AuthTokenModel = require('../models/AuthTokenModel');
const bcrypt = require('bcrypt');

const TOKEN_TTL_SECONDS = Number(process.env.ADMIN_TOKEN_TTL_SECONDS || 60 * 60 * 8); // 8 hours default
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);

async function login(req, res) {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: 'identifier and password required' });

    const user = await AdminModel.findByUsernameOrEmail(identifier);
    if (!user) return res.status(401).json({ error: 'invalid credentials' });

    if (user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    const { token, id, expiresAt } = await AuthTokenModel.createToken({
      user_id: user.id,
      name: 'admin-session',
      ttlSeconds: TOKEN_TTL_SECONDS
    });

    return res.json({
      token,
      token_id: id,
      expires_at: expiresAt,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        role: user.role
      }
    });
  } catch (err) {
    console.error('[adminAuth] login error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
  }
}

async function logout(req, res) {
  try {
    const tokenId = req.authToken && req.authToken.tokenId;
    if (tokenId) {
      await AuthTokenModel.revokeTokenById(tokenId);
      return res.json({ ok: true });
    }

    // fallback revoke by token string
    const tokenString = (req.headers.authorization && req.headers.authorization.startsWith('Bearer '))
      ? req.headers.authorization.slice(7).trim()
      : (req.cookies && req.cookies.xo_token) || null;

    if (tokenString) {
      const row = await AuthTokenModel.findToken(tokenString);
      if (row && row.token_id) await AuthTokenModel.revokeTokenById(row.token_id);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[adminAuth] logout error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
  }
}

module.exports = { login, logout };
