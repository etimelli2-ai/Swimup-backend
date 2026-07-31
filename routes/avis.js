// ============================================================
// 📁 backend/routes/avis.js — MODIFIÉ (Zod + sécurité)
// ============================================================

const express = require('express');
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { validate, schemas } = require('../middleware/security');
const { verifierAvis } = require('../jobs/verifier');

const router = express.Router();

router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT a.id, a.lien_maps, a.texte, a.prix, a.delai_paiement, a.statut,
            a.reserve_par, a.reserve_at, a.nb_etoiles,
            COALESCE(a.nom_etablissement, c.nom_societe) as nom_societe
            FROM avis a
            JOIN clients c ON a.client_id = c.id
            WHERE a.statut = 'disponible'
            ORDER BY a.created_at DESC`,
      args: [],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/mes-avis', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT a.*, COALESCE(a.nom_etablissement, c.nom_societe) as nom_societe
            FROM avis a
            JOIN clients c ON a.client_id = c.id
            WHERE a.reserve_par = ?
            ORDER BY a.reserve_at DESC`,
      args: [req.user.id],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/:id/reserver', authMiddleware, async (req, res) => {
  try {
    const avisId = req.params.id;

    // Vérifier si l'utilisateur a déjà un avis en cours
    const existing = await db.execute({
      sql: "SELECT id FROM avis WHERE reserve_par = ? AND statut IN ('reserve', 'en_verification')",
      args: [req.user.id],
    });
    if (existing.rows.length) {
      return res.status(400).json({ error: 'Tu as déjà un avis en cours' });
    }

    const avis = await db.execute({
      sql: "SELECT * FROM avis WHERE id = ? AND statut = 'disponible'",
      args: [avisId]
    });
    if (!avis.rows[0]) {
      return res.status(404).json({ error: 'Avis non disponible' });
    }

    await db.execute({
      sql: "UPDATE avis SET statut = 'reserve', reserve_par = ?, reserve_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [req.user.id, avisId],
    });

    res.json({ success: true, avis: avis.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/:id/soumettre', authMiddleware, validate(schemas.avisSoumettre), async (req, res) => {
  try {
    const { lien_avis } = req.body;
    const avisId = req.params.id;

    const avisRes = await db.execute({
      sql: "SELECT * FROM avis WHERE id = ? AND reserve_par = ? AND statut = 'reserve'",
      args: [avisId, req.user.id],
    });
    const avis = avisRes.rows[0];
    if (!avis) {
      return res.status(404).json({ error: 'Avis introuvable ou délai expiré' });
    }

    const reserveAt = new Date(avis.reserve_at);
    if (Date.now() - reserveAt.getTime() > 3600000) {
      await db.execute({
        sql: "UPDATE avis SET statut = 'disponible', reserve_par = NULL, reserve_at = NULL WHERE id = ?",
        args: [avisId]
      });
      return res.status(400).json({ error: "Délai d'1h dépassé, l'avis est de nouveau disponible" });
    }

    await db.execute({
      sql: "UPDATE avis SET statut = 'valide', lien_avis_poste = ?, soumis_at = CURRENT_TIMESTAMP, valide_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [lien_avis, avisId],
    });

    await db.execute({
      sql: 'INSERT OR REPLACE INTO verifications (avis_id, user_id) VALUES (?, ?)',
      args: [avisId, req.user.id],
    });

    res.json({
      success: true,
      status: 'valide',
      message: 'Avis soumis et validé ! Ton solde sera crédité après le délai.',
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/:id/annuler', authMiddleware, async (req, res) => {
  try {
    await db.execute({
      sql: "UPDATE avis SET statut = 'disponible', reserve_par = NULL, reserve_at = NULL WHERE id = ? AND reserve_par = ? AND statut = 'reserve'",
      args: [req.params.id, req.user.id],
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/:id/contester', authMiddleware, validate(schemas.contestation), async (req, res) => {
  try {
    const { message } = req.body;
    const avisId = req.params.id;

    const avisRes = await db.execute({
      sql: "SELECT * FROM avis WHERE id = ? AND reserve_par = ? AND statut = 'refuse'",
      args: [avisId, req.user.id],
    });
    if (!avisRes.rows[0]) {
      return res.status(404).json({ error: 'Avis introuvable ou non refusé' });
    }

    const totalRefuses = await db.execute({
      sql: "SELECT COUNT(*) as c FROM avis WHERE reserve_par = ? AND statut = 'refuse'",
      args: [req.user.id],
    });
    const totalContestes = await db.execute({
      sql: 'SELECT COUNT(*) as c FROM contestations WHERE user_id = ?',
      args: [req.user.id],
    });

    const nbRefuses = totalRefuses.rows[0].c;
    const nbContestes = totalContestes.rows[0].c;

    if (nbContestes >= Math.floor(nbRefuses / 2)) {
      return res.status(403).json({ error: 'Tu as atteint la limite de contestations.' });
    }

    const existing = await db.execute({
      sql: 'SELECT id FROM contestations WHERE avis_id = ?',
      args: [avisId],
    });
    if (existing.rows[0]) {
      return res.status(400).json({ error: 'Tu as déjà contesté cet avis' });
    }

    await db.execute({
      sql: 'INSERT INTO contestations (user_id, avis_id, message) VALUES (?,?,?)',
      args: [req.user.id, avisId, message || ''],
    });

    const adminRes = await db.execute({
      sql: "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
      args: [],
    });
    if (adminRes.rows[0]) {
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [
          adminRes.rows[0].id,
          'Contestation avis',
          `Un membre conteste la suppression de son avis #${avisId}${message ? ` : "${message}"` : ''}`,
        ],
      });
    }

    res.json({ success: true, message: 'Contestation envoyée à l'admin !' });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
