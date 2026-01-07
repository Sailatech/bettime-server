// scripts/simulateMatches.js
// Backend simulator for creating realistic match activity.
// - Creates up to BOT_COUNT bot users (idempotent).
// - Periodically creates matches between random bots and resolves them.
// - Uses transactions where possible and falls back to raw SQL if model methods differ.
// - Designed to run as a background process (pm2, systemd, docker sidecar, or manually).
//
// Usage:
//   NODE_ENV=production node scripts/simulateMatches.js
//
// Configuration via environment variables:
//   SIM_BOT_COUNT       (default 10)   - number of bot users to ensure exist
//   SIM_INTERVAL_MS     (default 60000) - how often to create a new simulated match (ms)
//   SIM_RESOLVE_DELAY_MS(default 5000)  - delay before resolving a created match (ms)
//   SIM_MIN_STAKE       (default 10)   - minimum stake for simulated matches
//   SIM_MAX_STAKE       (default 2000) - maximum stake for simulated matches
//   SIM_KEEP_RUNNING    (default true) - if "false", run once and exit
//
// IMPORTANT: Run this in a controlled environment. Bots are marked with is_bot=1.
// Adapt model method names if your codebase uses different APIs.

const path = require('path');

async function main() {
  // adapt these requires to your project layout
  const dbConfig = require(path.join(__dirname, '..', 'src', 'config', 'db'));
  const userModel = require(path.join(__dirname, '..', 'src', 'models', 'userModel'));
  const matchModel = require(path.join(__dirname, '..', 'src', 'models', 'matchModel'));

  const BOT_COUNT = Number(process.env.SIM_BOT_COUNT || 10);
  const SIM_INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS || 60 * 1000);
  const SIM_RESOLVE_DELAY_MS = Number(process.env.SIM_RESOLVE_DELAY_MS || 5 * 1000);
  const SIM_MIN_STAKE = Number(process.env.SIM_MIN_STAKE || 10);
  const SIM_MAX_STAKE = Number(process.env.SIM_MAX_STAKE || 2000);
  const SIM_KEEP_RUNNING = (typeof process.env.SIM_KEEP_RUNNING === 'undefined') ? true : (String(process.env.SIM_KEEP_RUNNING).toLowerCase() !== 'false');

  // small helper utils
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // Ensure DB pool is available
  if (!dbConfig || typeof dbConfig.getPool !== 'function') {
    console.error('db.getPool not found. Adjust require path to your DB config.');
    process.exit(1);
  }

  const pool = dbConfig.getPool();

  // Create or find bot users
  console.log(`[sim] Ensuring up to ${BOT_COUNT} bot users exist...`);
  const bots = [];
  for (let i = 1; i <= BOT_COUNT; i++) {
    const username = `sim_bot_${i}`;
    try {
      let user = null;
      try {
        user = await userModel.findByUsername(username);
      } catch (e) {
        // model may not expose findByUsername; fallback to raw query
        try {
          const conn = await pool.getConnection();
          const [rows] = await conn.query(
            `SELECT id, username, display_name AS displayName, balance FROM users WHERE username = ? LIMIT 1`,
            [username]
          );
          conn.release();
          if (rows && rows.length) user = rows[0];
        } catch (ee) {
          // ignore
        }
      }

      if (!user) {
        // create user via model if available, else raw insert
        try {
          if (typeof userModel.createUser === 'function') {
            user = await userModel.createUser({
              username,
              email: null,
              passwordHash: 'simulated-bot', // placeholder
              displayName: `Player ${i}`,
              isBot: 1,
              botType: 'sim',
              balance: randInt(5000, 20000)
            });
          } else {
            const conn = await pool.getConnection();
            const [res] = await conn.query(
              `INSERT INTO users (username, email, password_hash, display_name, is_bot, bot_type, balance, created_at, updated_at)
               VALUES (?, NULL, ?, ?, 1, 'sim', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              [username, 'simulated-bot', `Player ${i}`, randInt(5000, 20000)]
            );
            const [rows] = await conn.query(
              `SELECT id, username, display_name AS displayName, balance FROM users WHERE id = ? LIMIT 1`,
              [res.insertId]
            );
            conn.release();
            user = rows && rows.length ? rows[0] : null;
          }
          console.log(`[sim] Created bot ${username} id=${user && user.id}`);
        } catch (e) {
          console.warn(`[sim] Failed to create bot ${username}:`, e && e.message ? e.message : e);
          continue;
        }
      } else {
        console.log(`[sim] Found bot ${username} id=${user.id}`);
      }
      bots.push(user);
    } catch (err) {
      console.warn(`[sim] Unexpected error while ensuring bot ${username}:`, err && err.message ? err.message : err);
    }
  }

  if (bots.length < 2) {
    console.error('[sim] Need at least 2 bots to simulate matches. Exiting.');
    process.exit(1);
  }

  // Helper: create a match record and optionally resolve it
  async function createAndResolveMatch() {
    // pick two distinct bots
    let a = pick(bots);
    let b = pick(bots);
    let attempts = 0;
    while (a && b && a.id === b.id && attempts < 8) {
      b = pick(bots);
      attempts++;
    }
    if (!a || !b || a.id === b.id) {
      console.warn('[sim] Could not pick two distinct bots, skipping this round.');
      return;
    }

    const stake = randInt(SIM_MIN_STAKE, SIM_MAX_STAKE);
    const now = new Date();

    // Create match in DB using model if available, else raw SQL
    let matchId = null;
    try {
      if (typeof matchModel.createMatch === 'function') {
        // many apps expect an object payload; adapt if your model signature differs
        const created = await matchModel.createMatch({
          creator_id: a.id,
          opponent_id: b.id,
          creator_display_name: a.displayName || a.username,
          opponent_display_name: b.displayName || b.username,
          bet_amount: stake,
          status: 'waiting',
          created_at: now,
          updated_at: now
        });
        matchId = (created && (created.id || created.match_id)) || null;
      } else if (typeof matchModel.createMatchRow === 'function') {
        // alternative model method
        matchId = await matchModel.createMatchRow(null, a.id, {
          opponent_id: b.id,
          bet_amount: stake,
          creator_display_name: a.displayName || a.username,
          opponent_display_name: b.displayName || b.username,
          status: 'waiting'
        });
      } else {
        // fallback raw insert
        const conn = await pool.getConnection();
        const [res] = await conn.query(
          `INSERT INTO matches (creator_id, opponent_id, creator_display_name, opponent_display_name, bet_amount, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`,
          [a.id, b.id, a.displayName || a.username, b.displayName || b.username, stake, now, now]
        );
        matchId = res.insertId;
        conn.release();
      }
    } catch (e) {
      console.warn('[sim] match creation failed (model path):', e && e.message ? e.message : e);
      // try raw insert as last resort
      try {
        const conn = await pool.getConnection();
        const [res] = await conn.query(
          `INSERT INTO matches (creator_id, opponent_id, creator_display_name, opponent_display_name, bet_amount, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`,
          [a.id, b.id, a.displayName || a.username, b.displayName || b.username, stake, now, now]
        );
        matchId = res.insertId;
        conn.release();
      } catch (ee) {
        console.error('[sim] Raw insert fallback failed:', ee && ee.message ? ee.message : ee);
        return;
      }
    }

    if (!matchId) {
      console.warn('[sim] Could not obtain match id after creation, skipping resolve.');
      return;
    }

    console.log(`[sim] Created match #${matchId} ${a.username} vs ${b.username} stake ${stake}`);

    // Optionally adjust balances for realism (non-destructive): we won't debit real users,
    // but we can optionally decrement bot balances if you want. This is commented out by default.
    // try {
    //   if (typeof userModel.changeBalanceBy === 'function') {
    //     await userModel.changeBalanceBy(a.id, -stake);
    //     await userModel.changeBalanceBy(b.id, -stake);
    //   } else {
    //     const conn = await pool.getConnection();
    //     await conn.query(`UPDATE users SET balance = COALESCE(balance,0) - ? WHERE id = ?`, [stake, a.id]);
    //     await conn.query(`UPDATE users SET balance = COALESCE(balance,0) - ? WHERE id = ?`, [stake, b.id]);
    //     conn.release();
    //   }
    // } catch (e) {
    //   console.warn('[sim] Failed to adjust bot balances (non-fatal):', e && e.message ? e.message : e);
    // }

    // Resolve match after a short delay
    setTimeout(async () => {
      try {
        const winnerIsCreator = Math.random() < 0.5;
        const winnerId = winnerIsCreator ? a.id : b.id;
        // Use model resolve if available
        if (typeof matchModel.resolveMatch === 'function') {
          try {
            await matchModel.resolveMatch(null, matchId, {
              winner: winnerId,
              status: 'finished',
              updated_at: new Date()
            });
          } catch (e) {
            // try alternative signature
            await matchModel.resolveMatch(matchId, winnerId);
          }
        } else {
          // raw update
          const conn = await pool.getConnection();
          await conn.query(
            `UPDATE matches SET winner = ?, status = 'finished', updated_at = ? WHERE id = ?`,
            [winnerId, new Date(), matchId]
          );
          conn.release();
        }

        console.log(`[sim] Resolved match #${matchId} winner: ${winnerIsCreator ? a.username : b.username}`);
      } catch (e) {
        console.warn(`[sim] Failed to resolve match #${matchId}:`, e && e.message ? e.message : e);
      }
    }, SIM_RESOLVE_DELAY_MS);
  }

  // Runner: either run once or keep running
  if (!SIM_KEEP_RUNNING) {
    await createAndResolveMatch();
    console.log('[sim] Single-run simulation complete. Exiting.');
    process.exit(0);
  }

  console.log('[sim] Starting continuous simulation. Press Ctrl+C to stop.');
  // create an initial burst to populate feed
  for (let i = 0; i < Math.min(3, BOT_COUNT); i++) {
    // small stagger
    setTimeout(() => { createAndResolveMatch().catch(() => {}); }, i * 400);
  }

  // main interval
  const interval = setInterval(() => {
    createAndResolveMatch().catch((e) => {
      console.error('[sim] createAndResolveMatch error:', e && e.message ? e.message : e);
    });
  }, SIM_INTERVAL_MS);

  // graceful shutdown
  function shutdown() {
    console.log('[sim] Shutting down simulator...');
    clearInterval(interval);
    // allow pending resolves to finish for a short time
    setTimeout(() => process.exit(0), 2000);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[sim] Simulator crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
