// server.js
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');

const rateLimit = require('express-rate-limit');

let RedisStore;
let IORedis;
const REDIS_URL = process.env.REDIS_URL || '';

try {
  // optional: try to require Redis store libs if available
  IORedis = require('ioredis');
  RedisStore = require('rate-limit-redis');
} catch (e) {
  RedisStore = null;
  IORedis = null;
  // if not installed, we'll use the memory store from express-rate-limit
}

const db = require('./config/db');
const { initializeDatabase, getPool, closePool } = db;
const routes = require('./routes');
const authMiddleware = require('./middleware/auth');
const gameController = require('./controllers/gameController');
const { ensureAdminFromEnv } = require('./boot/admin-seed');

const apiKeyAuth = require('./middleware/apiKeyAuth');
const adminApiKeysRouter = require('./routes/adminApiKeys');
const adminAuthRouter = require('./routes/adminAuth');
const adminWithdrawalsRouter = require('./routes/adminWithdrawals');
const adminTablesRouter = require('./routes/adminTables');

const app = express();

// ---- Trust proxy ----
// Trusting 1 proxy hop by default (adjust via TRUST_PROXY env for your infra)
const TRUST_PROXY = process.env.TRUST_PROXY || '1';
app.set('trust proxy', TRUST_PROXY);

// Security headers and basic middleware
app.use(helmet());

// Simple request logger and origin debugger for CORS troubleshooting
app.use((req, res, next) => {
  try {
    console.debug(`[REQ] ${req.method} ${req.path} Origin=${req.headers.origin || 'none'}`);
  } catch (e) {}
  next();
});

// CORS configuration - same as before
const rawOrigins = (process.env.FRONTEND_ORIGIN || process.env.CORS_ORIGIN || '').trim();
let allowedOrigins = rawOrigins ? rawOrigins.split(',').map(s => s.trim()).filter(Boolean) : [];
const ADMIN_PANEL_ORIGIN = 'https://bettime-adminpanel.onrender.com';
if (!allowedOrigins.includes(ADMIN_PANEL_ORIGIN)) {
  allowedOrigins.push(ADMIN_PANEL_ORIGIN);
}
if (allowedOrigins.length === 0) {
  console.warn('WARNING: FRONTEND_ORIGIN not set. Set FRONTEND_ORIGIN to your front-end URL e.g. https://your-frontend.example.com');
} else {
  console.log('CORS allowed origins:', allowedOrigins);
}
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (!allowedOrigins.length && /^(https?:\/\/localhost:\d+|https?:\/\/127\.0\.0\.1:\d+)$/i.test(origin)) return callback(null, true);
    console.warn('CORS denied origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'x-api-key'],
  exposedHeaders: ['Content-Length'],
  credentials: true,
  optionsSuccessStatus: 204,
  maxAge: 600
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Serve static files and body parsers
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  express.json({
    limit: '1mb',
    verify: function (req, res, buf) {
      req.rawBody = buf;
    }
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

console.log('SERVER STARTING', {
  env: process.env.NODE_ENV || null,
  portEnv: process.env.PORT || null,
  frontendOrigin: allowedOrigins.length ? allowedOrigins : null,
  trustProxy: TRUST_PROXY,
  redisEnabled: !!(RedisStore && IORedis && REDIS_URL)
});

// ---- Rate limiting configuration ----
const DISABLE_RATE_LIMIT = String(process.env.DISABLE_RATE_LIMIT || 'false').toLowerCase() === 'true';

// Build a store for express-rate-limit: Redis if configured, otherwise fallback to memory store
let rateLimitStore = null;
if (!DISABLE_RATE_LIMIT && RedisStore && IORedis && REDIS_URL) {
  try {
    const client = new IORedis(REDIS_URL);
    rateLimitStore = new RedisStore({
      sendCommand: (...args) => client.call(...args)
    });
    console.log('Using Redis-backed rate limit store');
  } catch (e) {
    console.warn('Could not initialize Redis rate limit store, falling back to memory store', e && e.stack ? e.stack : e);
    rateLimitStore = null;
  }
}

// Helper for logging when a limit is hit
function onLimitReached(req, res, options) {
  const key = req.ip || req.connection.remoteAddress || 'unknown';
  console.warn(`[RATE-LIMIT] ${options.name || 'limit'} reached for key=${key} path=${req.originalUrl}`);
}

// Global lightweight limiter (per-IP)
const globalLimiter = DISABLE_RATE_LIMIT
  ? (req, res, next) => next()
  : rateLimit({
      windowMs: Number(process.env.GLOBAL_RATE_WINDOW_MS || 60 * 1000),
      max: Number(process.env.GLOBAL_RATE_MAX || 2000),
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        onLimitReached(req, res, { name: 'global' });
        res.status(429).json({ error: 'Too many requests (global). Try again later.' });
      },
      store: rateLimitStore || undefined,
      keyGenerator: (req) => req.ip || req.connection.remoteAddress
    });

app.use(globalLimiter);

// Strict limiter for auth-looking endpoints (login) to mitigate brute-force
const authLimitWindow = Number(process.env.AUTH_RATE_WINDOW_MS || 60 * 1000);
const authLimitMax = Number(process.env.AUTH_RATE_MAX || 10); // default 10 attempts per minute per IP
const authLimiter = DISABLE_RATE_LIMIT
  ? (req, res, next) => next()
  : rateLimit({
      windowMs: authLimitWindow,
      max: authLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        onLimitReached(req, res, { name: 'auth' });
        res.set('Retry-After', Math.ceil(authLimitWindow / 1000));
        res.status(429).json({ error: 'Too many login attempts. Try again later.' });
      },
      store: rateLimitStore || undefined,
      keyGenerator: (req) => req.ip || req.connection.remoteAddress
    });

// Optional: lightweight endpoint-specific limiter for sensitive operations other than login
const sensitiveLimiter = DISABLE_RATE_LIMIT
  ? (req, res, next) => next()
  : rateLimit({
      windowMs: Number(process.env.SENSITIVE_RATE_WINDOW_MS || 60 * 1000),
      max: Number(process.env.SENSITIVE_RATE_MAX || 200),
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        onLimitReached(req, res, { name: 'sensitive' });
        res.status(429).json({ error: 'Too many requests to this endpoint. Try again later.' });
      },
      store: rateLimitStore || undefined,
      keyGenerator: (req) => req.ip || req.connection.remoteAddress
    });

// ---- Account-level failed login lockout (in-memory simple implementation) ----
// NOTE: for production use persistent storage Redis or DB to survive restarts and scale across instances
const failedLoginAttempts = new Map(); // key: identifier (email or username), value: { count, firstAttemptTs, lockedUntilTs }
const ACCOUNT_LOCK_THRESHOLD = Number(process.env.ACCOUNT_LOCK_THRESHOLD || 5); // e.g., lock after 5 failed attempts
const ACCOUNT_LOCK_WINDOW_MS = Number(process.env.ACCOUNT_LOCK_WINDOW_MS || 15 * 60 * 1000); // count window
const ACCOUNT_LOCK_DURATION_MS = Number(process.env.ACCOUNT_LOCK_DURATION_MS || 15 * 60 * 1000); // lock duration

function recordFailedLogin(identifier) {
  if (!identifier) return;
  const now = Date.now();
  const prev = failedLoginAttempts.get(identifier) || { count: 0, firstAttemptTs: now, lockedUntilTs: 0 };
  // reset window if first attempt older than window
  if (now - prev.firstAttemptTs > ACCOUNT_LOCK_WINDOW_MS) {
    prev.count = 0;
    prev.firstAttemptTs = now;
    prev.lockedUntilTs = 0;
  }
  prev.count += 1;
  if (prev.count >= ACCOUNT_LOCK_THRESHOLD) {
    prev.lockedUntilTs = now + ACCOUNT_LOCK_DURATION_MS;
    console.warn(`[LOCKOUT] account ${identifier} locked until ${new Date(prev.lockedUntilTs).toISOString()}`);
  }
  failedLoginAttempts.set(identifier, prev);
}
function clearFailedLogin(identifier) {
  if (!identifier) return;
  failedLoginAttempts.delete(identifier);
}
function isAccountLocked(identifier) {
  if (!identifier) return false;
  const now = Date.now();
  const rec = failedLoginAttempts.get(identifier);
  if (!rec) return false;
  if (rec.lockedUntilTs && rec.lockedUntilTs > now) return true;
  // if lockedUntil expired, reset record
  if (rec.lockedUntilTs && rec.lockedUntilTs <= now) {
    failedLoginAttempts.delete(identifier);
    return false;
  }
  return false;
}

// Health check
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Serve Paystack callback page and existing routes
app.get('/payments/paystack-callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paystack-callback.html'));
});

// API guard function unchanged (keeps apiKeyAuth and authMiddleware behavior)
async function apiKeyOrSessionGuard(req, res, next) {
  try {
    let called = false;
    const maybeNextFromApiKey = () =>
      new Promise((resolve, reject) => {
        apiKeyAuth(req, res, (err) => {
          if (err) return reject(err);
          if (req.apiKey) {
            called = true;
            return resolve(true);
          }
          resolve(false);
        });
      });
    const apiKeyResult = await maybeNextFromApiKey().catch(() => false);
    if (apiKeyResult === true) return next();
    let sessionPassed = false;
    const maybeSession = () =>
      new Promise((resolve, reject) => {
        authMiddleware(req, res, (err) => {
          if (err) return reject(err);
          if (req.user) {
            sessionPassed = true;
            return resolve(true);
          }
          resolve(false);
        });
      });
    const sessionResult = await maybeSession().catch(() => false);
    if (sessionResult === true) return next();
    return res.status(401).json({ error: 'API key or session required' });
  } catch (err) {
    console.error('[apiKeyOrSessionGuard] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Auth guard error' });
  }
}

// Mount /api with guard that requires API key or session
app.use('/api', apiKeyOrSessionGuard, routes);

// Admin and other routers as before
app.use('/admin/auth', adminAuthRouter);
app.use('/admin/api-keys', adminApiKeysRouter);
app.use('/admin/withdrawals', adminWithdrawalsRouter);
app.use('/admin/tables', adminTablesRouter);

// Example protected routes unchanged...
app.get('/api/me', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user: { id: req.user.id, username: req.user.username, email: req.user.email, balance: req.user.balance } });
});
app.get('/api/external-data', async (req, res) => {
  res.json({ ok: true, apiKey: req.apiKey || null, user: req.user ? { id: req.user.id, username: req.user.username } : null, data: { message: 'external data' } });
});

// ---- Auth/login route override with extra protections ----
// If your existing adminAuthRouter or routes already handle /api/auth/login, you can keep them.
// This demonstrates wrapping the login endpoint with account lockout + ip limiter + optional captcha step.
app.post('/api/auth/login', authLimiter, async (req, res, next) => {
  try {
    const identifier = (req.body && (req.body.email || req.body.username || req.body.identifier)) || null;

    // 1) If account is currently locked, respond with 429 and Retry-After
    if (isAccountLocked(identifier)) {
      const rec = failedLoginAttempts.get(identifier) || {};
      const retryAfterSec = rec.lockedUntilTs ? Math.ceil((rec.lockedUntilTs - Date.now()) / 1000) : 60;
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'Account locked due to repeated failed login attempts. Try again later.' });
    }

    // 2) Forward request to your existing login handler (the same as before)
    // If your adminAuthRouter expects the request routed there, call next to let the router handle it.
    // Otherwise, call into your existing code to authenticate.
    // Here we delegate to the adminAuthRouter route by forwarding the request to that router's handler.
    // To avoid duplicate registration, ensure adminAuthRouter also handles POST /auth/login or adapt accordingly.
    // We'll call next() to let other route handlers (mounted at /admin/auth or /api) process this request.
    // But since you already mount adminAuthRouter at /admin/auth, and your routes may handle /api/auth/login,
    // we forward to existing routes by calling next() - ensure there is a matching handler mounted.
    return next();
  } catch (err) {
    console.error('[login wrapper] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Login processing error' });
  }
});

// To record failures and successes, ensure the actual login handler (inside your routes or adminAuthRouter)
// calls back to these helpers. You may either modify that handler to call `recordFailedLogin(identifier)`
// on authentication failure and `clearFailedLogin(identifier)` on success.
// Example: inside your login controller, on failed auth => recordFailedLogin(email); on success => clearFailedLogin(email);

// ---- Global error handler (unchanged) ----
app.use((err, req, res, next) => {
  try {
    console.error('Unhandled error', err && err.stack ? err.stack : err);
    const status = err && (err.status || 500) ? (err.status || 500) : 500;
    const payload = { error: (err && err.message) ? err.message : 'Internal server error' };
    if (process.env.NODE_ENV !== 'production' && err && err.stack) payload.stack = err.stack;
    try {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    } catch (e) {}
    res.status(status).json(payload);
  } catch (e) {
    console.error('Error in global error handler', e && e.stack ? e.stack : e);
    try { res.status(500).json({ error: 'Critical server error' }); } catch (_) {}
  }
});

// ---- Startup and shutdown (unchanged) ----
const PORT = Number(process.env.PORT || 4000);
let cleanupControllerHandle = null;
let serverInstance = null;

async function start() {
  try {
    await initializeDatabase();
    const pool = await getPool();
    const conn = await pool.getConnection();
    conn.release();
    try { await ensureAdminFromEnv(); } catch (e) { console.error('Admin seed error', e && e.stack ? e.stack : e); }

    try {
      if (gameController && typeof gameController.startPeriodicCleanup === 'function') {
        cleanupControllerHandle = gameController.startPeriodicCleanup({
          intervalMs: Number(process.env.CLEANUP_INTERVAL_MS || 5 * 60 * 1000)
        });
        console.log('Periodic cleanup started via gameController');
      } else {
        console.log('No gameController.startPeriodicCleanup available');
      }
    } catch (e) {
      console.warn('Could not start periodic cleanup via gameController', e && e.stack ? e.stack : e);
      try {
        if (typeof db.startCleanupTask === 'function') {
          db.startCleanupTask();
          console.log('Periodic cleanup started via db.startCleanupTask fallback');
        }
      } catch (ee) {
        console.warn('Could not start fallback cleanup task', ee && ee.stack ? ee.stack : ee);
      }
    }

    serverInstance = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server listening on port ${PORT}`);
    });

    const gracefulShutdown = async () => {
      console.log('Shutting down server...');
      try {
        try {
          if (cleanupControllerHandle && typeof cleanupControllerHandle.stop === 'function') {
            cleanupControllerHandle.stop();
            console.log('Stopped cleanup via gameController handle');
          } else if (typeof db.stopCleanupTask === 'function') {
            db.stopCleanupTask();
            console.log('Stopped cleanup via db.stopCleanupTask fallback');
          }
        } catch (e) {
          console.warn('Error stopping cleanup task', e && e.stack ? e.stack : e);
        }

        if (serverInstance && typeof serverInstance.close === 'function') {
          serverInstance.close(async (err) => {
            if (err) console.error('Error closing server', err && err.stack ? err.stack : err);
            try {
              await closePool();
              console.log('DB pool closed');
            } catch (e) {
              console.warn('Error closing DB pool', e && e.stack ? e.stack : e);
            } finally {
              process.exit(0);
            }
          });
        } else {
          try {
            await closePool();
            console.log('DB pool closed');
          } catch (e) {
            console.warn('Error closing DB pool', e && e.stack ? e.stack : e);
          } finally {
            process.exit(0);
          }
        }

        setTimeout(() => process.exit(1), 10000);
      } catch (e) {
        console.error('Shutdown error', e && e.stack ? e.stack : e);
        process.exit(1);
      }
    };

    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception', err && err.stack ? err.stack : err);
      gracefulShutdown();
    });
    process.on('unhandledRejection', (reason) => {
      console.error('Unhandled Rejection', reason && reason.stack ? reason.stack : reason);
    });
  } catch (err) {
    console.error('Failed to start server', err && err.stack ? err.stack : err);
    try {
      if (cleanupControllerHandle && typeof cleanupControllerHandle.stop === 'function') cleanupControllerHandle.stop();
    } catch (_) {}
    try { await closePool(); } catch (_) {}
    process.exit(1);
  }
}

start();
