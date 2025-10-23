// boot/admin-seed.js
const bcrypt = require('bcryptjs');
const AdminModel = require('../models/AdminModel');

async function ensureAdminFromEnv() {
  const username = process.env.ADMIN_USERNAME;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !email || !password) return;

  // check existing by username or email
  const existingByUsername = await AdminModel.findByUsernameOrEmail(username);
  const existingByEmail = await AdminModel.findByUsernameOrEmail(email);
  if (existingByUsername || existingByEmail) {
    console.log('[admin-seed] admin already exists, skipping');
    return;
  }

  const rounds = Number(process.env.BCRYPT_ROUNDS || 12);
  const hash = bcrypt.hashSync(password, rounds);

  // createAdmin implementation may expect snake_case column names; adjust to your model signature if needed
  const id = await AdminModel.createAdmin({
    username,
    email,
    password_hash: hash,
    display_name: 'Administrator'
  });

  console.log('[admin-seed] created admin id', id);
}

module.exports = { ensureAdminFromEnv };
