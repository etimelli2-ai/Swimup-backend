const express = require('express');
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');

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

router.post('/retrait', authMiddleware, async (req, res) => {
  try {
    const { montant } = req.body;

    // Validation du montant — fix bug string vs number
    const m = parseFloat(montant);
    if (isNaN(m) || m < 1) return res.status(400).json({ error: 'Montant minimum : 1€' });

    const userRes = await db.execute({
      sql: 'SELECT solde, paypal_email FROM users WHERE id = ?',
      args: [req.user.id]
    });
    const user = userRes.rows[0];

    if (!user.paypal_email) return res.status(400).json({ error: 'Ajoute ton adresse PayPal dans ton profil' });

    // Comparaison number vs number — fix bug critique
    const solde = parseFloat(user.solde || 0);
    if (solde < m) return res.status(400).json({ error: `Solde insuffisant (${solde.toFixed(2)}€ disponible)` });

    await db.execute({
      sql: 'UPDATE users SET solde = solde - ? WHERE id = ?',
      args: [m, req.user.id]
    });
    await db.execute({
      sql: 'INSERT INTO retraits (user_id, montant, paypal) VALUES (?, ?, ?)',
      args: [req.user.id, m, user.paypal_email],
    });
    await db.execute({
      sql: "INSERT INTO transactions (user_id, type, montant, note) VALUES (?, 'retrait', ?, 'Demande de retrait PayPal')",
      args: [req.user.id, m],
    });

    res.json({ success: true, message: 'Demande de retrait envoyée. Paiement sous 24-48h.' });
  } catch (e) {
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
