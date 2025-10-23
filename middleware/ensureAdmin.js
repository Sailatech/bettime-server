// middleware/ensureAdmin.js
// Requires auth middleware to run first (it attaches req.user)

module.exports = function ensureAdmin(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    return next();
  } catch (err) {
    console.error('[ensureAdmin] unexpected error', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
  }
};
