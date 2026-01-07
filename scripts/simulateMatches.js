// scripts/simulateMatches.js
// Backend simulator for creating realistic match activity.
// - Exported startSimulator(options) so it can be required and started by other modules (e.g., controller).
// - When run directly (node scripts/simulateMatches.js) it runs as a CLI.
// - Publishes to Redis channel and/or POSTs to internal publish endpoint if configured.

const path = require('path');
const axios = require('axios');

async function createSimulatorRunner(customOptions = {}) {
  // adapt these requires to your project layout
  const dbConfig = require(path.join(__dirname, '..', 'src', 'config', 'db'));
  const userModel = require(path.join(__dirname, '..', 'src', 'models', 'userModel'));
  const matchModel = require(path.join(__dirname, '..', 'src', 'models', 'matchModel'));

  const NAME_POOL = customOptions.namePool || [
    "John","Joshua","Caleb","Daniel","Matthew","Timothy","Samuel","Isaac","Peter","Joseph","Paul","James",
    "Emmanuel","Christian","Ayomide","Chukwudi","Adebayo","Toluwani","Oluwasegun","Chibueze","Rotimi","Femi",
    "Chinedu","Babatunde","Ikenna","Gbenga","Ademola","Nnamdi","Obinna","Olamide","Oluwadamilare","Chibuike",
    "Danjuma","Abubakar","Hassan","Aminu","Bello","Ibrahim","Yakubu","Musa","Saleh","Umar","Usman","Adamu","Idris",
    "Ayodeji","Kelechi","Ifeanyi","Olawale","Korede","Olumide","Chukwuebuka","Somtochukwu","Ejike","Chinedum",
    "Olaniyi","Anuoluwapo","Ibukunoluwa","Segun","Akpan","Okon","Etim","Idara","Inyang","Uchechukwu","Chukwuemeka",
    "Akachi","Obioma","Obiora","Onyedikachi","Ekenedilichukwu","Chisom","Chiamaka","Amara","Ngozi","Ifeoma","Chinwe",
    "Chidinma","Adaeze","Uzoamaka","Amarachi","Oluchi","Anwuli","Oyin","Modupe","Funke","Adetutu","Abimbola","Adedayo",
    "Adetola","Ayotunde","Omolara","Tolulope","Similola","Taiwo","Kehinde","Idowu","Aisha","Fatima","Zainab","Hadiza",
    "Maryam","Safiya","Binta","Jumoke","Laraba","Sade","Bisola","Damilola","Eniola","Ijeoma","Kemi","Lola","Mosun",
    "Mojisola","Nike","Opeoluwa","Patience","Blessing","Grace","Joy","Hope","Mercy","Goodness","Faith","Charity",
    "Praise","Gloria","Esther","Hannah","Deborah","Sarah","Rebecca","Rachel","Leah","Dinah","Judith","Ruth","Abigail",
    "Elizabeth","Lydia","Priscilla","Rhoda","Tabitha","Martha","Naomi","Susanna","Anna","Shalom","Felicia","Eucharia",
    "Victoria","Christiana","Theresa","Stella","Juliana","Cecilia","Regina","Augustina","Vivian","Florence","Roseline",
    "Helen","Dorcas","Lois","Eunice","Phyllis","Agnes","Clara","Jane","Mary","Rosemary","Sophia","Olivia","Nora","Phoebe",
    "Bernice","Candace","Angel","Samson","Solomon","Jesse","Stephen","Philip","Mark","Luke","Titus","David","Jacob",
    "Abraham","Gabriel","Michael","Raphael","Christopher","Dominic","Francis","Anthony","Patrick","Julian","Adrian",
    "Martin"
  ];

  const SIM_INTERVAL_MS = Number(customOptions.SIM_INTERVAL_MS || process.env.SIM_INTERVAL_MS || 60 * 1000);
  const SIM_RESOLVE_DELAY_MS = Number(customOptions.SIM_RESOLVE_DELAY_MS || process.env.SIM_RESOLVE_DELAY_MS || 5 * 1000);
  const SIM_MIN_STAKE = Number(customOptions.SIM_MIN_STAKE || process.env.SIM_MIN_STAKE || 10);
  const SIM_MAX_STAKE = Number(customOptions.SIM_MAX_STAKE || process.env.SIM_MAX_STAKE || 2000);
  const SIM_KEEP_RUNNING = (typeof customOptions.SIM_KEEP_RUNNING !== 'undefined') ? customOptions.SIM_KEEP_RUNNING : ((typeof process.env.SIM_KEEP_RUNNING === 'undefined') ? true : (String(process.env.SIM_KEEP_RUNNING).toLowerCase() !== 'false'));
  const SIM_BOT_COUNT = Math.min(NAME_POOL.length, Number(customOptions.SIM_BOT_COUNT || process.env.SIM_BOT_COUNT || 100));
  const REDIS_URL = customOptions.REDIS_URL || process.env.REDIS_URL || process.env.REDIS;
  const REDIS_CHANNEL = customOptions.REDIS_CHANNEL || process.env.MATCHES_PUBSUB_CHANNEL || 'matches:updates';
  const HIT_PUBLISH_URL = customOptions.HIT_PUBLISH_URL || process.env.HIT_PUBLISH_URL || null;
  const INTERNAL_SECRET = customOptions.INTERNAL_SECRET || process.env.INTERNAL_PUBLISH_SECRET || '';

  // helpers
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // DB pool
  if (!dbConfig || typeof dbConfig.getPool !== 'function') {
    throw new Error('db.getPool not found. Adjust require path to your DB config.');
  }
  const pool = dbConfig.getPool();

  // Redis publisher (optional)
  let redisPub = null;
  if (REDIS_URL) {
    try {
      const IORedis = require('ioredis');
      redisPub = new IORedis(REDIS_URL, { lazyConnect: true });
      await redisPub.connect();
      console.log('[sim] Connected to Redis for publishing on channel', REDIS_CHANNEL);
    } catch (e) {
      console.warn('[sim] Could not connect to Redis, continuing without Redis publish:', e && e.message ? e.message : e);
      redisPub = null;
    }
  }

  // Ensure bot users exist using the NAME_POOL (idempotent)
  console.log(`[sim] Ensuring up to ${SIM_BOT_COUNT} bot users exist from name pool...`);
  const bots = [];
  for (let i = 0; i < SIM_BOT_COUNT; i++) {
    const displayName = NAME_POOL[i];
    if (!displayName) continue;
    const username = (displayName.replace(/\s+/g, '_').toLowerCase() + '_' + (i + 1));
    try {
      let user = null;
      try {
        if (typeof userModel.findByUsername === 'function') {
          user = await userModel.findByUsername(username);
        }
      } catch (e) {
        // ignore and fallback to raw query
      }

      if (!user) {
        try {
          const conn = await pool.getConnection();
          const [rows] = await conn.query(`SELECT id, username, display_name AS displayName, balance FROM users WHERE username = ? LIMIT 1`, [username]);
          conn.release();
          if (rows && rows.length) user = rows[0];
        } catch (ee) {
          // ignore
        }
      }

      if (!user) {
        // create via model if available
        try {
          if (typeof userModel.createUser === 'function') {
            user = await userModel.createUser({
              username,
              email: null,
              passwordHash: 'simulated-bot',
              displayName,
              isBot: 1,
              botType: 'sim',
              balance: randInt(5000, 20000)
            });
          } else {
            const conn = await pool.getConnection();
            const [res] = await conn.query(
              `INSERT INTO users (username, email, password_hash, display_name, is_bot, bot_type, balance, created_at, updated_at)
               VALUES (?, NULL, ?, ?, 1, 'sim', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
              [username, 'simulated-bot', displayName, randInt(5000, 20000)]
            );
            const [rows] = await conn.query(`SELECT id, username, display_name AS displayName, balance FROM users WHERE id = ? LIMIT 1`, [res.insertId]);
            conn.release();
            user = rows && rows.length ? rows[0] : null;
          }
          console.log(`[sim] Created bot ${username} (${displayName}) id=${user && user.id}`);
        } catch (e) {
          console.warn(`[sim] Failed to create bot ${username}:`, e && e.message ? e.message : e);
          continue;
        }
      } else {
        console.log(`[sim] Found bot ${username} (${displayName}) id=${user.id}`);
      }
      bots.push(user);
    } catch (err) {
      console.warn('[sim] Unexpected error while ensuring bot', username, err && err.message ? err.message : err);
    }
  }

  if (bots.length < 2) {
    throw new Error('Need at least 2 bots to simulate matches.');
  }

  // create and resolve a match between two bots
  async function createAndResolveMatch() {
    let a = pick(bots);
    let b = pick(bots);
    let attempts = 0;
    while (a && b && a.id === b.id && attempts < 8) {
      b = pick(bots);
      attempts++;
    }
    if (!a || !b || a.id === b.id) {
      console.warn('[sim] Could not pick two distinct bots, skipping.');
      return;
    }

    const stake = randInt(SIM_MIN_STAKE, SIM_MAX_STAKE);
    const now = new Date();

    // create match record
    let matchId = null;
    let createdMatch = null;
    try {
      if (typeof matchModel.createMatch === 'function') {
        createdMatch = await matchModel.createMatch({
          creator_id: a.id,
          opponent_id: b.id,
          creator_display_name: a.displayName || a.username,
          opponent_display_name: b.displayName || b.username,
          bet_amount: stake,
          status: 'waiting',
          created_at: now,
          updated_at: now
        });
        matchId = (createdMatch && (createdMatch.id || createdMatch.match_id)) || null;
      } else if (typeof matchModel.createMatchRow === 'function') {
        matchId = await matchModel.createMatchRow(null, a.id, {
          opponent_id: b.id,
          bet_amount: stake,
          creator_display_name: a.displayName || a.username,
          opponent_display_name: b.displayName || b.username,
          status: 'waiting'
        });
        createdMatch = await matchModel.getMatchById(null, matchId);
      } else {
        const conn = await pool.getConnection();
        const [res] = await conn.query(
          `INSERT INTO matches (creator_id, opponent_id, creator_display_name, opponent_display_name, bet_amount, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`,
          [a.id, b.id, a.displayName || a.username, b.displayName || b.username, stake, now, now]
        );
        matchId = res.insertId;
        const [rows] = await conn.query(`SELECT * FROM matches WHERE id = ? LIMIT 1`, [matchId]);
        conn.release();
        createdMatch = rows && rows.length ? rows[0] : null;
      }
    } catch (e) {
      console.warn('[sim] match creation failed, attempting raw insert fallback:', e && e.message ? e.message : e);
      try {
        const conn = await pool.getConnection();
        const [res] = await conn.query(
          `INSERT INTO matches (creator_id, opponent_id, creator_display_name, opponent_display_name, bet_amount, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?)`,
          [a.id, b.id, a.displayName || a.username, b.displayName || b.username, stake, now, now]
        );
        matchId = res.insertId;
        const [rows] = await conn.query(`SELECT * FROM matches WHERE id = ? LIMIT 1`, [matchId]);
        conn.release();
        createdMatch = rows && rows.length ? rows[0] : null;
      } catch (ee) {
        console.error('[sim] Raw insert fallback failed:', ee && ee.message ? ee.message : ee);
        return;
      }
    }

    if (!matchId) {
      console.warn('[sim] Could not obtain match id after creation, skipping resolve.');
      return;
    }

    // Build public payload for broadcasting
    const publicPayload = {
      id: matchId,
      creator_id: a.id,
      creator_display_name: a.displayName || a.username,
      opponent_id: b.id,
      opponent_display_name: b.displayName || b.username,
      bet_amount: stake,
      status: 'waiting',
      winner: null,
      created_at: now,
      updated_at: now,
      _simulated: true
    };

    // Publish initial creation event
    try {
      if (redisPub) {
        await redisPub.publish(REDIS_CHANNEL, JSON.stringify({ type: 'match:create', match: publicPayload }));
      }
    } catch (e) {
      console.warn('[sim] Redis publish failed for create event:', e && e.message ? e.message : e);
    }

    if (HIT_PUBLISH_URL) {
      try {
        await axios.post(HIT_PUBLISH_URL, { match: publicPayload }, {
          timeout: 5000,
          headers: { 'X-INTERNAL-SECRET': INTERNAL_SECRET || '' }
        });
      } catch (e) {
        // non-fatal
      }
    }

    console.log(`[sim] Created match #${matchId} ${a.username} vs ${b.username} stake ${stake}`);

    // Resolve after delay
    setTimeout(async () => {
      try {
        const winnerIsCreator = Math.random() < 0.5;
        const winnerId = winnerIsCreator ? a.id : b.id;
        const winnerLabel = winnerIsCreator ? 'creator' : 'opponent';
        // update DB
        try {
          if (typeof matchModel.resolveMatch === 'function') {
            await matchModel.resolveMatch(null, matchId, {
              winner: winnerId,
              status: 'finished',
              updated_at: new Date()
            });
          } else {
            const conn = await pool.getConnection();
            await conn.query(`UPDATE matches SET winner = ?, status = 'finished', updated_at = ? WHERE id = ?`, [winnerId, new Date(), matchId]);
            conn.release();
          }
        } catch (e) {
          // fallback raw update
          try {
            const conn = await pool.getConnection();
            await conn.query(`UPDATE matches SET winner = ?, status = 'finished', updated_at = ? WHERE id = ?`, [winnerId, new Date(), matchId]);
            conn.release();
          } catch (ee) {
            console.warn('[sim] Failed to mark match finished:', ee && ee.message ? ee.message : ee);
          }
        }

        const resolvedPayload = Object.assign({}, publicPayload, {
          winner: winnerId,
          status: 'finished',
          updated_at: new Date()
        });

        // Publish resolved event
        try {
          if (redisPub) {
            await redisPub.publish(REDIS_CHANNEL, JSON.stringify({ type: 'match:update', match: resolvedPayload }));
          }
        } catch (e) {
          console.warn('[sim] Redis publish failed for update event:', e && e.message ? e.message : e);
        }

        if (HIT_PUBLISH_URL) {
          try {
            await axios.post(HIT_PUBLISH_URL, { match: resolvedPayload }, {
              timeout: 5000,
              headers: { 'X-INTERNAL-SECRET': INTERNAL_SECRET || '' }
            });
          } catch (e) {
            // ignore
          }
        }

        console.log(`[sim] Resolved match #${matchId} winner: ${winnerIsCreator ? a.username : b.username} (${winnerLabel})`);
      } catch (e) {
        console.warn('[sim] Error resolving match', e && e.message ? e.message : e);
      }
    }, SIM_RESOLVE_DELAY_MS);
  }

  // Runner function
  async function start() {
    if (!SIM_KEEP_RUNNING) {
      await createAndResolveMatch();
      return { stop: () => {} };
    }

    console.log('[sim] Starting continuous simulation.');
    // initial burst
    for (let i = 0; i < Math.min(3, bots.length); i++) {
      setTimeout(() => { createAndResolveMatch().catch(() => {}); }, i * 400);
    }

    const interval = setInterval(() => {
      createAndResolveMatch().catch((e) => {
        console.error('[sim] createAndResolveMatch error:', e && e.message ? e.message : e);
      });
    }, SIM_INTERVAL_MS);

    function stop() {
      clearInterval(interval);
      if (redisPub && typeof redisPub.quit === 'function') {
        try { redisPub.quit(); } catch (e) {}
      }
    }

    return { stop };
  }

  return { start };
}

// exported function to start simulator programmatically
async function startSimulator(options = {}) {
  const runner = await createSimulatorRunner(options);
  return runner.start();
}

// If run directly, start CLI
if (require.main === module) {
  (async () => {
    try {
      const runner = await createSimulatorRunner({});
      const controller = await runner.start();
      // keep process alive; controller.stop() will be available if needed
      process.on('SIGINT', async () => {
        console.log('[sim] SIGINT received, shutting down.');
        controller.stop && controller.stop();
        process.exit(0);
      });
      process.on('SIGTERM', async () => {
        console.log('[sim] SIGTERM received, shutting down.');
        controller.stop && controller.stop();
        process.exit(0);
      });
    } catch (err) {
      console.error('[sim] Fatal error', err && err.stack ? err.stack : err);
      process.exit(1);
    }
  })();
}

module.exports = { startSimulator };
