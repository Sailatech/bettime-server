require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');

const db = require('./config/db');
const { initializeDatabase, getPool, closePool } = db;
const routes = require('./routes');
const authMiddleware = require('./middleware/auth');
const gameController = require('./controllers/gameController');
const { ensureAdminFromEnv } = require('./boot/admin-seed');

// API-key pieces
const apiKeyAuth = require('./middleware/apiKeyAuth');
const adminApiKeysRouter = require('./routes/adminApiKeys');

const adminAuthRouter = require('./routes/adminAuth');
const adminWithdrawalsRouter = require('./routes/adminWithdrawals');
const adminTablesRouter = require('./routes/adminTables');

const app = express();

// Security headers
app.use(helmet());

// Simple request logger and origin debugger for CORS troubleshooting
app.use((req, res, next) => {
  try {
    console.debug(`[REQ] ${req.method} ${req.path} Origin=${req.headers.origin || 'none'}`);
  } catch (e) {}
  next();
});

// CORS configuration - supports single origin or comma-separated list in FRONTEND_ORIGIN / CORS_ORIGIN
const rawOrigins = (process.env.FRONTEND_ORIGIN || process.env.CORS_ORIGIN || '').trim();
let allowedOrigins = rawOrigins ? rawOrigins.split(',').map(s => s.trim()).filter(Boolean) : [];

// ensure admin panel origin is included
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

// Serve static files from ./public so the Paystack callback page can be same-origin
app.use(express.static(path.join(__dirname, 'public')));

// Capture raw JSON body for webhook signature verification while still populating req.body
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
  frontendOrigin: allowedOrigins.length ? allowedOrigins : null
});

// Health check
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Explicit route for the Paystack callback page
app.get('/payments/paystack-callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paystack-callback.html'));
});

/**
 * Combined guard for /api:
 * - Allow if request supplies a valid API key (apiKeyAuth)
 * - OR allow if the request carries a valid admin/user session token (authMiddleware)
 * - Otherwise reject with 401
 *
 * This prevents clients from calling /api without either an API key or a logged-in session.
 */
async function apiKeyOrSessionGuard(req, res, next) {
  try {
    // quick path: if apiKeyAuth passes, it will call next() — emulate by calling it and catching errors
    let called = false;
    const maybeNextFromApiKey = () =>
      new Promise((resolve, reject) => {
        apiKeyAuth(req, res, (err) => {
          if (err) return reject(err);
          // apiKeyAuth sets req.apiKey when successful
          if (req.apiKey) {
            called = true;
            return resolve(true);
          }
          resolve(false);
        });
      });

    const apiKeyResult = await maybeNextFromApiKey().catch(() => false);
    if (apiKeyResult === true) return next();

    // second path: session-based auth. Run authMiddleware but do not early-return the response.
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

    // neither API key nor session present/valid
    return res.status(401).json({ error: 'API key or session required' });
  } catch (err) {
    console.error('[apiKeyOrSessionGuard] error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Auth guard error' });
  }
}

// Mount /api with guard that requires API key or session
app.use('/api', apiKeyOrSessionGuard, routes);

// Mount admin auth route (public login, protected logout)
app.use('/admin/auth', adminAuthRouter);

// Mount admin API-keys management (protected by your existing admin middleware inside the router)
app.use('/admin/api-keys', adminApiKeysRouter);

// Mount admin-only routers; they internally use auth + ensureAdmin middleware
app.use('/admin/withdrawals', adminWithdrawalsRouter);
app.use('/admin/tables', adminTablesRouter);

// Example protected route to verify auth middleware is wired correctly
app.get('/api/me', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user: { id: req.user.id, username: req.user.username, email: req.user.email, balance: req.user.balance } });
});

// Example route accessible to external clients via API key (also protected by apiKeyOrSessionGuard above)
// If you want endpoint-only rules, add them inside routes instead of here
app.get('/api/external-data', async (req, res) => {
  // req.apiKey present when accessed via API key; req.user present when session auth used
  res.json({ ok: true, apiKey: req.apiKey || null, user: req.user ? { id: req.user.id, username: req.user.username } : null, data: { message: 'external data' } });
});

// Global error handler (ensures a body is always returned)
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

const PORT = Number(process.env.PORT || 4000);

// startup helpers
let cleanupControllerHandle = null;
let serverInstance = null;

async function start() {
  try {
    // initialize DB and ensure schema (includes api_keys table if configured in config/db.js)
    await initializeDatabase();
    const pool = await getPool();

    // quick connection check
    const conn = await pool.getConnection();
    conn.release();

    // idempotent admin seeding from env (creates admin user if ADMIN_* vars present)
    try {
      await ensureAdminFromEnv();
    } catch (e) {
      console.error('Admin seed error', e && e.stack ? e.stack : e);
    }

    // start periodic DB cleanup via gameController (optional)
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

    // bind server
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
