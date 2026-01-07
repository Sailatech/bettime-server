// src/controllers/historyController.js
// Controller for match history endpoints: listUserMatches, getMatchHistory, getMatchMoves, getRecentMatches, streamMatchHistory
// Style and error handling similar to your other controllers.

const { getPool } = require('../config/db');
const matchModel = require('../models/matchModel');

async function listUserMatches(req, res) {
  try {
    const user = req.user;
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

    const limit = Math.min(200, Number(req.query.limit || 50));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const db = await matchModel.getConnection();
    try {
      const rows = await matchModel.getUserMatches(db, user.id, { limit, offset });
      db.release && db.release();
      return res.json({ matches: rows || [] });
    } catch (e) {
      try { db && db.release && db.release(); } catch (_) {}
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
    if (!id) return res.status(400).json({ error: 'Missing match id' });

    const db = await matchModel.getConnection();
    try {
      const m = await matchModel.getMatchById(db, id);
      db.release && db.release();
      if (!m) return res.status(404).json({ error: 'Match not found' });

      // Only allow owner or opponent or admin to view full details
      const user = req.user;
      const isOwner = user && (user.id === m.creator_id || user.id === m.opponent_id);
      const isAdmin = user && (user.role === 'admin' || user.isAdmin);
      if (!isOwner && !isAdmin) {
        // return limited public info
        const publicRow = {
          id: m.id,
          creator_id: m.creator_id,
          opponent_id: m.opponent_id,
          status: m.status,
          bet_amount: m.bet_amount,
          created_at: m.created_at,
          updated_at: m.updated_at,
          winner: m.winner
        };
        return res.json({ match: publicRow });
      }

      return res.json({ match: m });
    } catch (e) {
      try { db && db.release && db.release(); } catch (_) {}
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
    if (!matchId) return res.status(400).json({ error: 'Missing match id' });

    const limit = Math.min(1000, Number(req.query.limit || 100));
    const offset = Math.max(0, Number(req.query.offset || 0));

    // We assume a `moves` table exists with columns: id, match_id, user_id, symbol, position, created_at
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
      return res.json({ moves: rows || [] });
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
    const limit = Math.min(100, Number(req.query.limit || 12));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const pool = await getPool();
    try {
      // Return recent finished or playing matches for feed
      const [rows] = await pool.query(
        `SELECT id, creator_id, opponent_id, creator_display_name, opponent_display_name,
                status, winner, bet_amount, created_at, updated_at
         FROM matches
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
        [limit, offset]
      );
      return res.json({ matches: rows || [] });
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
 * SSE stream for match history playback (optional)
 * GET /api/history/stream/:id
 */
async function streamMatchHistory(req, res) {
  try {
    const matchId = req.params.id;
    if (!matchId) return res.status(400).end('Missing match id');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('\n');

    // send initial snapshot
    try {
      const db = await matchModel.getConnection();
      const m = await matchModel.getMatchById(db, Number(matchId));
      db.release && db.release();
      if (m) {
        res.write(`event: match:init\n`);
        res.write(`data: ${JSON.stringify(m)}\n\n`);
      }
    } catch (e) {
      // ignore
    }

    // periodic ping
    const pingId = setInterval(() => {
      try { res.write(`event: ping\n`); res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`); } catch (e) {}
    }, 25000);

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
