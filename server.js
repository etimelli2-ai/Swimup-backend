require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { initDB, db } = require('./db');
const { jobVerificationQuotidienne } = require('./jobs/verifier');
const { authMiddleware, adminOnly } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/avis',      require('./routes/avis'));
app.use('/api/paiements', require('./routes/paiements'));
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/client',    require('./routes/client'));
app.use('/api/loterie',   require('./routes/loterie'));

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

// Lancer la vérification manuellement (admin uniquement)
app.post('/api/admin/run-verif', authMiddleware, adminOnly, async (req, res) => {
  try {
    res.json({ success: true, message: '🔍 Vérification de tous les avis lancée en arrière-plan !' });
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
