// ============================================================
// 📁 backend/server.js — MODIFIÉ (sécurisé)
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const { initDB, db } = require('./db');
const { jobVerificationQuotidienne } = require('./jobs/verifier');
const { authMiddleware, adminOnly } = require('./middleware/auth');
const { 
  corsOptions, 
  helmetConfig, 
  authLimiter, 
  apiLimiter, 
  avisLimiter,
  retraitLimiter,
  sanitizeResponse,
  logger
} = require('./middleware/security');

// Créer le dossier logs s'il n'existe pas
if (!fs.existsSync('logs')) fs.mkdirSync('logs');

const app = express();

// Trust proxy (Railway / Render)
app.set('trust proxy', 1);

// 1. Sécurité d'abord
app.use(helmet(helmetConfig));
app.use(cors(corsOptions));
app.use(compression());
app.use(cookieParser());

// 2. Parsing body (limité pour éviter les attaques DoS)
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// 3. Sanitize les réponses (XSS protection)
app.use(sanitizeResponse);

// 4. Rate limiting global
app.use('/api/', apiLimiter);

// 5. Routes avec protections spécifiques
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/avis', avisLimiter);
app.use('/api/paiements/retrait', retraitLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/avis', require('./routes/avis'));
app.use('/api/paiements', require('./routes/paiements'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/client', require('./routes/client'));
app.use('/api/loterie', require('./routes/loterie'));

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

// Lancer la vérification manuellement (admin uniquement)
app.post('/api/admin/run-verif', authMiddleware, adminOnly, async (req, res) => {
  try {
    res.json({ success: true, message: '🔍 Vérification lancée en arrière-plan !' });
    jobVerificationQuotidienne();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6. Error handler global
app.use((err, req, res, next) => {
  logger.error(err.message, { 
    stack: err.stack, 
    path: req.path, 
    ip: req.ip,
    method: req.method 
  });

  if (err.message === 'CORS bloqué') {
    return res.status(403).json({ error: 'Origine non autorisée' });
  }

  res.status(err.status || 500).json({ 
    error: process.env.NODE_ENV === 'production' 
      ? 'Erreur serveur' 
      : err.message 
  });
});

// 7. Job cron quotidien à 8h Paris
cron.schedule('0 8 * * *', () => {
  logger.info('Job de vérification quotidien démarré');
  jobVerificationQuotidienne();
}, { timezone: 'Europe/Paris' });

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => {
    logger.info(`✅ Swimup Backend sécurisé sur le port ${PORT}`);
  });
}).catch((err) => {
  logger.error('Erreur init DB:', err);
  process.exit(1);
});
