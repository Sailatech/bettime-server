// src/models/withdrawalModel.js
const { getPool } = require('../config/db');
const matchModel = require('./matchModel');

/*
  withdrawal statuses: pending, paid, declined
  columns expected in withdrawals table:
    id, user_id, amount, bank_name, account_number, account_name, status, requested_at, processed_at
*/

async function getConnection() {
  const pool = await getPool();
  return pool.getConnection();
}

async function createWithdrawalRow(conn, userId, amount, bankName, accountNumber, accountName) {
  if (!conn) throw new Error('createWithdrawalRow requires connection');
  const sql = `INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name, status, requested_at)
               VALUES (?, ?, ?, ?, ?, 'pending', NOW())`;
  const [res] = await conn.query(sql, [userId, amount, bankName || null, accountNumber || null, accountName || null]);
  return res.insertId;
}

async function getWithdrawalById(connOrPool, id, forUpdate = false) {
  if (!connOrPool) throw new Error('getWithdrawalById requires a connection or pool');
  const sql = `SELECT * FROM withdrawals WHERE id = ? LIMIT 1 ${forUpdate ? 'FOR UPDATE' : ''}`;
  const [rows] = await connOrPool.query(sql, [id]);
  return rows && rows[0] ? rows[0] : null;
}

async function getUserWithdrawals(connOrPool, userId, opts = {}) {
  if (!connOrPool) throw new Error('getUserWithdrawals requires connection or pool');
  const limit = Number(opts.limit || 50);
  const offset = Number(opts.offset || 0);
  const [rows] = await connOrPool.query(
    `SELECT * FROM withdrawals WHERE user_id = ? ORDER BY requested_at DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  return rows || [];
}

async function getPendingWithdrawals(connOrPool, opts = {}) {
  if (!connOrPool) throw new Error('getPendingWithdrawals requires connection or pool');
  const limit = Number(opts.limit || 100);
  const offset = Number(opts.offset || 0);
  const [rows] = await connOrPool.query(
    `SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY requested_at ASC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return rows || [];
}

/*
  Process a withdrawal: mark paid or declined, adjust user balance and record balance_transactions.
  - action: 'approve' or 'decline'
  - processedBy: optional admin id for meta/audit
*/
async function processWithdrawal(conn, withdrawalId, action, processedBy = null) {
  if (!conn) throw new Error('processWithdrawal requires connection');
  if (!withdrawalId) throw new Error('processWithdrawal requires withdrawalId');
  if (!['approve', 'decline'].includes(action)) throw new Error('action must be approve or decline');

  // lock withdrawal row
  const w = await getWithdrawalById(conn, withdrawalId, true);
  if (!w) throw new Error('Withdrawal not found');
  if (w.status !== 'pending') return { already: true, status: w.status };

  const amount = Number(w.amount || 0);
  const userId = w.user_id;

  if (action === 'decline') {
    // refund user balance (credit back) and record transaction
    await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
    await matchModel.insertBalanceTransaction(conn, {
      user_id,
      amount,
      type: 'credit',
      source: 'withdrawal_refund',
      reference_id: `withdrawal_${withdrawalId}_refund_${userId}`,
      status: 'completed',
      meta: { withdrawal_id: withdrawalId, processed_by: processedBy }
    });
    await conn.query('UPDATE withdrawals SET status = ?, processed_at = NOW() WHERE id = ?', ['declined', withdrawalId]);
    return { ok: true, status: 'declined' };
  }

  // approve: mark paid (actual external transfer should happen outside or before calling this)
  await conn.query('UPDATE withdrawals SET status = ?, processed_at = NOW() WHERE id = ?', ['paid', withdrawalId]);
  await matchModel.insertBalanceTransaction(conn, {
    user_id,
    amount,
    type: 'debit',
    source: 'withdrawal_payout',
    reference_id: `withdrawal_${withdrawalId}_payout_${userId}`,
    status: 'completed',
    meta: { withdrawal_id: withdrawalId, processed_by: processedBy }
  });

  return { ok: true, status: 'paid' };
}

module.exports = {
  getConnection,
  createWithdrawalRow,
  getWithdrawalById,
  getUserWithdrawals,
  getPendingWithdrawals,
  processWithdrawal
};
