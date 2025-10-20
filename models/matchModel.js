// src/models/matchModel.js
// Match model updated to support per-match random bot display_name and username.
// Idempotent fee handling added: applyFeeOnce

const db = require('../config/db');
const { getPool, EMPTY_BOARD, BOARD_CELLS } = db;

/* Utility: return a pooled connection */
async function getConnection() {
  const pool = await getPool();
  return pool.getConnection();
}

/* Small helpers for simulated bot users */
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

function pickSimulatedName() {
  return SIMULATED_NAMES[Math.floor(Math.random() * SIMULATED_NAMES.length)];
}
function makeUniqueUsername(base) {
  const suffix = Date.now().toString(36).slice(-6);
  return `${base.toLowerCase().replace(/\s+/g, '')}_${suffix}`;
}

/* Create a match row with EMPTY_BOARD */
async function createMatchRow(conn, creatorId, betAmount) {
  if (!conn) throw new Error('createMatchRow requires an active connection');
  if (!creatorId) throw new Error('createMatchRow requires creatorId');
  if (typeof betAmount === 'undefined' || betAmount === null) throw new Error('createMatchRow requires betAmount');

  const sql =
    `INSERT INTO matches (creator_id, board, current_turn, status, bet_amount, created_at)
     VALUES (?, ?, 'X', 'waiting', ?, NOW())`;
  const [res] = await conn.query(sql, [creatorId, EMPTY_BOARD, betAmount]);
  return res.insertId;
}

/* Get match by id; connOrPool may be pool or connection. Optionally FOR UPDATE.
   Prefer per-match display_name/username stored on matches table when present.
*/
async function getMatchById(connOrPool, matchId, forUpdate = false) {
  if (!connOrPool) throw new Error('getMatchById requires a connection or pool');
  if (!matchId) return null;

  const sql =
    `SELECT m.*,
            COALESCE(m.creator_display_name, COALESCE(u_creator.display_name, u_creator.username)) AS creator_display_name,
            COALESCE(m.opponent_display_name, COALESCE(u_opponent.display_name, u_opponent.username)) AS opponent_display_name,
            COALESCE(m.creator_username, u_creator.username) AS creator_username,
            COALESCE(m.opponent_username, u_opponent.username) AS opponent_username,
            COALESCE(m.creator_is_bot, u_creator.is_bot) AS creator_is_bot,
            COALESCE(m.opponent_is_bot, u_opponent.is_bot) AS opponent_is_bot
     FROM matches m
     LEFT JOIN users u_creator ON m.creator_id = u_creator.id
     LEFT JOIN users u_opponent ON m.opponent_id = u_opponent.id
     WHERE m.id = ? LIMIT 1 ${forUpdate ? 'FOR UPDATE' : ''}`;

  const [rows] = await connOrPool.query(sql, [matchId]);
  return rows && rows[0] ? rows[0] : null;
}

/* Generic update helper for matches */
async function updateMatch(conn, matchId, fields = {}) {
  if (!conn) throw new Error('updateMatch requires an active connection');
  if (!matchId) throw new Error('updateMatch requires matchId');
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const parts = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => fields[k]);
  await conn.query(`UPDATE matches SET ${parts}, updated_at = NOW() WHERE id = ?`, [...values, matchId]);
}

/* Insert a move (position must fit 0..BOARD_CELLS-1) */
async function insertMove(conn, matchId, userId, position, symbol) {
  if (!conn) throw new Error('insertMove requires an active connection');
  if (typeof position !== 'number' || position < 0 || position >= BOARD_CELLS) throw new Error(`Position must be in 0..${BOARD_CELLS - 1}`);
  const sql =
    `INSERT INTO moves (match_id, user_id, position, symbol, played_at)
     VALUES (?, ?, ?, ?, NOW())`;
  const [res] = await conn.query(sql, [matchId, userId, position, symbol]);
  return res.insertId;
}

/* Get ordered moves for a match */
async function getMoves(connOrPool, matchId) {
  if (!connOrPool) throw new Error('getMoves requires an connection or pool');
  const [rows] = await connOrPool.query(
    `SELECT mv.id, mv.user_id, COALESCE(mv.display_name, COALESCE(u.display_name, u.username)) AS username, mv.position, mv.symbol, mv.played_at
     FROM moves mv
     LEFT JOIN users u ON mv.user_id = u.id
     WHERE mv.match_id = ?
     ORDER BY mv.played_at ASC, mv.id ASC`,
    [matchId]
  );
  return rows || [];
}

/* Bets helpers */
async function insertBet(conn, matchId, userId, amount, netAmount, feeAmount) {
  if (!conn) throw new Error('insertBet requires an active connection');
  const sql =
    `INSERT INTO bets (match_id, user_id, amount, net_amount, fee_amount, placed_at)
     VALUES (?, ?, ?, ?, ?, NOW())`;
  const [res] = await conn.query(sql, [matchId, userId, amount, netAmount, feeAmount]);
  return res.insertId;
}
async function getBetsByMatch(connOrPool, matchId) {
  if (!connOrPool) throw new Error('getBetsByMatch requires an active connection or pool');
  const [rows] = await connOrPool.query('SELECT * FROM bets WHERE match_id = ?', [matchId]);
  return rows || [];
}

/* Balance transaction audit helper */
async function insertBalanceTransaction(conn, payload) {
  if (!conn) throw new Error('insertBalanceTransaction requires an active connection');
  const { user_id = null, amount, type, source = null, reference_id = null, status = null, meta = null } = payload;

  if (typeof amount === 'undefined' || amount === null) throw new Error('insertBalanceTransaction requires amount');
  if (!type) throw new Error('insertBalanceTransaction requires type');

  const sql =
    `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`;

  let metaVal = null;
  if (meta !== null && typeof meta !== 'undefined') metaVal = typeof meta === 'string' ? meta : JSON.stringify(meta);

  const params = [user_id, amount, type, source, reference_id, status, metaVal];
  const [res] = await conn.query(sql, params);
  return res.insertId;
}

/* Idempotent fee application helper
   Ensures admin_balance is credited exactly once per deterministic reference_id.
   If the admin fee transaction already exists for referenceId, skip admin credit and avoid double debit.
   Callers should use deterministic reference ids like:
     match_${matchId}_create_fee_${userId}
     match_${matchId}_join_fee_${userId}
     match_${matchId}_create_fee_bot_${botId}
*/
async function applyFeeOnce(conn, referenceId, userId, feeAmount) {
  if (!conn) throw new Error('applyFeeOnce requires an active connection');
  if (!referenceId) throw new Error('applyFeeOnce requires referenceId');
  const fee = Number((feeAmount || 0).toFixed(2));
  if (fee <= 0) return 0;

  // Check whether admin fee already recorded
  const [existing] = await conn.query(
    'SELECT id FROM balance_transactions WHERE reference_id = ? AND source = ? LIMIT 1',
    [referenceId, 'match_fee_collected']
  );
  if (existing && existing.length) {
    // Ensure user-side fee tx exists; if not, create it (do not credit admin again)
    const [userExisting] = await conn.query(
      'SELECT id FROM balance_transactions WHERE reference_id = ? AND source = ? LIMIT 1',
      [referenceId, 'match_fee']
    );
    if (!userExisting || !userExisting.length) {
      await insertBalanceTransaction(conn, {
        user_id: userId,
        amount: fee,
        type: 'debit',
        source: 'match_fee',
        reference_id: referenceId,
        status: 'completed',
        meta: { user_id: userId, fee, idempotent: true }
      });
    }
    return fee;
  }

  // Debit user (assumes caller has not yet debited fee); if user already debited fee and only admin credit missing,
  // detection above would have found match_fee_collected; so safe to debit here.
  await conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [fee, userId]);

  // Credit admin once
  await insertBalanceTransaction(conn, {
    user_id: null,
    amount: fee,
    type: 'credit',
    source: 'match_fee_collected',
    reference_id: referenceId,
    status: 'completed',
    meta: { user_id: userId, fee }
  });
  await conn.query('UPDATE admin_balance SET balance = balance + ? WHERE id = 1', [fee]);

  // Insert user fee transaction
  await insertBalanceTransaction(conn, {
    user_id: userId,
    amount: fee,
    type: 'debit',
    source: 'match_fee',
    reference_id: referenceId,
    status: 'completed',
    meta: { user_id: userId, fee }
  });

  return fee;
}

/* Record admin fee (keeps existing semantics but idempotent)
   Prefer applyFeeOnce; recordAdminFee will insert an admin_fee audit if not present.
*/
async function recordAdminFee(conn, amount, meta = {}) {
  const amt = Number(amount || 0);
  if (!(amt > 0)) return;
  const reference_id = meta.reference_id || null;

  if (reference_id) {
    // If this admin audit already exists, skip update
    const [existing] = await conn.query(
      'SELECT id FROM balance_transactions WHERE reference_id = ? AND source = ? LIMIT 1',
      [reference_id, 'admin_fee']
    );
    if (existing && existing.length) return;
  }

  await insertBalanceTransaction(conn, {
    user_id: null,
    amount: amt,
    type: 'credit',
    source: 'admin_fee',
    reference_id: reference_id,
    status: 'completed',
    meta: Object.assign({ admin_fee: true }, meta)
  });
  await conn.query('UPDATE admin_balance SET balance = balance + ? WHERE id = 1', [amt]);
}

/* Fee lookup wrapper */
async function chargeForAmount(connOrPool, amount) {
  try {
    if (connOrPool && typeof connOrPool.query === 'function') {
      return db.getChargeForAmount(connOrPool, amount);
    }
  } catch (e) {}
  return db.getChargeForAmount(await getPool(), amount);
}

/* Try to join an existing waiting match (caller holds transaction) */
async function tryJoinWaitingMatch(conn, userId, betAmount) {
  if (!conn) throw new Error('tryJoinWaitingMatch requires connection');
  const [candidateRows] = await conn.query(
    `SELECT * FROM matches WHERE status = 'waiting' AND bet_amount = ? ORDER BY id ASC LIMIT 1 FOR UPDATE`,
    [betAmount]
  );
  const candidate = candidateRows && candidateRows[0] ? candidateRows[0] : null;
  if (!candidate || String(candidate.creator_id) === String(userId)) return null;

  const fee = await chargeForAmount(conn, betAmount);
  const totalDebit = Number((betAmount + fee).toFixed(2));

  const [userRows] = await conn.query('SELECT id, balance FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!userRows || !userRows[0]) throw new Error('User not found');
  if (Number(userRows[0].balance || 0) < totalDebit) throw new Error('Insufficient balance');

  // debit stake
  await conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, userId]);

  // apply fee idempotently (will debit user and credit admin once)
  if (fee > 0) {
    const ref = `match_${candidate.id}_join_fee_${userId}`;
    await applyFeeOnce(conn, ref, userId, fee);
  }

  // record stake transaction (stake only)
  await insertBalanceTransaction(conn, {
    user_id: userId, amount: betAmount, type: 'debit', source: 'match_stake',
    reference_id: `match_${candidate.id}_stake_${userId}`, status: 'completed',
    meta: { match_id: candidate.id, fee }
  });

  // insert bets and set opponent, set status playing
  await insertBet(conn, candidate.id, candidate.creator_id, betAmount, Number((betAmount - fee).toFixed(2)), fee);
  await insertBet(conn, candidate.id, userId, betAmount, Number((betAmount - fee).toFixed(2)), fee);

  await updateMatch(conn, candidate.id, { opponent_id: userId, status: 'playing', current_turn: 'X' });

  return { joined: true, matchId: candidate.id, fee, totalDebit };
}

/* Create waiting match (caller holds transaction) */
async function createWaitingMatch(conn, creatorId, betAmount) {
  if (!conn) throw new Error('createWaitingMatch requires connection');
  const fee = await chargeForAmount(conn, betAmount);
  const totalDebit = Number((betAmount + fee).toFixed(2));
  const [creatorRows] = await conn.query('SELECT id, balance FROM users WHERE id = ? FOR UPDATE', [creatorId]);
  if (!creatorRows || !creatorRows[0]) throw new Error('User not found');
  if (Number(creatorRows[0].balance || 0) < totalDebit) throw new Error('Insufficient balance');

  // debit stake
  await conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmount, creatorId]);

  // create match row with EMPTY_BOARD
  const matchId = await createMatchRow(conn, creatorId, betAmount);

  // apply fee idempotently (use deterministic ref)
  if (fee > 0) {
    const ref = `match_${matchId}_create_fee_${creatorId}`;
    await applyFeeOnce(conn, ref, creatorId, fee);
  }

  // record stake tx (stake only)
  await insertBalanceTransaction(conn, {
    user_id: creatorId, amount: betAmount, type: 'debit', source: 'match_stake',
    reference_id: `match_${matchId}_stake_${creatorId}`, status: 'completed',
    meta: { match_id: matchId, fee }
  });

  // insert bet for creator
  await insertBet(conn, matchId, creatorId, betAmount, Number((betAmount - fee).toFixed(2)), fee);

  return { matchId, fee, totalDebit };
}

/* Attach a bot to a waiting match (caller holds transaction)
   Accepts optional botIdentity = { display_name, username } which will be persisted
   into the matches row as per-match display/username. The model will NOT overwrite
   users.display_name/username unless it must create a new bot user.
*/
async function attachBotToMatch(conn, matchId, botIdentity = null) {
  if (!conn) throw new Error('attachBotToMatch requires connection');
  const matchRow = await getMatchById(conn, matchId, true);
  if (!matchRow) throw new Error('Match not found');
  if (matchRow.status !== 'waiting' || matchRow.opponent_id) throw new Error('Match not waiting');

  const betAmt = Number(matchRow.bet_amount || 0);
  const fee = await chargeForAmount(conn, betAmt);
  const totalDebit = Number((betAmt + fee).toFixed(2));

  // If controller provided a per-match identity, prefer it for per-match display.
  const chosenName = pickSimulatedName();
  const base = chosenName.replace(/\s+/g, '').toLowerCase();
  const usernameCandidate = makeUniqueUsername(base);
  const botEmail = `${base}.${Date.now()}@example.local`;

  // find an existing bot user (lock it)
  const [botRows] = await conn.query('SELECT id, username, display_name, balance FROM users WHERE is_bot = 1 ORDER BY id ASC LIMIT 1 FOR UPDATE');
  let bot = botRows && botRows[0] ? botRows[0] : null;

  if (!bot) {
    // create a shared bot user (global single bot account).
    const display_name = botIdentity && botIdentity.display_name ? botIdentity.display_name : chosenName;
    const username = botIdentity && botIdentity.username ? botIdentity.username : usernameCandidate;
    const password_hash = '';
    const startingBalance = totalDebit * 10;
    const [ins] = await conn.query(
      `INSERT INTO users (username, email, password_hash, is_bot, balance, display_name, created_at)
       VALUES (?, ?, ?, 1, ?, ?, NOW())`,
      [username, botEmail, password_hash, startingBalance, display_name]
    );
    bot = { id: ins.insertId, balance: startingBalance, display_name, username };
  } else {
    const needsGlobalName = !bot.display_name || !bot.username;
    if (needsGlobalName) {
      const newUsername = bot.username || (botIdentity && botIdentity.username) || usernameCandidate;
      const newDisplay = bot.display_name || (botIdentity && botIdentity.display_name) || chosenName;
      await conn.query('UPDATE users SET username = ?, display_name = ? WHERE id = ?', [newUsername, newDisplay, bot.id]);
      bot.username = newUsername;
      bot.display_name = newDisplay;
    }
  }

  // lock bot row and ensure sufficient funds
  const [lockedBotRows] = await conn.query('SELECT id, balance FROM users WHERE id = ? FOR UPDATE', [bot.id]);
  if (!lockedBotRows || !lockedBotRows[0]) throw new Error('Bot user missing');
  let botBal = Number(lockedBotRows[0].balance || 0);

  // top-up if necessary
  if (botBal < totalDebit) {
    const topUp = Number((totalDebit * 2).toFixed(2));
    await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [topUp, bot.id]);
    botBal += topUp;
  }
  if (botBal < totalDebit) throw new Error('Bot lacks funds');

  // debit stake from bot
  await conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [betAmt, bot.id]);

  // apply bot fee idempotently (will debit bot and credit admin once)
  if (fee > 0) {
    const ref = `match_${matchId}_create_fee_bot_${bot.id}`;
    await applyFeeOnce(conn, ref, bot.id, fee);
  }

  // stake tx and bets
  await insertBalanceTransaction(conn, {
    user_id: bot.id, amount: betAmt, type: 'debit', source: 'match_stake',
    reference_id: `match_${matchId}_stake_${bot.id}`, status: 'completed',
    meta: { match_id: matchId, fee, simulated: true }
  });

  await insertBet(conn, matchId, matchRow.creator_id, betAmt, Number((betAmt - fee).toFixed(2)), fee);
  await insertBet(conn, matchId, bot.id, betAmt, Number((betAmt - fee).toFixed(2)), fee);

  // update match row to reference bot user and set status playing
  const matchUpdate = { opponent_id: bot.id, status: 'playing', current_turn: 'X' };

  if (botIdentity && typeof botIdentity === 'object') {
    matchUpdate.opponent_display_name = botIdentity.display_name || null;
    matchUpdate.opponent_username = botIdentity.username || null;
    matchUpdate.opponent_is_bot = 1;
  }

  await updateMatch(conn, matchId, matchUpdate);

  return { botId: bot.id, matchId, fee, bot_display_name: botIdentity && botIdentity.display_name ? botIdentity.display_name : bot.display_name || chosenName, bot_username: botIdentity && botIdentity.username ? botIdentity.username : bot.username };
}

/* Resolve match outcome and perform payouts/refunds.
   Accepts either (matchId, board, winner) or (conn, matchId, board, winner).
   Defensive and idempotent.
*/
async function resolveMatchOutcome() {
  // normalize arguments
  let conn = null;
  let internalConn = false;
  let matchId = null;
  let boardOrNull = null;
  let winnerSymbol = null;

  if (arguments.length === 3 && typeof arguments[0] === 'number') {
    matchId = arguments[0];
    boardOrNull = arguments[1];
    winnerSymbol = arguments[2];
    conn = await getConnection();
    internalConn = true;
    await conn.beginTransaction();
  } else if (arguments.length >= 4 && arguments[0] && typeof arguments[0].query === 'function') {
    conn = arguments[0];
    matchId = arguments[1];
    boardOrNull = arguments[2];
    winnerSymbol = arguments[3];
  } else {
    throw new Error('resolveMatchOutcome requires (matchId, board, winner) or (conn, matchId, board, winner)');
  }

  try {
    const match = await getMatchById(conn, matchId, true);
    if (!match) throw new Error('Match not found');

    if (String(match.status) === 'finished') {
      if (internalConn) { await conn.commit(); conn.release(); }
      return { already: true, matchId, status: match.status, winner: match.winner };
    }

    // compute winner symbol detection if not provided
    const board = String(boardOrNull || match.board || EMPTY_BOARD).padEnd(BOARD_CELLS, '_').slice(0, BOARD_CELLS);
    const localCheck = (function detectWinner(boardStr) {
      const ROWS = 6, COLS = 6, WIN = 4;
      const b = boardStr.split('');
      const lines = [];
      for (let r = 0; r < ROWS; r++) for (let c = 0; c + WIN - 1 < COLS; c++) {
        const seq = [];
        for (let k = 0; k < WIN; k++) seq.push(r * COLS + c + k);
        lines.push(seq);
      }
      for (let c = 0; c < COLS; c++) for (let r = 0; r + WIN - 1 < ROWS; r++) {
        const seq = [];
        for (let k = 0; k < WIN; k++) seq.push((r + k) * COLS + c);
        lines.push(seq);
      }
      for (let r = 0; r + WIN - 1 < ROWS; r++) for (let c = 0; c + WIN - 1 < COLS; c++) {
        const seq = [];
        for (let k = 0; k < WIN; k++) seq.push((r + k) * COLS + (c + k));
        lines.push(seq);
      }
      for (let r = 0; r + WIN - 1 < ROWS; r++) for (let c = WIN - 1; c < COLS; c++) {
        const seq = [];
        for (let k = 0; k < WIN; k++) seq.push((r + k) * COLS + (c - k));
        lines.push(seq);
      }
      for (const line of lines) {
        const first = b[line[0]];
        if (!first || first === '_') continue;
        let ok = true;
        for (let i = 1; i < line.length; i++) if (b[line[i]] !== first) { ok = false; break; }
        if (ok) return { winner: first, line };
      }
      const isDraw = b.every(c => c !== '_');
      return { winner: null, isDraw };
    })(board);

    // prefer provided winnerSymbol when it matches local detection, otherwise follow detection
    let finalWinnerSymbol = null;
    if (winnerSymbol === 'X' || winnerSymbol === 'O') finalWinnerSymbol = winnerSymbol;
    if (localCheck.winner) finalWinnerSymbol = localCheck.winner;

    // payout logic
    const betRows = await getBetsByMatch(conn, matchId);
    const creatorBet = betRows.find(b => String(b.user_id) === String(match.creator_id));
    const opponentBet = betRows.find(b => String(b.user_id) === String(match.opponent_id));
    const betAmount = Number(match.bet_amount || 0);
    const totalPooled = Number((betAmount * 2).toFixed(2));

    if (finalWinnerSymbol === 'X' || finalWinnerSymbol === 'O') {
      const winnerId = finalWinnerSymbol === 'X' ? match.creator_id : match.opponent_id;
      if (winnerId) {
        await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [totalPooled, winnerId]);
        await insertBalanceTransaction(conn, {
          user_id: winnerId,
          amount: totalPooled,
          type: 'credit',
          source: 'match_win',
          reference_id: `match_${matchId}_payout`,
          status: 'completed',
          meta: { match_id: matchId, payout: totalPooled, winner: winnerId }
        });
      }
      await updateMatch(conn, matchId, { status: 'finished', winner: finalWinnerSymbol === 'X' ? 'creator' : 'opponent', board: board });
      if (internalConn) { await conn.commit(); conn.release(); }
      return { winner: winnerId || null, payout: totalPooled };
    }

    // draw or no winner -> refund stakes (not fees)
    if (creatorBet) {
      await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [creatorBet.amount, match.creator_id]);
      await insertBalanceTransaction(conn, {
        user_id: match.creator_id,
        amount: creatorBet.amount,
        type: 'credit',
        source: 'match_refund',
        reference_id: `match_${matchId}_refund_creator`,
        status: 'completed',
        meta: { match_id: matchId }
      });
    }
    if (opponentBet) {
      await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [opponentBet.amount, match.opponent_id]);
      await insertBalanceTransaction(conn, {
        user_id: match.opponent_id,
        amount: opponentBet.amount,
        type: 'credit',
        source: 'match_refund',
        reference_id: `match_${matchId}_refund_opponent`,
        status: 'completed',
        meta: { match_id: matchId }
      });
    }

    await updateMatch(conn, matchId, { status: 'finished', winner: 'draw', board: board });
    if (internalConn) { await conn.commit(); conn.release(); }
    return { winner: null, payout: 0, draw: true };
  } catch (err) {
    if (internalConn) {
      try { await conn.rollback(); } catch (_) {}
      try { conn.release(); } catch (_) {}
    }
    throw err;
  }
}

/* Convenience transactional wrappers */
async function createMatchAsTransaction(creatorId, betAmount) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const res = await createWaitingMatch(conn, creatorId, betAmount);
    await conn.commit();
    return res;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function tryJoinWaitingMatchTx(userId, betAmount) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const res = await tryJoinWaitingMatch(conn, userId, betAmount);
    await conn.commit();
    return res;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function attachBotToMatchTx(matchId, botIdentity = null) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const res = await attachBotToMatch(conn, matchId, botIdentity);
    await conn.commit();
    return res;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/* wrap resolve as caller convenience */
async function resolveMatchOutcomeTx(matchId, board, winnerSymbol) {
  return resolveMatchOutcome(matchId, board, winnerSymbol);
}

/* Cleanup helper: delete short-lived rows for finished matches (safe) */
async function cleanupOldRows(pool) {
  if (!pool) pool = await getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const deleteTx1 = `DELETE FROM balance_transactions WHERE created_at < (NOW() - INTERVAL 5 MINUTE)`;
    const deleteTx2 = `DELETE mv FROM moves mv
       JOIN matches m ON mv.match_id = m.id
       WHERE m.status IN ('finished','cancelled') AND mv.played_at < (NOW() - INTERVAL 5 MINUTE)`;
    const deleteTx3 = `DELETE b FROM bets b
       JOIN matches m ON b.match_id = m.id
       WHERE m.status IN ('finished','cancelled') AND b.placed_at < (NOW() - INTERVAL 5 MINUTE)`;
    const deleteMatches = `DELETE FROM matches WHERE created_at < (NOW() - INTERVAL 5 MINUTE) AND (status IS NULL OR status <> 'playing')`;

    await conn.query(deleteTx1);
    await conn.query(deleteTx2);
    await conn.query(deleteTx3);
    await conn.query(deleteMatches);

    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[matchModel.cleanupOldRows] error', err && err.stack ? err.stack : err);
  } finally {
    try { conn.release(); } catch (_) {}
  }
}

/* Start a periodic cleanup timer (returns handle with stop()) */
function startCleanupTimer(options = {}) {
  const intervalMs = Number(options.intervalMs) || (5 * 60 * 1000);
  let pool = options.pool || null;

  const runOnce = async () => {
    try {
      if (!pool) pool = await getPool();
      await cleanupOldRows(pool);
    } catch (err) {
      console.error('[matchModel.startCleanupTimer] cleanup failed', err && err.stack ? err.stack : err);
    }
  };

  runOnce().catch(() => {});
  const timer = setInterval(runOnce, intervalMs);
  return { timer, stop: () => clearInterval(timer) };
}

module.exports = {
  getConnection,
  pickSimulatedName,
  makeUniqueUsername,
  createMatchRow,
  getMatchById,
  updateMatch,
  insertMove,
  getMoves,
  insertBet,
  getBetsByMatch,
  insertBalanceTransaction,
  recordAdminFee,
  chargeForAmount,
  tryJoinWaitingMatch,
  createWaitingMatch,
  attachBotToMatch,
  resolveMatchOutcome,
  createMatchAsTransaction,
  tryJoinWaitingMatchTx,
  attachBotToMatchTx,
  resolveMatchOutcomeTx,
  cleanupOldRows,
  startCleanupTimer,
  applyFeeOnce
};
