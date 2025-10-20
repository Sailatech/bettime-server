const express = require('express');
const router = express.Router();

const withdrawalCtrl = require('../controllers/withdrawalController');
const auth = require('../middleware/auth'); // your authMiddleware function

// sanity checks
if (!withdrawalCtrl || typeof withdrawalCtrl !== 'object') {
  throw new Error('withdrawalController did not export an object. Check src/controllers/withdrawalController.js');
}
const requiredHandlers = [
  'requestWithdrawal',
  'getMyWithdrawals',
  'getWithdrawal',
  'listPending',
  'approveWithdrawal',
  'declineWithdrawal',
  'updateBankInfo' // new required handler
];
for (const h of requiredHandlers) {
  if (typeof withdrawalCtrl[h] !== 'function') {
    throw new Error(`withdrawalController is missing handler: ${h}`);
  }
}
if (!auth || typeof auth !== 'function') {
  throw new Error('auth middleware must export a function (module.exports = authMiddleware)');
}

// admin guard middleware (uses req.user set by auth middleware)
function ensureAdmin(req, res, next) {
  if (req.user && (req.user.role === 'admin' || req.user.isAdmin)) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// User routes (require authentication)
router.post('/', auth, withdrawalCtrl.requestWithdrawal);
router.get('/', auth, withdrawalCtrl.getMyWithdrawals);
router.get('/:id', auth, withdrawalCtrl.getWithdrawal);

// Persist user's bank info
router.post('/bank', auth, withdrawalCtrl.updateBankInfo);

// Admin routes (require auth then admin check)
router.get('/admin/pending', auth, ensureAdmin, withdrawalCtrl.listPending);
router.post('/admin/:id/approve', auth, ensureAdmin, withdrawalCtrl.approveWithdrawal);
router.post('/admin/:id/decline', auth, ensureAdmin, withdrawalCtrl.declineWithdrawal);

module.exports = router;
