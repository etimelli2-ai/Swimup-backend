const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.headers.authorization;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Accès refusé' });
  next();
}

function clientOnly(req, res, next) {
  if (!['client', 'admin'].includes(req.user?.role)) return res.status(403).json({ error: 'Accès refusé' });
  next();
}

module.exports = { authMiddleware, adminOnly, clientOnly };
