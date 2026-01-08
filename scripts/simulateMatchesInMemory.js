// scripts/simulateMatchesInMemory.js
// In-process simulator that generates simulated matches in memory and calls a provided publish callback.
// - Does NOT write to DB or call HTTP endpoints.
// - Exported startSimulator(publishFn, options) returns { stop }.
// - When run directly, it will start and log to stdout.

const DEFAULT_NAME_POOL = [
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

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeId() {
  return 'sim-' + Math.random().toString(36).slice(2, 9);
}

/**
 * startSimulator(publishFn, options)
 * - publishFn(payload) is called for each event (create/update). payload is a plain object.
 * - options:
 *    { intervalMs = 60000, resolveDelayMs = 5000, minStake = 10, maxStake = 2000, botCount = 30, namePool }
 */
async function startSimulator(publishFn, options = {}) {
  if (typeof publishFn !== 'function') throw new Error('publishFn callback required');

  const namePool = Array.isArray(options.namePool) && options.namePool.length ? options.namePool : DEFAULT_NAME_POOL;
  const intervalMs = Number(options.intervalMs || process.env.SIM_INTERVAL_MS || 60 * 1000);
  const resolveDelayMs = Number(options.resolveDelayMs || process.env.SIM_RESOLVE_DELAY_MS || 5 * 1000);
  const minStake = Number(options.minStake || process.env.SIM_MIN_STAKE || 10);
  const maxStake = Number(options.maxStake || process.env.SIM_MAX_STAKE || 2000);
  const botCount = Math.min(namePool.length, Number(options.botCount || process.env.SIM_BOT_COUNT || 30));
  const bots = [];

  // create in-memory bot list (id and displayName)
  for (let i = 0; i < botCount; i++) {
    const displayName = namePool[i];
    const id = makeId(); // in-memory id
    bots.push({ id, displayName, username: (displayName.replace(/\s+/g, '_').toLowerCase() + '_' + (i + 1)) });
  }

  // create a match object (in-memory) and publish create event
  async function createAndResolve() {
    let a = pick(bots);
    let b = pick(bots);
    let attempts = 0;
    while (a && b && a.id === b.id && attempts < 8) {
      b = pick(bots);
      attempts++;
    }
    if (!a || !b || a.id === b.id) return;

    const stake = randInt(minStake, maxStake);
    const now = new Date();
    const matchId = makeId();

    const created = {
      id: matchId,
      creator_id: a.id,
      creator_display_name: a.displayName,
      opponent_id: b.id,
      opponent_display_name: b.displayName,
      bet_amount: stake,
      status: 'waiting',
      winner: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      _simulated: true
    };

    // publish creation event
    try { publishFn({ type: 'match:create', match: created }); } catch (e) { /* swallow */ }

    // resolve after delay (publish update)
    setTimeout(() => {
      const winnerIsCreator = Math.random() < 0.5;
      const winnerId = winnerIsCreator ? a.id : b.id;
      const resolved = Object.assign({}, created, {
        winner: winnerId,
        status: 'finished',
        updated_at: new Date().toISOString()
      });
      try { publishFn({ type: 'match:update', match: resolved }); } catch (e) { /* swallow */ }
    }, resolveDelayMs);
  }

  // initial burst
  for (let i = 0; i < Math.min(3, bots.length); i++) {
    setTimeout(() => { createAndResolve().catch(() => {}); }, i * 300);
  }

  const interval = setInterval(() => {
    createAndResolve().catch(() => {});
  }, intervalMs);

  function stop() {
    clearInterval(interval);
  }

  return { stop, bots };
}

// CLI run
if (require.main === module) {
  (async () => {
    console.log('[sim] Starting in-memory simulator (CLI mode). It will log events to stdout.');
    const runner = await startSimulator((payload) => {
      console.log('[sim:event]', JSON.stringify(payload));
    }, {});
    process.on('SIGINT', () => { console.log('[sim] stopping'); runner.stop(); process.exit(0); });
    process.on('SIGTERM', () => { console.log('[sim] stopping'); runner.stop(); process.exit(0); });
  })().catch((err) => { console.error('[sim] fatal', err); process.exit(1); });
}

module.exports = { startSimulator };
