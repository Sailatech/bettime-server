// models/Withdrawal.js
const { getPool } = require('../config/db'); // adjust path to your db module

class WithdrawalModel {
  static async findById(id, forUpdate = false, conn = null) {
    const db = conn || await getPool();
    const sql = forUpdate ? 'SELECT * FROM withdrawals WHERE id = ? FOR UPDATE' : 'SELECT * FROM withdrawals WHERE id = ?';
    const [rows] = await db.query(sql, [id]);
    return rows[0] || null;
  }

  static async list({ limit = 50, offset = 0, status } = {}) {
    limit = Math.min(500, Number(limit) || 50);
    offset = Math.max(0, Number(offset) || 0);

    const db = await getPool();
    let sql = 'SELECT * FROM withdrawals';
    const params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY requested_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const [rows] = await db.query(sql, params);
    return rows;
  }

  static async deleteById(id) {
    const db = await getPool();
    const [result] = await db.query('DELETE FROM withdrawals WHERE id = ?', [id]);
    return result.affectedRows;
  }

  static async updateStatus(id, status, conn = null) {
    const db = conn || await getPool();
    const [result] = await db.query('UPDATE withdrawals SET status = ?, processed_at = NOW() WHERE id = ?', [status, id]);
    return result.affectedRows;
  }
}

module.exports = WithdrawalModel;
