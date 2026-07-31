require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const winston = require('winston');
const { initDB, db } = require('./db');
const { jobVerificationQuotidienne } = require('./jobs/verifier');

// Logger structuré
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

const app = express();

// 1. Helmet — sécurise les headers HTTP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", process.env.FRONTEND_URL || ''],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  crossOriginEmbedderPolicy: false,
}));

// 2. CORS restreint
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// 3. Rate limiting global
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessaie plus tard.' },
});
app.use('/api/', limiter);

// 4. Rate limiting auth (plus strict)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Trop de tentatives. Réessaie dans 15 minutes.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// 5. Body parser limité
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// 6. Logging des requêtes
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: req.ip, userAgent: req.get('user-agent') });
  next();
});

// Routes
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/avis',      require('./routes/avis'));
app.use('/api/paiements', require('./routes/paiements'));
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/client',    require('./routes/client'));
app.use('/api/loterie',   require('./routes/loterie'));

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

// Debug Outscraper — UNIQUEMENT en dev
if (process.env.NODE_ENV === 'development') {
  app.get('/api/debug-outscraper', async (req, res) => {
    try {
      const axios = require('axios');
      const lien = req.query.lien;
      if (!lien) return res.json({ error: 'Passe ?lien=URL en paramètre' });
      const response = await axios.get('https://api.app.outscraper.com/maps/reviews-v3', {
        params: { query: lien, reviewsLimit: 5, language: 'fr', sort: 'newest' },
        headers: { 'X-API-KEY': process.env.OUTSCRAPER_API_KEY },
        timeout: 120000,
      });
      res.json({
        status: response.data?.status,
        nb_reviews: response.data?.data?.[0]?.reviews_data?.length || 0,
        first_review: response.data?.data?.[0]?.reviews_data?.[0]?.review_text || null,
        nom_etablissement: response.data?.data?.[0]?.name || 'Pas de nom trouvé',
      });
    } catch (e) {
      res.json({ error: e.message });
    }
  });
}

// 7. Gestion des erreurs globale
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Erreur serveur' : err.message,
  });
});

cron.schedule('0 8 * * *', jobVerificationQuotidienne, { timezone: 'Europe/Paris' });

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => logger.info(`✅ Swimup Backend sur le port ${PORT}`));
}).catch((err) => {
  logger.error('Erreur init DB:', err);
  process.exit(1);
});
