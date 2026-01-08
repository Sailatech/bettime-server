// src/controllers/historyController.js
// Match history controller with SSE and optional in-memory simulator integration.
// - Returns public match rows for API consumers
// - SSE endpoint broadcasts real-time updates to connected clients
// - In-memory simulator (optional) generates simulated matches and publishes them directly to SSE clients
// - getRecentMatches merges recent simulated matches (in-memory) with DB rows so polling clients see simulated activity
//
// Enable in-memory simulator by setting START_IN_MEMORY_SIMULATOR=true in the server environment.
// NOTE: Running the simulator in-process is intended for dev/staging only unless you explicitly allow it in production.

const path = require('path');
const { getPool } = require('../config/db');
const matchModel = require('../models/matchModel');
const userModel = require('../models/userModel');

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;
const SSE_PING_MS = 25000;

// SSE clients set: each item { id: string, res: http.ServerResponse }
const sseClients = new Set();

// In-memory buffer for recent simulated matches (public rows). Newest first.
const simulatedBuffer = [];
const SIM_BUFFER_MAX = 50; // keep a short buffer to merge into recent feed

// Helper: send SSE event
function sendSse(res, event, data, id) {
  try {
    if (id !== undefined && id !== null) res.write(`id: ${id}\n`);
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    // ignore write errors
  }
}

// Broadcast a public match row to all connected SSE clients
function broadcastMatchUpdate(publicRow) {
  if (!publicRow) return;
  for (const client of sseClients) {
    try {
      sendSse(client.res, 'match:update', publicRow, publicRow.id || null);
    } catch (e) {
      // ignore per-client errors
    }
  }
}

// Add a simulated public row to the in-memory buffer (newest first)
function pushSimulatedBuffer(publicRow) {
  if (!publicRow) return;
  simulatedBuffer.unshift(publicRow);
  if (simulatedBuffer.length > SIM_BUFFER_MAX) simulatedBuffer.length = SIM_BUFFER_MAX;
}

// Bulk fetch users by ids using a single query
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
    status: row.status || null,
    // preserve any simulated flag if present
    _simulated: row._simulated || row.simulated || false
  };
}

// Resolve display names for rows using bulk user lookup
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

      // Normalize winner: numeric id -> 'creator'/'opponent' when possible
      if (out.winner != null) {
        const w = String(out.winner).trim();
        if (/^\d+$/.test(w)) {
          const wid = Number(w);
          if (out.creator_id && Number(out.creator_id) === wid) out.winner = 'creator';
          else if (out.opponent_id && Number(out.opponent_id) === wid) out.winner = 'opponent';
          else out.winner = w;
        } else {
          out.winner = w.toLowerCase();
        }
      }
    } catch (e) {
      // swallow mapping errors
    }
    return out;
  });
}

/**
 * GET /api/history/recent
 * Merge DB recent rows with in-memory simulated rows so polling clients see simulated activity.
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

      // Merge simulatedBuffer (newest first) with DB rows, dedupe by id, and cap to limit
      const merged = [];
      const seen = new Set();

      // include simulated rows first
      for (const s of simulatedBuffer) {
        if (merged.length >= limit) break;
        const sid = s && s.id ? String(s.id) : null;
        if (sid && seen.has(sid)) continue;
        if (sid) seen.add(sid);
        merged.push(s);
      }

      // then include DB rows
      for (const r of publicRows) {
        if (merged.length >= limit) break;
        const rid = r && r.id ? String(r.id) : null;
        if (rid && seen.has(rid)) continue;
        if (rid) seen.add(rid);
        merged.push(r);
      }

      return res.json({ matches: merged, meta: { limit, offset, count: merged.length } });
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
 * GET /api/history/matches
 * List matches for authenticated user (unchanged)
 */
async function listUserMatches(req, res) {
  try {
    const user = req.user;
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit || DEFAULT_LIMIT)));
    const offset = Math.max(0, Number(req.query.offset || 0));

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
 * Return single match; owners/admins get full row, others get public row
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
        const resolved = (await resolveNamesForRows([m]))[0];
        return res.json({ match: resolved || toPublicMatchRow(m) });
      }

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
 * GET /api/history/matches/:id/moves
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
 * SSE stream endpoint
 * GET /api/history/stream?matchId=...
 */
async function streamMatchHistory(req, res) {
  try {
    // optional auth check can be added by middleware before this handler
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('\n');

    // optional initial snapshot for a specific match
    const matchId = req.query && req.query.matchId ? Number(req.query.matchId) : null;
    if (matchId && Number.isInteger(matchId) && matchId > 0) {
      try {
        const dbConn = await matchModel.getConnection();
        const m = await matchModel.getMatchById(dbConn, matchId);
        if (dbConn && typeof dbConn.release === 'function') dbConn.release();
        if (m) {
          const publicRow = (await resolveNamesForRows([m]))[0];
          sendSse(res, 'match:init', publicRow, publicRow.id || null);
        } else {
          sendSse(res, 'match:init', { id: matchId }, matchId);
        }
      } catch (e) {
        console.warn('streamMatchHistory snapshot error', e && e.message ? e.message : e);
      }
    }

    // register client
    const clientId = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    const client = { id: clientId, res };
    sseClients.add(client);

    // ping to keep connection alive
    const ping = setInterval(() => {
      try {
        res.write(`event: ping\n`);
        res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      } catch (e) {}
    }, SSE_PING_MS);

    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(client);
      try { res.end(); } catch (e) {}
    });
  } catch (err) {
    console.error('streamMatchHistory error', err && err.message ? err.message : err);
    try { res.status(500).end(); } catch (_) {}
  }
}

/**
 * Internal publish endpoint for other services (protected by route middleware)
 * POST /api/history/publish { match: {...} }
 */
async function publishMatchUpdate(req, res) {
  try {
    const payload = req.body && req.body.match ? req.body.match : req.body;
    if (!payload) return res.status(400).json({ error: 'Missing match payload' });

    const publicRow = {
      id: payload.id,
      creator_id: payload.creator_id || null,
      creator_display_name: payload.creator_display_name || payload.creator_username || null,
      opponent_id: payload.opponent_id || null,
      opponent_display_name: payload.opponent_display_name || payload.opponent_username || null,
      bet_amount: payload.bet_amount != null ? Number(payload.bet_amount) : null,
      timestamp: payload.updated_at || payload.created_at || Date.now(),
      winner: payload.winner != null ? payload.winner : null,
      status: payload.status || null,
      _simulated: payload._simulated || payload.simulated || false
    };

    // broadcast and also push to simulated buffer if flagged simulated
    broadcastMatchUpdate(publicRow);
    if (publicRow._simulated) pushSimulatedBuffer(publicRow);

    return res.json({ ok: true });
  } catch (e) {
    console.error('publishMatchUpdate error', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Server error' });
  }
}

/* ---------------------------
   In-memory simulator integration
   --------------------------- */

let simRunner = null;
let simModule = null;

// Try to require the in-memory simulator module if present
try {
  simModule = require(path.join(__dirname, '..', 'scripts', 'simulateMatchesInMemory.js'));
} catch (e) {
  // module optional; log at debug level
  // console.warn('simulateMatchesInMemory module not found; in-memory simulator disabled.');
  simModule = null;
}

// Handler that simulator will call with payloads { type, match }
function handleSimulatorPayload(payload) {
  try {
    if (!payload) return;
    const match = payload.match || payload;
    const publicRow = {
      id: match.id,
      creator_id: match.creator_id || null,
      creator_display_name: match.creator_display_name || match.creator_username || null,
      opponent_id: match.opponent_id || null,
      opponent_display_name: match.opponent_display_name || match.opponent_username || null,
      bet_amount: match.bet_amount != null ? Number(match.bet_amount) : null,
      timestamp: match.updated_at || match.created_at || Date.now(),
      winner: match.winner != null ? match.winner : null,
      status: match.status || null,
      _simulated: true
    };

    // broadcast to SSE clients and push to buffer
    broadcastMatchUpdate(publicRow);
    pushSimulatedBuffer(publicRow);
  } catch (e) {
    console.warn('handleSimulatorPayload error', e && e.message ? e.message : e);
  }
}

// Optionally start in-memory simulator in-process (guarded by env var)
(async function maybeStartInMemorySimulator() {
  try {
    const startSim = String(process.env.START_IN_MEMORY_SIMULATOR || '').toLowerCase();
    if (startSim === 'true' || startSim === '1') {
      // avoid starting in production unless explicitly allowed
      if (process.env.NODE_ENV === 'production' && String(process.env.START_IN_MEMORY_SIMULATOR_IN_PROD || '').toLowerCase() !== 'true') {
        console.warn('START_IN_MEMORY_SIMULATOR requested but NODE_ENV=production and START_IN_MEMORY_SIMULATOR_IN_PROD not true. Skipping.');
        return;
      }

      if (!simModule || typeof simModule.startSimulator !== 'function') {
        console.warn('In-memory simulator module not available; ensure scripts/simulateMatchesInMemory.js exists and exports startSimulator.');
        return;
      }

      if (simRunner) return; // already started

      const simOptions = {
        intervalMs: Number(process.env.SIM_INTERVAL_MS || 60 * 1000),
        resolveDelayMs: Number(process.env.SIM_RESOLVE_DELAY_MS || 5 * 1000),
        minStake: Number(process.env.SIM_MIN_STAKE || 10),
        maxStake: Number(process.env.SIM_MAX_STAKE || 2000),
        botCount: Number(process.env.SIM_BOT_COUNT || 30),
        namePool: undefined // optional: pass custom pool via env or code
      };

      try {
        const runner = await simModule.startSimulator(handleSimulatorPayload, simOptions);
        simRunner = runner;
        console.log('In-memory simulator started in-process.');
        // ensure graceful shutdown stops simulator
        process.on('SIGINT', () => { try { simRunner && simRunner.stop(); } catch (e) {} });
        process.on('SIGTERM', () => { try { simRunner && simRunner.stop(); } catch (e) {} });
      } catch (e) {
        console.warn('Failed to start in-memory simulator', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('maybeStartInMemorySimulator error', e && e.message ? e.message : e);
  }
})();

/* Export controller functions */
module.exports = {
  listUserMatches,
  getMatchHistory,
  getMatchMoves,
  getRecentMatches,
  streamMatchHistory,
  publishMatchUpdate
};
