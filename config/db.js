require('dotenv').config();
const mysql = require('mysql2/promise');
const { URL } = require('url');

const UPLOAD_FEE_IDENTIFIER = -1;

// === GAME BOARD CONFIG ===
const BOARD_ROWS = 6;
const BOARD_COLS = 6;
const BOARD_CELLS = BOARD_ROWS * BOARD_COLS;
const EMPTY_BOARD = '_'.repeat(BOARD_CELLS);

let pool = null;

/**
 * Parse database connection details from DATABASE_URL or environment vars
 */
function getDbConfigFromEnv() {
  const { DATABASE_URL, CONNECTION_TIMEOUT = 10000 } = process.env;

  if (!DATABASE_URL) {
    throw new Error('❌ Missing DATABASE_URL in .env file');
  }

  const dbUrl = new URL(DATABASE_URL);
  const sslMode =
    dbUrl.searchParams.get('sslmode') || dbUrl.searchParams.get('ssl-mode');

  // Aiven and Render both may require SSL connections
  const ssl =
    sslMode && sslMode.toLowerCase().startsWith('req')
      ? { rejectUnauthorized: false }
      : undefined;

  return {
    host: dbUrl.hostname,
    port: Number(dbUrl.port) || 3306,
    user: dbUrl.username,
    password: dbUrl.password,
    database: dbUrl.pathname ? dbUrl.pathname.slice(1) : undefined,
    ssl,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: Number(CONNECTION_TIMEOUT)
  };
}

/**
 * Create admin connection config without database name
 */
function createAdminConnectionConfig() {
  const cfg = getDbConfigFromEnv();
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl,
    connectTimeout: cfg.connectTimeout
  };
}

/**
 * Ensure the database exists before connecting
 */
async function ensureDatabaseExists() {
  const cfg = getDbConfigFromEnv();
  const adminCfg = createAdminConnectionConfig();
  const connection = await mysql.createConnection(adminCfg);

  const dbName = cfg.database;
  if (!dbName) {
    await connection.end();
    throw new Error('❌ Database name not found in DATABASE_URL');
  }

  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
  );
  await connection.end();
}

/**
 * Create and cache a connection pool
 */
async function getPool() {
  if (pool) return pool;
  await ensureDatabaseExists();

  const cfg = getDbConfigFromEnv();

  const poolOptions = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: 'Z',
    connectTimeout: cfg.connectTimeout,
    ssl: cfg.ssl
  };

  pool = mysql.createPool(poolOptions);
  return pool;
}

/**
 * Calculate charge for an amount
 */
async function getChargeForAmount(dbClient, amount) {
  const MIN_AMOUNT_THRESHOLD = 100.0;
  const MIN_FEE_FOR_SMALL = 10.0;
  const MAX_BAND_UPPER = 10000000.0;
  const PERCENT_FALLBACK = 0.10;
  const TOP_BAND_CAP_FEE = 100000.0;

  const am = parseFloat(amount);
  if (isNaN(am) || am <= 0) return 0.0;

  if (am < MIN_AMOUNT_THRESHOLD) {
    return parseFloat(MIN_FEE_FOR_SMALL.toFixed(2));
  }

  try {
    if (!dbClient) dbClient = await getPool();

    const [rows] = await dbClient.query(
      `SELECT fee_amount FROM charge_rates
       WHERE ? BETWEEN min_amount AND max_amount
       ORDER BY min_amount LIMIT 1`,
      [am]
    );

    if (rows && rows.length) {
      return parseFloat(rows[0].fee_amount);
    }

    if (am > MAX_BAND_UPPER) {
      const pct = parseFloat((am * PERCENT_FALLBACK).toFixed(2));
      const capped = Math.min(pct, TOP_BAND_CAP_FEE);
      return parseFloat(capped.toFixed(2));
    }

    return parseFloat((am * PERCENT_FALLBACK).toFixed(2));
  } catch (err) {
    console.error('⚠️ Error calculating fee:', err.message);
    if (am < MIN_AMOUNT_THRESHOLD) return MIN_FEE_FOR_SMALL;
    if (am > MAX_BAND_UPPER) {
      const pct = parseFloat((am * PERCENT_FALLBACK).toFixed(2));
      const capped = Math.min(pct, TOP_BAND_CAP_FEE);
      return parseFloat(capped.toFixed(2));
    }
    return parseFloat((am * PERCENT_FALLBACK).toFixed(2));
  }
}

/**
 * Create all database tables including api_keys
 */
async function initializeDatabase() {
  const db = await getPool();

  // USERS
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      username VARCHAR(100) NOT NULL UNIQUE,
      email VARCHAR(255) UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(255) DEFAULT NULL,
      is_bot TINYINT(1) DEFAULT 0,
      bot_type ENUM('obvious','simulation') DEFAULT NULL,
      balance DECIMAL(14,2) DEFAULT 0.00,
      pending_balance DECIMAL(14,2) DEFAULT 0.00,
      bank_name VARCHAR(255) DEFAULT NULL,
      account_number VARCHAR(50) DEFAULT NULL,
      account_name VARCHAR(255) DEFAULT NULL,
      role ENUM('user','admin') DEFAULT 'user',
      status ENUM('active','banned','inactive') DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      last_login TIMESTAMP NULL DEFAULT NULL,
      INDEX (username), INDEX (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // AUTH TOKENS
  await db.query(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      token VARCHAR(512) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uniq_token (token),
      INDEX (user_id), INDEX (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // ADMIN BALANCE
  await db.query(`
    CREATE TABLE IF NOT EXISTS admin_balance (
      id TINYINT PRIMARY KEY,
      balance DECIMAL(18,2) DEFAULT 0.00,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  await db.query(`
    INSERT INTO admin_balance (id, balance)
    VALUES (1, 0.00)
    ON DUPLICATE KEY UPDATE id = id;
  `);

  // MATCHES
  await db.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id INT PRIMARY KEY AUTO_INCREMENT,
      creator_id INT NOT NULL,
      opponent_id INT DEFAULT NULL,
      board CHAR(36) NOT NULL DEFAULT '____________________________________',
      current_turn ENUM('X','O') NOT NULL DEFAULT 'X',
      status ENUM('waiting','playing','finished','cancelled') DEFAULT 'waiting',
      winner ENUM('creator','opponent','draw') DEFAULT NULL,
      bet_amount DECIMAL(14,2) DEFAULT 0.00,
      creator_display_name VARCHAR(255) DEFAULT NULL,
      creator_username VARCHAR(255) DEFAULT NULL,
      opponent_display_name VARCHAR(255) DEFAULT NULL,
      opponent_username VARCHAR(255) DEFAULT NULL,
      creator_is_bot TINYINT(1) DEFAULT 0,
      opponent_is_bot TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (opponent_id) REFERENCES users(id) ON DELETE SET NULL,
      INDEX (creator_id), INDEX (opponent_id), INDEX (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // BETS
  await db.query(`
    CREATE TABLE IF NOT EXISTS bets (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      match_id INT NOT NULL,
      user_id INT NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      net_amount DECIMAL(14,2) NOT NULL,
      fee_amount DECIMAL(14,2) NOT NULL,
      placed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      refunded TINYINT(1) DEFAULT 0,
      FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX (match_id), INDEX (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // MOVES
  await db.query(`
    CREATE TABLE IF NOT EXISTS moves (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      match_id INT NOT NULL,
      user_id INT NOT NULL,
      position TINYINT NOT NULL,
      symbol ENUM('X','O') NOT NULL,
      display_name VARCHAR(255) DEFAULT NULL,
      played_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY unique_move_per_position (match_id, position),
      INDEX (match_id), INDEX (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // BALANCE TRANSACTIONS
  await db.query(`
    CREATE TABLE IF NOT EXISTS balance_transactions (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NULL,
      amount DECIMAL(18,2) NOT NULL,
      type ENUM('credit','debit') NOT NULL,
      source VARCHAR(100),
      reference_id VARCHAR(100),
      status VARCHAR(32) DEFAULT NULL,
      meta JSON DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      INDEX (user_id), INDEX (type), INDEX (reference_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // CHARGE RATES
  await db.query(`
    CREATE TABLE IF NOT EXISTS charge_rates (
      min_amount DECIMAL(14,2) NOT NULL,
      max_amount DECIMAL(14,2) NOT NULL,
      fee_amount DECIMAL(14,2) NOT NULL,
      PRIMARY KEY (min_amount, max_amount)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // SEED CHARGE RATES
  const seedBands = [
    [10.00, 1000.00, 20.00],
    [1000.01, 5000.00, 50.00],
    [5000.01, 20000.00, 200.00],
    [20000.01, 100000.00, 1000.00],
    [100000.01, 500000.00, 5000.00],
    [500000.01, 1000000.00, 10000.00],
    [1000000.01, 5000000.00, 50000.00],
    [5000000.01, 10000000.00, 100000.00]
  ];

  for (const [minA, maxA, feeA] of seedBands) {
    await db.query(
      `INSERT INTO charge_rates (min_amount, max_amount, fee_amount)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE fee_amount = VALUES(fee_amount)`,
      [minA, maxA, feeA]
    );
  }

  // WITHDRAWALS
  await db.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      amount DECIMAL(14,2) NOT NULL,
      bank_name VARCHAR(255),
      account_number VARCHAR(50),
      account_name VARCHAR(255),
      status ENUM('pending','paid','declined') DEFAULT 'pending',
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      processed_at TIMESTAMP NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX (user_id), INDEX (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // PROMOTIONAL FEES
  await db.query(`
    CREATE TABLE IF NOT EXISTS promotional_fees (
      id INT PRIMARY KEY AUTO_INCREMENT,
      identifier INT NOT NULL,
      fee_amount DECIMAL(14,2) NOT NULL,
      description VARCHAR(255) DEFAULT NULL,
      starts_at DATETIME DEFAULT NULL,
      ends_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX (identifier)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // MIGRATIONS
  await db.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // API KEYS table
  await db.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(128) NOT NULL,
      key_hash VARCHAR(512) NOT NULL,
      created_by_admin TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP NULL,
      revoked_at TIMESTAMP NULL,
      meta JSON DEFAULT NULL,
      UNIQUE KEY uniq_name (name),
      INDEX (revoked_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log('✅ Database and tables initialized successfully');
}

/**
 * Gracefully close the pool
 */
async function closePool() {
  if (pool) {
    try {
      await pool.end();
    } catch {
      // ignore
    } finally {
      pool = null;
    }
  }
}

module.exports = {
  getPool,
  initializeDatabase,
  ensureDatabaseExists,
  createAdminConnectionConfig,
  getChargeForAmount,
  closePool,
  UPLOAD_FEE_IDENTIFIER,
  BOARD_ROWS,
  BOARD_COLS,
  BOARD_CELLS,
  EMPTY_BOARD
};
