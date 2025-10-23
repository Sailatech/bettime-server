// controllers/adminWithdrawalController.js
const { getPool } = require('../config/db');
const WithdrawalModel = require('../models/adminWithdrawal');

async function listWithdrawals(req, res) {
  try {
    const { limit, offset, status } = req.query;
    const rows = await WithdrawalModel.list({ limit, offset, status });
    return res.json(rows);
  } catch (err) {
    console.error('listWithdrawals error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
  }
}

/**
 * Approve withdrawal
 * Marks withdrawal paid, records a balance transaction and updates admin_balance.
 * IMPORTANT: ensure this behavior matches your business rules.
 * If you previously deducted user balance at withdrawal creation, avoid double-deducting.
 * The code below assumes deduction has already occurred at request creation.
 */
async function approveWithdrawal(req, res) {
  const id = req.params.id;
  const pool = await getPool();
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const wd = await WithdrawalModel.findById(id, true, conn);
    if (!wd) throw new Error('withdrawal not found');
    if (wd.status !== 'pending') throw new Error('withdrawal not pending');

    // mark withdrawal paid
    await WithdrawalModel.updateStatus(id, 'paid', conn);

    // record a balance_transactions row for auditing (do not deduct if already deducted)
    await conn.query(
      `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, created_at)
       VALUES (?, ?, 'debit', 'withdrawal', ?, 'completed', NOW())`,
      [wd.user_id, wd.amount, `withdrawal:${id}`]
    );

    // If admin pool should receive funds, credit admin_balance
    await conn.query('UPDATE admin_balance SET balance = balance + ? WHERE id = 1', [wd.amount]);

    // optional audit record (non-critical)
    await conn.query('INSERT INTO migrations (name) VALUES (?)', [`admin:approved_withdrawal:${id}`]);

    await conn.commit();
    conn.release();
    return res.json({ ok: true });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
        conn.release();
      } catch (_) {}
    }
    console.error('approveWithdrawal error', err && err.stack ? err.stack : err);
    return res.status(400).json({ error: err.message || 'approve failed' });
  }
}

/**
 * Decline withdrawal
 * Marks declined and refunds the user (because you said balance was already deducted at request time).
 * The refund and logging happen in a transaction to maintain consistency.
 */
async function declineWithdrawal(req, res) {
  const id = req.params.id;
  const pool = await getPool();
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const wd = await WithdrawalModel.findById(id, true, conn);
    if (!wd) throw new Error('withdrawal not found');
    if (wd.status !== 'pending') throw new Error('withdrawal not pending');

    // mark as declined
    await WithdrawalModel.updateStatus(id, 'declined', conn);

    // refund: decrease pending_balance and credit balance (adapt to your schema)
    await conn.query(
      `UPDATE users
       SET pending_balance = GREATEST(COALESCE(pending_balance,0) - ?, 0),
           balance = COALESCE(balance,0) + ?
       WHERE id = ?`,
      [wd.amount, wd.amount, wd.user_id]
    );

    // log refund transaction
    await conn.query(
      `INSERT INTO balance_transactions (user_id, amount, type, source, reference_id, status, meta, created_at)
       VALUES (?, ?, 'credit', 'withdrawal_decline', ?, 'completed', ?, NOW())`,
      [wd.user_id, wd.amount, `withdrawal:${id}`, JSON.stringify({ withdrawal_id: id })]
    );

    // optional audit record
    await conn.query('INSERT INTO migrations (name) VALUES (?)', [`admin:declined_withdrawal:${id}`]);

    await conn.commit();
    conn.release();
    return res.json({ ok: true });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
        conn.release();
      } catch (_) {}
    }
    console.error('declineWithdrawal error', err && err.stack ? err.stack : err);
    return res.status(400).json({ error: err.message || 'decline failed' });
  }
}

async function deleteWithdrawal(req, res) {
  try {
    const id = req.params.id;
    // check status before deleting
    const wd = await WithdrawalModel.findById(id);
    if (!wd) return res.status(404).json({ error: 'not found' });
    if (wd.status === 'pending') return res.status(400).json({ error: 'cannot delete pending withdrawal' });

    const affected = await WithdrawalModel.deleteById(id);
    return res.json({ affectedRows: affected });
  } catch (err) {
    console.error('deleteWithdrawal error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
  }
}

module.exports = {
  listWithdrawals,
  approveWithdrawal,
  declineWithdrawal,
  deleteWithdrawal
};
