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

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

// Migration 6 — table commandes Stripe
app.get('/api/migrate6', async (req, res) => {
  try {
    await db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS commandes (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id         INTEGER NOT NULL,
        stripe_session_id TEXT UNIQUE,
        montant           REAL NOT NULL,
        nb_avis           INTEGER NOT NULL,
        statut            TEXT DEFAULT 'en_attente',
        created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        paye_at           DATETIME,
        FOREIGN KEY (client_id) REFERENCES clients(id)
      );
      ALTER TABLE avis ADD COLUMN commande_id INTEGER;
    `);
    res.json({ success: true, message: 'Migration 6 OK' });
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

cron.schedule('0 8 * * *', jobVerificationQuotidienne, { timezone: 'Europe/Paris' });

const PORT = process.env.PORT || 3001;

initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Swimup Backend sur le port ${PORT}`));
}).catch(console.error);
