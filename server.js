// server.js
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

const db = require('./config/db');
const { initializeDatabase, getPool, closePool } = db;
const routes = require('./routes');
const authMiddleware = require('./middleware/auth');
const gameController = require('./controllers/gameController');

const app = express();

// Security headers
app.use(helmet());

// CORS configuration
const frontendOrigin = process.env.FRONTEND_ORIGIN || process.env.CORS_ORIGIN || '';
if (!frontendOrigin) {
  console.warn('WARNING: FRONTEND_ORIGIN not set. Set FRONTEND_ORIGIN to your front-end URL e.g. https://bettime.onrender.com');
}

const corsOptions = {
  origin: function (origin, callback) {
    // Allow non-browser tools such as curl or Postman where origin is undefined
    if (!origin) return callback(null, true);
    // Allow exact configured frontend origin
    if (frontendOrigin && origin === frontendOrigin) return callback(null, true);
    // Allow localhost during development if FRONTEND_ORIGIN not provided
    if (!frontendOrigin && /^(https?:\/\/localhost:\d+|https?:\/\/127\.0\.0\.1:\d+)$/i.test(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: true,
  optionsSuccessStatus: 204,
  maxAge: 600
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // ensure preflight handled

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

// Basic startup log
console.log('SERVER STARTING', {
  env: process.env.NODE_ENV || null,
  portEnv: process.env.PORT || null,
  frontendOrigin: frontendOrigin || null
});

// Health check
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Explicit route for the Paystack callback page
app.get('/payments/paystack-callback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paystack-callback.html'));
});

// Mount API routes under /api
app.use('/api', routes);

// Example protected route to verify auth middleware is wired correctly
app.get('/api/me', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ user: { id: req.user.id, username: req.user.username, email: req.user.email, balance: req.user.balance } });
});

// Global error handler (ensures a body is always returned)
app.use((err, req, res, next) => {
  try {
    console.error('Unhandled error', err && err.stack ? err.stack : err);
    const status = err.status || 500;
    const payload = { error: err.message || 'Internal server error' };
    if (process.env.NODE_ENV !== 'production' && err.stack) payload.stack = err.stack;
    res.status(status).json(payload);
  } catch (e) {
    // Last-resort fallback if error handler itself fails
    console.error('Error in global error handler', e && e.stack ? e.stack : e);
    try { res.status(500).json({ error: 'Critical server error' }); } catch (_) {}
  }
});

const PORT = Number(process.env.PORT || 4000);

// startup hints
console.log('PAYSTACK_SECRET present:', !!(process.env.PAYSTACK_SECRET || process.env.PAYSTACK_SECRET_KEY));
if (process.env.FRONTEND_CALLBACK_URL) {
  console.log('FRONTEND_CALLBACK_URL:', process.env.FRONTEND_CALLBACK_URL);
} else {
  console.log('Tip: set FRONTEND_CALLBACK_URL to your /payments/paystack-callback URL for Paystack init e.g. http://localhost:4000/payments/paystack-callback');
}

let cleanupControllerHandle = null;
let serverInstance = null;

async function start() {
  try {
    await initializeDatabase();
    const pool = await getPool();

    // quick connection check
    const conn = await pool.getConnection();
    conn.release();

    // start periodic DB cleanup via gameController
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

    // ensure we bind to 0.0.0.0 for Render
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
