// services/service.js
// Combined service layer: BotService, GameService, PaymentService
// Depends on config/db.getPool and model helpers (or direct queries).
const { getPool, getChargeForAmount } = require('../config/db');
const userModel = require('../models/userModel');
const matchModel = require('../models/matchModel');
const betModel = require('../models/betModel');
const moveModel = require('../models/moveModel');
const adminBalance = require('../models/adminBalanceModel');
const txnModel = require('../models/balanceTransactionModel');
const platformEvent = require('../models/platformEventModel');
const { v4: uuidv4 } = require('uuid');

const sampleNames = [
  'Chike', 'Aisha', 'Tunde', 'Nkechi', 'Kemi', 'Emeka', 'Ade', 'Zainab',
  'Ife', 'Sade', 'Bayo', 'Rita', 'Sam'
];

const BotService = {
  // create or return an existing bot of the requested type.
  // type: 'obvious' or 'simulation'
  async createOrGetBot({ type = 'obvious', displayName = null } = {}) {
    const pool = await getPool();
    const db = pool;

    // For obvious bots we try to reuse a named account; for simulation create or reuse any simulation bot
    if (type === 'obvious') {
      const username = 'bot_obvious';
      const [rows] = await db.query(`SELECT * FROM users WHERE username = ? LIMIT 1`, [username]);
      if (rows.length) return rows[0];
      // create obvious bot
      await db.query(
        `INSERT INTO users (username, email, password_hash, display_name, is_bot, bot_type, balance)
         VALUES (?, ?, ?, ?, 1, 'obvious', 0.00)`,
        [username, `${username}@bots.local`, 'no_password', 'Computer',]
      );
      const [newRows] = await db.query(`SELECT * FROM users WHERE username = ? LIMIT 1`, [username]);
      return newRows[0];
    }

    // simulation bot: try to find an unused simulation bot, otherwise create a new one
    const [simRows] = await db.query(`SELECT * FROM users WHERE is_bot = 1 AND bot_type = 'simulation' LIMIT 1`);
    if (simRows.length && !displayName) return simRows[0];

    // create new simulation bot with random username/displayName
    const username = `bot_sim_${uuidv4().slice(0,8)}`;
    const nameToUse = displayName || sampleNames[Math.floor(Math.random() * sampleNames.length)];
    await db.query(
      `INSERT INTO users (username, email, password_hash, display_name, is_bot, bot_type, balance)
       VALUES (?, ?, ?, ?, 1, 'simulation', 0.00)`,
      [username, `${username}@bots.local`, 'no_password', nameToUse]
    );
    const [newRows] = await db.query(`SELECT * FROM users WHERE username = ? LIMIT 1`, [username]);
    return newRows[0];
  },

  // Very simple move picker for bots: prefer center, then corners, then sides
  pickBotMove(boardStr) {
    const board = boardStr.split('');
    const preferred = [4, 0, 2, 6, 8, 1, 3, 5, 7];
    for (const pos of preferred) {
      if (board[pos] === '_' || board[pos] === ' ') return pos;
    }
    return null;
  }
};

const GameService = {
  // check game winner: returns 'X' | 'O' | 'draw' | null
  checkWinner(boardStr) {
    const b = boardStr.split('');
    const lines = [
      [0,1,2],[3,4,5],[6,7,8],
      [0,3,6],[1,4,7],[2,5,8],
      [0,4,8],[2,4,6]
    ];
    for (const l of lines) {
      const [a,b1,c] = l;
      if (b[a] !== '_' && b[a] === b[b1] && b[a] === b[c]) return b[a];
    }
    if (b.every(ch => ch !== '_' && ch !== ' ')) return 'draw';
    return null;
  },

  // attempt to make a move on behalf of a player (userId). This is transactional and returns updated match.
  async playMove({ userId, matchId, position }) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [mRows] = await conn.query(`SELECT * FROM matches WHERE id = ? FOR UPDATE`, [matchId]);
      if (!mRows.length) { throw { status: 404, message: 'Match not found' }; }
      const match = mRows[0];
      if (match.status !== 'playing') throw { status: 400, message: 'Match not playing' };

      // determine player's symbol
      let playerSymbol = null;
      if (match.creator_id === userId) playerSymbol = 'X';
      else if (match.opponent_id === userId) playerSymbol = 'O';
      else throw { status: 403, message: 'Not part of match' };

      if (match.current_turn !== playerSymbol) throw { status: 400, message: 'Not your turn' };

      const boardArr = match.board.split('');
      if (boardArr[position] !== '_' && boardArr[position] !== ' ') throw { status: 400, message: 'Position taken' };

      // create move
      await conn.query(
        `INSERT INTO moves (match_id, user_id, position, symbol) VALUES (?, ?, ?, ?)`,
        [matchId, userId, position, playerSymbol]
      );

      boardArr[position] = playerSymbol;
      const newBoard = boardArr.join('');
      const winnerSym = GameService.checkWinner(newBoard);
      let newStatus = match.status;
      let winner = null;
      let nextTurn = playerSymbol === 'X' ? 'O' : 'X';

      if (winnerSym === 'draw') {
        newStatus = 'finished';
        winner = 'draw';
      } else if (winnerSym === 'X' || winnerSym === 'O') {
        newStatus = 'finished';
        winner = (winnerSym === 'X') ? 'creator' : 'opponent';
      }

      await conn.query(
        `UPDATE matches SET board = ?, current_turn = ?, status = ?, winner = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [newBoard, nextTurn, newStatus, winner, matchId]
      );

      // handle settlement if finished
      if (newStatus === 'finished') {
        // fetch bets
        const [bets] = await conn.query(`SELECT * FROM bets WHERE match_id = ?`, [matchId]);
        const totalPot = parseFloat(match.bet_amount || 0);

        if (bets.length) {
          if (winner === 'draw') {
            // refund each bettor their net_amount
            for (const b of bets) {
              if (!b.refunded) {
                await conn.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [b.net_amount, b.user_id]);
                await txnModel.createTransaction({ userId: b.user_id, amount: b.net_amount, type: 'credit', source: 'bet_refund_draw', referenceId: `match:${matchId}` }, conn);
                await betModel.markBetRefunded(b.id, conn);
              }
            }
            await platformEvent.createEvent('match_finished_draw', { matchId, pot: totalPot });
          } else {
            const winnerId = winner === 'creator' ? match.creator_id : match.opponent_id;
            const winnerUser = await userModel.findById(winnerId);
            if (!winnerUser) {
              // no user found -> platform keeps pot
              await adminBalance.addToAdminBalance(totalPot, conn);
              await platformEvent.createEvent('match_finished_no_user', { matchId, pot: totalPot });
            } else if (winnerUser.is_bot) {
              // bot won -> platform keeps pot
              await adminBalance.addToAdminBalance(totalPot, conn);
              await platformEvent.createEvent('bot_win', { matchId, botId: winnerId, pot: totalPot });
            } else {
              // human winner
              await conn.query(`UPDATE users SET balance = balance + ? WHERE id = ?`, [totalPot, winnerId]);
              await txnModel.createTransaction({ userId: winnerId, amount: totalPot, type: 'credit', source: 'match_win', referenceId: `match:${matchId}` }, conn);
              await platformEvent.createEvent('match_win_paid', { matchId, winnerId, pot: totalPot });
            }
          }
        }
      }

      await conn.commit();
      conn.release();

      const updated = await matchModel.getMatchById(matchId);
      return updated;
    } catch (err) {
      try { await conn.rollback(); } catch(e){/* ignore */ }
      conn.release();
      if (err && err.status) throw err;
      console.error('playMove error', err);
      throw { status: 500, message: 'Server error' };
    }
  },

  // Kickoff a simple bot simulation loop for a match where opponent is a bot.
  // This spawns a background non-blocking sequence that makes moves for the bot until match ends.
  // Options:
  //  - intervalMs: delay between bot moves
  //  - maxMoves: safety cap
  async simulateMatchPlay({ matchId, botId, intervalMs = 800, maxMoves = 20 } = {}) {
    // run in background, don't await here
    (async () => {
      try {
        let movesMade = 0;
        const pool = await getPool();

        while (movesMade < maxMoves) {
          const [mRows] = await pool.query(`SELECT * FROM matches WHERE id = ?`, [matchId]);
          if (!mRows.length) return;
          const match = mRows[0];
          if (match.status !== 'playing') return;

          // determine if it's bot's turn
          const botIsCreator = match.creator_id === botId;
          const botSymbol = botIsCreator ? 'X' : 'O';
          if (match.current_turn !== botSymbol) {
            // wait and check again
            await new Promise(r => setTimeout(r, intervalMs));
            continue;
          }

          // pick move
          const pos = BotService.pickBotMove(match.board);
          if (pos === null) return;

          try {
            // use GameService.playMove but we need to pass botId as userId
            await GameService.playMove({ userId: botId, matchId, position: pos });
          } catch (e) {
            // if error, log and break
            console.error('simulateMatchPlay move error', e);
            return;
          }

          movesMade += 1;
          // small pause before next loop
          await new Promise(r => setTimeout(r, intervalMs));
        }
      } catch (e) {
        console.error('simulateMatchPlay error', e);
      }
    })();
  }
};

const PaymentService = {
  // Places a bet: deducts user, computes fee, credits admin, records bet and increments match pot.
  // All operations are transactional.
  async placeBet({ userId, matchId, amount }) {
    const pool = await getPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // lock user and match
      const [uRows] = await conn.query(`SELECT * FROM users WHERE id = ? FOR UPDATE`, [userId]);
      if (!uRows.length) throw { status: 404, message: 'User not found' };
      const user = uRows[0];

      const [mRows] = await conn.query(`SELECT * FROM matches WHERE id = ? FOR UPDATE`, [matchId]);
      if (!mRows.length) throw { status: 404, message: 'Match not found' };
      const match = mRows[0];
      if (!['waiting','playing'].includes(match.status)) throw { status: 400, message: 'Match not open' };

      const gross = parseFloat(amount);
      if (isNaN(gross) || gross <= 0) throw { status: 400, message: 'Invalid amount' };

      if (parseFloat(user.balance) < gross) throw { status: 400, message: 'Insufficient funds' };

      // compute fee
      const fee = await getChargeForAmount(conn, gross);
      const net = parseFloat((gross - fee).toFixed(2));

      // deduct user
      await conn.query(`UPDATE users SET balance = balance - ? WHERE id = ?`, [gross, userId]);

      // create bet record
      const bet = await betModel.createBet({ matchId, userId, amount: gross, netAmount: net, feeAmount: fee }, conn);

      // increment match pot by net
      await matchModel.incrementMatchPot(matchId, net, conn);

      // credit admin fee
      await adminBalance.addToAdminBalance(fee, conn);

      // record transactions
      await txnModel.createTransaction({ userId, amount: -gross, type: 'debit', source: 'bet_placed', referenceId: `bet:${bet.id}` }, conn);
      await txnModel.createTransaction({ userId: null, amount: fee, type: 'credit', source: 'fee', referenceId: `bet:${bet.id}` }, conn);

      await conn.commit();
      conn.release();

      return { bet, fee, net };
    } catch (err) {
      try { await conn.rollback(); } catch(e){/*ignore*/ }
      conn.release();
      if (err && err.status) throw err;
      console.error('placeBet error', err);
      throw { status: 500, message: 'Server error' };
    }
  }
};

module.exports = {
  BotService,
  GameService,
  PaymentService
};