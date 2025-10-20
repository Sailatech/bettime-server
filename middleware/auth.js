const { findToken } = require('../helpers/tokenHelper');

/**
 * Auth middleware (opaque token, no JWT)
 * - Accepts Authorization: Bearer <opaque-token> or cookie "xo_token"
 * - Validates token via helpers/tokenHelper.findToken
 * - Attaches req.user (plain object) including bank fields: bank_name, account_number, account_name
 */
async function authMiddleware(req, res, next) {
  try {
    let authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
    let token = null;

    if (authHeader && typeof authHeader === 'string') {
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
      } else {
        console.warn('[auth] Authorization header present but not Bearer');
      }
    }

    if (!token && req.cookies && req.cookies.xo_token) {
      token = req.cookies.xo_token;
      console.debug('[auth] token taken from cookie xo_token');
    }

    if (!token) {
      console.warn('[auth] no token provided (header or cookie)');
      return res.status(401).json({ error: 'No token provided' });
    }

    const tokenRow = await findToken(token, { requireActive: true });
    if (!tokenRow) {
      console.warn('[auth] token not found, revoked, expired or user inactive');
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Build user object defensively (do not assume any extra columns exist)
    const user = {
      id: tokenRow.user_id ?? tokenRow.id ?? null,
      username: tokenRow.username ?? null,
      email: tokenRow.email ?? null,
      display_name: tokenRow.display_name ?? tokenRow.displayName ?? null,
      balance: Number(tokenRow.balance ?? 0),
      status: tokenRow.status ?? 'active',
      role: tokenRow.role ?? null,
      isAdmin: !!(tokenRow.role === 'admin'),
      bank_name: tokenRow.bank_name ?? null,
      account_number: tokenRow.account_number ?? null,
      account_name: tokenRow.account_name ?? null,
      token_id: tokenRow.token_id ?? null,
      token_name: tokenRow.name ?? null,
      token_created_at: tokenRow.token_created_at ?? null,
      token_expires_at: tokenRow.expires_at ?? null,
    };

    req.user = user;
    req.authToken = {
      token,
      tokenId: tokenRow.token_id ?? null,
      expiresAt: tokenRow.expires_at ?? null,
      revoked: !!Number(tokenRow.revoked)
    };

    return next();
  } catch (err) {
    console.error('[auth] unexpected error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Auth error' });
  }
}

module.exports = authMiddleware;
