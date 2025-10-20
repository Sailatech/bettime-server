// src/controllers/withdrawalController.js
// Enhanced controller that will ensure users table has bank_name, account_number, account_name columns.
// If columns are missing the controller will add them (ALTER TABLE) before attempting updates.
// This makes updateBankInfo safe to call even when the users table wasn't migrated yet.
//
// Note: performing schema changes from application code is convenient for quick setups but
// in production you should prefer explicit DB migrations. This code performs minimal ALTERs
// and logs actions. Requires DB user to have ALTER TABLE privileges.

const { getPool } = require('../config/db');
const matchModel = require('../models/matchModel');

/* helper utilities */
function validateAmount(v) {
  const n = Number(v);
  if (isNaN(n) || n <= 0) return null;
  return Number(n.toFixed(2));
}
function sanitizeStr(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

async function ensureUserBankColumns(conn) {
  // returns object { bank_name: bool, account_number: bool, account_name: bool }
  const needed = ['bank_name', 'account_number', 'account_name'];
  const present = { bank_name: false, account_number: false, account_name: false };

  // Determine database name in current connection
  // For mysql2 promise pool connection, use SELECT DATABASE()
  const [dbRows] = await conn.query('SELECT DATABASE() AS db');
  const dbName = dbRows && dbRows[0] && dbRows[0].db ? String(dbRows[0].db) : null;

  if (!dbName) {
    // cannot check information_schema, assume columns missing
    return present;
  }

  const placeholders = needed.map(() => '?').join(',');
  const sql = `
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME IN (${placeholders})
  `;
  const params = [dbName, ...needed];
  const [rows] = await conn.query(sql, params);
  if (rows && rows.length) {
    for (const r of rows) {
      const col = String(r.COLUMN_NAME);
      if (col in present) present[col] = true;
    }
  }
  // Add missing columns (one ALTER with multiple ADDs)
  const adds = [];
  if (!present.bank_name) adds.push('ADD COLUMN bank_name VARCHAR(255) NULL');
  if (!present.account_number) adds.push('ADD COLUMN account_number VARCHAR(64) NULL');
  if (!present.account_name) adds.push('ADD COLUMN account_name VARCHAR(255) NULL');

  if (adds.length > 0) {
    const alterSql = `ALTER TABLE users ${adds.join(', ')}`;
    // execute alter - caller should be inside transaction if desired (we run this outside a user-locking tx)
    await conn.query(alterSql);
    // mark present as true for added columns
    for (const a of adds) {
      if (a.includes('bank_name')) present.bank_name = true;
      if (a.includes('account_number')) present.account_number = true;
      if (a.includes('account_name')) present.account_name = true;
    }
  }
  return present;
}

/*
  POST /withdrawals/bank
  Body: { bank_name?: string, account_number?: string, account_name?: string }
  Persists bank info to users table for the authenticated user and returns updated profile subset.
*/
async function updateBankInfo(req, res) {
  const user = req.user;
  if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

  const bankName = sanitizeStr(req.body.bank_name);
  const accountNumber = sanitizeStr(req.body.account_number);
  const accountName = sanitizeStr(req.body.account_name);

  if (!bankName && !accountNumber && !accountName) {
    return res.status(400).json({ error: 'No bank info provided' });
  }

  let conn;
  try {
    const pool = await getPool();
    conn = await pool.getConnection();

    // Ensure columns exist before updating
    try {
      await ensureUserBankColumns(conn);
    } catch (e) {
      console.error('[withdrawalController.updateBankInfo] ensureUserBankColumns failed', e && e.stack ? e.stack : e);
      // proceed but surface error
      await conn.release();
      return res.status(500).json({ error: 'Could not prepare database for bank info', detail: e && (e.message || e.sqlMessage) || String(e) });
    }

    await conn.beginTransaction();

    const updates = [];
    const params = [];
    if (bankName !== null) { updates.push('bank_name = ?'); params.push(bankName); }
    if (accountNumber !== null) { updates.push('account_number = ?'); params.push(accountNumber); }
    if (accountName !== null) { updates.push('account_name = ?'); params.push(accountName); }

    if (updates.length === 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Nothing to update' });
    }

    params.push(user.id);
    const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    await conn.query(sql, params);

    const [rows] = await conn.query('SELECT id, username, email, display_name, bank_name, account_number, account_name, balance FROM users WHERE id = ?', [user.id]);
    await conn.commit();

    const u = rows && rows[0] ? rows[0] : null;
    return res.json({
      ok: true,
      user: u ? {
        id: u.id,
        username: u.username,
        email: u.email,
        display_name: u.display_name,
        bank_name: u.bank_name,
        account_number: u.account_number,
        account_name: u.account_name,
        balance: Number(u.balance || 0)
      } : null
    });
  } catch (err) {
    try { if (conn) await conn.rollback(); } catch (_) {}
    console.error('[withdrawalController.updateBankInfo] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not update bank info', detail: err && (err.message || err.sqlMessage) || String(err) });
  } finally {
    try { if (conn) conn.release(); } catch (_) {}
  }
}

/*
  POST /withdrawals
  Body: { amount, bank_name?, account_number?, account_name? }
  Behavior:
    - if any bank field missing, attempt to read stored bank info from users table
    - require at least account_number and account_name (either provided or stored)
    - lock user row (FOR UPDATE) to check and deduct balance
    - insert a withdrawal row with status pending and record a debit balance transaction
*/
async function requestWithdrawal(req, res) {
  const user = req.user;
  if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

  const amount = validateAmount(req.body.amount);
  if (!amount) return res.status(400).json({ error: 'Invalid amount' });

  let bankName = sanitizeStr(req.body.bank_name);
  let accountNumber = sanitizeStr(req.body.account_number);
  let accountName = sanitizeStr(req.body.account_name);

  let conn;
  try {
    const pool = await getPool();
    conn = await pool.getConnection();

    // Ensure columns exist before reading users table
    try {
      await ensureUserBankColumns(conn);
    } catch (e) {
      console.error('[withdrawalController.requestWithdrawal] ensureUserBankColumns failed', e && e.stack ? e.stack : e);
      await conn.release();
      return res.status(500).json({ error: 'Could not prepare database for withdrawals', detail: e && (e.message || e.sqlMessage) || String(e) });
    }

    await conn.beginTransaction();

    // Fetch stored bank info and balance while locking the row
    const [userRows] = await conn.query('SELECT bank_name, account_number, account_name, balance FROM users WHERE id = ? FOR UPDATE', [user.id]);
    if (!userRows || !userRows[0]) {
      await conn.rollback();
      return res.status(404).json({ error: 'User not found' });
    }
    const stored = userRows[0];

    if (!bankName) bankName = stored.bank_name ? String(stored.bank_name).trim() : null;
    if (!accountNumber) accountNumber = stored.account_number ? String(stored.account_number).trim() : null;
    if (!accountName) accountName = stored.account_name ? String(stored.account_name).trim() : null;

    const balance = Number(stored.balance || 0);
    if (balance < amount) {
      await conn.rollback();
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    if (!accountNumber || !accountName) {
      await conn.rollback();
      return res.status(400).json({ error: 'Missing account name or account number' });
    }

    // Deduct balance (reserve)
    await conn.query('UPDATE users SET balance = balance - ? WHERE id = ?', [amount, user.id]);

    // Record a debit transaction via matchModel helper if available
    try {
      if (matchModel && typeof matchModel.insertBalanceTransaction === 'function') {
        await matchModel.insertBalanceTransaction(conn, {
          user_id: user.id,
          amount,
          type: 'debit',
          source: 'withdrawal_request',
          reference_id: `withdrawal_request_${Date.now()}_${user.id}`,
          status: 'pending',
          meta: { requested_by: user.id }
        });
      }
    } catch (txErr) {
      await conn.rollback();
      console.error('[withdrawalController.requestWithdrawal] transaction recording failed', txErr && txErr.stack ? txErr.stack : txErr);
      return res.status(500).json({ error: 'Could not record transaction' });
    }

    // Insert withdrawal row
    const insertSql = `
      INSERT INTO withdrawals (user_id, amount, bank_name, account_number, account_name, status, requested_at)
      VALUES (?, ?, ?, ?, ?, 'pending', NOW())
    `;
    const [result] = await conn.query(insertSql, [user.id, amount, bankName, accountNumber, accountName]);
    const withdrawalId = result && result.insertId ? result.insertId : null;

    await conn.commit();

    return res.json({
      ok: true,
      withdrawal_id: withdrawalId,
      amount,
      bank_name: bankName || null,
      account_number: accountNumber || null,
      account_name: accountName || null,
      status: 'pending',
      requested_at: new Date().toISOString()
    });
  } catch (err) {
    try { if (conn) await conn.rollback(); } catch (_) {}
    console.error('[withdrawalController.requestWithdrawal] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not request withdrawal', detail: err && (err.message || err.sqlMessage) || String(err) });
  } finally {
    try { if (conn) conn.release(); } catch (_) {}
  }
}

/*
  GET /withdrawals
  Returns a list of the current user's withdrawals (limit optional)
*/
async function getMyWithdrawals(req, res) {
  const user = req.user;
  if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

  const limit = Number(req.query.limit || 100);
  const offset = Number(req.query.offset || 0);

  try {
    const pool = await getPool();
    const [rows] = await pool.query(
      'SELECT id, user_id, amount, bank_name, account_number, account_name, status, requested_at, processed_at FROM withdrawals WHERE user_id = ? ORDER BY requested_at DESC LIMIT ? OFFSET ?',
      [user.id, limit, offset]
    );
    return res.json({ ok: true, withdrawals: rows });
  } catch (err) {
    console.error('[withdrawalController.getMyWithdrawals] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not fetch withdrawals', detail: err && (err.message || err.sqlMessage) || String(err) });
  }
}

/*
  GET /withdrawals/:id
  Returns a single withdrawal if owned by user or if the requester is admin
*/
async function getWithdrawal(req, res) {
  const user = req.user;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  try {
    const pool = await getPool();
    const [rows] = await pool.query('SELECT id, user_id, amount, bank_name, account_number, account_name, status, requested_at, processed_at FROM withdrawals WHERE id = ?', [id]);
    const w = rows && rows[0] ? rows[0] : null;
    if (!w) return res.status(404).json({ error: 'Withdrawal not found' });
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });
    if (String(w.user_id) !== String(user.id) && user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    return res.json({ ok: true, withdrawal: w });
  } catch (err) {
    console.error('[withdrawalController.getWithdrawal] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not fetch withdrawal', detail: err && (err.message || err.sqlMessage) || String(err) });
  }
}

/*
  Admin: list pending withdrawals
  GET /withdrawals/admin/pending
*/
async function listPending(req, res) {
  const user = req.user;
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  const limit = Number(req.query.limit || 500);
  const offset = Number(req.query.offset || 0);

  try {
    const pool = await getPool();
    const [rows] = await pool.query(
      'SELECT id, user_id, amount, bank_name, account_number, account_name, status, requested_at FROM withdrawals WHERE status = ? ORDER BY requested_at ASC LIMIT ? OFFSET ?',
      ['pending', limit, offset]
    );
    return res.json({ ok: true, pending: rows });
  } catch (err) {
    console.error('[withdrawalController.listPending] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not fetch pending withdrawals', detail: err && (err.message || err.sqlMessage) || String(err) });
  }
}

/*
  Admin: approve a withdrawal
  POST /withdrawals/admin/:id/approve
  Marks the withdrawal as paid and records processed_at, and optionally records an audit row via matchModel
*/
async function approveWithdrawal(req, res) {
  const user = req.user;
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  let conn;
  try {
    const pool = await getPool();
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT id, user_id, amount, status FROM withdrawals WHERE id = ? FOR UPDATE', [id]);
    const w = rows && rows[0] ? rows[0] : null;
    if (!w) { await conn.rollback(); return res.status(404).json({ error: 'Withdrawal not found' }); }
    if (w.status !== 'pending') { await conn.rollback(); return res.status(400).json({ error: 'Withdrawal not pending' }); }

    // mark as paid
    await conn.query('UPDATE withdrawals SET status = ?, processed_at = NOW() WHERE id = ?', ['paid', id]);

    // optional: insert an audit/transaction row (if you track payout records)
    try {
      if (matchModel && typeof matchModel.insertBalanceTransaction === 'function') {
        await matchModel.insertBalanceTransaction(conn, {
          user_id: w.user_id,
          amount: w.amount,
          type: 'payout',
          source: 'withdrawal_paid',
          reference_id: `withdrawal_paid_${id}`,
          status: 'completed',
          meta: { processed_by: user.id, withdrawal_id: id }
        });
      }
    } catch (txErr) {
      console.warn('[withdrawalController.approveWithdrawal] audit insert failed', txErr && txErr.stack ? txErr.stack : txErr);
    }

    await conn.commit();
    return res.json({ ok: true, id, status: 'paid' });
  } catch (err) {
    try { if (conn) await conn.rollback(); } catch (_) {}
    console.error('[withdrawalController.approveWithdrawal] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not approve withdrawal', detail: err && (err.message || err.sqlMessage) || String(err) });
  } finally {
    try { if (conn) conn.release(); } catch (_) {}
  }
}

/*
  Admin: decline a withdrawal
  POST /withdrawals/admin/:id/decline
  Refunds the reserved amount back to the user's balance and marks the withdrawal declined
*/
async function declineWithdrawal(req, res) {
  const user = req.user;
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  let conn;
  try {
    const pool = await getPool();
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT id, user_id, amount, status FROM withdrawals WHERE id = ? FOR UPDATE', [id]);
    const w = rows && rows[0] ? rows[0] : null;
    if (!w) { await conn.rollback(); return res.status(404).json({ error: 'Withdrawal not found' }); }
    if (w.status !== 'pending') { await conn.rollback(); return res.status(400).json({ error: 'Withdrawal not pending' }); }

    // refund user balance
    await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [w.amount, w.user_id]);

    // mark withdrawal as declined and set processed_at
    await conn.query('UPDATE withdrawals SET status = ?, processed_at = NOW() WHERE id = ?', ['declined', id]);

    // record refund transaction via matchModel if available
    try {
      if (matchModel && typeof matchModel.insertBalanceTransaction === 'function') {
        await matchModel.insertBalanceTransaction(conn, {
          user_id: w.user_id,
          amount: w.amount,
          type: 'credit',
          source: 'withdrawal_refund',
          reference_id: `withdrawal_refund_${id}`,
          status: 'completed',
          meta: { processed_by: user.id, withdrawal_id: id }
        });
      }
    } catch (txErr) {
      console.warn('[withdrawalController.declineWithdrawal] refund audit failed', txErr && txErr.stack ? txErr.stack : txErr);
    }

    await conn.commit();
    return res.json({ ok: true, id, status: 'declined' });
  } catch (err) {
    try { if (conn) await conn.rollback(); } catch (_) {}
    console.error('[withdrawalController.declineWithdrawal] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not decline withdrawal', detail: err && (err.message || err.sqlMessage) || String(err) });
  } finally {
    try { if (conn) conn.release(); } catch (_) {}
  }
}

module.exports = {
  requestWithdrawal,
  getMyWithdrawals,
  getWithdrawal,
  listPending,
  approveWithdrawal,
  declineWithdrawal,
  updateBankInfo
};
