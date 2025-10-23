const express = require('express');
const { generateKey, hashKey } = require('../utils/apiKey');
const db = require('../config/db');
// replace with your existing admin guard middleware name
const adminMiddleware = require('../middleware/auth');

const router = express.Router();

// POST /admin/api-keys  { name: "integration-name" }
router.post('/', adminMiddleware, async (req, res, next) => {
  try {
    const name = req.body && String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });

    const plainKey = generateKey();
    const keyHash = await hashKey(plainKey);

    const pool = await db.getPool();
    await pool.query(
      'INSERT INTO api_keys (name, key_hash, created_by_admin, meta) VALUES (?, ?, ?, ?)',
      [name, keyHash, 1, JSON.stringify({ createdBy: 'admin-ui' })]
    );

    // return plaintext once
    return res.status(201).json({
      apiKey: plainKey,
      note: 'Copy this key now. It will not be shown again.'
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
