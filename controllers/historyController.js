// src/controllers/historyController.js
// History controller with SSE and optional in-process simulator start.
// If START_SIMULATOR_IN_PROCESS is "true", the controller will require and start the simulator module.
// Ensure this is only enabled in controlled environments (dev/staging) or behind proper safeguards.

const { getPool } = require('../config/db');
const matchModel = require('../models/matchModel');
const userModel = require('../models/userModel');

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;
const SSE_PING_MS = 25000;
const REDIS_CHANNEL = process.env.MATCHES_PUBSUB_CHANNEL || 'matches:updates';

let redisSubscriber = null;
let sseClients = new Set(); // each item: { id: string, res: http.ServerResponse }

/* SSE helper */
function sendSse(res, event, data, id) {
  try {
    if (id) res.write(`id: ${id}\n`);
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {}
}

function broadcastMatchUpdate(payload) {
  if (!payload) return;
  for (const client of sseClients) {
    try {
      sendSse(client.res, 'match:update', payload, payload.id || null);
    } catch (e) {}
  }
}

/* Redis subscriber init */
async function initRedisSubscriber() {
  const url = process.env.REDIS_URL || process.env.REDIS;
  if (!url) return;
  try {
    const IORedis = require('ioredis');
    redisSubscriber = new IORedis(url, { lazyConnect: true });
    redisSubscriber.on('error', (err) => {
      console.warn('Redis subscriber error', err && err.message ? err.message : err);
    });
    await redisSubscriber.connect();
    await redisSubscriber.subscribe(REDIS_CHANNEL);
    redisSubscriber.on('message', (channel, message) => {
      if (!message) return;
      try {
        const parsed = JSON.parse(message);
        const match = parsed.match || parsed;
        if (match) {
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
            _simulated: !!match._simulated || !!match.simulated || false
          };
          broadcastMatchUpdate(publicRow);
        }
      } catch (e) {
        console.warn('Failed to parse redis message', e && e.message ? e.message : e);
      }
    });
    console.log('Redis subscriber connected to', REDIS_CHANNEL);
  } catch (e) {
    console.warn('Could not initialize Redis subscriber for match updates:', e && e.message ? e.message : e);
    redisSubscriber = null;
  }
}

/* Bulk user fetch */
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
    status: row.status || null
  };
}

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
    } catch (e) {}
    return out;
  });
}

/* Controller endpoints */

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

/* SSE stream endpoint */
async function streamMatchHistory(req, res) {
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('\n');

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

    const clientId = Date.now() + '-' + Math.random().toString(36).slice(2, 9);
    const client = { id: clientId, res };
    sseClients.add(client);

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

/* Internal publish endpoint (protect this route) */
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

    // Broadcast locally
    broadcastMatchUpdate(publicRow);

    // Also publish to Redis for other instances (best-effort)
    try {
      if (redisSubscriber && typeof redisSubscriber.publish === 'function') {
        await redisSubscriber.publish(REDIS_CHANNEL, JSON.stringify({ match: publicRow }));
      }
    } catch (e) {
      // ignore
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('publishMatchUpdate error', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Server error' });
  }
}

/* Initialize Redis subscriber on module load (best-effort) */
initRedisSubscriber().catch((e) => {
  console.warn('initRedisSubscriber failed', e && e.message ? e.message : e);
});

/* Optionally start simulator in-process (guarded) */
(async function maybeStartSimulatorInProcess() {
  try {
    const startInProcess = String(process.env.START_SIMULATOR_IN_PROCESS || '').toLowerCase();
    if (startInProcess === 'true' || startInProcess === '1') {
      // Only allow in non-production by default unless explicitly allowed
      const allowInProd = String(process.env.START_SIMULATOR_IN_PROD || '').toLowerCase() === 'true';
      if (process.env.NODE_ENV === 'production' && !allowInProd) {
        console.warn('START_SIMULATOR_IN_PROCESS requested but NODE_ENV=production and START_SIMULATOR_IN_PROD not true. Skipping.');
        return;
      }

      // require simulator module and start it
      try {
        const simModule = require(path.join(__dirname, '..', 'scripts', 'simulateMatches.js'));
        if (simModule && typeof simModule.startSimulator === 'function') {
          const simOptions = {
            // pass through useful env vars
            SIM_INTERVAL_MS: Number(process.env.SIM_INTERVAL_MS || 60000),
            SIM_RESOLVE_DELAY_MS: Number(process.env.SIM_RESOLVE_DELAY_MS || 5000),
            SIM_MIN_STAKE: Number(process.env.SIM_MIN_STAKE || 10),
            SIM_MAX_STAKE: Number(process.env.SIM_MAX_STAKE || 2000),
            SIM_BOT_COUNT: Number(process.env.SIM_BOT_COUNT || 100),
            REDIS_URL: process.env.REDIS_URL || process.env.REDIS,
            REDIS_CHANNEL: process.env.MATCHES_PUBSUB_CHANNEL || REDIS_CHANNEL,
            HIT_PUBLISH_URL: process.env.HIT_PUBLISH_URL || null,
            INTERNAL_SECRET: process.env.INTERNAL_PUBLISH_SECRET || ''
          };
          const simController = await simModule.startSimulator(simOptions);
          console.log('Simulator started in-process.');
          // store stop handle if needed
          if (simController && typeof simController.stop === 'function') {
            process.on('SIGINT', () => { try { simController.stop(); } catch (e) {} });
            process.on('SIGTERM', () => { try { simController.stop(); } catch (e) {} });
          }
        } else {
          console.warn('Simulator module found but startSimulator not exported.');
        }
      } catch (e) {
        console.warn('Failed to start simulator in-process:', e && e.message ? e.message : e);
      }
    }
  } catch (e) {
    console.warn('maybeStartSimulatorInProcess error', e && e.message ? e.message : e);
  }
})();

module.exports = {
  listUserMatches,
  getMatchHistory,
  getMatchMoves,
  getRecentMatches,
  streamMatchHistory,
  publishMatchUpdate
};
