// routes/games.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const gameCtrl = require('../controllers/gameController');

function logEntry(req, action) {
  try {
    console.log(`${new Date().toISOString()} - ROUTE ${action}`, {
      path: req.originalUrl,
      method: req.method,
      userId: req.user?.id ?? null,
      params: req.params,
      body: req.body,
      // show only a short preview of Authorization for correlation, not the full token
      authPreview: (req.headers?.authorization || '').slice(0, 32)
    });
  } catch (e) {
    console.error('logEntry failed', e && e.stack ? e.stack : e);
  }
}

// Create a match or join an existing waiting match with same stake
router.post('/matches', auth, async (req, res, next) => {
  logEntry(req, 'POST /api/games/matches');
  try {
    await gameCtrl.createMatch(req, res);
    // ensure handler responded; if handler didn't call res.*, send a safe fallback
    if (!res.headersSent) {
      console.warn('Handler createMatch did not send response; sending fallback 204');
      return res.status(204).end();
    }
  } catch (err) {
    next(err);
  }
});

// Explicitly join a specific match
router.post('/matches/:id/join', auth, async (req, res, next) => {
  logEntry(req, 'POST /api/games/matches/:id/join');
  try {
    await gameCtrl.joinMatch(req, res);
    if (!res.headersSent) return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Play a move on a match
router.post('/matches/:id/move', auth, async (req, res, next) => {
  logEntry(req, 'POST /api/games/matches/:id/move');
  try {
    await gameCtrl.playMove(req, res);
    if (!res.headersSent) return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Get match state and moves
router.get('/matches/:id', auth, async (req, res, next) => {
  logEntry(req, 'GET /api/games/matches/:id');
  try {
    await gameCtrl.getMatch(req, res);
    if (!res.headersSent) return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Cancel a waiting match (creator only)
router.post('/matches/:id/cancel', auth, async (req, res, next) => {
  logEntry(req, 'POST /api/games/matches/:id/cancel');
  try {
    await gameCtrl.cancelMatch(req, res);
    if (!res.headersSent) return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Request that the server simulate an opponent and join the waiting match
router.post('/matches/:id/simulate', auth, async (req, res, next) => {
  logEntry(req, 'POST /api/games/matches/:id/simulate');
  try {
    await gameCtrl.simulateOpponent(req, res);
    if (!res.headersSent) return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
