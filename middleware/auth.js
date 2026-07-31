// ============================================================
// 📁 backend/middleware/auth.js — MODIFIÉ (cookies HTTP-only)
// ============================================================

const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  try {
    // Priorité au cookie HTTP-only, fallback header pour compat transition
    const token = req.cookies?.token || 
      (req.headers.authorization?.startsWith('Bearer ') 
        ? req.headers.authorization.slice(7) 
        : null);

    if (!token) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { 
      algorithms: ['HS256'],
      maxAge: '7d'
    });

    req.user = decoded;
    next();
  } catch (e) {
    res.clearCookie('token', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict'
    });
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
