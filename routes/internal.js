// routes/internal.js
const express = require('express');
const router = express.Router();

const simulationService = require('../services/simulationService');
// best-effort require of gameController if it exposes runSimulationAsync
let gameController = null;
try { gameController = require('../controllers/gameController'); } catch (_) { gameController = null; }

// accept JSON bodies
router.post('/terminal-event', express.json(), (req, res) => {
  try {
    const { event, payload } = req.body || {};
    if (!event) return res.status(400).json({ ok: false, error: 'event required' });

    // Normalize payload values for easy parsing
    const matchId = payload && payload.matchId ? Number(payload.matchId) : null;
    const position = payload && typeof payload.position !== 'undefined' ? Number(payload.position) : null;
    const symbol = payload && payload.symbol ? payload.symbol : 'unknown';
    const userId = payload && payload.userId ? payload.userId : 'unknown';

    // Log concise line for moves
    if (event === 'playMove_done' && matchId !== null && position !== null) {
      console.log(`EVENT:move matchId=${matchId} position=${position} symbol=${symbol} userId=${userId} ts=${Date.now()}`);

      // Non-blocking attempt to trigger simulation / bot move asynchronously
      setImmediate(async () => {
        try {
          // Prefer controller helper if available
          if (gameController && typeof gameController.runSimulationAsync === 'function') {
            try {
              gameController.runSimulationAsync(matchId, { moveDelayMs: 0, joinAsBot: false });
              return;
            } catch (_) { /* fallback to service */ }
          }

          // Fallback: call simulationService.simulateMatch(matchId) if available
          if (simulationService && typeof simulationService.simulateMatch === 'function') {
            try {
              await simulationService.simulateMatch(matchId, { moveDelayMs: 0, joinAsBot: false });
              return;
            } catch (err) {
              console.warn('simulateMatch fallback error', err && err.message ? err.message : err);
            }
          }

          // As last resort, just log that we could not trigger simulation
          console.log(`EVENT:move_trigger_skipped matchId=${matchId} reason=no_simulator`);
        } catch (err) {
          console.error('ERROR:terminal-event-simulate', err && err.stack ? err.stack : err);
        }
      });

      return res.json({ ok: true });
    }

    // Generic events are logged and ignored
    console.log(`EVENT:${event}`, payload || {});
    return res.json({ ok: true });
  } catch (e) {
    console.error('ERROR:terminal_event', e && e.stack ? e.stack : e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

module.exports = router;
