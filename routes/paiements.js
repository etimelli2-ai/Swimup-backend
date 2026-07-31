// ============================================================
// 📁 backend/routes/paiements.js — MODIFIÉ (Zod + sécurité)
// ============================================================

const express = require('express');
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { validate, schemas, logger } = require('../middleware/security');

const router = express.Router();

router.get('/solde', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT solde FROM users WHERE id = ?', args: [req.user.id] });
    res.json({ solde: parseFloat(result.rows[0]?.solde || 0) });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      args: [req.user.id],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/retrait', authMiddleware, validate(schemas.retrait), async (req, res) => {
  try {
    const { montant } = req.body;

    const userRes = await db.execute({
      sql: 'SELECT solde, paypal_email FROM users WHERE id = ?',
      args: [req.user.id]
    });
    const user = userRes.rows[0];

    if (!user.paypal_email) {
      return res.status(400).json({ error: 'Ajoute ton adresse PayPal dans ton profil' });
    }

    const solde = parseFloat(user.solde || 0);
    if (solde < montant) {
      return res.status(400).json({ error: `Solde insuffisant (${solde.toFixed(2)}€ disponible)` });
    }

    await db.execute({
      sql: 'UPDATE users SET solde = solde - ? WHERE id = ?',
      args: [montant, req.user.id]
    });
    await db.execute({
      sql: 'INSERT INTO retraits (user_id, montant, paypal) VALUES (?, ?, ?)',
      args: [req.user.id, montant, user.paypal_email],
    });
    await db.execute({
      sql: "INSERT INTO transactions (user_id, type, montant, note) VALUES (?, 'retrait', ?, 'Demande de retrait PayPal')",
      args: [req.user.id, montant],
    });

    logger.info(`Retrait demandé: ${montant}€ par user ${req.user.id}`);

    res.json({ success: true, message: 'Demande de retrait envoyée. Paiement sous 24-48h.' });
  } catch (e) {
    logger.error('Erreur retrait:', e.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/retraits', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM retraits WHERE user_id = ? ORDER BY created_at DESC',
      args: [req.user.id],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
