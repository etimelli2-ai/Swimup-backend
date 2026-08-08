const express = require('express');
const { db } = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

// ─── ROUTES MEMBRES ───

// GET /api/boutique/produits
router.get('/produits', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM boutique_produits WHERE actif = 1 ORDER BY created_at DESC',
      args: [],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/boutique/mes-commandes
router.get('/mes-commandes', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT bc.*, bp.nom, bp.image_url, bp.description FROM boutique_commandes bc
            JOIN boutique_produits bp ON bc.produit_id = bp.id
            WHERE bc.user_id = ?
            ORDER BY bc.created_at DESC`,
      args: [req.user.id],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/boutique/commander — payer avec solde
router.post('/commander', authMiddleware, async (req, res) => {
  try {
    const { produit_id, quantite } = req.body;
    const qty = parseInt(quantite) || 1;

    const produitRes = await db.execute({
      sql: 'SELECT * FROM boutique_produits WHERE id = ? AND actif = 1',
      args: [produit_id],
    });
    const produit = produitRes.rows[0];
    if (!produit) return res.status(404).json({ error: 'Produit introuvable' });

    if (produit.stock !== -1 && produit.stock < qty) {
      return res.status(400).json({ error: `Stock insuffisant — ${produit.stock} disponible(s)` });
    }

    const montant = produit.prix * qty;

    const userRes = await db.execute({
      sql: 'SELECT solde FROM users WHERE id = ?',
      args: [req.user.id],
    });
    const solde = parseFloat(userRes.rows[0]?.solde || 0);
    if (solde < montant) {
      return res.status(400).json({ error: `Solde insuffisant — tu as ${solde.toFixed(2)}€, il faut ${montant.toFixed(2)}€` });
    }

    await db.execute({
      sql: 'UPDATE users SET solde = solde - ? WHERE id = ?',
      args: [montant, req.user.id],
    });

    await db.execute({
      sql: "INSERT INTO transactions (user_id, type, montant, note) VALUES (?, 'debit', ?, ?)",
      args: [req.user.id, montant, `Achat boutique : ${produit.nom} x${qty}`],
    });

    await db.execute({
      sql: `INSERT INTO boutique_commandes (user_id, produit_id, quantite, montant, statut)
            VALUES (?, ?, ?, ?, 'en_attente')`,
      args: [req.user.id, produit_id, qty, montant],
    });

    if (produit.stock !== -1) {
      await db.execute({
        sql: 'UPDATE boutique_produits SET stock = stock - ? WHERE id = ?',
        args: [qty, produit_id],
      });
    }

    await db.execute({
      sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
      args: [req.user.id, '🛍️ Commande confirmée !', `Ta commande de ${produit.nom} x${qty} a été passée. ${montant.toFixed(2)}€ déduits de ton solde.`],
    });

    res.json({ success: true, message: `✅ Commande passée ! ${montant.toFixed(2)}€ déduits.` });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── ROUTES ADMIN ───

// GET /api/boutique/admin/produits
router.get('/admin/produits', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM boutique_produits ORDER BY created_at DESC',
      args: [],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/boutique/admin/produits
router.post('/admin/produits', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nom, description, prix, stock, image_url } = req.body;
    if (!nom || !prix) return res.status(400).json({ error: 'Nom et prix requis' });

    await db.execute({
      sql: `INSERT INTO boutique_produits (nom, description, prix, stock, image_url)
            VALUES (?, ?, ?, ?, ?)`,
      args: [nom, description || null, parseFloat(prix), parseInt(stock) ?? -1, image_url || null],
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/boutique/admin/produits/:id
router.put('/admin/produits/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { nom, description, prix, stock, image_url, actif } = req.body;
    await db.execute({
      sql: `UPDATE boutique_produits SET nom=?, description=?, prix=?, stock=?, image_url=?, actif=? WHERE id=?`,
      args: [nom, description || null, parseFloat(prix), parseInt(stock) ?? -1, image_url || null, actif ? 1 : 0, req.params.id],
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /api/boutique/admin/produits/:id
router.delete('/admin/produits/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await db.execute({
      sql: 'DELETE FROM boutique_produits WHERE id = ?',
      args: [req.params.id],
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/boutique/admin/commandes
router.get('/admin/commandes', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT bc.*, bp.nom as produit_nom, u.email
            FROM boutique_commandes bc
            JOIN boutique_produits bp ON bc.produit_id = bp.id
            JOIN users u ON bc.user_id = u.id
            ORDER BY bc.created_at DESC`,
      args: [],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/boutique/admin/commandes/:id — statut + instructions + code
router.put('/admin/commandes/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { statut, instructions, code } = req.body;
    const commandeRes = await db.execute({
      sql: 'SELECT bc.*, bp.nom FROM boutique_commandes bc JOIN boutique_produits bp ON bc.produit_id = bp.id WHERE bc.id = ?',
      args: [req.params.id],
    });
    const commande = commandeRes.rows[0];
    if (!commande) return res.status(404).json({ error: 'Commande introuvable' });

    await db.execute({
      sql: `UPDATE boutique_commandes
            SET statut = ?,
                instructions = COALESCE(?, instructions),
                code = COALESCE(?, code)
            WHERE id = ?`,
      args: [statut || commande.statut, instructions || null, code || null, req.params.id],
    });

    // Annulation — rembourser
    if (statut === 'annulee' && commande.statut === 'en_attente') {
      await db.execute({
        sql: 'UPDATE users SET solde = solde + ? WHERE id = ?',
        args: [commande.montant, commande.user_id],
      });
      await db.execute({
        sql: "INSERT INTO transactions (user_id, type, montant, note) VALUES (?, 'credit', ?, ?)",
        args: [commande.user_id, commande.montant, `Remboursement boutique : ${commande.nom}`],
      });
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [commande.user_id, '↩️ Commande annulée', `Ta commande de ${commande.nom} a été annulée. ${parseFloat(commande.montant).toFixed(2)}€ remboursés.`],
      });
    }

    // Livraison — notifier avec instructions
    if (statut === 'livree') {
      const msg = instructions
        ? `Ta commande de ${commande.nom} a été livrée ! Instructions : ${instructions}`
        : `Ta commande de ${commande.nom} a été livrée !`
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [commande.user_id, '📦 Commande livrée !', msg],
      });
    }

    // Instructions ajoutées sans changement de statut
    if (!statut && (instructions || code)) {
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [commande.user_id, '📋 Infos disponibles !', `Des instructions ont été ajoutées à ta commande de ${commande.nom}. Consulte tes commandes !`],
      });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
