// server.js
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');

let rateLimit;
try {
  rateLimit = require('express-rate-limit');
} catch (e) {
  rateLimit = null;
}

let RedisStore;
let IORedis;
const REDIS_URL = process.env.REDIS_URL || '';

try {
  IORedis = require('ioredis');
  RedisStore = require('rate-limit-redis');
} catch (e) {
  RedisStore = null;
  IORedis = null;
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

// CORS configuration
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
// Force-disable rate limiting regardless of env: use no-op middlewares
const DISABLE_RATE_LIMIT = true; // forced true to disable rate limiting

// Provide no-op store variable (for compatibility)
let rateLimitStore = null;

// Helper for logging when a limit would have been hit
function onLimitReached(req, res, options) {
  const key = req.ip || req.connection.remoteAddress || 'unknown';
  console.warn(`[RATE-LIMIT - DISABLED] ${options.name || 'limit'} would have been hit for key=${key} path=${req.originalUrl}`);
}

// Global limiter no-op (unlimited requests)
const globalLimiter = (req, res, next) => next();
app.use(globalLimiter);

// Auth limiter no-op
const authLimiter = (req, res, next) => next();

// Sensitive endpoint limiter no-op
const sensitiveLimiter = (req, res, next) => next();

// ---- Account-level failed login lockout (in-memory simple implementation) ----
const failedLoginAttempts = new Map();
const ACCOUNT_LOCK_THRESHOLD = Number(process.env.ACCOUNT_LOCK_THRESHOLD || 5);
const ACCOUNT_LOCK_WINDOW_MS = Number(process.env.ACCOUNT_LOCK_WINDOW_MS || 15 * 60 * 1000);
const ACCOUNT_LOCK_DURATION_MS = Number(process.env.ACCOUNT_LOCK_DURATION_MS || 15 * 60 * 1000);

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

// API guard function unchanged
async function apiKeyOrSessionGuard(req, res, next) {
  try {
    const maybeNextFromApiKey = () =>
      new Promise((resolve, reject) => {
        apiKeyAuth(req, res, (err) => {
          if (err) return reject(err);
          if (req.apiKey) {
            return resolve(true);
          }
          resolve(false);
        });
      });
    const apiKeyResult = await maybeNextFromApiKey().catch(() => false);
    if (apiKeyResult === true) return next();
    const maybeSession = () =>
      new Promise((resolve, reject) => {
        authMiddleware(req, res, (err) => {
          if (err) return reject(err);
          if (req.user) {
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

// Mount /api with guard
app.use('/api', apiKeyOrSessionGuard, routes);

// Admin and other routers
app.use('/admin/auth', adminAuthRouter);
app.use('/admin/api-keys', adminApiKeysRouter);
app.use('/admin/withdrawals', adminWithdrawalsRouter);
app.use('/admin/tables', adminTablesRouter);

// Example protected routes
app.get('/api/me', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user: { id: req.user.id, username: req.user.username, email: req.user.email, balance: req.user.balance } });
});
app.get('/api/external-data', async (req, res) => {
  res.json({ ok: true, apiKey: req.apiKey || null, user: req.user ? { id: req.user.id, username: req.user.username } : null, data: { message: 'external data' } });
});

// ---- Auth/login route override with extra protections ----
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

    // 2) Forward to existing handler (delegate to downstream routes or router)
    return next();
  } catch (err) {
    console.error('[login wrapper] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Login processing error' });
  }
});

// Note: ensure your actual login handler calls recordFailedLogin(identifier) on failure and clearFailedLogin(identifier) on success

// ---- Global error handler ----
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

// ---- Startup and shutdown ----
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
      console.log('Rate limiting disabled: true (no-op middlewares in use)');
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
