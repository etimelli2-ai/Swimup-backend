const express = require('express');
const { db } = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/', authMiddleware, async (req, res) => {
  try {
    const loterieRes = await db.execute({
      sql: "SELECT * FROM loteries WHERE statut = 'en_cours' ORDER BY created_at DESC LIMIT 1",
      args: [],
    });
    const loterie = loterieRes.rows[0] || null;

    if (!loterie) return res.json({ loterie: null, tickets: 0, totalTickets: 0 });

    const ticketsRes = await db.execute({
      sql: 'SELECT nb_tickets FROM loterie_tickets WHERE loterie_id = ? AND user_id = ?',
      args: [loterie.id, req.user.id],
    });

    const totalRes = await db.execute({
      sql: 'SELECT SUM(nb_tickets) as total FROM loterie_tickets WHERE loterie_id = ?',
      args: [loterie.id],
    });

    res.json({
      loterie,
      tickets: ticketsRes.rows[0]?.nb_tickets || 0,
      totalTickets: totalRes.rows[0]?.total || 0,
    });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/historique', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: "SELECT * FROM loteries WHERE statut = 'terminee' ORDER BY termine_at DESC LIMIT 10",
      args: [],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { titre, montant_gain, prix_ticket } = req.body;
    if (!titre || !montant_gain) return res.status(400).json({ error: 'Titre et montant requis' });

    const m = parseFloat(montant_gain);
    if (isNaN(m) || m <= 0) return res.status(400).json({ error: 'Montant invalide' });

    const existing = await db.execute({
      sql: "SELECT id FROM loteries WHERE statut = 'en_cours'",
      args: [],
    });
    if (existing.rows.length) return res.status(400).json({ error: 'Une loterie est déjà en cours' });

    await db.execute({
      sql: 'INSERT INTO loteries (titre, montant_gain, prix_ticket) VALUES (?,?,?)',
      args: [titre, m, parseFloat(prix_ticket) || 1],
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/:id/tickets', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { user_id, nb_tickets } = req.body;
    if (!user_id || !nb_tickets) return res.status(400).json({ error: 'user_id et nb_tickets requis' });

    const nb = parseInt(nb_tickets);
    if (isNaN(nb) || nb <= 0) return res.status(400).json({ error: 'Nombre de tickets invalide' });

    await db.execute({
      sql: `INSERT INTO loterie_tickets (loterie_id, user_id, nb_tickets) VALUES (?,?,?)
            ON CONFLICT(loterie_id, user_id) DO UPDATE SET nb_tickets = nb_tickets + ?`,
      args: [req.params.id, user_id, nb, nb],
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/:id/participants', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT lt.*, u.email FROM loterie_tickets lt
            JOIN users u ON lt.user_id = u.id
            WHERE lt.loterie_id = ?
            ORDER BY lt.nb_tickets DESC`,
      args: [req.params.id],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/:id/tirer', authMiddleware, adminOnly, async (req, res) => {
  try {
    const loterieRes = await db.execute({
      sql: "SELECT * FROM loteries WHERE id = ? AND statut = 'en_cours'",
      args: [req.params.id],
    });
    const loterie = loterieRes.rows[0];
    if (!loterie) return res.status(404).json({ error: 'Loterie introuvable ou déjà terminée' });

    const ticketsRes = await db.execute({
      sql: 'SELECT user_id, nb_tickets FROM loterie_tickets WHERE loterie_id = ? AND nb_tickets > 0',
      args: [req.params.id],
    });

    if (!ticketsRes.rows.length) return res.status(400).json({ error: 'Aucun participant' });

    // Construire le pool pondéré
    const pool = [];
    for (const row of ticketsRes.rows) {
      for (let i = 0; i < row.nb_tickets; i++) {
        pool.push(row.user_id);
      }
    }

    const gagnantId = pool[Math.floor(Math.random() * pool.length)];

    const userRes = await db.execute({
      sql: 'SELECT email FROM users WHERE id = ?',
      args: [gagnantId],
    });
    const gagnantEmail = userRes.rows[0]?.email;
    const montantGain = parseFloat(loterie.montant_gain);

    // Créditer le gagnant
    await db.execute({
      sql: 'UPDATE users SET solde = solde + ? WHERE id = ?',
      args: [montantGain, gagnantId],
    });
    await db.execute({
      sql: "INSERT INTO transactions (user_id, type, montant, note) VALUES (?, 'credit', ?, ?)",
      args: [gagnantId, montantGain, `🎉 Gagnant loterie : ${loterie.titre}`],
    });

    // Fix — Notifier le gagnant
    await db.execute({
      sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
      args: [gagnantId, '🎉 Tu as gagné !', `Félicitations ! Tu as remporté ${montantGain.toFixed(2)}€ à la loterie "${loterie.titre}" ! Le montant a été crédité sur ton solde.`],
    });

    // Terminer la loterie
    await db.execute({
      sql: "UPDATE loteries SET statut = 'terminee', gagnant_id = ?, gagnant_email = ?, termine_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [gagnantId, gagnantEmail, req.params.id],
    });

    res.json({
      success: true,
      gagnant_email: gagnantEmail,
      gagnant_id: gagnantId,
      montant: montantGain,
    });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
