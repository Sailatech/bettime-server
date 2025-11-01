// lib/lockout.js
// In-memory account lockout helpers. Replace with Redis for multi-instance deployments.

const ACCOUNT_LOCK_THRESHOLD = Number(process.env.ACCOUNT_LOCK_THRESHOLD || 5);
const ACCOUNT_LOCK_WINDOW_MS = Number(process.env.ACCOUNT_LOCK_WINDOW_MS || 15 * 60 * 1000); // 15m default
const ACCOUNT_LOCK_DURATION_MS = Number(process.env.ACCOUNT_LOCK_DURATION_MS || 15 * 60 * 1000); // 15m lock

const failedLoginAttempts = new Map();

/**
 * recordFailedLogin(identifier)
 * - increments counter and locks account when threshold reached
 */
function recordFailedLogin(identifier) {
  if (!identifier) return;
  const now = Date.now();
  const prev = failedLoginAttempts.get(identifier) || { count: 0, firstAttemptTs: now, lockedUntilTs: 0 };
  if (now - prev.firstAttemptTs > ACCOUNT_LOCK_WINDOW_MS) {
    prev.count = 0;
    prev.firstAttemptTs = now;
    prev.lockedUntilTs = 0;
  }
  prev.count += 1;
  if (prev.count >= ACCOUNT_LOCK_THRESHOLD) {
    prev.lockedUntilTs = now + ACCOUNT_LOCK_DURATION_MS;
    console.warn(`[lockout] account ${identifier} locked until ${new Date(prev.lockedUntilTs).toISOString()}`);
  }
  failedLoginAttempts.set(identifier, prev);
}

/**
 * clearFailedLogin(identifier)
 */
function clearFailedLogin(identifier) {
  if (!identifier) return;
  failedLoginAttempts.delete(identifier);
}

/**
 * isAccountLocked(identifier) => boolean
 */
function isAccountLocked(identifier) {
  if (!identifier) return false;
  const now = Date.now();
  const rec = failedLoginAttempts.get(identifier);
  if (!rec) return false;
  if (rec.lockedUntilTs && rec.lockedUntilTs > now) return true;
  if (rec.lockedUntilTs && rec.lockedUntilTs <= now) {
    failedLoginAttempts.delete(identifier);
    return false;
  }
  return false;
}

/**
 * getLockInfo(identifier) => { lockedUntilTs, count, firstAttemptTs } or null
 */
function getLockInfo(identifier) {
  return failedLoginAttempts.get(identifier) || null;
}

module.exports = {
  recordFailedLogin,
  clearFailedLogin,
  isAccountLocked,
  getLockInfo,
  ACCOUNT_LOCK_THRESHOLD,
  ACCOUNT_LOCK_WINDOW_MS,
  ACCOUNT_LOCK_DURATION_MS
};
