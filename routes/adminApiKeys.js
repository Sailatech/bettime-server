const express = require('express');
const { generateKey, hashKey } = require('../utils/apiKey');
const db = require('../config/db');
const adminMiddleware = require('../middleware/auth');

const router = express.Router();

// internal helper to ensure requester is admin
function ensureAdmin(req, res) {
  if (!req.user || !req.user.isAdmin) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

// POST /admin/api-keys
// Body: { name: "integration-name" }
// Returns: { apiKey: "<plaintext>", note: "copy now" }
router.post('/', adminMiddleware, async (req, res, next) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const name = req.body && String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const plainKey = generateKey();
    const keyHash = await hashKey(plainKey);

    const pool = await db.getPool();
    await pool.query(
      'INSERT INTO api_keys (name, key_hash, created_by_admin, meta) VALUES (?, ?, ?, ?)',
      [name, keyHash, 1, JSON.stringify({ createdBy: req.user.id || 'admin-ui' })]
    );

    return res.status(201).json({
      apiKey: plainKey,
      note: 'Copy this key now. It will not be shown again.'
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/api-keys
// Returns array of key metadata (no key_hash)
router.get('/', adminMiddleware, async (req, res, next) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const pool = await db.getPool();
    const [rows] = await pool.query(
      'SELECT id, name, created_at, last_used_at, revoked_at, meta FROM api_keys ORDER BY created_at DESC'
    );

    return res.json(Array.isArray(rows) ? rows : []);
  } catch (err) {
    next(err);
  }
});

// POST /admin/api-keys/:id/revoke
// Returns { ok: true }
router.post('/:id/revoke', adminMiddleware, async (req, res, next) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });

    const pool = await db.getPool();
    const [result] = await pool.query('UPDATE api_keys SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL', [id]);

    if (result && result.affectedRows === 0) {
      return res.status(404).json({ error: 'Key not found or already revoked' });
    }

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /admin/api-keys/:id/rotate
// Body: { name?: "new-name" }
// Creates a new key, revokes the old one, returns { apiKey: "<plaintext>", note }
router.post('/:id/rotate', adminMiddleware, async (req, res, next) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });

    const newName = req.body && typeof req.body.name === 'string' ? String(req.body.name).trim() : null;
    const pool = await db.getPool();

    // check existing
    const [rows] = await pool.query('SELECT id, name, revoked_at FROM api_keys WHERE id = ?', [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Key not found' });

    // generate new key
    const plainKey = generateKey();
    const keyHash = await hashKey(plainKey);

    // insert new key (preserve newName or original with suffix)
    const insertName = newName || `${rows[0].name || 'rotated'}-${Date.now()}`;
    await pool.query(
      'INSERT INTO api_keys (name, key_hash, created_by_admin, meta) VALUES (?, ?, ?, ?)',
      [insertName, keyHash, 1, JSON.stringify({ rotatedFrom: id, rotatedBy: req.user.id || null })]
    );

    // revoke old key
    await pool.query('UPDATE api_keys SET revoked_at = NOW() WHERE id = ?', [id]);

    return res.status(201).json({
      apiKey: plainKey,
      note: 'Copy this key now. It will not be shown again.'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
