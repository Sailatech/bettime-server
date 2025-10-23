// boot/admin-seed.js
const bcrypt = require('bcrypt');
const AdminModel = require('../models/AdminModel');

async function ensureAdminFromEnv() {
  const username = process.env.ADMIN_USERNAME;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !email || !password) return;

  // check existing by username or email
  const existing = await AdminModel.findByUsernameOrEmail(username) || await AdminModel.findByUsernameOrEmail(email);
  if (existing) {
    console.log('[admin-seed] admin already exists, skipping');
    return;
  }

  const rounds = Number(process.env.BCRYPT_ROUNDS || 12);
  const hash = await bcrypt.hash(password, rounds);
  const id = await AdminModel.createAdmin({ username, email, passwordHash: hash, displayName: 'Administrator' });
  console.log('[admin-seed] created admin id', id);
}

module.exports = { ensureAdminFromEnv };
