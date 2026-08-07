require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { initDB, db } = require('./db');
const { jobVerificationQuotidienne } = require('./jobs/verifier');
const { authMiddleware, adminOnly } = require('./middleware/auth');

const app = express();

// Fix — webhook Stripe doit recevoir le raw body
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/avis',      require('./routes/avis'));
app.use('/api/paiements', require('./routes/paiements'));
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/client',    require('./routes/client'));
app.use('/api/loterie',   require('./routes/loterie'));
app.use('/api/stripe',    require('./routes/stripe'));
app.use('/api/public',    require('./routes/public'));
app.use('/api/boutique',  require('./routes/boutique'));

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

// Debug connexion Stripe
app.get('/api/debug-stripe2', async (req, res) => {
  try {
    const https = require('https');
    https.get('https://api.stripe.com', (r) => {
      res.json({ success: true, status: r.statusCode });
    }).on('error', (e) => {
      res.json({ success: false, error: e.message, code: e.code });
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.get('/api/migrate8', async (req, res) => {
  try {
    await db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS boutique_produits (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        nom         TEXT NOT NULL,
        description TEXT,
        prix        REAL NOT NULL,
        stock       INTEGER DEFAULT -1,
        image_url   TEXT,
        actif       INTEGER DEFAULT 1,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS boutique_commandes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        produit_id  INTEGER NOT NULL,
        quantite    INTEGER DEFAULT 1,
        montant     REAL NOT NULL,
        statut      TEXT DEFAULT 'en_attente',
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (produit_id) REFERENCES boutique_produits(id)
      );
      CREATE INDEX IF NOT EXISTS idx_boutique_commandes_user ON boutique_commandes(user_id);
      CREATE INDEX IF NOT EXISTS idx_boutique_commandes_statut ON boutique_commandes(statut);
    `);
    res.json({ success: true, message: 'Migration 8 OK' });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// Lancer la vérification manuellement
app.post('/api/admin/run-verif', authMiddleware, adminOnly, async (req, res) => {
  try {
    res.json({ success: true, message: '🔍 Vérification lancée !' });
    jobVerificationQuotidienne();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

cron.schedule('0 8 * * 1', jobVerificationQuotidienne, { timezone: 'Europe/Paris' })

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Swimup Backend sur le port ${PORT}`));
}).catch(console.error);
