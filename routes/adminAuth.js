// routes/adminAuth.js
const express = require('express');
const router = express.Router();
const adminAuthCtrl = require('../controllers/adminAuthController');
const auth = require('../middleware/auth'); // your opaque-token auth middleware

// POST /admin/auth/login
router.post('/login', adminAuthCtrl.login);

// POST /admin/auth/logout (requires existing token)
router.post('/logout', auth, adminAuthCtrl.logout);

module.exports = router;
