// src/services/simulationService.js
// Simulator for 6x6 board with 4-in-a-row win condition.
// Uses per-match reserved display_name/username when available instead of users table display_name.

const db = require('../config/db');
const matchModel = require('../models/matchModel');

const { getPool } = db;

const BOARD_ROWS = Number(process.env.BOARD_ROWS || 6);
const BOARD_COLS = Number(process.env.BOARD_COLS || 6);
const BOARD_CELLS = BOARD_ROWS * BOARD_COLS;
const EMPTY_BOARD = '_'.repeat(BOARD_CELLS);

// Strict per-turn timeout (must match controller)
const TURN_TIMEOUT_MS = 15 * 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* single-run guard to avoid multiple simulators racing on same match */
const activeSimulations = new Map();

/* WIN length (4 in a row) */
const WIN_LENGTH = 4;

/* Generate all WIN_LENGTH-in-a-row lines for BOARD_ROWS x BOARD_COLS */
function generateLines() {
  const lines = [];
  const rows = BOARD_ROWS, cols = BOARD_COLS;
  const winLen = WIN_LENGTH;

  // horizontal
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c + winLen - 1 < cols; c++) {
      const seq = [];
      for (let k = 0; k < winLen; k++) seq.push(r * cols + (c + k));
      lines.push(seq);
    }
  }
  // vertical
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r + winLen - 1 < rows; r++) {
      const seq = [];
      for (let k = 0; k < winLen; k++) seq.push((r + k) * cols + c);
      lines.push(seq);
    }
  }
  // diag down-right
  for (let r = 0; r + winLen - 1 < rows; r++) {
    for (let c = 0; c + winLen - 1 < cols; c++) {
      const seq = [];
      for (let k = 0; k < winLen; k++) seq.push((r + k) * cols + (c + k));
      lines.push(seq);
    }
  }
  // diag down-left
  for (let r = 0; r + winLen - 1 < rows; r++) {
    for (let c = winLen - 1; c < cols; c++) {
      const seq = [];
      for (let k = 0; k < winLen; k++) seq.push((r + k) * cols + (c - k));
      lines.push(seq);
    }
  }
  return lines;
}

const LINES = generateLines();

/* Board checks */
function checkBoard(boardStr) {
  const b = (boardStr || EMPTY_BOARD).split('');
  for (const line of LINES) {
    const first = b[line[0]];
    if (!first || first === '_') continue;
    let allSame = true;
    for (let idx = 1; idx < line.length; idx++) {
      if (b[line[idx]] !== first) { allSame = false; break; }
    }
    if (allSame) return { winner: first, isDraw: false };
  }
  const isDraw = b.every(c => c !== '_');
  return { winner: null, isDraw };
}

function availableMoves(boardArr) {
  return boardArr.map((v, i) => v === '_' ? i : -1).filter(i => i >= 0);
}

function findImmediateWin(boardArr, symbol) {
  for (const line of LINES) {
    const vals = line.map(idx => boardArr[idx]);
    const countSym = vals.filter(v => v === symbol).length;
    const countEmpty = vals.filter(v => v === '_').length;
    if (countSym === WIN_LENGTH - 1 && countEmpty === 1) {
      return line.find(idx => boardArr[idx] === '_');
    }
  }
  return -1;
}

/* Heuristic move chooser */
function chooseMoveHeuristic(boardStr, botSym) {
  const board = (boardStr || EMPTY_BOARD).split('');
  const opp = botSym === 'X' ? 'O' : 'X';

  const win = findImmediateWin(board, botSym);
  if (win >= 0) return win;

  const block = findImmediateWin(board, opp);
  if (block >= 0) return block;

  const rows = BOARD_ROWS, cols = BOARD_COLS;
  const centerR = (rows - 1) / 2;
  const centerC = (cols - 1) / 2;
  const avail = availableMoves(board);
  const scored = avail.map(i => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const dist = Math.hypot(r - centerR, c - centerC);
    return { i, score: -dist };
  });
  scored.sort((a, b) => b.score - a.score);
  if (scored.length) {
    const top = Math.max(1, Math.min(6, scored.length));
    return scored[Math.floor(Math.random() * top)].i;
  }

  if (avail.length === 0) return -1;
  return avail[Math.floor(Math.random() * avail.length)];
}

function chooseMovePerfect(boardStr, botSym) {
  return chooseMoveHeuristic(boardStr, botSym);
}

/* Utility: polite connection release */
async function safeRelease(conn) {
  if (!conn) return;
  try { await conn.release(); } catch (_) {}
}

/*
 simulateMatch(matchId, options)
 options:
  - moveDelayMs: number
  - joinAsBot: boolean (default true)
  - botIdentity: { display_name, username } optional reserved per-match identity from controller
*/
async function simulateMatch(matchId, options = {}) {
  if (activeSimulations.has(matchId)) return { ok: false, reason: 'already-running' };
  activeSimulations.set(matchId, true);

  const moveDelayMs = typeof options.moveDelayMs === 'number' ? options.moveDelayMs : 600;
  const joinAsBotIfWaiting = options.joinAsBot !== false;
  const providedBotIdentity = options.botIdentity || null;
  const pool = await getPool();

  try {
    // snapshot
    let match = await matchModel.getMatchById(pool, matchId, false);
    if (!match) return { ok: false, reason: 'match-not-found' };

    // If waiting: attach bot and persist per-match identity if controller provided one.
    if (match.status === 'waiting') {
      if (!joinAsBotIfWaiting) return { ok: false, reason: 'match-waiting-not-joined' };
      try {
        if (providedBotIdentity) {
          // pass botIdentity to model; model expected to persist per-match fields into matches table
          await matchModel.attachBotToMatchTx(matchId, providedBotIdentity);
        } else {
          await matchModel.attachBotToMatchTx(matchId);
        }
        match = await matchModel.getMatchById(pool, matchId, false);
        if (!match) return { ok: false, reason: 'match-gone-after-attach' };
        if (match.status !== 'playing') return { ok: false, reason: 'attach-failed-or-still-waiting' };
      } catch (err) {
        return { ok: false, reason: 'attach-db-error', error: err && err.message ? err.message : String(err) };
      }
    }

    // ensure playing
    match = await matchModel.getMatchById(pool, matchId, false);
    if (!match || match.status !== 'playing') return { ok: false, reason: 'not-playing' };

    // Determine bot user id (is_bot flag) but do NOT use users.display_name for UI.
    const ids = [match.creator_id, match.opponent_id].filter(Boolean);
    if (ids.length < 2) return { ok: false, reason: 'missing-participants' };

    let botId = null;
    try {
      const conn0 = await pool.getConnection();
      try {
        const [rows] = await conn0.query('SELECT id, is_bot FROM users WHERE id IN (?)', [ids]);
        const botRow = (rows || []).find(r => Number(r.is_bot) === 1);
        if (!botRow) { await safeRelease(conn0); return { ok: false, reason: 'no-bot-participant' }; }
        botId = botRow.id;
      } finally {
        await safeRelease(conn0);
      }
    } catch (err) {
      return { ok: false, reason: 'db-error-getting-bot', error: err && err.message ? err.message : String(err) };
    }

    // Re-fetch authoritative match
    const refreshed = await matchModel.getMatchById(pool, matchId, false);
    if (!refreshed || refreshed.status !== 'playing') return { ok: false, reason: 'not-playing-after-refresh' };

    // Decide display name for bot: prefer per-match stored display_name/username fields on matches table
    // (opponent_display_name/opponent_username or creator_display_name/creator_username).
    const botIsCreator = String(refreshed.creator_id) === String(botId);
    const perMatchDisplay = botIsCreator ? (refreshed.creator_display_name || null) : (refreshed.opponent_display_name || null);
    const perMatchUsername = botIsCreator ? (refreshed.creator_username || null) : (refreshed.opponent_username || null);

    const botDisplayName = perMatchDisplay || null;
    const botUsername = perMatchUsername || null;

    const resolvedBotSymbol = botIsCreator ? 'X' : 'O';

    // If not bot's turn, exit quickly
    if (refreshed.current_turn !== resolvedBotSymbol) {
      return { ok: false, reason: 'not-bot-turn', bot_display_name: botDisplayName, bot_username: botUsername };
    }

    // thinking delay but keeping within TURN_TIMEOUT_MS
    if (moveDelayMs > 0) {
      const waitMs = Math.min(moveDelayMs, TURN_TIMEOUT_MS - 50);
      if (waitMs > 0) await sleep(waitMs);
    }

    // Attempt move function (primary)
    const attemptMove = async () => {
      let conn;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        const locked = await matchModel.getMatchById(conn, matchId, true);
        if (!locked) { await conn.rollback().catch(() => {}); return { ok: false, reason: 'match-gone-during-attempt' }; }
        if (locked.status !== 'playing') { await conn.rollback().catch(() => {}); return { ok: false, reason: 'match-not-playing-during-attempt' }; }

        const currentTurn = locked.current_turn || 'X';
        if (currentTurn !== resolvedBotSymbol) { await conn.rollback().catch(() => {}); return { ok: false, reason: 'turn-changed' }; }

        const boardStr = (locked.board || EMPTY_BOARD).toString().padEnd(BOARD_CELLS, '_').slice(0, BOARD_CELLS);
        const pos = chooseMovePerfect(boardStr, resolvedBotSymbol);

        if (pos < 0 || pos >= BOARD_CELLS) {
          await matchModel.resolveMatchOutcomeTx(matchId, boardStr, null);
          await conn.commit();
          return { ok: true, reason: 'no-valid-move' };
        }

        const arr = boardStr.split('');
        if (arr[pos] !== '_') {
          await conn.rollback().catch(() => {});
          return { ok: false, reason: 'cell-taken' };
        }

        // insert move and update
        await matchModel.insertMove(conn, matchId, botId, pos, resolvedBotSymbol);
        arr[pos] = resolvedBotSymbol;
        const newBoard = arr.join('');
        const nextTurn = resolvedBotSymbol === 'X' ? 'O' : 'X';
        await matchModel.updateMatch(conn, matchId, { board: newBoard, current_turn: nextTurn });

        const result = checkBoard(newBoard);
        if (result.winner || result.isDraw) {
          await matchModel.resolveMatchOutcomeTx(matchId, newBoard, result.winner || null);
        }

        await conn.commit();
        return { ok: true, reason: 'moved', pos, result: result || null };
      } catch (err) {
        try { if (conn) await conn.rollback(); } catch (_) {}
        return { ok: false, reason: 'attempt-exception', error: err && err.message ? err.message : String(err) };
      } finally {
        await safeRelease(conn);
      }
    };

    // Race primary attempt against strict TURN_TIMEOUT_MS
    const primaryPromise = attemptMove();
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'turn-timeout' }), TURN_TIMEOUT_MS));
    const primaryResult = await Promise.race([primaryPromise, timeoutPromise]);

    if (primaryResult && primaryResult.ok && primaryResult.reason === 'moved') {
      return { ok: true, reason: 'moved', pos: primaryResult.pos, result: primaryResult.result, bot_display_name: botDisplayName, bot_username: botUsername };
    }

    // If timed out, resolve opponent as winner to avoid hangs
    if (primaryResult && primaryResult.reason === 'turn-timeout') {
      const fresh = await matchModel.getMatchById(pool, matchId, false);
      if (fresh && fresh.status === 'playing') {
        const winnerSymbol = resolvedBotSymbol === 'X' ? 'O' : 'X';
        try { await matchModel.resolveMatchOutcomeTx(matchId, fresh.board || null, winnerSymbol); } catch (_) {}
        return { ok: false, reason: 'bot-timeout-resolved', winner: winnerSymbol, bot_display_name: botDisplayName, bot_username: botUsername };
      }
      return { ok: false, reason: 'bot-timeout', bot_display_name: botDisplayName, bot_username: botUsername };
    }

    // If transient failure, quick retry bounded by TURN_TIMEOUT_MS
    if (primaryResult && (primaryResult.reason === 'cell-taken' || primaryResult.reason === 'attempt-exception')) {
      await sleep(50 + Math.floor(Math.random() * 100));
      const retryPromise = attemptMove();
      const retryTimeout = new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'turn-timeout-retry' }), TURN_TIMEOUT_MS));
      const retryResult = await Promise.race([retryPromise, retryTimeout]);

      if (retryResult && retryResult.ok && retryResult.reason === 'moved') {
        return { ok: true, reason: 'moved-retry', pos: retryResult.pos, result: retryResult.result, bot_display_name: botDisplayName, bot_username: botUsername };
      }

      if (retryResult && retryResult.reason && retryResult.reason.includes('timeout')) {
        const fresh = await matchModel.getMatchById(pool, matchId, false);
        if (fresh && fresh.status === 'playing') {
          const winnerSymbol = resolvedBotSymbol === 'X' ? 'O' : 'X';
          try { await matchModel.resolveMatchOutcomeTx(matchId, fresh.board || null, winnerSymbol); } catch (_) {}
          return { ok: false, reason: 'bot-timeout-resolved', winner: winnerSymbol, bot_display_name: botDisplayName, bot_username: botUsername };
        }
        return { ok: false, reason: 'bot-timeout-on-retry', bot_display_name: botDisplayName, bot_username: botUsername };
      }

      return { ok: false, reason: 'retry-failed', details: retryResult, bot_display_name: botDisplayName, bot_username: botUsername };
    }

    return { ok: false, reason: 'move-failed', details: primaryResult, bot_display_name: botDisplayName, bot_username: botUsername };
  } finally {
    activeSimulations.delete(matchId);
  }
}

module.exports = {
  simulateMatch,
  chooseMovePerfect,
  checkBoard
};
