const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const gameCtrl = require('../controllers/gameController');

// Create a match or join an existing waiting match with same stake
router.post('/matches', auth, async (req, res, next) => {
  try { await gameCtrl.createMatch(req, res); } catch (err) { next(err); }
});

// Explicitly join a specific match
router.post('/matches/:id/join', auth, async (req, res, next) => {
  try { await gameCtrl.joinMatch(req, res); } catch (err) { next(err); }
});

// Play a move on a match
router.post('/matches/:id/move', auth, async (req, res, next) => {
  try { await gameCtrl.playMove(req, res); } catch (err) { next(err); }
});

// Get match state and moves
router.get('/matches/:id', auth, async (req, res, next) => {
  try { await gameCtrl.getMatch(req, res); } catch (err) { next(err); }
});

// Cancel a waiting match (creator only)
router.post('/matches/:id/cancel', auth, async (req, res, next) => {
  try { await gameCtrl.cancelMatch(req, res); } catch (err) { next(err); }
});

// Request that the server simulate an opponent and join the waiting match
router.post('/matches/:id/simulate', auth, async (req, res, next) => {
  try { await gameCtrl.simulateOpponent(req, res); } catch (err) { next(err); }
});

module.exports = router;
