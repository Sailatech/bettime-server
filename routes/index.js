const express = require('express');
const router = express.Router();

router.use('/auth', require('./auth'));
router.use('/withdrawals', require('./withdrawal'));
router.use('/payments', require('./payment'));
router.use('/internal', require('./internal'));
// Mount new games routes (matchmaking, join, moves, etc.)
router.use('/games', require('./games'));

module.exports = router;
