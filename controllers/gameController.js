// src/controllers/gameController.js
require('dotenv').config();
const { getPool, getChargeForAmount } = require('../config/db');
const matchModel = require('../models/matchModel');
const simulationService = require('../services/simulationService');
const { broadcastMessage } = require('../server');

const AUTO_SIMULATE_WAIT_MS = Number(process.env.MATCH_AUTO_SIMULATE_MS || 20000);
const SIM_MOVE_DELAY_MS = Number(process.env.SIM_MOVE_DELAY_MS || 800);

const TURN_TIMEOUT_MS = 15 * 1000;
const MATCH_MAX_MS = 135 * 1000;

const BOARD_ROWS = 6;
const BOARD_COLS = 6;
const WIN_LENGTH = 4;
const BOARD_CELLS = BOARD_ROWS * BOARD_COLS;
const EMPTY_BOARD = '_'.repeat(BOARD_CELLS);

// full list of names (200)
const SIMULATED_NAMES = [
  "John","Joshua","Caleb","Daniel","Matthew","Timothy","Samuel","Isaac","Peter","Joseph","Paul","James",
  "Emmanuel","Christian","Ayomide","Chukwudi","Adebayo","Toluwani","Oluwasegun","Chibueze","Rotimi","Femi",
  "Chinedu","Babatunde","Ikenna","Gbenga","Ademola","Nnamdi","Obinna","Olamide","Oluwadamilare","Chibuike",
  "Danjuma","Abubakar","Hassan","Aminu","Bello","Ibrahim","Yakubu","Musa","Saleh","Umar","Usman","Adamu","Idris",
  "Ayodeji","Kelechi","Ifeanyi","Olawale","Korede","Olumide","Chukwuebuka","Somtochukwu","Ejike","Chinedum",
  "Olaniyi","Anuoluwapo","Ibukunoluwa","Segun","Akpan","Okon","Etim","Idara","Inyang","Uchechukwu","Chukwuemeka",
  "Akachi","Obioma","Obiora","Onyedikachi","Ekenedilichukwu","Chisom","Chiamaka","Amara","Ngozi","Ifeoma","Chinwe",
  "Chidinma","Adaeze","Uzoamaka","Amarachi","Oluchi","Anwuli","Oyin","Modupe","Funke","Adetutu","Abimbola","Adedayo",
  "Adetola","Ayotunde","Omolara","Tolulope","Similola","Taiwo","Kehinde","Idowu","Aisha","Fatima","Zainab","Hadiza",
  "Maryam","Safiya","Binta","Jumoke","Laraba","Sade","Bisola","Damilola","Eniola","Ijeoma","Kemi","Lola","Mosun",
  "Mojisola","Nike","Opeoluwa","Patience","Blessing","Grace","Joy","Hope","Mercy","Goodness","Faith","Charity",
  "Praise","Gloria","Esther","Hannah","Deborah","Sarah","Rebecca","Rachel","Leah","Dinah","Judith","Ruth","Abigail",
  "Elizabeth","Lydia","Priscilla","Rhoda","Tabitha","Martha","Naomi","Susanna","Anna","Shalom","Felicia","Eucharia",
  "Victoria","Christiana","Theresa","Stella","Juliana","Cecilia","Regina","Augustina","Vivian","Florence","Roseline",
  "Helen","Dorcas","Lois","Eunice","Phyllis","Agnes","Clara","Jane","Mary","Rosemary","Sophia","Olivia","Nora","Phoebe",
  "Bernice","Candace","Angel","Samson","Solomon","Jesse","Stephen","Philip","Mark","Luke","Titus","David","Jacob",
  "Abraham","Gabriel","Michael","Raphael","Christopher","Dominic","Francis","Anthony","Patrick","Julian","Adrian",
  "Martin"
];

// In-memory rotating name pool and helper
let _namePool = [];
let _nameCounter = 0;

function _shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function _refillNamePool() {
  _namePool = SIMULATED_NAMES.slice();
  _shuffleArray(_namePool);
}
_refillNamePool();

function reserveBotName() {
  if (!_namePool || _namePool.length === 0) _refillNamePool();
  const display_name = _namePool.pop();
  const base = String(display_name || 'bot').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'bot';
  _nameCounter = (_nameCounter + 1) % 0x100000;
  const suffix = Date.now().toString(36).slice(-4) + (_nameCounter).toString(36);
  const username = `${base}_${suffix}`;
  return { display_name, username };
}

function makeUniqueUsername(base) {
  const suffix = Date.now().toString(36).slice(-6);
  return `${base.toLowerCase().replace(/\s+/g, '')}_${suffix}`;
}

const simThrottle = new Map();
function runSimulationAsync(matchId, opts = {}) {
  const key = `sim:${matchId}`;
  if (simThrottle.has(key)) return;
  simThrottle.set(key, true);
  setTimeout(() => simThrottle.delete(key), 300);
  setImmediate(async () => {
    try {
      await simulationService.simulateMatch(matchId, opts);
      broadcastMessage('reload');
    } catch (err) {
      console.warn('[simulation] error', err && err.message ? err.message : err);
    }
  });
}

const matchTimers = new Map();
function clearTimersForMatch(matchId) {
  const t = matchTimers.get(matchId);
  if (!t) return;
  try { if (t.turnTimer) clearTimeout(t.turnTimer); } catch (_) {}
  try { if (t.matchTimer) clearTimeout(t.matchTimer); } catch (_) {}
  matchTimers.delete(matchId);
}

async function onMatchTimeout(matchId) {
  try {
    const pool = await getPool();
    const match = await matchModel.getMatchById(pool, matchId, false);
    if (!match || match.status !== 'playing') { clearTimersForMatch(matchId); return; }
    const winnerSymbol = match.current_turn === 'X' ? 'O' : 'X';
    await matchModel.resolveMatchOutcomeTx(matchId, match.board || EMPTY_BOARD, winnerSymbol);
    clearTimersForMatch(matchId);
    broadcastMessage('reload');
  } catch (e) {
    console.error('[onMatchTimeout] error', e && e.stack ? e.stack : e);
  }
}

async function getLastMoveSymbol(matchId) {
  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query('SELECT symbol FROM moves WHERE match_id = ? ORDER BY id DESC LIMIT 1', [matchId]);
    return (rows && rows.length) ? rows[0].symbol : null;
  } catch (e) {
    return null;
  } finally {
    try { conn.release(); } catch (_) {}
  }
}

async function onTurnTimeout(matchId) {
  try {
    const pool = await getPool();
    const match = await matchModel.getMatchById(pool, matchId, false);
    if (!match || match.status !== 'playing') { clearTimersForMatch(matchId); return; }

    let winnerSymbol = null;
    const lastMover = await getLastMoveSymbol(matchId);
    if (lastMover) {
      winnerSymbol = lastMover;
    } else {
      const timedOutSymbol = match.current_turn;
      winnerSymbol = timedOutSymbol === 'X' ? 'O' : 'X';
      try {
        const conn = await pool.getConnection();
        try {
          const ids = [ timedOutSymbol === 'X' ? match.creator_id : match.opponent_id,
                        timedOutSymbol === 'X' ? match.opponent_id : match.creator_id ].filter(Boolean);
          if (ids.length) {
            const [rows] = await conn.query('SELECT id, is_bot FROM users WHERE id IN (?)', [ids]);
            const timedOutRow = rows.find(r => String(r.id) === String(ids[0])) || null;
            const opponentRow = rows.find(r => String(r.id) === String(ids[1])) || null;
            const timedOutIsBot = !!(timedOutRow && Number(timedOutRow.is_bot));
            const opponentIsBot = !!(opponentRow && Number(opponentRow.is_bot));
            if (!timedOutIsBot && opponentIsBot) {
              winnerSymbol = timedOutSymbol === 'X' ? 'O' : 'X';
            }
          }
        } finally { try { conn.release(); } catch (_) {} }
      } catch (e) {}
    }

    if (!winnerSymbol) {
      winnerSymbol = match.current_turn === 'X' ? 'O' : 'X';
    }

    await matchModel.resolveMatchOutcomeTx(matchId, match.board || EMPTY_BOARD, winnerSymbol);
    clearTimersForMatch(matchId);
    broadcastMessage('reload');
  } catch (e) {
    console.error('[onTurnTimeout] error', e && e.stack ? e.stack : e);
  }
}

function startTimersForMatch(matchId, currentTurnSymbol) {
  clearTimersForMatch(matchId);
  const now = Date.now();
  const matchTimer = setTimeout(() => onMatchTimeout(matchId), MATCH_MAX_MS);
  const turnTimer = setTimeout(() => onTurnTimeout(matchId), TURN_TIMEOUT_MS);
  matchTimers.set(matchId, { matchTimer, turnTimer, matchStartTs: now, turnStartTs: now, currentTurnSymbol });
}

function restartTurnTimer(matchId, currentTurnSymbol) {
  const rec = matchTimers.get(matchId);
  if (!rec) {
    startTimersForMatch(matchId, currentTurnSymbol);
    return;
  }
  try { if (rec.turnTimer) clearTimeout(rec.turnTimer); } catch (_) {}
  const turnTimer = setTimeout(() => onTurnTimeout(matchId), TURN_TIMEOUT_MS);
  rec.turnTimer = turnTimer;
  rec.turnStartTs = Date.now();
  rec.currentTurnSymbol = currentTurnSymbol;
  matchTimers.set(matchId, rec);
}

async function augmentMatchPayload(match) {
  if (!match) return match;
  let creatorIsBot = false;
  let opponentIsBot = false;
  if ('creator_is_bot' in match) creatorIsBot = Boolean(match.creator_is_bot);
  if ('opponent_is_bot' in match) opponentIsBot = Boolean(match.opponent_is_bot);

  // Prefer per-match display_name/username stored on matches when present
  if (match.creator_display_name) {
    match.creator = match.creator || {};
    match.creator.display_name = match.creator_display_name;
  }
  if (match.creator_username) {
    match.creator = match.creator || {};
    match.creator.username = match.creator_username;
  }
  if (match.opponent_display_name) {
    match.opponent = match.opponent || {};
    match.opponent.display_name = match.opponent_display_name;
  }
  if (match.opponent_username) {
    match.opponent = match.opponent || {};
    match.opponent.username = match.opponent_username;
  }

  if (match.creator && typeof match.creator === 'object' && 'is_bot' in match.creator) creatorIsBot = creatorIsBot || Boolean(match.creator.is_bot);
  if (match.opponent && typeof match.opponent === 'object' && 'is_bot' in match.opponent) opponentIsBot = opponentIsBot || Boolean(match.opponent.is_bot);

  if (!('creator_is_bot' in match) || !('opponent_is_bot' in match)) {
    try {
      const pool = await getPool();
      const ids = [];
      if (match.creator_id) ids.push(match.creator_id);
      if (match.opponent_id) ids.push(match.opponent_id);
      if (ids.length) {
        const conn = await pool.getConnection();
        try {
          const [rows] = await conn.query('SELECT id, is_bot, username, display_name FROM users WHERE id IN (?)', [ids]);
          for (const r of (rows || [])) {
            if (String(r.id) === String(match.creator_id)) {
              creatorIsBot = creatorIsBot || Boolean(r.is_bot);
              match.creator = match.creator || {};
              if (!match.creator.display_name) match.creator.display_name = r.display_name;
              if (!match.creator.username) match.creator.username = r.username;
              match.creator.id = r.id;
              match.creator.is_bot = Boolean(r.is_bot);
            }
            if (String(r.id) === String(match.opponent_id)) {
              opponentIsBot = opponentIsBot || Boolean(r.is_bot);
              match.opponent = match.opponent || {};
              if (!match.opponent.display_name) match.opponent.display_name = r.display_name;
              if (!match.opponent.username) match.opponent.username = r.username;
              match.opponent.id = r.id;
              match.opponent.is_bot = Boolean(r.is_bot);
            }
          }
        } finally { try { conn.release(); } catch (_) {} }
      }
    } catch (_) { /* ignore */ }
  }

  match.creator_is_bot = !!creatorIsBot;
  match.opponent_is_bot = !!opponentIsBot;
  return match;
}

async function attachBotToMatchIfAvailable(matchId, side = 'opponent') {
  const botIdentity = reserveBotName();
  const attached = await matchModel.attachBotToMatchTx(matchId, botIdentity);

  if (attached && attached.matchId) {
    const update = {};
    if (side === 'creator') {
      update.creator_display_name = botIdentity.display_name;
      update.creator_username = botIdentity.username;
    } else {
      update.opponent_display_name = botIdentity.display_name;
      update.opponent_username = botIdentity.username;
    }
    try {
      const pool = await getPool();
      const conn = await pool.getConnection();
      try {
        await matchModel.updateMatch(conn, matchId, update);
      } finally { try { conn.release(); } catch (_) {} }
    } catch (e) {
      console.warn('[attachBotToMatchIfAvailable] could not persist per-match name', e && e.message ? e.message : e);
    }
  }

  return attached;
}

function checkWin4(boardStr) {
  const b = String(boardStr || EMPTY_BOARD).padEnd(BOARD_CELLS, '_').slice(0, BOARD_CELLS).split('');
  // horizontal
  for (let r = 0; r < BOARD_ROWS; r++) {
    for (let c = 0; c + WIN_LENGTH - 1 < BOARD_COLS; c++) {
      const idx = r * BOARD_COLS + c;
      const ch = b[idx];
      if (!ch || ch === '_' ) continue;
      let ok = true;
      for (let k = 1; k < WIN_LENGTH; k++) {
        if (b[idx + k] !== ch) { ok = false; break; }
      }
      if (ok) return { winner: ch, isDraw: false };
    }
  }
  // vertical
  for (let c = 0; c < BOARD_COLS; c++) {
    for (let r = 0; r + WIN_LENGTH - 1 < BOARD_ROWS; r++) {
      const idx = r * BOARD_COLS + c;
      const ch = b[idx];
      if (!ch || ch === '_' ) continue;
      let ok = true;
      for (let k = 1; k < WIN_LENGTH; k++) {
        if (b[(r + k) * BOARD_COLS + c] !== ch) { ok = false; break; }
      }
      if (ok) return { winner: ch, isDraw: false };
    }
  }
  // diag down-right
  for (let r = 0; r + WIN_LENGTH - 1 < BOARD_ROWS; r++) {
    for (let c = 0; c + WIN_LENGTH - 1 < BOARD_COLS; c++) {
      const idx = r * BOARD_COLS + c;
      const ch = b[idx];
      if (!ch || ch === '_' ) continue;
      let ok = true;
      for (let k = 1; k < WIN_LENGTH; k++) {
        if (b[(r + k) * BOARD_COLS + (c + k)] !== ch) { ok = false; break; }
      }
      if (ok) return { winner: ch, isDraw: false };
    }
  }
  // diag down-left
  for (let r = 0; r + WIN_LENGTH - 1 < BOARD_ROWS; r++) {
    for (let c = WIN_LENGTH - 1; c < BOARD_COLS; c++) {
      const idx = r * BOARD_COLS + c;
      const ch = b[idx];
      if (!ch || ch === '_' ) continue;
      let ok = true;
      for (let k = 1; k < WIN_LENGTH; k++) {
        if (b[(r + k) * BOARD_COLS + (c - k)] !== ch) { ok = false; break; }
      }
      if (ok) return { winner: ch, isDraw: false };
    }
  }

  const isDraw = b.every(cell => cell !== '_');
  return { winner: null, isDraw };
}

async function createMatch(req, res) {
  const user = req.user;
  if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

  const betAmount = Number(req.body.bet_amount);
  if (isNaN(betAmount) || betAmount <= 0)
    return res.status(400).json({ error: 'Invalid bet amount' });

  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Look for waiting candidate
    const [candidateRows] = await conn.query(
      `SELECT * FROM matches WHERE status = 'waiting' AND opponent_id IS NULL AND bet_amount = ? ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      [betAmount]
    );
    const candidate = candidateRows?.[0] || null;

    // compute fee and amounts
    const fee = await getChargeForAmount(conn, betAmount);
    const feeAmount = Number((fee || 0).toFixed(2));
    const debitStake = Number(betAmount.toFixed(2));
    const totalDebitCreator = Number((debitStake + feeAmount).toFixed(2));

    // ------------------ JOINING EXISTING MATCH ------------------
    if (candidate && candidate.creator_id !== user.id) {
      const [userRows] = await conn.query(
        'SELECT id, balance FROM users WHERE id = ? FOR UPDATE',
        [user.id]
      );
      const userRow = userRows?.[0];
      if (!userRow) {
        await conn.rollback();
        return res.status(404).json({ error: 'User not found' });
      }

      const feeJoin = await getChargeForAmount(conn, betAmount);
      const feeAmountJoin = Number((feeJoin || 0).toFixed(2));
      const totalDebit = Number((betAmount + feeAmountJoin).toFixed(2));

      if (Number(userRow.balance || 0) < totalDebit) {
        await conn.rollback();
        return res
          .status(400)
          .json({ error: 'Insufficient balance to join' });
      }

      // Deduct stake and fee
      await conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [
        betAmount,
        user.id,
      ]);

      if (feeAmountJoin > 0) {
        const ref = `match_${candidate.id}_join_fee_${user.id}`;
        await matchModel.applyFeeOnce(conn, ref, user.id, feeAmountJoin);
      }

      await matchModel.insertBalanceTransaction(conn, {
        user_id: user.id,
        amount: betAmount,
        type: 'debit',
        source: 'match_stake',
        reference_id: `match_${candidate.id}_stake_${user.id}`,
        status: 'completed',
        meta: { match_id: candidate.id, fee: feeAmountJoin },
      });

      // Update match to playing
      await matchModel.updateMatch(conn, candidate.id, {
        opponent_id: user.id,
        status: 'playing',
        current_turn: 'X',
      });

      // Insert bets for both
      await matchModel.insertBet(
        conn,
        candidate.id,
        candidate.creator_id,
        betAmount,
        Number((betAmount - feeAmountJoin).toFixed(2)),
        feeAmountJoin
      );
      await matchModel.insertBet(
        conn,
        candidate.id,
        user.id,
        betAmount,
        Number((betAmount - feeAmountJoin).toFixed(2)),
        feeAmountJoin
      );

      await conn.commit();

      startTimersForMatch(candidate.id, 'X');

      let matchWithNames = await matchModel.getMatchById(pool, candidate.id, false);
      matchWithNames = await augmentMatchPayload(matchWithNames);

      // ✅ Attach fee data directly to match for frontend compatibility
      matchWithNames.fee = feeAmountJoin;
      matchWithNames.total_debit = totalDebit;

      setImmediate(() =>
        runSimulationAsync(candidate.id, { moveDelayMs: SIM_MOVE_DELAY_MS })
      );

      return res.json({
        ok: true,
        matched: true,
        status: 'playing',
        match: matchWithNames,
      });
    }

    // ------------------ CREATING NEW MATCH ------------------
    const [creatorRows] = await conn.query(
      'SELECT id, balance FROM users WHERE id = ? FOR UPDATE',
      [user.id]
    );
    const creator = creatorRows?.[0];
    if (!creator) {
      await conn.rollback();
      return res.status(404).json({ error: 'User not found' });
    }

    if (Number(creator.balance || 0) < totalDebitCreator) {
      await conn.rollback();
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct stake
    await conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [
      betAmount,
      user.id,
    ]);

    // Create match row
    const matchId = await matchModel.createMatchRow(conn, user.id, betAmount);

    if (feeAmount > 0) {
      const ref = `match_${matchId}_create_fee_${user.id}`;
      await matchModel.applyFeeOnce(conn, ref, user.id, feeAmount);
    }

    await matchModel.updateMatch(conn, matchId, { board: EMPTY_BOARD });

    await matchModel.insertBalanceTransaction(conn, {
      user_id: user.id,
      amount: betAmount,
      type: 'debit',
      source: 'match_stake',
      reference_id: `match_${matchId}_stake_${user.id}`,
      status: 'completed',
      meta: { match_id: matchId, fee: feeAmount },
    });

    await matchModel.insertBet(
      conn,
      matchId,
      user.id,
      betAmount,
      Number((betAmount - feeAmount).toFixed(2)),
      feeAmount
    );

    await conn.commit();

    let matchWithNames = await matchModel.getMatchById(pool, matchId, false);
    matchWithNames = await augmentMatchPayload(matchWithNames);

    // ✅ Attach fee data for frontend compatibility
    matchWithNames.fee = feeAmount;
    matchWithNames.total_debit = totalDebitCreator;

    // Auto attach bot after timeout if still waiting
    setTimeout(async () => {
      try {
        const pool2 = await getPool();
        const conn2 = await pool2.getConnection();
        await conn2.beginTransaction();
        const m = await matchModel.getMatchById(conn2, matchId, true);
        if (!m || m.status !== 'waiting' || m.opponent_id) {
          await conn2.rollback();
          conn2.release();
          return;
        }
        await conn2.commit();
        conn2.release();

        const attached = await attachBotToMatchIfAvailable(matchId, 'opponent');
        if (attached) {
          startTimersForMatch(matchId, 'X');
          setImmediate(() =>
            runSimulationAsync(matchId, {
              moveDelayMs: SIM_MOVE_DELAY_MS,
              joinAsBot: true,
            })
          );
          broadcastMessage('reload');
        }
      } catch (_) {}
    }, AUTO_SIMULATE_WAIT_MS);

    return res.json({
      ok: true,
      matched: false,
      status: 'waiting',
      match: matchWithNames,
    });
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    console.error('[gameController.createMatch] error', err);
    return res.status(500).json({ error: 'Could not create match' });
  } finally {
    try {
      conn.release();
    } catch (_) {}
  }
}


async function joinMatch(req, res) {
  const user = req.user;
  if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

  const matchId = Number(req.params.id);
  if (!matchId) return res.status(400).json({ error: 'Invalid match id' });

  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const match = await matchModel.getMatchById(conn, matchId, true);
    if (!match) { await conn.rollback(); return res.status(404).json({ error: 'Match not found' }); }

    if (match.opponent_id) { await conn.rollback(); return res.status(400).json({ error: 'Match already has an opponent' }); }
    if (match.creator_id === user.id) { await conn.rollback(); return res.status(400).json({ error: 'Cannot join your own match' }); }

    const betAmount = Number(match.bet_amount || 0);
    const fee = await getChargeForAmount(conn, betAmount);
    const feeAmount = Number((fee || 0).toFixed(2));
    const debitStake = Number((betAmount).toFixed(2));
    const debitFee = Number((feeAmount).toFixed(2));
    const totalDebit = Number((debitStake + debitFee).toFixed(2));

    const [joinerRows] = await conn.query('SELECT id, balance FROM users WHERE id = ? FOR UPDATE', [user.id]);
    if (!joinerRows || !joinerRows[0]) { await conn.rollback(); return res.status(404).json({ error: 'User not found' }); }
    if (Number(joinerRows[0].balance || 0) < totalDebit) { await conn.rollback(); return res.status(400).json({ error: 'Insufficient balance to join' }); }

    // Deduct stake
    await conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [debitStake, user.id]);

    // Deduct fee and credit admin via model helper
    if (debitFee > 0) {
      const ref = `match_${matchId}_join_fee_${user.id}`;
      await matchModel.applyFeeOnce(conn, ref, user.id, debitFee);
    }

    await matchModel.insertBalanceTransaction(conn, {
      user_id: user.id, amount: debitStake, type: 'debit', source: 'match_stake',
      reference_id: `match_${matchId}_stake_${user.id}`, status: 'completed',
      meta: { match_id: matchId, fee: debitFee }
    });

    await matchModel.updateMatch(conn, matchId, { opponent_id: user.id, status: 'playing', current_turn: 'X' });

    await matchModel.insertBet(conn, matchId, match.creator_id, betAmount, Number((betAmount - feeAmount).toFixed(2)), feeAmount);
    await matchModel.insertBet(conn, matchId, user.id, betAmount, Number((betAmount - feeAmount).toFixed(2)), feeAmount);

    await conn.commit();

    startTimersForMatch(matchId, 'X');

    let matchWithNames = await matchModel.getMatchById(pool, matchId, false);

    if (!matchWithNames.board || String(matchWithNames.board).length !== BOARD_CELLS) {
      await matchModel.updateMatch(await getPool(), matchId, { board: EMPTY_BOARD });
      matchWithNames.board = EMPTY_BOARD;
    }

    matchWithNames = await augmentMatchPayload(matchWithNames);

    setImmediate(() => runSimulationAsync(matchId, { moveDelayMs: SIM_MOVE_DELAY_MS, joinAsBot: false }));
    return res.json({ ok: true, match: matchWithNames, status: 'playing', bet_amount: betAmount, fee: feeAmount });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[gameController.joinMatch] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not join match' });
  } finally {
    try { conn.release(); } catch (_) {}
  }
}

async function playMove(req, res) {
  const user = req.user;
  if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

  const matchId = Number(req.params.id);
  const position = Number(req.body.position);
  if (!Number.isInteger(position) || position < 0 || position >= BOARD_CELLS) return res.status(400).json({ error: `Invalid position; must be 0..${BOARD_CELLS - 1}` });

  const pool = await getPool();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    let match = await matchModel.getMatchById(conn, matchId, true);
    if (!match) { await conn.rollback(); return res.status(404).json({ error: 'Match not found' }); }

    if (match.status === 'waiting' && match.creator_id && match.opponent_id) {
      await matchModel.updateMatch(conn, matchId, { status: 'playing', current_turn: 'X' });
      match = await matchModel.getMatchById(conn, matchId, true);
    }

    if (match.status !== 'playing') { await conn.rollback(); return res.status(400).json({ error: 'Match is not in playing state' }); }

    let playerSymbol = null;
    if (String(user.id) === String(match.creator_id)) playerSymbol = 'X';
    else if (String(user.id) === String(match.opponent_id)) playerSymbol = 'O';
    else { await conn.rollback(); return res.status(403).json({ error: 'Not a participant in this match' }); }

    if (match.current_turn !== playerSymbol) { await conn.rollback(); return res.status(400).json({ error: "Not your turn" }); }

    const rec = matchTimers.get(matchId);
    if (rec) {
      const now = Date.now();
      if (rec.matchStartTs && now - rec.matchStartTs >= MATCH_MAX_MS) {
        await conn.rollback();
        await onMatchTimeout(matchId);
        broadcastMessage('reload');
        return res.status(400).json({ error: 'Match overall time expired; you lost' });
      }
      if (rec.turnStartTs && now - rec.turnStartTs >= TURN_TIMEOUT_MS) {
        await conn.rollback();
        await onTurnTimeout(matchId);
        broadcastMessage('reload');
        return res.status(400).json({ error: 'You timed out and lost the match' });
      }
    }

    const [posRows] = await conn.query('SELECT id FROM moves WHERE match_id = ? AND position = ? LIMIT 1', [matchId, position]);
    if (posRows && posRows.length) { await conn.rollback(); return res.status(400).json({ error: 'Position already taken' }); }

    await matchModel.insertMove(conn, matchId, user.id, position, playerSymbol);

    const boardArr = (String(match.board || EMPTY_BOARD).padEnd(BOARD_CELLS, '_').slice(0, BOARD_CELLS)).split('');
    boardArr[position] = playerSymbol;
    const newBoard = boardArr.join('');
    const nextTurn = playerSymbol === 'X' ? 'O' : 'X';
    await matchModel.updateMatch(conn, matchId, { board: newBoard, current_turn: nextTurn });

    const cb = checkWin4(newBoard);

    if (cb.winner || cb.isDraw) {
      await conn.commit();
      await matchModel.resolveMatchOutcomeTx(matchId, newBoard, cb.winner || null);
      clearTimersForMatch(matchId);
      broadcastMessage('reload');
      let updatedMatch = await matchModel.getMatchById(pool, matchId, false);
      updatedMatch = await augmentMatchPayload(updatedMatch);
      const moves = await matchModel.getMoves(pool, matchId);
      return res.json({ ok: true, match: updatedMatch, moves });
    }

    await conn.commit();

    restartTurnTimer(matchId, nextTurn);

    let refreshed = await matchModel.getMatchById(pool, matchId, false);
    refreshed = await augmentMatchPayload(refreshed);

    if (refreshed && refreshed.status === 'playing') {
      const creatorIsBot = Boolean(refreshed.creator_is_bot);
      const opponentIsBot = Boolean(refreshed.opponent_is_bot);
      const botTurnSymbol = (creatorIsBot && refreshed.current_turn === 'X') || (opponentIsBot && refreshed.current_turn === 'O')
        ? refreshed.current_turn : null;
      if (botTurnSymbol) setImmediate(() => runSimulationAsync(matchId, { moveDelayMs: SIM_MOVE_DELAY_MS, joinAsBot: false }));
    }

    broadcastMessage('reload');

    let updatedMatch = await matchModel.getMatchById(pool, matchId, false);
    updatedMatch = await augmentMatchPayload(updatedMatch);
    const moves = await matchModel.getMoves(pool, matchId);
    return res.json({ ok: true, match: updatedMatch, moves });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[gameController.playMove] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not play move' });
  } finally {
    try { conn.release(); } catch (_) {}
  }
}

async function getMatch(req, res) {
  const matchId = Number(req.params.id);
  if (!matchId) return res.status(400).json({ error: 'Invalid match id' });

  try {
    const pool = await getPool();
    let match = await matchModel.getMatchById(pool, matchId, false);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    if (match.status === 'playing' && !matchTimers.has(matchId)) {
      startTimersForMatch(matchId, match.current_turn || 'X');
    }

    if (!match.board || String(match.board).length !== BOARD_CELLS) {
      await matchModel.updateMatch(await getPool(), matchId, { board: EMPTY_BOARD });
      match.board = EMPTY_BOARD;
    }

    match = await augmentMatchPayload(match);
    const moves = await matchModel.getMoves(pool, matchId);
    return res.json({ ok: true, match, moves });
  } catch (err) {
    console.error('[gameController.getMatch] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not fetch match' });
  }
}

async function cancelMatch(req, res) {
  const user = req.user;
  if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

  const matchId = Number(req.params.id);
  if (!matchId) return res.status(400).json({ error: 'Invalid match id' });

  const pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const match = await matchModel.getMatchById(conn, matchId, true);
    if (!match) { await conn.rollback(); return res.status(404).json({ error: 'Match not found' }); }
    if (match.creator_id !== user.id) { await conn.rollback(); return res.status(403).json({ error: 'Only creator can cancel' }); }
    if (match.status !== 'waiting') { await conn.rollback(); return res.status(400).json({ error: 'Match cannot be cancelled' }); }

    const [stakeTxRows] = await conn.query('SELECT * FROM balance_transactions WHERE reference_id LIKE ? AND source = ? LIMIT 1', [`match_${matchId}_stake_%`, 'match_stake']);
    const [feeTxRows] = await conn.query('SELECT * FROM balance_transactions WHERE reference_id LIKE ? AND source = ? LIMIT 1', [`match_${matchId}_create_fee_%`, 'match_fee']);
    let totalDebited = 0;
    if (stakeTxRows && stakeTxRows[0]) totalDebited += Number(stakeTxRows[0].amount || 0);
    if (feeTxRows && feeTxRows[0]) totalDebited += Number(feeTxRows[0].amount || 0);

    if (!totalDebited) {
      const fee = await getChargeForAmount(conn, match.bet_amount || 0);
      totalDebited = Number((Number(match.bet_amount || 0) + Number(fee || 0)).toFixed(2));
    }

    await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [totalDebited, user.id]);
    await matchModel.insertBalanceTransaction(conn, {
      user_id: user.id, amount: totalDebited, type: 'credit',
      source: 'match_cancel_refund', reference_id: `match_${matchId}_cancel_refund_${user.id}`,
      status: 'completed', meta: { match_id: matchId }
    });

    await matchModel.updateMatch(conn, matchId, { status: 'cancelled' });

    await conn.commit();

    clearTimersForMatch(matchId);

    return res.json({ ok: true, match_id: matchId });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[gameController.cancelMatch] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not cancel match' });
  } finally {
    try { conn.release(); } catch (_) {}
  }
}

async function simulateOpponent(req, res) {
  const matchId = Number(req.params.id);
  if (!matchId) return res.status(400).json({ error: 'Invalid match id' });

  try {
    const pool = await getPool();
    const match = await matchModel.getMatchById(pool, matchId, false);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    if (match.status !== 'waiting') {
      return res.status(400).json({ error: 'Match not waiting' });
    }

    const botIdentity = reserveBotName();
    const attached = await matchModel.attachBotToMatchTx(matchId, botIdentity);
    if (attached && attached.matchId) {
      try {
        const pool2 = await getPool();
        const conn2 = await pool2.getConnection();
        try {
          await matchModel.updateMatch(conn2, matchId, {
            opponent_display_name: botIdentity.display_name,
            opponent_username: botIdentity.username
          });
        } finally { try { conn2.release(); } catch (_) {} }
      } catch (e) {
        console.warn('[simulateOpponent] failed to persist per-match name', e && e.message ? e.message : e);
      }

      startTimersForMatch(matchId, 'X');
      setImmediate(() => runSimulationAsync(matchId, { moveDelayMs: SIM_MOVE_DELAY_MS, joinAsBot: true, botIdentity }));
      broadcastMessage('reload');  // Notify clients immediately after bot attaches to match
      let matchWithNames = await matchModel.getMatchById(await getPool(), matchId, false);
      matchWithNames = await augmentMatchPayload(matchWithNames);
      return res.json({ ok: true, match_id: matchId, simulated: true, bot: botIdentity.display_name, match: matchWithNames });
    }

    return res.status(400).json({ error: 'Could not attach bot (possibly already joined)' });
  } catch (e) {
    console.error('[gameController.simulateOpponent] error', e && e.stack ? e.stack : e);
    return res.status(500).json({ error: 'Could not attach bot', details: e && e.message ? e.message : String(e) });
  }
}

// Expose timers and helper to kick off periodic cleanup
let cleanupHandle = null;
function startPeriodicCleanup(options = {}) {
  if (cleanupHandle) return cleanupHandle;
  const intervalMs = Number(options.intervalMs) || (5 * 60 * 1000);
  const poolPromise = getPool();
  poolPromise.then(pool => {
    cleanupHandle = matchModel.startCleanupTimer({ intervalMs, pool });
  }).catch(err => {
    console.error('[gameController.startPeriodicCleanup] could not start cleanup', err && err.stack ? err.stack : err);
  });
  return {
    stop: () => {
      if (cleanupHandle && cleanupHandle.stop) cleanupHandle.stop();
    }
  };
}

module.exports = {
  createMatch,
  joinMatch,
  playMove,
  getMatch,
  cancelMatch,
  simulateOpponent,
  _matchTimers: matchTimers,
  startPeriodicCleanup,
  _reserveBotName: reserveBotName,
  _attachBotToMatchIfAvailable: attachBotToMatchIfAvailable
};
