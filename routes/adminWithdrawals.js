// routes/adminWithdrawals.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminWithdrawalController');
const auth = require('../middleware/auth'); // your provided auth middleware
const ensureAdmin = require('../middleware/ensureAdmin');

router.use(auth, ensureAdmin);

router.get('/', controller.listWithdrawals);
router.post('/:id/approve', controller.approveWithdrawal);
router.post('/:id/decline', controller.declineWithdrawal);
router.delete('/:id', controller.deleteWithdrawal);

module.exports = router;
