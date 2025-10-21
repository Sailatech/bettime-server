// routes/games.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const gameCtrl = require('../controllers/gameController');

function safeAuthPreview(header) {
  try { return String(header || '').slice(0, 32); } catch (_) { return null; }
}

function logEntry(req, action) {
  try {
    console.log(`${new Date().toISOString()} - ROUTE ${action}`, {
      path: req.originalUrl,
      method: req.method,
      userId: req.user?.id ?? null,
      params: req.params,
      // shallow copy of body for logs (avoid very large payloads)
      body: req.body && Object.keys(req.body).length ? req.body : null,
      authPreview: safeAuthPreview(req.headers?.authorization)
    });
  } catch (e) {
    console.error('logEntry failed', e && e.stack ? e.stack : e);
  }
}

/**
 * Helper wrapper to call controller functions that accept (req,res)
 * Ensures: errors are forwarded to next, unhandled rejections are caught,
 * and if the controller callback did not send a response we return a 500.
 */
function wrapHandler(actionName, handler) {
  return async (req, res, next) => {
    logEntry(req, actionName);
    try {
      await handler(req, res);
      if (!res.headersSent) {
        const msg = `Handler ${actionName} finished without sending a response`;
        console.warn(msg);
        // Include stack in non-production for faster debugging
        if (process.env.NODE_ENV === 'production') return res.status(500).json({ error: 'Server error' });
        return res.status(500).json({ error: 'Server error', detail: msg });
      }
    } catch (err) {
      console.error(`${actionName} error`, err && err.stack ? err.stack : err);
      next(err);
    }
  };
}

// Create a match or join an existing waiting match with same stake
router.post('/matches', auth, wrapHandler('POST /api/games/matches', gameCtrl.createMatch));

// Explicitly join a specific match
router.post('/matches/:id/join', auth, wrapHandler('POST /api/games/matches/:id/join', gameCtrl.joinMatch));

// Play a move on a match
router.post('/matches/:id/move', auth, wrapHandler('POST /api/games/matches/:id/move', gameCtrl.playMove));

// Get match state and moves
router.get('/matches/:id', auth, wrapHandler('GET /api/games/matches/:id', gameCtrl.getMatch));

// Cancel a waiting match (creator only)
router.post('/matches/:id/cancel', auth, wrapHandler('POST /api/games/matches/:id/cancel', gameCtrl.cancelMatch));

// Request that the server simulate an opponent and join the waiting match
router.post('/matches/:id/simulate', auth, wrapHandler('POST /api/games/matches/:id/simulate', gameCtrl.simulateOpponent));

module.exports = router;
