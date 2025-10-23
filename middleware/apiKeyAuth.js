const db = require('../config/db');
const { verifyKey } = require('../utils/apiKey');

/**
 * API key middleware
 * - Accepts Authorization: ApiKey <key> or x-api-key header
 * - Validates against api_keys table (revoked_at IS NULL)
 * - Sets req.apiKey with metadata on success
 */
async function apiKeyAuth(req, res, next) {
  try {
    // extract incoming key
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    let incoming;

    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('apikey ')) {
      incoming = authHeader.slice(7).trim();
    } else if (req.get && req.get('x-api-key')) {
      incoming = req.get('x-api-key').trim();
    } else if (typeof authHeader === 'string' && authHeader.startsWith('ApiKey ')) {
      incoming = authHeader.slice(7).trim();
    }

    if (!incoming) {
      return res.status(401).json({ error: 'API key required' });
    }

    const pool = await db.getPool();
    // fetch only active keys (not revoked)
    const [rows] = await pool.query('SELECT id, name, key_hash, meta, last_used_at FROM api_keys WHERE revoked_at IS NULL');

    for (const row of rows) {
      if (!row.key_hash) continue;
      // verify each stored hash against incoming plaintext
      if (await verifyKey(incoming, row.key_hash)) {
        // update last_used_at asynchronously but wait for completion to keep audit consistent
        try {
          await pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [row.id]);
        } catch (e) {
          console.warn('[apiKeyAuth] failed to update last_used_at', e && e.stack ? e.stack : e);
        }

        req.apiKey = {
          id: row.id,
          name: row.name,
          meta: row.meta || null,
          lastUsedAt: row.last_used_at || null
        };

        return next();
      }
    }

    return res.status(401).json({ error: 'Invalid API key' });
  } catch (err) {
    console.error('[apiKeyAuth] unexpected error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'API key auth error' });
  }
}

module.exports = apiKeyAuth;
