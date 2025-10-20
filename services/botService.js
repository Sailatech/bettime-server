// services/botService.js
// Simple bot creation and move utilities used by controllers/services.
// Place this file at ./services/botService.js

const { getPool } = require('../config/db');
const { v4: uuidv4 } = require('uuid');

const sampleNames = [
  'Chike', 'Aisha', 'Tunde', 'Nkechi', 'Kemi', 'Emeka', 'Ade', 'Zainab',
  'Ife', 'Sade', 'Bayo', 'Rita', 'Sam'
];

async function createOrGetBot({ type = 'obvious', displayName = null } = {}) {
  const pool = await getPool();
  const db = pool;

  if (type === 'obvious') {
    const username = 'bot_obvious';
    const [rows] = await db.query(`SELECT * FROM users WHERE username = ? LIMIT 1`, [username]);
    if (rows.length) return rows[0];

    await db.query(
      `INSERT INTO users (username, email, password_hash, display_name, is_bot, bot_type, balance)
       VALUES (?, ?, ?, ?, 1, 'obvious', 0.00)`,
      [username, `${username}@bots.local`, 'no_password', 'Computer']
    );

    const [newRows] = await db.query(`SELECT * FROM users WHERE username = ? LIMIT 1`, [username]);
    return newRows[0];
  }

  // simulation bot: try reuse an existing simulation bot, otherwise create a new one
  {
    const [simRows] = await db.query(`SELECT * FROM users WHERE is_bot = 1 AND bot_type = 'simulation' LIMIT 1`);
    if (simRows.length && !displayName) return simRows[0];
  }

  const username = `bot_sim_${uuidv4().slice(0,8)}`;
  const nameToUse = displayName || sampleNames[Math.floor(Math.random() * sampleNames.length)];

  await db.query(
    `INSERT INTO users (username, email, password_hash, display_name, is_bot, bot_type, balance)
     VALUES (?, ?, ?, ?, 1, 'simulation', 0.00)`,
    [username, `${username}@bots.local`, 'no_password', nameToUse]
  );

  const [newRows] = await db.query(`SELECT * FROM users WHERE username = ? LIMIT 1`, [username]);
  return newRows[0];
}

function pickBotMove(boardStr) {
  // Prefer center, then corners, then sides
  const board = boardStr.split('');
  const preferred = [4, 0, 2, 6, 8, 1, 3, 5, 7];
  for (const pos of preferred) {
    if (board[pos] === '_' || board[pos] === ' ') return pos;
  }
  return null;
}

module.exports = {
  createOrGetBot,
  pickBotMove,
};
