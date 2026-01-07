// src/models/matchModel.js
const { getPool } = require('../config/db');

/*
  matches table (expected columns based on provided DDL):
    id, creator_id, opponent_id, board, current_turn, status, winner,
    bet_amount, creator_display_name, creator_username,
    opponent_display_name, opponent_username,
    creator_is_bot, opponent_is_bot, created_at, updated_at

  This model provides a small set of helpers similar in style to withdrawalModel:
    - getConnection
    - createMatchRow
    - getMatchById
    - getUserMatches
    - findWaitingMatch (find an open waiting match optionally by bet)
    - setOpponent (claim a waiting match)
    - playMove (update board, current_turn, status, winner)
    - cancelMatch
    - finishMatch (mark finished with winner/draw)
    - insertBalanceTransaction (utility used by other models)
*/

async function getConnection() {
  const pool = await getPool();
  return pool.getConnection();
}

async function createMatchRow(conn, creatorId, opts = {}) {
  if (!conn) throw new Error('createMatchRow requires connection');
  const board = typeof opts.board === 'string' ? opts.board : '____________________________________';
  const currentTurn = opts.current_turn || 'X';
  const status = opts.status || 'waiting';
  const bet = typeof opts.bet_amount === 'number' ? opts.bet_amount : (opts.bet_amount ? Number(opts.bet_amount) : 0.00);
  const creatorDisplay = opts.creator_display_name || null;
  const creatorUsername = opts.creator_username || null;
  const creatorIsBot = opts.creator_is_bot ? 1 : 0;

  const sql = `INSERT INTO matches
    (creator_id, opponent_id, board, current_turn, status, winner, bet_amount,
     creator_display_name, creator_username, opponent_display_name, opponent_username,
     creator_is_bot, opponent_is_bot, created_at, updated_at)
    VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, 0, NOW(), NOW())`;

  const [res] = await conn.query(sql, [
    creatorId,
    board,
    currentTurn,
    status,
    bet,
    creatorDisplay,
    creatorUsername,
    creatorIsBot
  ]);
  return res.insertId;
}

async function getMatchById(connOrPool, id, forUpdate = false) {
  if (!connOrPool) throw new Error('getMatchById requires a connection or pool');
  const sql = `SELECT * FROM matches WHERE id = ? LIMIT 1 ${forUpdate ? 'FOR UPDATE' : ''}`;
  const [rows] = await connOrPool.query(sql, [id]);
  return rows && rows[0] ? rows[0] : null;
}

async function getUserMatches(connOrPool, userId, opts = {}) {
  if (!connOrPool) throw new Error('getUserMatches requires connection or pool');
  const limit = Number(opts.limit || 50);
  const offset = Number(opts.offset || 0);
  const sql = `
    SELECT * FROM matches
    WHERE creator_id = ? OR opponent_id = ?
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?`;
  const [rows] = await connOrPool.query(sql, [userId, userId, limit, offset]);
  return rows || [];
}

async function findWaitingMatch(connOrPool, opts = {}) {
  if (!connOrPool) throw new Error('findWaitingMatch requires connection or pool');
  // optional filters: minBet, maxBet, excludeUserId
  const minBet = typeof opts.minBet === 'number' ? opts.minBet : null;
  const maxBet = typeof opts.maxBet === 'number' ? opts.maxBet : null;
  const excludeUserId = opts.excludeUserId || null;

  const clauses = ['status = \'waiting\''];
  const params = [];

  if (minBet !== null) { clauses.push('bet_amount >= ?'); params.push(minBet); }
  if (maxBet !== null) { clauses.push('bet_amount <= ?'); params.push(maxBet); }
  if (excludeUserId !== null) { clauses.push('(creator_id IS NULL OR creator_id <> ?)'); params.push(excludeUserId); }

  const where = clauses.length ? ('WHERE ' + clauses.join(' AND ')) : '';
  const sql = `SELECT * FROM matches ${where} ORDER BY created_at ASC LIMIT 1`;
  const [rows] = await connOrPool.query(sql, params);
  return rows && rows[0] ? rows[0] : null;
}

async function setOpponent(conn, matchId, opponentId, opponentDisplayName = null, opponentUsername = null, opponentIsBot = 0) {
  if (!conn) throw new Error('setOpponent requires connection');
  // lock row
  const m = await getMatchById(conn, matchId, true);
  if (!m) throw new Error('Match not found');
  if (m.status !== 'waiting') return { already: true, status: m.status };

  const sql = `UPDATE matches
               SET opponent_id = ?, opponent_display_name = ?, opponent_username = ?, opponent_is_bot = ?, status = 'playing', updated_at = NOW()
               WHERE id = ?`;
  await conn.query(sql, [opponentId, opponentDisplayName, opponentUsername, opponentIsBot ? 1 : 0, matchId]);
  const updated = await getMatchById(conn, matchId);
  return { ok: true, match: updated };
}

/*
  playMove:
    - conn: connection (transaction recommended)
    - matchId: id
    - board: new board string (should be length 36)
    - nextTurn: 'X' or 'O' or null
    - status: optional new status ('playing'|'finished'|'cancelled')
    - winner: optional winner value ('creator'|'opponent'|'draw'|NULL)
    - returns updated match row
*/
async function playMove(conn, matchId, board, nextTurn, opts = {}) {
  if (!conn) throw new Error('playMove requires connection');
  if (!matchId) throw new Error('playMove requires matchId');

  // lock match row
  const m = await getMatchById(conn, matchId, true);
  if (!m) throw new Error('Match not found');

  const status = opts.status || m.status || 'playing';
  const winner = typeof opts.winner !== 'undefined' ? opts.winner : m.winner;

  const sql = `UPDATE matches
               SET board = ?, current_turn = ?, status = ?, winner = ?, updated_at = NOW()
               WHERE id = ?`;
  await conn.query(sql, [board, nextTurn || m.current_turn, status, winner || null, matchId]);

  const updated = await getMatchById(conn, matchId);
  return updated;
}

async function cancelMatch(conn, matchId) {
  if (!conn) throw new Error('cancelMatch requires connection');
  const m = await getMatchById(conn, matchId, true);
  if (!m) throw new Error('Match not found');
  if (m.status === 'cancelled') return { already: true };
  await conn.query('UPDATE matches SET status = ?, updated_at = NOW() WHERE id = ?', ['cancelled', matchId]);
  const updated = await getMatchById(conn, matchId);
  return { ok: true, match: updated };
}

async function finishMatch(conn, matchId, winnerValue) {
  if (!conn) throw new Error('finishMatch requires connection');
  const m = await getMatchById(conn, matchId, true);
  if (!m) throw new Error('Match not found');
  if (m.status === 'finished') return { already: true, match: m };

  // winnerValue: 'creator' | 'opponent' | 'draw' | null
  const sql = `UPDATE matches SET status = 'finished', winner = ?, updated_at = NOW() WHERE id = ?`;
  await conn.query(sql, [winnerValue || null, matchId]);
  const updated = await getMatchById(conn, matchId);
  return { ok: true, match: updated };
}

/*
  insertBalanceTransaction
  - small helper to record balance transactions (used by withdrawalModel and others)
  - expects a table `balance_transactions` with columns:
    id, user_id, amount, type ('credit'|'debit'), source, reference_id, status, meta (JSON), created_at
*/
async function insertBalanceTransaction(conn, tx) {
  if (!conn) throw new Error('insertBalanceTransaction requires connection');
  if (!tx || !tx.user_id) throw new Error('insertBalanceTransaction requires tx.user_id');

  const amount = Number(tx.amount || 0);
  const type = tx.type === 'debit' ? 'debit' : 'credit';
  const source = tx.source || null;
  const referenceId = tx.reference_id || null;
  const status = tx.status || 'pending';
  const meta = tx.meta ? JSON.stringify(tx.meta) : null;

  const sql = `INSERT INTO balance_transactions
    (user_id, amount, type, source, reference_id, status, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`;
  const [res] = await conn.query(sql, [tx.user_id, amount, type, source, referenceId, status, meta]);
  return res.insertId;
}

module.exports = {
  getConnection,
  createMatchRow,
  getMatchById,
  getUserMatches,
  findWaitingMatch,
  setOpponent,
  playMove,
  cancelMatch,
  finishMatch,
  insertBalanceTransaction
};
