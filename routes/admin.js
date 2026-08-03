const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware, adminOnly);

router.get('/stats', async (req, res) => {
  try {
    const [users, avisTotal, avisValides, retraitsAttente, soldeTotal] = await Promise.all([
      db.execute({ sql: 'SELECT COUNT(*) as c FROM users', args: [] }),
      db.execute({ sql: 'SELECT COUNT(*) as c FROM avis', args: [] }),
      db.execute({ sql: "SELECT COUNT(*) as c FROM avis WHERE statut = 'valide'", args: [] }),
      db.execute({ sql: "SELECT COUNT(*) as c, SUM(montant) as s FROM retraits WHERE statut = 'en_attente'", args: [] }),
      db.execute({ sql: 'SELECT SUM(solde) as s FROM users', args: [] }),
    ]);
    res.json({
      users: users.rows[0].c,
      avisTotal: avisTotal.rows[0].c,
      avisValides: avisValides.rows[0].c,
      retraitsAttente: retraitsAttente.rows[0].c,
      montantRetraitsAttente: retraitsAttente.rows[0].s || 0,
      soldeTotal: soldeTotal.rows[0].s || 0,
    });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT u.id, u.email, u.discord_id, u.paypal_email, u.role, u.solde,
              u.created_at, u.ip_address, u.last_login, u.banned, u.discord_demande,
              COUNT(a.id) as nb_avis,
              SUM(CASE WHEN a.statut IN ('valide','paye') THEN 1 ELSE 0 END) as nb_valides
            FROM users u
            LEFT JOIN avis a ON a.reserve_par = u.id
            GROUP BY u.id
            ORDER BY u.created_at DESC`,
      args: []
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/users/:id/detail', async (req, res) => {
  try {
    const [userRes, avisRes, transRes] = await Promise.all([
      db.execute({
        sql: 'SELECT id, email, discord_id, paypal_email, role, solde, created_at, ip_address, last_login, banned, discord_demande FROM users WHERE id = ?',
        args: [req.params.id],
      }),
      db.execute({
        sql: `SELECT a.*, COALESCE(a.nom_etablissement, c.nom_societe) as nom_societe FROM avis a
              JOIN clients c ON a.client_id = c.id
              WHERE a.reserve_par = ?
              ORDER BY a.created_at DESC LIMIT 20`,
        args: [req.params.id],
      }),
      db.execute({
        sql: 'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
        args: [req.params.id],
      }),
    ]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Membre introuvable' });
    res.json({ user, avis: avisRes.rows, transactions: transRes.rows });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/users/:id/ban', async (req, res) => {
  try {
    const { banned } = req.body;
    await db.execute({ sql: 'UPDATE users SET banned = ? WHERE id = ?', args: [banned ? 1 : 0, req.params.id] });
    if (banned) {
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [req.params.id, '🚫 Compte suspendu', "Ton compte a été suspendu par l'admin."],
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/users/:id/solde', async (req, res) => {
  try {
    const { montant, note } = req.body;
    const m = parseFloat(montant);
    if (isNaN(m)) return res.status(400).json({ error: 'Montant invalide' });
    await db.execute({ sql: 'UPDATE users SET solde = solde + ? WHERE id = ?', args: [m, req.params.id] });
    await db.execute({
      sql: "INSERT INTO transactions (user_id, type, montant, note) VALUES (?, ?, ?, ?)",
      args: [req.params.id, m >= 0 ? 'credit' : 'debit', Math.abs(m), note || 'Ajustement manuel admin'],
    });
    await db.execute({
      sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
      args: [req.params.id, m >= 0 ? '💰 Solde crédité' : '💸 Solde débité',
        `L'admin a ${m >= 0 ? 'ajouté' : 'retiré'} ${Math.abs(m).toFixed(2)}€ sur ton compte.`],
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/users/:id/reset-password', async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court' });
    const hash = await bcrypt.hash(new_password, 12);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [hash, req.params.id] });
    await db.execute({
      sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
      args: [req.params.id, '🔑 Mot de passe modifié', "Ton mot de passe a été réinitialisé par l'admin."],
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/users/:id/demander-discord', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE users SET discord_demande = 1 WHERE id = ?', args: [req.params.id] });
    await db.execute({
      sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
      args: [req.params.id, '⚠️ ID Discord requis', "L'admin te demande de renseigner ton ID Discord dans ton profil."],
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/avis', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT a.*,
              COALESCE(a.nom_etablissement, c.nom_societe) as nom_societe,
              u.email as membre_email,
              v.last_check, v.nb_checks, v.statut as verif_statut
            FROM avis a
            JOIN clients c ON a.client_id = c.id
            LEFT JOIN users u ON a.reserve_par = u.id
            LEFT JOIN verifications v ON v.avis_id = a.id
            ORDER BY a.prioritaire DESC, a.created_at DESC`,
      args: [],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/avis', async (req, res) => {
  try {
    const { client_id, lien_maps, texte, prix, delai_paiement } = req.body;
    if (!lien_maps || !texte || !prix || !client_id) return res.status(400).json({ error: 'Champs requis manquants' });
    await db.execute({
      sql: 'INSERT INTO avis (client_id, lien_maps, texte, prix, delai_paiement) VALUES (?,?,?,?,?)',
      args: [client_id, lien_maps, texte, parseFloat(prix), parseInt(delai_paiement) || 30],
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Fix — une seule route menage qui fait les deux actions
router.delete('/avis/menage', async (req, res) => {
  try {
    // 1. Remettre en disponible les avis refusés
    const refusesRes = await db.execute({
      sql: "SELECT id FROM avis WHERE statut = 'refuse'",
      args: [],
    });
    let resetCount = 0;
    for (const a of refusesRes.rows) {
      await db.execute({
        sql: `UPDATE avis SET statut = 'disponible', reserve_par = NULL, reserve_at = NULL,
                soumis_at = NULL, lien_avis_poste = NULL, valide_at = NULL WHERE id = ?`,
        args: [a.id],
      });
      await db.execute({
        sql: "UPDATE verifications SET statut = 'actif', last_check = NULL, nb_checks = 0 WHERE avis_id = ?",
        args: [a.id],
      });
      resetCount++;
    }

    // 2. Supprimer les avis payés
    const payesRes = await db.execute({
      sql: "SELECT id FROM avis WHERE statut = 'paye'",
      args: [],
    });
    let deleteCount = 0;
    for (const a of payesRes.rows) {
      await db.execute({ sql: 'DELETE FROM contestations WHERE avis_id = ?', args: [a.id] });
      await db.execute({ sql: 'DELETE FROM verifications WHERE avis_id = ?', args: [a.id] });
      await db.execute({ sql: 'DELETE FROM transactions WHERE avis_id = ?', args: [a.id] });
      await db.execute({ sql: 'DELETE FROM avis WHERE id = ?', args: [a.id] });
      deleteCount++;
    }

    res.json({
      success: true,
      message: `✅ ${resetCount} avis refusés remis en dispo · ${deleteCount} avis payés supprimés !`
    });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/avis/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await db.execute({ sql: 'DELETE FROM contestations WHERE avis_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM verifications WHERE avis_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM transactions WHERE avis_id = ?', args: [id] });
    await db.execute({ sql: 'DELETE FROM avis WHERE id = ?', args: [id] });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/avis/:id', async (req, res) => {
  try {
    const { lien_maps, texte, prix, delai_paiement, statut } = req.body;
    await db.execute({
      sql: 'UPDATE avis SET lien_maps=?, texte=?, prix=?, delai_paiement=?, statut=? WHERE id=?',
      args: [lien_maps, texte, parseFloat(prix), parseInt(delai_paiement), statut, req.params.id],
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/avis/:id/valider', async (req, res) => {
  try {
    const { lien_avis_poste } = req.body;
    const avisRes = await db.execute({ sql: 'SELECT * FROM avis WHERE id = ?', args: [req.params.id] });
    const avis = avisRes.rows[0];
    if (!avis) return res.status(404).json({ error: 'Avis introuvable' });
    const lien = lien_avis_poste || avis.lien_avis_poste;
    await db.execute({
      sql: "UPDATE avis SET statut = 'valide', valide_at = CURRENT_TIMESTAMP, lien_avis_poste = ? WHERE id = ?",
      args: [lien, req.params.id],
    });
    await db.execute({
      sql: 'INSERT OR REPLACE INTO verifications (avis_id, user_id) VALUES (?, ?)',
      args: [avis.id, avis.reserve_par],
    });
    if (avis.reserve_par) {
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [avis.reserve_par, '✅ Avis validé !', "Ton avis a été validé par l'admin. Ton solde sera crédité après le délai."],
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/avis/:id/refuser', async (req, res) => {
  try {
    const avisRes = await db.execute({ sql: 'SELECT * FROM avis WHERE id = ?', args: [req.params.id] });
    const avis = avisRes.rows[0];
    if (!avis) return res.status(404).json({ error: 'Avis introuvable' });
    await db.execute({ sql: "UPDATE avis SET statut = 'refuse' WHERE id = ?", args: [req.params.id] });
    const transRes = await db.execute({
      sql: "SELECT * FROM transactions WHERE avis_id = ? AND type = 'credit'",
      args: [avis.id],
    });
    if (transRes.rows.length) {
      const montant = parseFloat(transRes.rows[0].montant);
      await db.execute({ sql: 'UPDATE users SET solde = MAX(0, solde - ?) WHERE id = ?', args: [montant, avis.reserve_par] });
      await db.execute({
        sql: "INSERT INTO transactions (user_id, type, montant, note, avis_id) VALUES (?, 'penalite', ?, ?, ?)",
        args: [avis.reserve_par, montant, "Avis refusé par l'admin", avis.id],
      });
    }
    if (avis.reserve_par) {
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [avis.reserve_par, '❌ Avis refusé', "Ton avis a été refusé car il n'est plus présent sur Google Maps."],
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/avis/:id/remettre-dispo', async (req, res) => {
  try {
    const avisRes = await db.execute({ sql: 'SELECT * FROM avis WHERE id = ?', args: [req.params.id] });
    const avis = avisRes.rows[0];
    if (!avis) return res.status(404).json({ error: 'Avis introuvable' });
    await db.execute({
      sql: `UPDATE avis SET statut = 'disponible', reserve_par = NULL, reserve_at = NULL,
              soumis_at = NULL, lien_avis_poste = NULL, valide_at = NULL WHERE id = ?`,
      args: [req.params.id],
    });
    await db.execute({
      sql: "UPDATE verifications SET statut = 'actif', last_check = NULL, nb_checks = 0 WHERE avis_id = ?",
      args: [req.params.id],
    });
    res.json({ success: true, message: 'Avis remis en disponible !' });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/avis/:id/prioritaire', async (req, res) => {
  try {
    const { prioritaire, prix_membre } = req.body;
    const m = parseFloat(prix_membre);
    if (isNaN(m) || m < 1) return res.status(400).json({ error: 'Prix minimum 1€' });
    await db.execute({
      sql: 'UPDATE avis SET prioritaire = ?, prix_membre = ? WHERE id = ?',
      args: [prioritaire ? 1 : 0, m, req.params.id],
    });
    if (prioritaire) {
      const membresRes = await db.execute({
        sql: "SELECT id FROM users WHERE role = 'membre' AND banned = 0",
        args: [],
      });
      for (const membre of membresRes.rows) {
        await db.execute({
          sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
          args: [membre.id, '🔥 Avis prioritaire disponible !', `Un avis prioritaire à ${m.toFixed(2)}€ est disponible ! Dépêche-toi de le réserver.`],
        });
      }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/avis/:id/verifier', async (req, res) => {
  try {
    const { verifierViaOutscraper } = require('../jobs/verifier');
    const avisRes = await db.execute({ sql: 'SELECT * FROM avis WHERE id = ?', args: [req.params.id] });
    const avis = avisRes.rows[0];
    if (!avis) return res.status(404).json({ error: 'Avis introuvable' });

    res.json({ success: true, message: '🔍 Vérification lancée ! Rafraîchis dans 1-2 minutes.' });

    verifierViaOutscraper(avis.lien_maps, avis.texte, avis.nb_etoiles)
      .then(async (result) => {
        try {
          const existingVerif = await db.execute({
            sql: 'SELECT id FROM verifications WHERE avis_id = ?',
            args: [avis.id],
          });
          if (existingVerif.rows[0]) {
            await db.execute({
              sql: 'UPDATE verifications SET last_check = CURRENT_TIMESTAMP, nb_checks = nb_checks + 1 WHERE avis_id = ?',
              args: [avis.id],
            });
          } else {
            await db.execute({
              sql: 'INSERT INTO verifications (avis_id, user_id, last_check, nb_checks) VALUES (?,?,CURRENT_TIMESTAMP,1)',
              args: [avis.id, avis.reserve_par],
            });
          }
          if (result.erreur) {
            console.log(`⚠️ Vérif manuelle avis #${avis.id} : erreur API — ${result.raison}`);
            return;
          }
          if (!result.trouve) {
            await db.execute({
              sql: "UPDATE avis SET statut = 'refuse' WHERE id = ?",
              args: [avis.id],
            });
            await db.execute({
              sql: "UPDATE verifications SET statut = 'inactif' WHERE avis_id = ?",
              args: [avis.id],
            });
            if (avis.reserve_par) {
              await db.execute({
                sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
                args: [avis.reserve_par, '❌ Avis non trouvé', `Ton avis n'a pas été trouvé sur Google Maps : ${result.raison}`],
              });
            }
          } else {
            await db.execute({
              sql: "UPDATE avis SET statut = 'valide', valide_at = CURRENT_TIMESTAMP WHERE id = ? AND statut != 'paye'",
              args: [avis.id],
            });
            if (avis.reserve_par) {
              await db.execute({
                sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
                args: [avis.reserve_par, '✅ Avis vérifié !', "Ton avis a été vérifié et validé par l'admin."],
              });
            }
          }
          console.log(`✅ Vérif manuelle avis #${avis.id} : ${result.trouve ? 'trouvé' : 'non trouvé'} — ${result.raison}`)
        } catch (e) {
          console.error('Erreur post-vérif:', e.message)
        }
      })
      .catch(e => console.error('Erreur Outscraper:', e.message))
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/avis/:id/lien-incorrect', async (req, res) => {
  try {
    const avisRes = await db.execute({ sql: 'SELECT * FROM avis WHERE id = ?', args: [req.params.id] });
    const avis = avisRes.rows[0];
    if (!avis) return res.status(404).json({ error: 'Avis introuvable' });
    await db.execute({
      sql: "UPDATE avis SET statut = 'reserve', lien_avis_poste = NULL, soumis_at = NULL WHERE id = ?",
      args: [req.params.id],
    });
    if (avis.reserve_par) {
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [avis.reserve_par, '🔗 Lien incorrect', "L'admin a détecté que le lien de ton avis est incorrect. Retourne sur ton avis en cours et soumets le bon lien."],
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/retraits', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT r.*, u.email, u.discord_id FROM retraits r
            JOIN users u ON r.user_id = u.id
            ORDER BY r.created_at DESC`,
      args: [],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/retraits/:id', async (req, res) => {
  try {
    const { statut } = req.body;
    const retraitRes = await db.execute({ sql: 'SELECT * FROM retraits WHERE id = ?', args: [req.params.id] });
    const retrait = retraitRes.rows[0];
    if (!retrait) return res.status(404).json({ error: 'Retrait introuvable' });
    const oldStatut = retrait.statut;
    await db.execute({ sql: 'UPDATE retraits SET statut = ? WHERE id = ?', args: [statut, req.params.id] });
    if (statut === 'refuse' && oldStatut === 'en_attente') {
      await db.execute({ sql: 'UPDATE users SET solde = solde + ? WHERE id = ?', args: [retrait.montant, retrait.user_id] });
      await db.execute({
        sql: "INSERT INTO transactions (user_id, type, montant, note) VALUES (?, 'credit', ?, ?)",
        args: [retrait.user_id, retrait.montant, 'Retrait refusé — solde recrédité'],
      });
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [retrait.user_id, '↩️ Retrait refusé', `Ton retrait de ${parseFloat(retrait.montant).toFixed(2)}€ a été refusé. Ton solde a été recrédité.`],
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/clients', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT c.*, u.email FROM clients c
            JOIN users u ON c.user_id = u.id
            ORDER BY c.solde_depot DESC`,
      args: [],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/clients/:id/valider-paiement', async (req, res) => {
  try {
    const clientRes = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [req.params.id] });
    const client = clientRes.rows[0];
    if (!client) return res.status(404).json({ error: 'Client introuvable' });
    const montant = parseFloat(client.solde_depot || 0);
    await db.execute({ sql: 'UPDATE clients SET solde_depot = 0, paiement_valide = 1 WHERE id = ?', args: [req.params.id] });
    await db.execute({
      sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
      args: [client.user_id, '💳 Paiement validé', `Ton paiement de ${montant.toFixed(2)}€ a été reçu et validé.`],
    });
    res.json({ success: true, montant_valide: montant });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/clients/:id/bloquer', async (req, res) => {
  try {
    const { bloquer } = req.body;
    await db.execute({ sql: 'UPDATE clients SET bloquer_si_dette = ? WHERE id = ?', args: [bloquer ? 1 : 0, req.params.id] });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/contestations', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT co.*, u.email, a.prix, a.lien_avis_poste
            FROM contestations co
            JOIN users u ON co.user_id = u.id
            JOIN avis a ON co.avis_id = a.id
            ORDER BY co.created_at DESC`,
      args: [],
    });
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/contestations/:id', async (req, res) => {
  try {
    const { statut, avis_id, user_id, montant } = req.body;
    const contestRes = await db.execute({ sql: 'SELECT statut FROM contestations WHERE id = ?', args: [req.params.id] });
    const contest = contestRes.rows[0];
    if (!contest) return res.status(404).json({ error: 'Contestation introuvable' });
    if (contest.statut !== 'en_attente') return res.status(400).json({ error: 'Contestation déjà traitée' });
    const m = parseFloat(montant);
    if (isNaN(m)) return res.status(400).json({ error: 'Montant invalide' });
    await db.execute({ sql: 'UPDATE contestations SET statut = ? WHERE id = ?', args: [statut, req.params.id] });
    if (statut === 'acceptee') {
      await db.execute({ sql: 'UPDATE users SET solde = solde + ? WHERE id = ?', args: [m, user_id] });
      await db.execute({
        sql: "INSERT INTO transactions (user_id, type, montant, note, avis_id) VALUES (?, 'credit', ?, ?, ?)",
        args: [user_id, m, 'Contestation acceptée', avis_id],
      });
      await db.execute({ sql: "UPDATE avis SET statut = 'valide', valide_at = CURRENT_TIMESTAMP WHERE id = ?", args: [avis_id] });
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [user_id, '✅ Contestation acceptée !', `${m.toFixed(2)}€ recrédités sur ton solde.`],
      });
    } else {
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [user_id, '❌ Contestation refusée', "Ta contestation a été refusée par l'admin."],
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/users/:id/role', async (req, res) => {
  try {
    const { role } = req.body;
    if (!['membre', 'client', 'admin'].includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
    await db.execute({ sql: 'UPDATE users SET role = ? WHERE id = ?', args: [role, req.params.id] });
    if (role === 'client') {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO clients (user_id, nom_societe) VALUES (?, ?)',
        args: [req.params.id, 'Nouveau client'],
      });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
