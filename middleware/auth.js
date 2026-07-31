const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Token manquant' });

    // Gérer avec ou sans préfixe Bearer
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé — admin uniquement' });
  }
  next();
}

function clientOnly(req, res, next) {
  if (req.user?.role !== 'client' && req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Accès refusé — client uniquement' });
  }
  next();
}

module.exports = { authMiddleware, adminOnly, clientOnly };
