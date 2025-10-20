// routes/payment.js
const express = require('express');
const router = express.Router();
const paymentCtrl = require('../controllers/paymentController');
const auth = require('../middleware/auth');

const jsonParser = express.json();

// Feature flag to allow guest init: set ALLOW_GUEST_INIT=true in .env
const allowGuestInit = (process.env.ALLOW_GUEST_INIT || '').toLowerCase() === 'true';

/**
 * deposit-init
 * - If ALLOW_GUEST_INIT is true this endpoint is public
 * - Otherwise it requires auth middleware
 */
if (allowGuestInit) {
  router.post('/deposit-init', jsonParser, async function (req, res, next) {
    try {
      await paymentCtrl.initDeposit(req, res);
    } catch (err) {
      next(err);
    }
  });
} else {
  router.post('/deposit-init', jsonParser, auth, async function (req, res, next) {
    try {
      await paymentCtrl.initDeposit(req, res);
    } catch (err) {
      next(err);
    }
  });
}

/**
 * verify/:reference
 * - Accepts Authorization: Bearer <opaque-token> or xo_token cookie optionally
 * - Controller will attempt to populate req.user from header/cookie; endpoint remains public
 *   so flows that verify without middleware (cookie/header) continue to work.
 */
router.get('/verify/:reference', async function (req, res, next) {
  try {
    await paymentCtrl.verifyDeposit(req, res);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
