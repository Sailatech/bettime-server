// routes/admin.js
const express = require('express');
const router = express.Router();
const adminCtrl = require('../controllers/adminController');
const auth = require('../middleware/auth');

// Minimal admin guard middleware example (assumes req.user.role exists)
function adminOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// Admin endpoints
router.get('/dashboard', auth, adminOnly, adminCtrl.getAdminDashboard);
router.post('/charge-rate', auth, adminOnly, adminCtrl.upsertChargeRate);

module.exports = router;
