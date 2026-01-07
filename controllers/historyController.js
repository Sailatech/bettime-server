// controllers/matchController.js
// Controller for matches: create/join/play/cancel/get/history + SSE realtime updates and simple bot simulation.
// Style and error handling follow controllers/authController.js

const { getPool } = require('../config/db');
const matchModel = require('../models/historyModel');
const userModel = require('../models/userModel'); // optional, if you have one
const { v4: uuidv4 } = require('uuid');

//
// In-memory SSE clients and simple bot timers.
// In production you would use a pub/sub (Redis, etc.) so multiple node instances can broadcast.
//
const sseClients = new Map(); // key: matchId -> Set of res objects
const botTimers = new Map();  // key: matchId -> timeoutId

// Game constants (keep in sync with client)
const BOARD_ROWS = 6;
const BOARD_COLS = 6;
const BOARD_CELLS = BOARD_ROWS * BOARD_COLS;
const WIN_LENGTH = 4;
const EMPTY_CELL = '_';
const EMPTY_BOARD = EMPTY_CELL.repeat(BOARD_CELLS);

// Utility: generate winning lines (same logic as client)
function generateLines(rows, cols, winLen) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c + winLen - 1 < cols; c++) {
      const seq = [];
      for (let k = 0; k < winLen; k++) seq.push(r * cols + c + k);
      lines.push(seq);
    }
  }
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r + winLen - 1 < rows; r++) {
      const seq = [];
      for (let k = 0; k < winLen; k++) seq.push((r + k) * cols + c);
      lines.push(seq);
    }
  }
  for (let r = 0; r + winLen - 1 < rows; r++) {
    for (let c = 0; c + winLen - 1 < cols; c++) {
      const seq = [];
      for (let k = 0; k < winLen; k++) seq.push((r + k) * cols + (c + k));
      lines.push(seq);
    }
  }
  for (let r = 0; r + winLen - 1 < rows; r++) {
    for (let c = winLen - 1; c < cols; c++) {
      const seq = [];
      for (let k = 0; k < winLen; k++) seq.push((r + k) * cols + (c - k));
      lines.push(seq);
    }
  }
  return lines;
}
const LINES = generateLines(BOARD_ROWS, BOARD_COLS, WIN_LENGTH);

function checkBoard(boardStr) {
  const b = (boardStr || EMPTY_BOARD).split('');
  for (let li = 0; li < LINES.length; li++) {
    const line = LINES[li];
    const first = b[line[0]];
    if (!first || first === EMPTY_CELL) continue;
    let allSame = true;
    for (let i = 1; i < line.length; i++) {
      if (b[line[i]] !== first) { allSame = false; break; }
    }
    if (allSame) return { winner: first, isDraw: false, line };
  }
  const isDraw = b.every(function (c) { return c !== EMPTY_CELL; });
  return { winner: null, isDraw: isDraw };
}

// SSE helpers
function sendSseEvent(matchId, event, data) {
  const set = sseClients.get(String(matchId));
  if (!set || !set.size) return;
  const payload = typeof data === 'string' ? data : JSON.stringify(data || {});
  for (const res of Array.from(set)) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${payload}\n\n`);
    } catch (e) {
      // ignore broken clients; cleanup later
    }
  }
}

function addSseClient(matchId, res) {
  const key = String(matchId);
  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);
}

function removeSseClient(matchId, res) {
  const key = String(matchId);
  const set = sseClients.get(key);
  if (!set) return;
  set.delete(res);
  if (!set.size) sseClients.delete(key);
}

// Simple bot move generator: pick random empty cell
function pickRandomEmptyCell(boardStr) {
  const arr = String(boardStr || EMPTY_BOARD).padEnd(BOARD_CELLS, EMPTY_CELL).slice(0, BOARD_CELLS).split('');
  const empties = arr.map((v, i) => v === EMPTY_CELL ? i : -1).filter(i => i >= 0);
  if (!empties.length) return null;
  return empties[Math.floor(Math.random() * empties.length)];
}

// Schedule a bot move for a match (if opponent_is_bot or creator_is_bot)
async function scheduleBotMove(matchId, delayMs = 1200) {
  // clear existing timer
  if (botTimers.has(String(matchId))) {
    clearTimeout(botTimers.get(String(matchId)));
    botTimers.delete(String(matchId));
  }

  const t = setTimeout(async () => {
    botTimers.delete(String(matchId));
    let conn;
    try {
      conn = await matchModel.getConnection();
      await conn.beginTransaction();

      const m = await matchModel.getMatchById(conn, matchId, true);
      if (!m || m.status !== 'playing') {
        await conn.commit();
        conn.release && conn.release();
        return;
      }

      // determine which side is bot and whether it's their turn
      const creatorIsBot = !!m.creator_is_bot;
      const opponentIsBot = !!m.opponent_is_bot;
      const currentTurn = m.current_turn || 'X';
      const botIsX = creatorIsBot;
      const isBotTurn = (currentTurn === 'X' && botIsX) || (currentTurn === 'O' && !botIsX);
      if (!isBotTurn) {
        await conn.commit();
        conn.release && conn.release();
        return;
      }

      // pick a move
      const pos = pickRandomEmptyCell(m.board || EMPTY_BOARD);
      if (pos === null) {
        // no move possible -> draw
        await matchModel.finishMatch(conn, matchId, 'draw');
        await conn.commit();
        const updated = await matchModel.getMatchById(conn, matchId);
        sendSseEvent(matchId, 'match:update', updated);
        conn.release && conn.release();
        return;
      }

      // apply move locally: set symbol at pos
      const arr = String(m.board || EMPTY_BOARD).padEnd(BOARD_CELLS, EMPTY_CELL).slice(0, BOARD_CELLS).split('');
      const symbol = currentTurn; // 'X' or 'O'
      arr[pos] = symbol;
      const newBoard = arr.join('');

      // compute winner/draw
      const localResult = checkBoard(newBoard);
      let nextTurn = currentTurn === 'X' ? 'O' : 'X';
      let newStatus = 'playing';
      let winnerValue = null;
      if (localResult.winner) {
        newStatus = 'finished';
        // map symbol to creator/opponent
        if (localResult.winner === 'X') winnerValue = 'creator';
        else if (localResult.winner === 'O') winnerValue = 'opponent';
      } else if (localResult.isDraw) {
        newStatus = 'finished';
        winnerValue = 'draw';
      }

      await matchModel.playMove(conn, matchId, newBoard, nextTurn, { status: newStatus, winner: winnerValue });
      await conn.commit();

      // broadcast updated match
      const updated = await matchModel.getMatchById(await matchModel.getConnection(), matchId);
      sendSseEvent(matchId, 'match:update', updated);
    } catch (e) {
      try { if (conn) await conn.rollback(); } catch (_) {}
      console.error('[bot] error scheduling move for match', matchId, e && e.message);
    } finally {
      try { conn && conn.release && conn.release(); } catch (_) {}
    }
  }, delayMs);

  botTimers.set(String(matchId), t);
}

// Controller functions (to be used in routes)
async function createMatch(req, res) {
  try {
    const user = req.user;
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

    const { bet_amount, creator_display_name, creator_username, creator_is_bot } = req.body || {};
    const conn = await matchModel.getConnection();
    try {
      const matchId = await matchModel.createMatchRow(conn, user.id, {
        bet_amount: Number(bet_amount || 0),
        creator_display_name: creator_display_name || user.display_name || user.username,
        creator_username: creator_username || user.username,
        creator_is_bot: creator_is_bot ? 1 : 0
      });
      const created = await matchModel.getMatchById(conn, matchId);
      conn.release && conn.release();

      // If creator created a match and opponent is a bot (immediate), set opponent and start playing
      if (created && created.creator_is_bot && !created.opponent_id) {
        // schedule bot to join as opponent (simulate)
        setTimeout(async () => {
          let c;
          try {
            c = await matchModel.getConnection();
            await c.beginTransaction();
            // set opponent to a fake bot user id 0 (or null) and mark opponent_is_bot
            await matchModel.setOpponent(c, matchId, null, 'Bot', 'bot', 1);
            await c.commit();
            c.release && c.release();
            // schedule bot move
            scheduleBotMove(matchId, 1200);
            sendSseEvent(matchId, 'match:update', await matchModel.getMatchById(await matchModel.getConnection(), matchId));
          } catch (e) {
            try { if (c) await c.rollback(); } catch (_) {}
            console.error('auto-join bot error', e && e.message);
          } finally { try { c && c.release && c.release(); } catch (_) {} }
        }, 600);
      }

      // broadcast creation
      sendSseEvent(matchId, 'match:created', created);
      return res.json({ ok: true, match: created });
    } catch (e) {
      try { conn && conn.release && conn.release(); } catch (_) {}
      console.error('createMatch error', e && e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('createMatch outer error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function getMatch(req, res) {
  try {
    const matchId = Number(req.params.id || req.query.id);
    if (!matchId) return res.status(400).json({ error: 'Missing match id' });
    const db = await matchModel.getConnection();
    try {
      const m = await matchModel.getMatchById(db, matchId);
      db.release && db.release();
      if (!m) return res.status(404).json({ error: 'Match not found' });
      return res.json({ match: m });
    } catch (e) {
      try { db && db.release && db.release(); } catch (_) {}
      console.error('getMatch error', e && e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('getMatch outer error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function listUserMatches(req, res) {
  try {
    const user = req.user;
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const db = await matchModel.getConnection();
    try {
      const rows = await matchModel.getUserMatches(db, user.id, { limit, offset });
      db.release && db.release();
      return res.json({ matches: rows });
    } catch (e) {
      try { db && db.release && db.release(); } catch (_) {}
      console.error('listUserMatches error', e && e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('listUserMatches outer error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * Join a waiting match as opponent
 * POST /api/matches/:id/join
 */
async function joinMatch(req, res) {
  try {
    const user = req.user;
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });
    const matchId = Number(req.params.id);
    if (!matchId) return res.status(400).json({ error: 'Missing match id' });

    const conn = await matchModel.getConnection();
    try {
      await conn.beginTransaction();
      const m = await matchModel.getMatchById(conn, matchId, true);
      if (!m) { await conn.rollback(); conn.release && conn.release(); return res.status(404).json({ error: 'Match not found' }); }
      if (m.status !== 'waiting') { await conn.rollback(); conn.release && conn.release(); return res.status(400).json({ error: 'Match not available' }); }
      if (m.creator_id === user.id) { await conn.rollback(); conn.release && conn.release(); return res.status(400).json({ error: 'Cannot join your own match' }); }

      await matchModel.setOpponent(conn, matchId, user.id, user.display_name || user.username, user.username, 0);
      await conn.commit();
      conn.release && conn.release();

      // broadcast update
      const updated = await matchModel.getMatchById(await matchModel.getConnection(), matchId);
      sendSseEvent(matchId, 'match:update', updated);

      // if opponent is a bot (shouldn't be here), schedule bot move
      if (updated && updated.opponent_is_bot) scheduleBotMove(matchId, 1200);

      return res.json({ ok: true, match: updated });
    } catch (e) {
      try { if (conn) await conn.rollback(); } catch (_) {}
      try { conn && conn.release && conn.release(); } catch (_) {}
      console.error('joinMatch error', e && e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('joinMatch outer error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * Play a move
 * POST /api/matches/:id/play
 * body: { position: <int> }
 */
async function playMove(req, res) {
  try {
    const user = req.user;
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });
    const matchId = Number(req.params.id);
    const position = Number(req.body && req.body.position);
    if (!matchId || isNaN(position)) return res.status(400).json({ error: 'Missing match id or position' });
    if (position < 0 || position >= BOARD_CELLS) return res.status(400).json({ error: 'Invalid position' });

    const conn = await matchModel.getConnection();
    try {
      await conn.beginTransaction();
      const m = await matchModel.getMatchById(conn, matchId, true);
      if (!m) { await conn.rollback(); conn.release && conn.release(); return res.status(404).json({ error: 'Match not found' }); }
      if (m.status !== 'playing') { await conn.rollback(); conn.release && conn.release(); return res.status(400).json({ error: 'Match not active' }); }

      // determine player's symbol
      const meSymbol = (user.id === m.creator_id) ? 'X' : (user.id === m.opponent_id) ? 'O' : null;
      if (!meSymbol) { await conn.rollback(); conn.release && conn.release(); return res.status(403).json({ error: 'Not a participant' }); }
      if (m.current_turn !== meSymbol) { await conn.rollback(); conn.release && conn.release(); return res.status(400).json({ error: 'Not your turn' }); }

      const boardNow = String(m.board || EMPTY_BOARD).padEnd(BOARD_CELLS, EMPTY_CELL).slice(0, BOARD_CELLS).split('');
      if (boardNow[position] !== EMPTY_CELL) { await conn.rollback(); conn.release && conn.release(); return res.status(400).json({ error: 'Position already taken' }); }

      // apply move
      boardNow[position] = meSymbol;
      const newBoard = boardNow.join('');
      const localResult = checkBoard(newBoard);

      let nextTurn = meSymbol === 'X' ? 'O' : 'X';
      let newStatus = 'playing';
      let winnerValue = null;
      if (localResult.winner) {
        newStatus = 'finished';
        winnerValue = localResult.winner === 'X' ? 'creator' : 'opponent';
      } else if (localResult.isDraw) {
        newStatus = 'finished';
        winnerValue = 'draw';
      }

      const updated = await matchModel.playMove(conn, matchId, newBoard, nextTurn, { status: newStatus, winner: winnerValue });
      await conn.commit();
      conn.release && conn.release();

      // broadcast update
      sendSseEvent(matchId, 'match:update', updated);

      // if opponent is bot and match still playing, schedule bot move
      if (updated && updated.status === 'playing') {
        const opponentIsBot = !!updated.opponent_is_bot;
        const creatorIsBot = !!updated.creator_is_bot;
        const botTurn = (updated.current_turn === 'X' && creatorIsBot) || (updated.current_turn === 'O' && opponentIsBot);
        if (botTurn) scheduleBotMove(matchId, 900 + Math.floor(Math.random() * 1200));
      }

      return res.json({ ok: true, match: updated });
    } catch (e) {
      try { if (conn) await conn.rollback(); } catch (_) {}
      try { conn && conn.release && conn.release(); } catch (_) {}
      console.error('playMove error', e && e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('playMove outer error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * Cancel match (creator only)
 * POST /api/matches/:id/cancel
 */
async function cancelMatch(req, res) {
  try {
    const user = req.user;
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });
    const matchId = Number(req.params.id);
    if (!matchId) return res.status(400).json({ error: 'Missing match id' });

    const conn = await matchModel.getConnection();
    try {
      await conn.beginTransaction();
      const m = await matchModel.getMatchById(conn, matchId, true);
      if (!m) { await conn.rollback(); conn.release && conn.release(); return res.status(404).json({ error: 'Match not found' }); }
      if (m.creator_id !== user.id) { await conn.rollback(); conn.release && conn.release(); return res.status(403).json({ error: 'Not allowed' }); }
      if (m.status === 'finished' || m.status === 'cancelled') { await conn.rollback(); conn.release && conn.release(); return res.json({ ok: true, already: true }); }

      const result = await matchModel.cancelMatch(conn, matchId);
      await conn.commit();
      conn.release && conn.release();

      sendSseEvent(matchId, 'match:cancelled', result.match);
      return res.json({ ok: true, match: result.match });
    } catch (e) {
      try { if (conn) await conn.rollback(); } catch (_) {}
      try { conn && conn.release && conn.release(); } catch (_) {}
      console.error('cancelMatch error', e && e.message);
      return res.status(500).json({ error: 'Server error' });
    }
  } catch (err) {
    console.error('cancelMatch outer error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

/**
 * SSE stream for a match
 * GET /api/matches/:id/stream
 * Keeps connection open and pushes events:
 *  - match:update  (payload: match row)
 *  - match:created
 *  - match:cancelled
 *  - ping
 */
async function streamMatch(req, res) {
  try {
    const matchId = req.params.id;
    if (!matchId) return res.status(400).end('Missing match id');

    // set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('\n');

    // add client
    addSseClient(matchId, res);

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

    // periodic ping to keep connection alive
    const pingId = setInterval(() => {
      try { res.write(`event: ping\n`); res.write(`data: ${JSON.stringify({ ts: Date.now() })}\n\n`); } catch (e) {}
    }, 25000);

    // cleanup on close
    req.on('close', () => {
      clearInterval(pingId);
      removeSseClient(matchId, res);
      try { res.end(); } catch (e) {}
    });
  } catch (err) {
    console.error('streamMatch error', err && err.message);
    try { res.status(500).end(); } catch (_) {}
  }
}

module.exports = {
  createMatch,
  getMatch,
  listUserMatches,
  joinMatch,
  playMove,
  cancelMatch,
  streamMatch,
  // exported for tests or admin usage
  _internal: { sendSseEvent, scheduleBotMove }
};
