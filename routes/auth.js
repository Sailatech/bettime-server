// routes/auth.js
const express = require('express');
const router = express.Router();
const authCtrl = require('../controllers/authController');
const auth = require('../middleware/auth');

// Public
router.post('/register', authCtrl.register);
router.post('/login', authCtrl.login);

// Protected: current user
// Frontend expects GET /api/me — mount this file under /api in your app, then GET /api/me works.
router.get('/me', auth, authCtrl.me);

module.exports = router;
