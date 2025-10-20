// routes/static.js
const express = require('express');
const path = require('path');
const router = express.Router();

// Serve paystack callback from same origin.
// Adjust the path to your public folder as needed.
router.get('/payments/paystack-callback', function (req, res) {
  res.sendFile(path.join(__dirname, '..', 'public', 'paystack-callback.html'));
});

module.exports = router;
