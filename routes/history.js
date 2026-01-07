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
 * Internal publish protection middleware
 * - If INTERNAL_PUBLISH_SECRET is set, require X-INTERNAL-SECRET header to match.
 * - Otherwise allow only requests from localhost (127.0.0.1 / ::1).
 */
function requireInternalSecret(req, res, next) {
  try {
    const secret = process.env.INTERNAL_PUBLISH_SECRET || '';
    if (secret) {
      const header = req.get('X-INTERNAL-SECRET') || '';
      if (header === secret) return next();
      return res.status(403).json({ error: 'Forbidden' });
    }
    // no secret configured: allow only localhost by default
    const ip = (req.ip || req.connection?.remoteAddress || '').replace('::ffff:', '');
    if (ip === '127.0.0.1' || ip === '::1') return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) {
    console.error('requireInternalSecret error', e && e.stack ? e.stack : e);
    return res.status(500).json({ error: 'Server error' });
  }
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
 * - GET /history/stream
 *     SSE stream for match updates. Optional query param: ?matchId=123
 *
 * - POST /history/publish
 *     Internal endpoint for services (simulator) to publish match updates to SSE clients.
 *     Protected by INTERNAL_PUBLISH_SECRET or localhost-only if secret not set.
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

/* SSE stream for match updates (optional matchId query param) */
router.get(
  '/stream',
  auth,
  wrapHandler('GET /api/history/stream', historyCtrl.streamMatchHistory)
);

/* Internal publish endpoint for simulator or other internal services */
router.post(
  '/publish',
  requireInternalSecret,
  wrapHandler('POST /api/history/publish', historyCtrl.publishMatchUpdate)
);

module.exports = router;
