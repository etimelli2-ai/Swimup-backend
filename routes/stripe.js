const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
  timeout: 30000,
});
const { db } = require('../db');
const { authMiddleware, clientOnly } = require('../middleware/auth');

const router = express.Router();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const PRIX_AVIS = 3.00;

// POST /api/stripe/create-checkout-session
router.post('/create-checkout-session', authMiddleware, clientOnly, async (req, res) => {
  try {
    const { nb_avis, nom_etablissement, lien_maps, type_etablissement, delai_paiement, nb_etoiles } = req.body;

    if (!nb_avis || nb_avis < 1) return res.status(400).json({ error: 'Nombre d\'avis invalide' });
    if (!lien_maps) return res.status(400).json({ error: 'Lien Google Maps requis' });

    const clientRes = await db.execute({
      sql: 'SELECT id FROM clients WHERE user_id = ?',
      args: [req.user.id],
    });
    const client = clientRes.rows[0];
    if (!client) return res.status(404).json({ error: 'Profil client introuvable' });

    const montant = nb_avis * PRIX_AVIS;

    // Créer la session Stripe
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `${nb_avis} avis Google — ${nom_etablissement || 'SwimUp'}`,
            description: `Commande de ${nb_avis} avis Google Maps pour ${nom_etablissement || 'votre établissement'}`,
          },
          unit_amount: Math.round(montant * 100), // en centimes
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/client/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/client`,
      metadata: {
        client_id:         String(client.id),
        user_id:           String(req.user.id),
        nb_avis:           String(nb_avis),
        nom_etablissement: nom_etablissement || '',
        lien_maps:         lien_maps,
        type_etablissement: type_etablissement || '',
        delai_paiement:    String(delai_paiement || 30),
        nb_etoiles:        String(nb_etoiles || 5),
      },
    });

    // Sauvegarder la commande en attente
    await db.execute({
      sql: `INSERT INTO commandes (client_id, stripe_session_id, montant, nb_avis, statut)
            VALUES (?, ?, ?, ?, 'en_attente')`,
      args: [client.id, session.id, montant, nb_avis],
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (e) {
    console.error('Stripe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/stripe/webhook — appelé par Stripe après paiement
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (e) {
    console.error('Webhook signature error:', e.message);
    return res.status(400).json({ error: `Webhook Error: ${e.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata;

    try {
      const clientId      = parseInt(meta.client_id);
      const userId        = parseInt(meta.user_id);
      const nbAvis        = parseInt(meta.nb_avis);
      const nomEtab       = meta.nom_etablissement;
      const lienMaps      = meta.lien_maps;
      const typeEtab      = meta.type_etablissement;
      const delaiPaiement = parseInt(meta.delai_paiement) || 30;
      const nbEtoiles     = parseInt(meta.nb_etoiles) || 5;
      const montant       = parseFloat(session.amount_total) / 100;

      // Mettre à jour la commande
      await db.execute({
        sql: `UPDATE commandes SET statut = 'paye', paye_at = CURRENT_TIMESTAMP
              WHERE stripe_session_id = ?`,
        args: [session.id],
      });

      // Récupérer l'ID de la commande
      const commandeRes = await db.execute({
        sql: 'SELECT id FROM commandes WHERE stripe_session_id = ?',
        args: [session.id],
      });
      const commandeId = commandeRes.rows[0]?.id;

      // Créer les slots d'avis (sans texte — le client les remplira)
      for (let i = 0; i < nbAvis; i++) {
        await db.execute({
          sql: `INSERT INTO avis (client_id, lien_maps, texte, prix, delai_paiement, nb_etoiles, nom_etablissement, commande_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            clientId,
            lienMaps,
            '', // texte vide — sera rempli par le client
            1.00, // gain membre
            delaiPaiement,
            nbEtoiles,
            nomEtab,
            commandeId || null,
          ],
        });
      }

      // Notifier le client
      await db.execute({
        sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
        args: [userId, '✅ Paiement reçu !', `Ton paiement de ${montant.toFixed(2)}€ a été reçu. Tu peux maintenant remplir les textes de tes ${nbAvis} avis.`],
      });

      console.log(`✅ Paiement Stripe reçu — ${nbAvis} avis créés pour client #${clientId}`);
    } catch (e) {
      console.error('Erreur traitement webhook:', e.message);
    }
  }

  res.json({ received: true });
});

// GET /api/stripe/commandes — liste des commandes du client
router.get('/commandes', authMiddleware, clientOnly, async (req, res) => {
  try {
    const clientRes = await db.execute({
      sql: 'SELECT id FROM clients WHERE user_id = ?',
      args: [req.user.id],
    });
    const client = clientRes.rows[0];
    if (!client) return res.status(404).json({ error: 'Profil client introuvable' });

    const result = await db.execute({
      sql: `SELECT c.*, 
              COUNT(a.id) as nb_avis_total,
              SUM(CASE WHEN a.texte != '' THEN 1 ELSE 0 END) as nb_avis_remplis
            FROM commandes c
            LEFT JOIN avis a ON a.commande_id = c.id
            WHERE c.client_id = ? AND c.statut = 'paye'
            GROUP BY c.id
            ORDER BY c.created_at DESC`,
      args: [client.id],
    });

    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/stripe/commande/:id/avis — avis d'une commande
router.get('/commande/:id/avis', authMiddleware, clientOnly, async (req, res) => {
  try {
    const clientRes = await db.execute({
      sql: 'SELECT id FROM clients WHERE user_id = ?',
      args: [req.user.id],
    });
    const client = clientRes.rows[0];

    const result = await db.execute({
      sql: `SELECT * FROM avis WHERE commande_id = ? AND client_id = ? ORDER BY id ASC`,
      args: [req.params.id, client.id],
    });

    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/stripe/avis/:id — modifier texte et étoiles d'un avis
router.put('/avis/:id', authMiddleware, clientOnly, async (req, res) => {
  try {
    const { texte, nb_etoiles } = req.body;
    const clientRes = await db.execute({
      sql: 'SELECT id FROM clients WHERE user_id = ?',
      args: [req.user.id],
    });
    const client = clientRes.rows[0];

    // Vérifier que l'avis appartient à ce client
    const avisRes = await db.execute({
      sql: 'SELECT id, commande_id FROM avis WHERE id = ? AND client_id = ?',
      args: [req.params.id, client.id],
    });
    if (!avisRes.rows[0]) return res.status(404).json({ error: 'Avis introuvable' });
    if (!avisRes.rows[0].commande_id) return res.status(403).json({ error: 'Modification non autorisée' });

    // Ne peut modifier que texte et étoiles
    await db.execute({
      sql: 'UPDATE avis SET texte = ?, nb_etoiles = ? WHERE id = ?',
      args: [texte, parseInt(nb_etoiles) || 5, req.params.id],
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
