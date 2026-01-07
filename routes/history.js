// routes/history.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const historyCtrl = require('../controllers/historyController');

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
        if (process.env.NODE_ENV === 'production') return res.status(500).json({ error: 'Server error' });
        return res.status(500).json({ error: 'Server error', detail: msg });
      }
    } catch (err) {
      console.error(`${actionName} error`, err && err.stack ? err.stack : err);
      next(err);
    }
  };
}

/**
 * History routes
 *
 * - GET /history/matches
 *     List paginated match history for the authenticated user.
 *     Query params: ?limit=50&offset=0&status=finished
 *
 * - GET /history/matches/:id
 *     Get a single match history record (details) by id (must belong to user or be admin).
 *
 * - GET /history/matches/:id/moves
 *     Get moves for a specific match (paginated).
 *
 * - GET /history/recent
 *     Get recent matches across the platform (public) for feed/leaderboard.
 *
 * - GET /history/stream/:id
 *     Optional: SSE stream for historical updates for a match (if you want realtime playback).
 */

/* List authenticated user's match history */
router.get(
  '/matches',
  auth,
  wrapHandler('GET /api/history/matches', historyCtrl.listUserMatches)
);

/* Get a single match history record (details) */
router.get(
  '/matches/:id',
  auth,
  wrapHandler('GET /api/history/matches/:id', historyCtrl.getMatchHistory)
);

/* Get moves for a specific match (paginated) */
router.get(
  '/matches/:id/moves',
  auth,
  wrapHandler('GET /api/history/matches/:id/moves', historyCtrl.getMatchMoves)
);

/* Recent public matches (feed) */
router.get(
  '/recent',
  auth,
  wrapHandler('GET /api/history/recent', historyCtrl.getRecentMatches)
);

/* Optional SSE stream for match history playback (if implemented in controller) */
router.get(
  '/stream/:id',
  auth,
  wrapHandler('GET /api/history/stream/:id', historyCtrl.streamMatchHistory)
);

module.exports = router;
