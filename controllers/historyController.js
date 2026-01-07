// src/controllers/historyController.js
// Production-ready match history controller that works with the backend simulator.
// - Returns minimal public fields: id, creator/opponent display names, bet_amount, timestamp, winner, status
// - Resolves names in bulk with a single DB query for efficiency
// - Validates inputs, uses try/finally to release connections, and returns pagination metadata
// - SSE endpoint sends public snapshot and supports optional token check via req.user (if your auth middleware sets it)

const { getPool } = require('../config/db');
const matchModel = require('../models/matchModel');
const userModel = require('../models/userModel');

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

function toPublicMatchRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    creator_id: row.creator_id || null,
    creator_display_name: row.creator_display_name || row.creator_username || null,
    opponent_id: row.opponent_id || null,
    opponent_display_name: row.opponent_display_name || row.opponent_username || null,
    bet_amount: row.bet_amount != null ? Number(row.bet_amount) : null,
    timestamp: row.updated_at || row.created_at || row.updatedAt || row.createdAt || null,
    winner: row.winner != null ? row.winner : null,
    status: row.status || null
  };
}

/**
 * Bulk fetch users by ids using a single query for efficiency.
 * Returns a map: { [id]: { id, username, displayName } }
 */
async function fetchUsersByIds(ids = []) {
  const map = {};
  if (!Array.isArray(ids) || ids.length === 0) return map;
  const pool = await getPool();
  const placeholders = ids.map(() => '?').join(',');
  const sql = `SELECT id, username, display_name AS displayName FROM users WHERE id IN (${placeholders})`;
  const [rows] = await pool.query(sql, ids);
  (rows || []).forEach((r) => {
    map[Number(r.id)] = { id: Number(r.id), username: r.username, displayName: r.displayName };
  });
  return map;
}

/**
 * Resolve display names for an array of match rows using bulk user lookup.
 * If a row already has creator_display_name/opponent_display_name, it is preserved.
 */
async function resolveNamesForRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const ids = new Set();
  rows.forEach((r) => {
    if (r.creator_id) ids.add(Number(r.creator_id));
    if (r.opponent_id) ids.add(Number(r.opponent_id));
  });
  const idList = Array.from(ids).filter(Boolean);
  const usersById = await fetchUsersByIds(idList);

  return rows.map((r) => {
    const out = toPublicMatchRow(r);
    try {
      if ((!out.creator_display_name || out.creator_display_name === null) && out.creator_id) {
        const cu = usersById[Number(out.creator_id)];
        if (cu) out.creator_display_name = cu.displayName || cu.username || ('#' + out.creator_id);
      }
      if ((!out.opponent_display_name || out.opponent_display_name === null) && out.opponent_id) {
        const ou = usersById[Number(out.opponent_id)];
        if (ou) out.opponent_display_name = ou.displayName || ou.username || ('#' + out.opponent_id);
      }

      // Normalize winner: if numeric id, convert to 'creator' or 'opponent' when possible
      if (out.winner != null) {
        const w = String(out.winner).trim();
        if (/^\d+$/.test(w)) {
          const wid = Number(w);
          if (out.creator_id && Number(out.creator_id) === wid) out.winner = 'creator';
          else if (out.opponent_id && Number(out.opponent_id) === wid) out.winner = 'opponent';
          else out.winner = w; // keep numeric if it doesn't match
        } else {
          out.winner = w.toLowerCase();
        }
      }
    } catch (e) {
      // swallow mapping errors and return best-effort row
    }
    return out;
  });
}

/**
 * GET /api/history/user
 * List matches for the authenticated user (requires req.user)
 */
async function listUserMatches(req, res) {
  try {
    const user = req.user;
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit || DEFAULT_LIMIT)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    // Prefer model helper if available
    let dbConn = null;
    try {
      dbConn = await matchModel.getConnection();
      const rows = await matchModel.getUserMatches(dbConn, user.id, { limit, offset });
      if (dbConn && typeof dbConn.release === 'function') dbConn.release();
      const publicRows = await resolveNamesForRows(rows || []);
      return res.json({ matches: publicRows, meta: { limit, offset, count: publicRows.length } });
    } catch (e) {
      try { if (dbConn && typeof dbConn.release === 'function') dbConn.release(); } catch (_) {}
      console.error('listUserMatches error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('listUserMatches outer error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * GET /api/history/:id
 * Get a single match's public history. If the requester is owner or admin, return full details.
 */
async function getMatchHistory(req, res) {
  try {
    const id = Number(req.params.id || req.query.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid match id' });

    let dbConn = null;
    try {
      dbConn = await matchModel.getConnection();
      const m = await matchModel.getMatchById(dbConn, id);
      if (dbConn && typeof dbConn.release === 'function') dbConn.release();
      if (!m) return res.status(404).json({ error: 'Match not found' });

      const user = req.user;
      const isOwner = user && (Number(user.id) === Number(m.creator_id) || Number(user.id) === Number(m.opponent_id));
      const isAdmin = user && (user.role === 'admin' || user.isAdmin);

      if (!isOwner && !isAdmin) {
        // return limited public info
        const publicRow = toPublicMatchRow(m);
        const resolved = (await resolveNamesForRows([m]))[0];
        return res.json({ match: resolved || publicRow });
      }

      // Owner or admin: return full match row but normalize winner if numeric
      const full = Object.assign({}, m);
      if (full.winner != null && /^\d+$/.test(String(full.winner))) {
        const wid = Number(full.winner);
        if (Number(full.creator_id) === wid) full.winner = 'creator';
        else if (Number(full.opponent_id) === wid) full.winner = 'opponent';
      }
      return res.json({ match: full });
    } catch (e) {
      try { if (dbConn && typeof dbConn.release === 'function') dbConn.release(); } catch (_) {}
      console.error('getMatchHistory error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('getMatchHistory outer error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * GET /api/history/moves/:id
 * Return moves for a match (if you store moves). This endpoint is unchanged except for validation.
 */
async function getMatchMoves(req, res) {
  try {
    const matchId = Number(req.params.id || req.query.id);
    if (!Number.isInteger(matchId) || matchId <= 0) return res.status(400).json({ error: 'Missing or invalid match id' });

    const limit = Math.min(1000, Number(req.query.limit || 100));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const pool = await getPool();
    try {
      const [rows] = await pool.query(
        `SELECT id, match_id, user_id, username, symbol, position, created_at
         FROM moves
         WHERE match_id = ?
         ORDER BY id ASC
         LIMIT ? OFFSET ?`,
        [matchId, limit, offset]
      );
      return res.json({ moves: rows || [], meta: { limit, offset, count: (rows || []).length } });
    } catch (e) {
      console.error('getMatchMoves error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('getMatchMoves outer error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * GET /api/history/recent
 * Return recent matches for feed. Works well with the simulator which inserts matches into `matches`.
 */
async function getRecentMatches(req, res) {
  try {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit || DEFAULT_LIMIT)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const pool = await getPool();
    try {
      const [rows] = await pool.query(
        `SELECT id,
                creator_id, creator_display_name, creator_username,
                opponent_id, opponent_display_name, opponent_username,
                bet_amount, status, winner,
                created_at, updated_at
         FROM matches
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
        [limit, offset]
      );

      const publicRows = await resolveNamesForRows(rows || []);
      return res.json({ matches: publicRows, meta: { limit, offset, count: publicRows.length } });
    } catch (e) {
      console.error('getRecentMatches error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('getRecentMatches outer error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * SSE stream for match history playback
 * GET /api/history/stream/:id?token=...
 *
 * Notes:
 * - This implementation sends a single initial snapshot (public fields) and keeps the connection alive with pings.
 * - For production, integrate with your app's auth (req.user) or require a token query param and validate it.
 * - For real-time updates, wire this to your pub/sub (Redis, Postgres NOTIFY) and push events when matches change.
 */
async function streamMatchHistory(req, res) {
  try {
    const matchIdRaw = req.params.id;
    if (!matchIdRaw) return res.status(400).end('Missing match id');

    // Optional: simple auth check (if you use req.user from middleware)
    // if (!req.user) return res.status(401).end('Unauthorized');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    // initial newline to establish stream
    res.write('\n');

    // send initial snapshot (public fields only)
    try {
      const dbConn = await matchModel.getConnection();
      const m = await matchModel.getMatchById(dbConn, Number(matchIdRaw));
      if (dbConn && typeof dbConn.release === 'function') dbConn.release();
      if (m) {
        const publicRow = (await resolveNamesForRows([m]))[0];
        res.write(`event: match:init\n`);
        res.write(`data: ${JSON.stringify(publicRow)}\n\n`);
      } else {
        res.write(`event: match:init\n`);
        res.write(`data: ${JSON.stringify({ id: Number(matchIdRaw) })}\n\n`);
      }
    } catch (e) {
      // ignore snapshot errors but log
      console.warn('streamMatchHistory snapshot error', e && e.message ? e.message : e);
    }

    // periodic ping to keep connection alive
    const pingId = setInterval(() => {
      try {
        res.write(`event: ping\n`);
        res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      } catch (e) {
        // ignore write errors
      }
    }, 25000);

    // Clean up on client disconnect
    req.on('close', () => {
      clearInterval(pingId);
      try { res.end(); } catch (e) {}
    });
  } catch (err) {
    console.error('streamMatchHistory error', err && err.message ? err.message : err);
    try { res.status(500).end(); } catch (_) {}
  }
}

module.exports = {
  listUserMatches,
  getMatchHistory,
  getMatchMoves,
  getRecentMatches,
  streamMatchHistory
};
