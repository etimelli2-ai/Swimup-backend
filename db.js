const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

async function initDB() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT NOT NULL UNIQUE,
      password_hash   TEXT NOT NULL,
      discord_id      TEXT,
      paypal_email    TEXT,
      role            TEXT DEFAULT 'membre' CHECK(role IN ('membre', 'client', 'admin')),
      solde           REAL DEFAULT 0,
      ip_address      TEXT,
      last_login      DATETIME,
      banned          INTEGER DEFAULT 0,
      discord_demande INTEGER DEFAULT 0,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS clients (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER NOT NULL UNIQUE,
      nom_societe      TEXT,
      solde_depot      REAL DEFAULT 0,
      paiement_valide  INTEGER DEFAULT 1,
      bloquer_si_dette INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS avis (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id         INTEGER NOT NULL,
      lien_maps         TEXT NOT NULL,
      texte             TEXT NOT NULL,
      prix              REAL NOT NULL,
      delai_paiement    INTEGER NOT NULL DEFAULT 30,
      nb_etoiles        INTEGER DEFAULT 5,
      nom_etablissement TEXT,
      statut            TEXT DEFAULT 'disponible' CHECK(statut IN ('disponible','reserve','en_verification','valide','refuse','paye')),
      reserve_par       INTEGER,
      reserve_at        DATETIME,
      soumis_at         DATETIME,
      lien_avis_poste   TEXT,
      place_id          TEXT,
      valide_at         DATETIME,
      paye_at           DATETIME,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (client_id) REFERENCES clients(id),
      FOREIGN KEY (reserve_par) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS verifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      avis_id    INTEGER NOT NULL UNIQUE,
      user_id    INTEGER NOT NULL,
      last_check DATETIME DEFAULT CURRENT_TIMESTAMP,
      nb_checks  INTEGER DEFAULT 0,
      statut     TEXT DEFAULT 'actif',
      FOREIGN KEY (avis_id) REFERENCES avis(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      type       TEXT NOT NULL CHECK(type IN ('credit','debit','retrait','penalite')),
      montant    REAL NOT NULL,
      note       TEXT,
      avis_id    INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS retraits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      montant    REAL NOT NULL,
      paypal     TEXT NOT NULL,
      statut     TEXT DEFAULT 'en_attente' CHECK(statut IN ('en_attente','paye','refuse')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT NOT NULL UNIQUE,
      role       TEXT DEFAULT 'client',
      utilise    INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS loteries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      titre         TEXT NOT NULL,
      montant_gain  REAL NOT NULL,
      prix_ticket   REAL DEFAULT 1,
      statut        TEXT DEFAULT 'en_cours' CHECK(statut IN ('en_cours','terminee')),
      gagnant_id    INTEGER,
      gagnant_email TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      termine_at    DATETIME,
      FOREIGN KEY (gagnant_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS loterie_tickets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      loterie_id INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      nb_tickets INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(loterie_id, user_id),
      FOREIGN KEY (loterie_id) REFERENCES loteries(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      titre      TEXT NOT NULL,
      message    TEXT NOT NULL,
      lu         INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS contestations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      avis_id    INTEGER NOT NULL,
      message    TEXT,
      statut     TEXT DEFAULT 'en_attente',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(avis_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (avis_id) REFERENCES avis(id)
    );
  `);
  console.log('✅ DB Swimup initialisée');
}

module.exports = { db, initDB };
