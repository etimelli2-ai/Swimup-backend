const express = require('express');
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/public/suivi/:token — suivi commande publique
router.get('/suivi/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const orderRes = await db.execute({
      sql: 'SELECT * FROM public_orders WHERE token_suivi = ?',
      args: [token],
    });
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    const avisRes = await db.execute({
      sql: 'SELECT * FROM avis_publics WHERE public_order_id = ?',
      args: [order.id],
    });

    res.json({ order, avis: avisRes.rows });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/public/avis-disponibles — avis publics dispo pour les membres
router.get('/avis-disponibles', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT ap.*, po.lien_maps, po.nom_etablissement, po.texte_avis,
              po.nb_etoiles, po.ton, po.type_etablissement
            FROM avis_publics ap
            JOIN public_orders po ON ap.public_order_id = po.id
            WHERE ap.statut = 'disponible' AND po.statut = 'paye'
            ORDER BY ap.created_at DESC`,
      args: [],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/public/avis/:id/reserver — membre réserve un avis public
router.post('/avis/:id/reserver', authMiddleware, async (req, res) => {
  try {
    const avisRes = await db.execute({
      sql: "SELECT * FROM avis_publics WHERE id = ? AND statut = 'disponible'",
      args: [req.params.id],
    });
    const avis = avisRes.rows[0];
    if (!avis) return res.status(404).json({ error: 'Avis non disponible' });

    // Vérifier qu'il n'a pas déjà un avis public en cours
    const existing = await db.execute({
      sql: "SELECT id FROM avis_publics WHERE reserve_par = ? AND statut = 'reserve'",
      args: [req.user.id],
    });
    if (existing.rows.length) return res.status(400).json({ error: 'Tu as déjà un avis public en cours' });

    await db.execute({
      sql: `UPDATE avis_publics SET statut = 'reserve', reserve_par = ?, reserve_at = CURRENT_TIMESTAMP
            WHERE id = ?`,
      args: [req.user.id, req.params.id],
    });

    // Mettre à jour la commande publique
    await db.execute({
      sql: "UPDATE public_orders SET statut = 'reserve' WHERE id = ?",
      args: [avis.public_order_id],
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/public/avis/:id/soumettre — membre soumet le lien
router.post('/avis/:id/soumettre', authMiddleware, async (req, res) => {
  try {
    const { lien_avis } = req.body;
    if (!lien_avis) return res.status(400).json({ error: 'Lien requis' });

    const avisRes = await db.execute({
      sql: "SELECT * FROM avis_publics WHERE id = ? AND reserve_par = ? AND statut = 'reserve'",
      args: [req.params.id, req.user.id],
    });
    const avis = avisRes.rows[0];
    if (!avis) return res.status(404).json({ error: 'Avis introuvable' });

    // Vérifier délai 1h
    const reserveAt = new Date(avis.reserve_at);
    if (Date.now() - reserveAt.getTime() > 3600000) {
      await db.execute({
        sql: "UPDATE avis_publics SET statut = 'disponible', reserve_par = NULL, reserve_at = NULL WHERE id = ?",
        args: [req.params.id],
      });
      return res.status(400).json({ error: 'Délai d\'1h dépassé' });
    }

    await db.execute({
      sql: `UPDATE avis_publics SET statut = 'soumis', lien_avis_poste = ?,
              soumis_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [lien_avis, req.params.id],
    });

    await db.execute({
      sql: "UPDATE public_orders SET statut = 'soumis' WHERE id = ?",
      args: [avis.public_order_id],
    });

    // Créditer le membre — gain fixe 1.50€ pour avis public
    const GAIN_MEMBRE_PUBLIC = 1.50;
    await db.execute({
      sql: 'UPDATE users SET solde = solde + ? WHERE id = ?',
      args: [GAIN_MEMBRE_PUBLIC, req.user.id],
    });
    await db.execute({
      sql: "INSERT INTO transactions (user_id, type, montant, note) VALUES (?, 'credit', ?, ?)",
      args: [req.user.id, GAIN_MEMBRE_PUBLIC, 'Avis public soumis'],
    });
    await db.execute({
      sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
      args: [req.user.id, '💰 +1.50€ crédité !', 'Ton avis public a été soumis et ton solde crédité.'],
    });

    res.json({ success: true, message: '✅ Avis soumis ! 1.50€ crédités sur ton solde.' });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
