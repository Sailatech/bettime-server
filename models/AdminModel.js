// models/AdminModel.js
const { getPool } = require('../config/db');

class AdminModel {
  static async findByUsernameOrEmail(identifier) {
    const db = await getPool();
    const q = `SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1`;
    const [rows] = await db.query(q, [identifier, identifier]);
    return rows[0] || null;
  }

  static async findById(id) {
    const db = await getPool();
    const [rows] = await db.query(`SELECT * FROM users WHERE id = ? LIMIT 1`, [id]);
    return rows[0] || null;
  }

  static async createAdmin({ username, email, passwordHash, displayName = 'Administrator' }) {
    const db = await getPool();
    const q = `INSERT INTO users (username, email, password_hash, display_name, role, status, created_at)
               VALUES (?, ?, ?, ?, 'admin', 'active', NOW())`;
    const [res] = await db.query(q, [username, email, passwordHash, displayName]);
    return res.insertId;
  }

  static async promoteToAdmin(userId) {
    const db = await getPool();
    const [res] = await db.query(`UPDATE users SET role = 'admin' WHERE id = ?`, [userId]);
    return res.affectedRows;
  }
}

module.exports = AdminModel;
