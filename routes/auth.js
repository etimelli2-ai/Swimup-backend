const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const xss = require('xss');
const { db } = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
};

router.post('/register',
  body('email').isEmail().normalizeEmail().withMessage('Email invalide'),
  body('password').isLength({ min: 6 }).withMessage('Mot de passe trop court (min 6 caractères)'),
  body('discord_id').optional().trim().escape(),
  validate,
  async (req, res) => {
    try {
      const { email, password, discord_id, invitation_code } = req.body;

      const existing = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
      if (existing.rows.length) return res.status(400).json({ error: 'Email déjà utilisé' });

      let role = 'membre';
      if (invitation_code) {
        const invRes = await db.execute({
          sql: 'SELECT * FROM invitations WHERE code = ? AND utilise = 0',
          args: [invitation_code],
        });
        if (!invRes.rows[0]) return res.status(400).json({ error: 'Code d'invitation invalide ou déjà utilisé' });
        role = invRes.rows[0].role;
        await db.execute({ sql: 'UPDATE invitations SET utilise = 1 WHERE code = ?', args: [invitation_code] });
      }

      const hash = await bcrypt.hash(password, 12);
      const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || null;

      const result = await db.execute({
        sql: 'INSERT INTO users (email, password_hash, discord_id, role, ip_address, last_login) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
        args: [email, hash, discord_id || null, role, ip],
      });

      if (role === 'client') {
        await db.execute({
          sql: 'INSERT INTO clients (user_id, nom_societe) VALUES (?, ?)',
          args: [Number(result.lastInsertRowid), email],
        });
      }

      const newId = Number(result.lastInsertRowid);
      const token = jwt.sign({ id: newId, email, role }, process.env.JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' });
      res.json({ token, user: { id: newId, email, role, discord_id } });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

router.post('/login',
  body('email').isEmail().normalizeEmail().withMessage('Email invalide'),
  body('password').notEmpty().withMessage('Mot de passe requis'),
  validate,
  async (req, res) => {
    try {
      const { email, password } = req.body;
      const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
      const user = result.rows[0];
      if (!user) return res.status(400).json({ error: 'Email ou mot de passe incorrect' });

      if (user.banned) return res.status(403).json({ error: 'Ton compte a été suspendu. Contacte l'admin.' });

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(400).json({ error: 'Email ou mot de passe incorrect' });

      const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || null;
      await db.execute({
        sql: 'UPDATE users SET ip_address = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?',
        args: [ip, user.id],
      });

      const token = jwt.sign(
        { id: Number(user.id), email: user.email, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: '7d', algorithm: 'HS256' }
      );
      res.json({
        token,
        user: {
          id: Number(user.id),
          email: user.email,
          role: user.role,
          discord_id: user.discord_id,
          solde: user.solde,
        },
      });
    } catch (e) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT id, email, discord_id, paypal_email, role, solde, created_at FROM users WHERE id = ?',
      args: [req.user.id],
    });
    const user = result.rows[0];
    res.json({ ...user, id: Number(user.id) });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/profile', authMiddleware,
  body('discord_id').optional().trim().escape(),
  body('paypal_email').optional().isEmail().normalizeEmail(),
  validate,
  async (req, res) => {
    try {
      const { discord_id, paypal_email, new_password, current_password } = req.body;

      if (new_password) {
        if (!current_password) return res.status(400).json({ error: 'Mot de passe actuel requis' });
        const userRes = await db.execute({ sql: 'SELECT password_hash FROM users WHERE id = ?', args: [req.user.id] });
        const valid = await bcrypt.compare(current_password, userRes.rows[0].password_hash);
        if (!valid) return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
        const hash = await bcrypt.hash(new_password, 12);
        await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [hash, req.user.id] });
      }

      await db.execute({
        sql: 'UPDATE users SET discord_id = ?, paypal_email = ? WHERE id = ?',
        args: [discord_id, paypal_email, req.user.id],
      });

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
);

router.post('/invitation', authMiddleware, adminOnly, async (req, res) => {
  try {
    const code = crypto.randomBytes(16).toString('hex');
    await db.execute({
      sql: 'INSERT INTO invitations (code, role) VALUES (?, ?)',
      args: [code, 'client'],
    });
    const lien = `${process.env.FRONTEND_URL}/register?invite=${code}`;
    res.json({ success: true, code, lien });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/invitation/:code', async (req, res) => {
  try {
    const invRes = await db.execute({
      sql: 'SELECT * FROM invitations WHERE code = ? AND utilise = 0',
      args: [req.params.code],
    });
    if (!invRes.rows[0]) return res.status(400).json({ error: 'Invitation invalide ou déjà utilisée' });
    res.json({ valid: true, role: invRes.rows[0].role });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
