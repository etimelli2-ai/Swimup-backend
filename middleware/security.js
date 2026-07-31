// ============================================================
// 📁 backend/middleware/security.js — NOUVEAU FICHIER
// ============================================================

const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const winston = require('winston');

// ─── Logger structuré ───
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({ 
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// ─── Rate limiters ───
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    logger.warn(`Rate limit auth dépassé: ${req.ip} sur ${req.path}`);
    res.status(429).json({ error: 'Trop de tentatives. Réessaie dans 15 min.' });
  }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 100,
  keyGenerator: (req) => req.ip
});

const avisLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: 'Trop de réservations rapides. Attends 1 min.' });
  }
});

const retraitLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24h
  max: 3,
  keyGenerator: (req) => req.user?.id || req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: 'Max 3 retraits par jour.' });
  }
});

// ─── Validation Zod schemas ───
const schemas = {
  register: z.object({
    email: z.string().email('Email invalide'),
    password: z.string().min(8, 'Min 8 caractères').max(128, 'Max 128 caractères'),
    discord_id: z.string().regex(/^\d{17,20}$/, 'ID Discord invalide').optional().nullable(),
    invitation_code: z.string().length(32, 'Code invalide').optional().nullable()
  }),

  login: z.object({
    email: z.string().email('Email invalide'),
    password: z.string().min(1, 'Mot de passe requis')
  }),

  profileUpdate: z.object({
    discord_id: z.string().regex(/^\d{17,20}$/, 'ID Discord invalide').optional().nullable(),
    paypal_email: z.string().email('Email PayPal invalide').optional().nullable(),
    new_password: z.string().min(8, 'Min 8 caractères').max(128).optional().nullable(),
    current_password: z.string().optional().nullable()
  }).refine(data => {
    if (data.new_password && !data.current_password) return false;
    return true;
  }, { message: 'Mot de passe actuel requis', path: ['current_password'] }),

  avisCreate: z.object({
    client_id: z.number().int().positive('Client ID invalide'),
    lien_maps: z.string().url('Lien Maps invalide'),
    texte: z.string().min(10, 'Texte trop court').max(2000, 'Texte trop long'),
    prix: z.number().positive('Prix invalide'),
    delai_paiement: z.number().int().min(1).max(90).default(30),
    nb_etoiles: z.number().int().min(1).max(5).default(5),
    nom_etablissement: z.string().max(200).optional().nullable()
  }),

  avisSoumettre: z.object({
    lien_avis: z.string().url('Lien invalide').startsWith('https://', 'Doit être un lien HTTPS')
  }),

  retrait: z.object({
    montant: z.number().positive().min(5, 'Min 5€').max(500, 'Max 500€')
  }),

  contestation: z.object({
    message: z.string().max(500, 'Max 500 caractères').optional().nullable()
  }),

  loterieCreate: z.object({
    titre: z.string().min(1, 'Titre requis').max(100),
    montant_gain: z.number().positive(),
    prix_ticket: z.number().positive().default(1)
  })
};

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const issue = result.error.issues[0];
    return res.status(400).json({ 
      error: issue.message,
      field: issue.path[0]
    });
  }
  req.body = result.data;
  next();
};

// ─── Audit logger ───
const auditLog = (action) => async (req, res, next) => {
  const originalJson = res.json;
  res.json = function(data) {
    if (req.user && res.statusCode < 400) {
      logger.info('AUDIT', {
        user_id: req.user.id,
        action,
        target_type: req.params.id ? req.path.split('/')[2] : null,
        target_id: req.params.id || null,
        ip: req.ip,
        user_agent: req.headers['user-agent'],
        timestamp: new Date().toISOString()
      });
    }
    return originalJson.call(this, data);
  };
  next();
};

// ─── Détection multi-comptes ───
const detectMultiAccount = async (req, res, next) => {
  if (!req.user || req.user.role === 'admin') return next();
  try {
    const { db } = require('../db');
    const ipRes = await db.execute({
      sql: `SELECT COUNT(*) as c FROM users 
            WHERE ip_address = ? AND id != ? 
            AND created_at > datetime('now', '-7 days')`,
      args: [req.ip, req.user.id]
    });

    if (ipRes.rows[0].c >= 3) {
      logger.warn(`Multi-compte suspect: IP ${req.ip}, user ${req.user.id}, ${ipRes.rows[0].c} comptes`);
    }
  } catch (e) {
    // Silencieux — ne pas bloquer la requête
  }
  next();
};

// ─── Sanitize output ───
const escapeHtml = (text) => {
  if (!text) return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const sanitizeResponse = (req, res, next) => {
  const originalJson = res.json;
  res.json = function(data) {
    if (typeof data === 'object' && data !== null) {
      const sanitize = (obj) => {
        if (Array.isArray(obj)) return obj.map(sanitize);
        if (typeof obj === 'object' && obj !== null) {
          const sanitized = {};
          for (const [key, value] of Object.entries(obj)) {
            if (typeof value === 'string' && ['texte', 'message', 'titre', 'note', 'nom_societe', 'nom_etablissement'].includes(key)) {
              sanitized[key] = escapeHtml(value);
            } else {
              sanitized[key] = sanitize(value);
            }
          }
          return sanitized;
        }
        return obj;
      };
      return originalJson.call(this, sanitize(data));
    }
    return originalJson.call(this, data);
  };
  next();
};

module.exports = {
  authLimiter,
  apiLimiter,
  avisLimiter,
  retraitLimiter,
  schemas,
  validate,
  auditLog,
  detectMultiAccount,
  sanitizeResponse,
  logger,
  escapeHtml
};
