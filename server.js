require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');

const db = require('./config/db');
const { initializeDatabase, getPool, closePool } = db;

const routes = require('./routes');
const authMiddleware = require('./middleware/auth');
const gameController = require('./controllers/gameController');
const { ensureAdminFromEnv } = require('./boot/admin-seed');

const adminAuthRouter = require('./routes/adminAuth');
const adminWithdrawalsRouter = require('./routes/adminWithdrawals');
const adminTablesRouter = require('./routes/adminTables');

const app = express();

/* ---------------------------
   Basic security & middleware
   --------------------------- */

app.use(helmet());
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Capture raw JSON body for webhook signature verification while still populating req.body
app.use(
  express.json({
    limit: '1mb',
    verify: function (req, res, buf) {
      req.rawBody = buf;
    },
  })
);

app.use(express.urlencoded({ extended: true }));

/* ---------------------------
   CORS configuration
   --------------------------- */

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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: true,
  optionsSuccessStatus: 204,
  maxAge: 600,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

/* ---------------------------
   Static files & basic routes
   --------------------------- */

app.use(express.static(path.join(__dirname, 'public')));

// readiness flag for /healthz readiness probe
let ready = false;

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', ready });
});

app.get('/payments/paystack-callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paystack-callback.html'));
});

/* ---------------------------
   Mount routers
   --------------------------- */

app.use('/api', routes);
app.use('/admin/auth', adminAuthRouter);
app.use('/admin/withdrawals', adminWithdrawalsRouter);
app.use('/admin/tables', adminTablesRouter);

app.get('/api/me', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      balance: req.user.balance,
    },
  });
});

/* ---------------------------
   Global error handler
   --------------------------- */

app.use((err, req, res, next) => {
  try {
    console.error('Unhandled error', err && err.stack ? err.stack : err);
    const status = err && err.status ? err.status : 500;
    const payload = { error: err && err.message ? err.message : 'Internal server error' };
    if (process.env.NODE_ENV !== 'production' && err && err.stack) payload.stack = err.stack;
    if (!res.headersSent) res.status(status).json(payload);
    else console.warn('Headers already sent when handling error');
  } catch (e) {
    console.error('Error in global error handler', e && e.stack ? e.stack : e);
    try {
      if (!res.headersSent) res.status(500).json({ error: 'Critical server error' });
    } catch (_) {}
  }
});

/* ---------------------------
   Utilities: safe interval and DB helpers
   --------------------------- */

function startSafeInterval(fn, intervalMs) {
  let timer = null;
  let stopped = false;

  const run = async () => {
    if (stopped) return;
    try {
      await fn();
    } catch (err) {
      console.error('Error in periodic task', err && err.stack ? err.stack : err);
    } finally {
      if (!stopped) timer = setTimeout(run, intervalMs);
    }
  };

  timer = setTimeout(run, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function withConnection(pool, fn) {
  let conn = null;
  try {
    conn = await pool.getConnection();
    return await fn(conn);
  } finally {
    if (conn) {
      try {
        await conn.release();
      } catch (e) {
        console.warn('Error releasing DB connection', e && e.stack ? e.stack : e);
      }
    }
  }
}

/* ---------------------------
   Startup & graceful shutdown
   --------------------------- */

const PORT = Number(process.env.PORT || 4000);
let cleanupControllerHandle = null;
let serverInstance = null;
let isShuttingDown = false;

async function start() {
  try {
    console.log('SERVER STARTING', {
      env: process.env.NODE_ENV || null,
      portEnv: process.env.PORT || null,
      frontendOrigin: allowedOrigins.length ? allowedOrigins : null,
    });

    // initialize DB and ensure schema
    await initializeDatabase();

    // Quick pool connection check (uses withConnection to ensure release)
    const pool = await getPool();
    await withConnection(pool, async (conn) => {
      // simple ping to validate connection
      if (conn.ping) {
        try {
          await conn.ping();
        } catch (_) {
          // some drivers don't implement ping; ignore
        }
      }
    });

    // idempotent admin seeding from env
    try {
      await ensureAdminFromEnv();
    } catch (e) {
      console.error('Admin seed error', e && e.stack ? e.stack : e);
    }

    // Start periodic cleanup via gameController if available, using a safe interval wrapper
    try {
      const intervalMs = Number(process.env.CLEANUP_INTERVAL_MS || 5 * 60 * 1000);
      if (gameController && typeof gameController.cleanupOnce === 'function') {
        cleanupControllerHandle = startSafeInterval(() => gameController.cleanupOnce(), intervalMs);
        console.log('Periodic cleanup started via gameController.cleanupOnce with safe wrapper');
      } else if (gameController && typeof gameController.startPeriodicCleanup === 'function') {
        // if the controller returns a handle, ensure it has a stop()
        try {
          const handle = gameController.startPeriodicCleanup({ intervalMs });
          if (handle && typeof handle.stop === 'function') {
            cleanupControllerHandle = handle;
            console.log('Periodic cleanup started via gameController.startPeriodicCleanup');
          } else {
            console.warn('gameController.startPeriodicCleanup did not return a stop handle; wrapping is not possible');
          }
        } catch (e) {
          console.warn('Error starting gameController.startPeriodicCleanup', e && e.stack ? e.stack : e);
        }
      } else if (typeof db.startCleanupTask === 'function') {
        try {
          db.startCleanupTask();
          console.log('Periodic cleanup started via db.startCleanupTask fallback');
        } catch (e) {
          console.warn('Could not start fallback cleanup task', e && e.stack ? e.stack : e);
        }
      } else {
        console.log('No periodic cleanup configured or available');
      }
    } catch (e) {
      console.warn('Could not initialize periodic cleanup', e && e.stack ? e.stack : e);
    }

    // mark ready after DB init and optional seeding
    ready = true;

    // bind server
    serverInstance = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server', err && err.stack ? err.stack : err);
    try {
      if (cleanupControllerHandle && typeof cleanupControllerHandle.stop === 'function') cleanupControllerHandle.stop();
    } catch (_) {}
    try {
      await closePool();
    } catch (_) {}
    // do not call process.exit here; let the platform handle restarts
    throw err;
  }
}

async function stopCleanupTasks() {
  try {
    if (cleanupControllerHandle && typeof cleanupControllerHandle.stop === 'function') {
      try {
        cleanupControllerHandle.stop();
        console.log('Stopped cleanup via handle');
      } catch (e) {
        console.warn('Error stopping cleanup via handle', e && e.stack ? e.stack : e);
      }
    } else if (typeof db.stopCleanupTask === 'function') {
      try {
        db.stopCleanupTask();
        console.log('Stopped cleanup via db.stopCleanupTask fallback');
      } catch (e) {
        console.warn('Error stopping db.stopCleanupTask', e && e.stack ? e.stack : e);
      }
    }
  } catch (e) {
    console.warn('Error while attempting to stop cleanup tasks', e && e.stack ? e.stack : e);
  }
}

const gracefulShutdown = async (reason) => {
  if (isShuttingDown) {
    console.warn('Shutdown already in progress, ignoring duplicate signal', reason);
    return;
  }
  isShuttingDown = true;
  console.warn('Shutting down server due to:', reason);

  // mark not ready immediately so readiness probes fail fast
  ready = false;

  try {
    await stopCleanupTasks();
  } catch (e) {
    console.warn('Error stopping cleanup tasks during shutdown', e && e.stack ? e.stack : e);
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
        console.log('Graceful shutdown completed');
        // Do not call process.exit here; let the platform handle lifecycle.
      }
    });

    // fallback forced exit only if process hangs after timeout
    setTimeout(() => {
      console.error('Forcing shutdown after timeout');
      process.exit(1);
    }, 30_000);
  } else {
    try {
      await closePool();
      console.log('DB pool closed (no server instance)');
    } catch (e) {
      console.warn('Error closing DB pool', e && e.stack ? e.stack : e);
    } finally {
      console.log('Graceful shutdown completed (no server instance)');
    }
  }
};

/* ---------------------------
   Process event handlers
   --------------------------- */

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception', err && err.stack ? err.stack : err);
  // Try graceful shutdown; do not immediately exit
  gracefulShutdown('uncaughtException').catch(() => {});
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason && reason.stack ? reason.stack : reason);
  // Do not force shutdown; log and continue where safe
});

/* ---------------------------
   Start server
   --------------------------- */

start().catch((err) => {
  // If start fails, log and allow process to exit with failure (platform will restart)
  console.error('Server failed to start', err && err.stack ? err.stack : err);
});

module.exports = app;
