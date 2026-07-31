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

// Debug Stripe API
app.get('/api/debug-stripe', async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16',
      timeout: 60000,
      maxNetworkRetries: 0,
    });
    const balance = await stripe.balance.retrieve();
    res.json({ success: true, currency: balance.available[0]?.currency });
  } catch (e) {
    res.json({ success: false, error: e.message, type: e.type });
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
