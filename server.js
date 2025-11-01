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

// application modules
const db = require('./config/db');
const { initializeDatabase, getPool, closePool } = db;
const routes = require('./routes'); // your router that mounts /auth, /withdrawals, /payments, /internal, /games, etc.
const authMiddleware = require('./middleware/auth');
const gameController = require('./controllers/gameController');
const { ensureAdminFromEnv } = require('./boot/admin-seed');

const apiKeyAuth = require('./middleware/apiKeyAuth');
const adminApiKeysRouter = require('./routes/adminApiKeys');
const adminAuthRouter = require('./routes/adminAuth');
const adminWithdrawalsRouter = require('./routes/adminWithdrawals');
const adminTablesRouter = require('./routes/adminTables');

const proxyRouter = require('./server/proxy'); // optional: separate proxy router (queue + retry); create this file if you need outbound proxying
// Lockout utilities moved to lib/lockout.js (see comments below)
const lockout = require('./lib/lockout');

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
  // IMPORTANT: do NOT include 'x-api-key' here so browsers will not attempt to send it
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  exposedHeaders: ['Content-Length', 'Retry-After'],
  credentials: true,
  optionsSuccessStatus: 204,
  maxAge: 600
};
app.use(cors(corsOptions));
// short-circuit preflight to avoid extra forwarding work
app.options('*', cors(corsOptions), (req, res) => res.sendStatus(204));

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
// Force-disable rate limiting regardless of env: use no-op middlewares by default
const DISABLE_RATE_LIMIT = true; // forced true to disable rate limiting

// Global limiter no-op (unlimited requests)
const globalLimiter = (req, res, next) => next();
app.use(globalLimiter);

// Auth limiter no-op (kept in place so you can swap in a real limiter later)
const authLimiter = (req, res, next) => next();

// Sensitive endpoint limiter no-op
const sensitiveLimiter = (req, res, next) => next();

// ---- Account-level failed login lockout utilities are in lib/lockout.js ----
// Ensure lib/lockout exports: { recordFailedLogin, clearFailedLogin, isAccountLocked, ACCOUNT_LOCK_THRESHOLD, ACCOUNT_LOCK_WINDOW_MS, ACCOUNT_LOCK_DURATION_MS }
// Example: const lockout = require('./lib/lockout');
// call lockout.recordFailedLogin(identifier) from your auth controller on failed attempts
// call lockout.clearFailedLogin(identifier) on successful login
// use lockout.isAccountLocked(identifier) in your auth controller to return 429 + Retry-After

// Health check
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Serve Paystack callback page and existing routes
app.get('/payments/paystack-callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paystack-callback.html'));
});

// ---- Mount API routes (main router handles /auth, /withdrawals, /payments, /internal, /games, etc.) ----
// The routes module should include the login handler and perform lockout checks via lib/lockout utilities
app.use('/api', routes);

// ---- Admin and other routers ----
app.use('/admin/auth', adminAuthRouter);
app.use('/admin/api-keys', adminApiKeysRouter);
app.use('/admin/withdrawals', adminWithdrawalsRouter);
app.use('/admin/tables', adminTablesRouter);

// ---- Example protected endpoints (keep as convenience) ----
app.get('/api/me', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user: { id: req.user.id, username: req.user.username, email: req.user.email, balance: req.user.balance } });
});
app.get('/api/external-data', async (req, res) => {
  res.json({ ok: true, apiKey: req.apiKey || null, user: req.user ? { id: req.user.id, username: req.user.username } : null, data: { message: 'external data' } });
});

// ---- Proxy router (outbound proxy/queue) ----
// Mount the proxy router under /proxy if you need to forward requests to an external MAIN_API.
// Keep proxy logic separate so it does not affect internal route handling.
// Implement server/proxy.js with queue/retry logic and ensure it strips/forbids browser-sent server-only headers.
// If you do not need a proxy, you can remove this mount.
try {
  if (proxyRouter && typeof proxyRouter === 'function') {
    app.use('/proxy', proxyRouter());
    console.log('Proxy router mounted at /proxy');
  } else if (proxyRouter) {
    app.use('/proxy', proxyRouter);
    console.log('Proxy router mounted at /proxy');
  } else {
    console.log('No proxy router found');
  }
} catch (e) {
  console.warn('Proxy router could not be mounted:', e && e.stack ? e.stack : e);
}

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
