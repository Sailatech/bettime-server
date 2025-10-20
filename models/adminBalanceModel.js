// models/adminBalanceModel.js
const { getPool } = require('../config/db');

async function getAdminBalance() {
  const db = await getPool();
  const [rows] = await db.query(`SELECT * FROM admin_balance WHERE id = 1 LIMIT 1`);
  return rows[0] || null;
}

async function addToAdminBalance(amount, conn = null) {
  const db = conn || (await getPool());
  await db.query(`UPDATE admin_balance SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, [amount]);
  return getAdminBalance();
}

module.exports = {
  getAdminBalance,
  addToAdminBalance,
};
