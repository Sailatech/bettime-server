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

const adminAuthRouter = require('./routes/adminAuth');
const adminWithdrawalsRouter = require('./routes/adminWithdrawals');
const adminTablesRouter = require('./routes/adminTables');

const app = express();

/* ---------------------------
   Basic security & middleware
   --------------------------- */

// Security headers
app.use(helmet());

// Parse cookies
app.use(cookieParser());

// Capture raw JSON body for webhook signature verification while still populating req.body
app.use(
  express.json({
    limit: '1mb',
    verify: function (req, res, buf) {
      req.rawBody = buf;
    },
  })
);

// Parse URL-encoded bodies
app.use(express.urlencoded({ extended: true }));

/* ---------------------------
   CORS configuration
   --------------------------- */

const rawOrigins = (process.env.FRONTEND_ORIGIN || process.env.CORS_ORIGIN || '').trim();
let allowedOrigins = rawOrigins
  ? rawOrigins.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

// Ensure admin panel origin is allowed
const ADMIN_PANEL_ORIGIN = 'https://bettime-adminpanel.onrender.com';
if (!allowedOrigins.includes(ADMIN_PANEL_ORIGIN)) {
  allowedOrigins.push(ADMIN_PANEL_ORIGIN);
}

if (allowedOrigins.length === 0) {
  console.warn(
    'WARNING: FRONTEND_ORIGIN not set. Set FRONTEND_ORIGIN to your front-end URL e.g. https://your-frontend.example.com'
  );
} else {
  console.log('CORS allowed origins:', allowedOrigins);
}

const corsOptions = {
  origin: function (origin, callback) {
    // allow non-browser tools such as curl or Postman where origin is undefined
    if (!origin) return callback(null, true);

    // Exact match against configured origins
    if (allowedOrigins.includes(origin)) return callback(null, true);

    // For development when FRONTEND_ORIGIN not configured allow localhost variants
    if (
      !allowedOrigins.length &&
      /^(https?:\/\/localhost:\d+|https?:\/\/127\.0\.0\.1:\d+)$/i.test(origin)
    ) {
      return callback(null, true);
    }

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
   Static files & routes
   --------------------------- */

// Serve static files from ./public so the Paystack callback page can be same-origin
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Explicit route for the Paystack callback page
app.get('/payments/paystack-callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paystack-callback.html'));
});

// Public API routes under /api
app.use('/api', routes);

// Admin auth and admin-only routers
app.use('/admin/auth', adminAuthRouter);
app.use('/admin/withdrawals', adminWithdrawalsRouter);
app.use('/admin/tables', adminTablesRouter);

// Example protected route to verify auth middleware is wired correctly
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

    if (process.env.NODE_ENV !== 'production' && err && err.stack) {
      payload.stack = err.stack;
    }

    // Ensure we always send JSON
    if (!res.headersSent) {
      res.status(status).json(payload);
    } else {
      console.warn('Headers already sent when handling error');
    }
  } catch (e) {
    console.error('Error in global error handler', e && e.stack ? e.stack : e);
    try {
      if (!res.headersSent) res.status(500).json({ error: 'Critical server error' });
    } catch (_) {}
  }
});

/* ---------------------------
   Startup and graceful shutdown
   --------------------------- */

const PORT = Number(process.env.PORT || 4000);

let cleanupControllerHandle = null;
let serverInstance = null;

async function start() {
  try {
    console.log('SERVER STARTING', {
      env: process.env.NODE_ENV || null,
      portEnv: process.env.PORT || null,
      frontendOrigin: allowedOrigins.length ? allowedOrigins : null,
    });

    // Initialize DB and ensure schema
    await initializeDatabase();

    // Quick pool connection check
    const pool = await getPool();
    const conn = await pool.getConnection();
    conn.release();

    // Idempotent admin seeding from env (creates admin user if ADMIN_* vars present)
    try {
      await ensureAdminFromEnv();
    } catch (e) {
      console.error('Admin seed error', e && e.stack ? e.stack : e);
    }

    // Start periodic DB cleanup via gameController (optional)
    try {
      if (gameController && typeof gameController.startPeriodicCleanup === 'function') {
        cleanupControllerHandle = gameController.startPeriodicCleanup({
          intervalMs: Number(process.env.CLEANUP_INTERVAL_MS || 5 * 60 * 1000),
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

    // Bind server
    serverInstance = app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server', err && err.stack ? err.stack : err);
    // Attempt cleanup then exit
    try {
      if (cleanupControllerHandle && typeof cleanupControllerHandle.stop === 'function') {
        cleanupControllerHandle.stop();
      }
    } catch (_) {}
    try {
      await closePool();
    } catch (_) {}
    process.exit(1);
  }
}

async function stopCleanupTasks() {
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
}

const gracefulShutdown = async () => {
  console.log('Shutting down server...');
  try {
    await stopCleanupTasks();

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

      // Force exit if server does not close in time
      setTimeout(() => {
        console.error('Forcing shutdown after timeout');
        process.exit(1);
      }, 10000);
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
  } catch (e) {
    console.error('Shutdown error', e && e.stack ? e.stack : e);
    process.exit(1);
  }
};

// Signal handlers
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception', err && err.stack ? err.stack : err);
  // try to shutdown gracefully
  gracefulShutdown();
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection', reason && reason.stack ? reason.stack : reason);
});

// Start server
start();

module.exports = app;
