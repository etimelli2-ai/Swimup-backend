const express = require('express');
const { db } = require('../db');
const { authMiddleware, clientOnly } = require('../middleware/auth');

const PRIX_AVIS = 3.00;
const GAIN_MEMBRE = 1.00;

const router = express.Router();
router.use(authMiddleware, clientOnly);

router.get('/avis', async (req, res) => {
  try {
    const clientRes = await db.execute({ sql: 'SELECT id FROM clients WHERE user_id = ?', args: [req.user.id] });
    const client = clientRes.rows[0];
    if (!client) return res.status(404).json({ error: 'Profil client introuvable' });

    const result = await db.execute({
      sql: `SELECT a.*, u.email as membre_email, u.discord_id
            FROM avis a
            LEFT JOIN users u ON a.reserve_par = u.id
            WHERE a.client_id = ?
            ORDER BY a.created_at DESC`,
      args: [client.id],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/avis', async (req, res) => {
  try {
    const { lien_maps, texte, delai_paiement, nb_etoiles, nom_etablissement } = req.body;
    if (!lien_maps || !texte) return res.status(400).json({ error: 'Lien et texte requis' });

    const clientRes = await db.execute({
      sql: 'SELECT id, solde_depot, paiement_valide, bloquer_si_dette FROM clients WHERE user_id = ?',
      args: [req.user.id]
    });
    const client = clientRes.rows[0];
    if (!client) return res.status(404).json({ error: 'Profil client introuvable' });

    if (client.bloquer_si_dette && parseFloat(client.solde_depot || 0) > 0 && !client.paiement_valide) {
      return res.status(403).json({
        error: `Ton compte est bloqué — tu as une dette de ${parseFloat(client.solde_depot).toFixed(2)}€. Contacte l'admin.`
      });
    }

    await db.execute({
      sql: 'UPDATE clients SET solde_depot = solde_depot + ?, paiement_valide = 0 WHERE id = ?',
      args: [PRIX_AVIS, client.id],
    });

    await db.execute({
      sql: 'INSERT INTO avis (client_id, lien_maps, texte, prix, delai_paiement, nb_etoiles, nom_etablissement) VALUES (?,?,?,?,?,?,?)',
      args: [client.id, lien_maps, texte, GAIN_MEMBRE, parseInt(delai_paiement) || 30, parseInt(nb_etoiles) || 5, nom_etablissement || null],
    });

    await db.execute({
      sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
      args: [req.user.id, '✅ Avis commandé', `Ton avis pour "${nom_etablissement || lien_maps.slice(0, 40)}" a bien été ajouté !`],
    });

    res.json({ success: true, message: `Avis ajouté ! Coût : ${PRIX_AVIS}€` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/avis/:id', async (req, res) => {
  try {
    const clientRes = await db.execute({ sql: 'SELECT id FROM clients WHERE user_id = ?', args: [req.user.id] });
    const client = clientRes.rows[0];

    const avisRes = await db.execute({
      sql: "SELECT id FROM avis WHERE id = ? AND client_id = ? AND statut = 'disponible'",
      args: [req.params.id, client.id],
    });

    if (avisRes.rows[0]) {
      await db.execute({
        sql: 'UPDATE clients SET solde_depot = MAX(0, solde_depot - ?) WHERE id = ?',
        args: [PRIX_AVIS, client.id],
      });
      await db.execute({ sql: 'DELETE FROM avis WHERE id = ?', args: [req.params.id] });

      // Fix — remettre paiement_valide si plus de dette
      const restantRes = await db.execute({
        sql: "SELECT SUM(solde_depot) as total FROM clients WHERE id = ?",
        args: [client.id],
      });
      const soldeRestant = parseFloat(restantRes.rows[0]?.total || 0);
      if (soldeRestant <= 0) {
        await db.execute({ sql: 'UPDATE clients SET paiement_valide = 1 WHERE id = ?', args: [client.id] });
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const clientRes = await db.execute({
      sql: 'SELECT id, solde_depot, paiement_valide, bloquer_si_dette FROM clients WHERE user_id = ?',
      args: [req.user.id]
    });
    const client = clientRes.rows[0];
    if (!client) return res.status(404).json({ error: 'Profil client introuvable' });

    const [total, valides, enCours] = await Promise.all([
      db.execute({ sql: 'SELECT COUNT(*) as c FROM avis WHERE client_id = ?', args: [client.id] }),
      db.execute({ sql: "SELECT COUNT(*) as c FROM avis WHERE client_id = ? AND statut IN ('valide','paye')", args: [client.id] }),
      db.execute({ sql: "SELECT COUNT(*) as c FROM avis WHERE client_id = ? AND statut IN ('reserve','en_verification')", args: [client.id] }),
    ]);

    res.json({
      total: total.rows[0].c,
      valides: valides.rows[0].c,
      aPayerTotal: parseFloat(client.solde_depot || 0),
      paiementValide: !!client.paiement_valide,
      bloquerSiDette: !!client.bloquer_si_dette,
      enCours: enCours.rows[0].c,
    });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      args: [req.user.id],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/notifications/lire', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE notifications SET lu = 1 WHERE user_id = ?', args: [req.user.id] });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
