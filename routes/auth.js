// ============================================================
// 📁 backend/routes/auth.js — MODIFIÉ (cookies + Zod)
// ============================================================

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { schemas, validate, logger } = require('../middleware/security');

const router = express.Router();

// ─── Cookie config ───
const cookieConfig = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 jours
};

// ─── POST /api/auth/register ───
router.post('/register', validate(schemas.register), async (req, res) => {
  try {
    const { email, password, discord_id, invitation_code } = req.body;

    const existing = await db.execute({ 
      sql: 'SELECT id FROM users WHERE email = ?', 
      args: [email.toLowerCase().trim()] 
    });
    if (existing.rows.length) {
      return res.status(400).json({ error: 'Email déjà utilisé' });
    }

    let role = 'membre';
    if (invitation_code) {
      const invRes = await db.execute({
        sql: 'SELECT * FROM invitations WHERE code = ? AND utilise = 0',
        args: [invitation_code],
      });
      if (!invRes.rows[0]) {
        return res.status(400).json({ error: "Code d'invitation invalide ou déjà utilisé" });
      }
      role = invRes.rows[0].role;
      await db.execute({ sql: 'UPDATE invitations SET utilise = 1 WHERE code = ?', args: [invitation_code] });
    }

    const hash = await bcrypt.hash(password, 12);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;

    const result = await db.execute({
      sql: `INSERT INTO users (email, password_hash, discord_id, role, ip_address, last_login) 
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      args: [email.toLowerCase().trim(), hash, discord_id || null, role, ip],
    });

    const newId = Number(result.lastInsertRowid);

    if (role === 'client') {
      await db.execute({
        sql: 'INSERT INTO clients (user_id, nom_societe) VALUES (?, ?)',
        args: [newId, email],
      });
    }

    const token = jwt.sign(
      { id: newId, email: email.toLowerCase().trim(), role }, 
      process.env.JWT_SECRET, 
      { algorithm: 'HS256', expiresIn: '7d' }
    );

    res.cookie('token', token, cookieConfig);

    logger.info(`Nouvel utilisateur inscrit: ${email}, role: ${role}, ip: ${ip}`);

    res.json({ 
      token, 
      user: { id: newId, email, role, discord_id: discord_id || null } 
    });
  } catch (e) {
    logger.error('Erreur register:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /api/auth/login ───
router.post('/login', validate(schemas.login), async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await db.execute({ 
      sql: 'SELECT * FROM users WHERE email = ?', 
      args: [email.toLowerCase().trim()] 
    });
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ error: 'Email ou mot de passe incorrect' });
    }

    if (user.banned) {
      return res.status(403).json({ error: '🚫 Ton compte a été suspendu. Contacte l'admin.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(400).json({ error: 'Email ou mot de passe incorrect' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || null;
    await db.execute({
      sql: 'UPDATE users SET ip_address = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?',
      args: [ip, user.id],
    });

    const token = jwt.sign(
      { id: Number(user.id), email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '7d' }
    );

    res.cookie('token', token, cookieConfig);

    res.json({
      token,
      user: {
        id: Number(user.id),
        email: user.email,
        role: user.role,
        discord_id: user.discord_id,
        paypal_email: user.paypal_email,
        solde: parseFloat(user.solde || 0),
      },
    });
  } catch (e) {
    logger.error('Erreur login:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /api/auth/logout ───
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  });
  res.json({ success: true });
});

// ─── GET /api/auth/me ───
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT id, email, discord_id, paypal_email, role, solde, created_at FROM users WHERE id = ?',
      args: [req.user.id],
    });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ ...user, id: Number(user.id), solde: parseFloat(user.solde || 0) });
  } catch (e) {
    logger.error('Erreur me:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PUT /api/auth/profile ───
router.put('/profile', authMiddleware, validate(schemas.profileUpdate), async (req, res) => {
  try {
    const { discord_id, paypal_email, new_password, current_password } = req.body;

    if (new_password) {
      const userRes = await db.execute({ 
        sql: 'SELECT password_hash FROM users WHERE id = ?', 
        args: [req.user.id] 
      });
      const valid = await bcrypt.compare(current_password, userRes.rows[0].password_hash);
      if (!valid) {
        return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
      }
      const hash = await bcrypt.hash(new_password, 12);
      await db.execute({ 
        sql: 'UPDATE users SET password_hash = ? WHERE id = ?', 
        args: [hash, req.user.id] 
      });
    }

    await db.execute({
      sql: 'UPDATE users SET discord_id = ?, paypal_email = ? WHERE id = ?',
      args: [discord_id || null, paypal_email || null, req.user.id],
    });

    res.json({ success: true });
  } catch (e) {
    logger.error('Erreur profile:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /api/auth/invitation ───
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
    logger.error('Erreur invitation:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /api/auth/invitation/:code ───
router.get('/invitation/:code', async (req, res) => {
  try {
    const invRes = await db.execute({
      sql: 'SELECT * FROM invitations WHERE code = ? AND utilise = 0',
      args: [req.params.code],
    });
    if (!invRes.rows[0]) {
      return res.status(400).json({ error: 'Invitation invalide ou déjà utilisée', valid: false });
    }
    res.json({ valid: true, role: invRes.rows[0].role });
  } catch (e) {
    logger.error('Erreur invitation check:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
