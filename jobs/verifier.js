const axios = require('axios');
const https = require('https');
const { db } = require('../db');

function normaliser(texte) {
  return texte
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function similarite(texte1, texte2) {
  const t1 = normaliser(texte1)
  const t2 = normaliser(texte2)
  if (t1 === t2) return 1
  const mots1 = t1.split(' ').filter(m => m.length > 2)
  const mots2 = new Set(t2.split(' ').filter(m => m.length > 2))
  if (mots1.length === 0) return 0
  const communs = mots1.filter(m => mots2.has(m))
  return communs.length / mots1.length
}

// Résoudre les liens courts Google Maps
async function resoudreLienCourt(lien) {
  if (!lien.includes('goo.gl') && !lien.includes('maps.app.goo.gl')) return lien
  return new Promise((resolve) => {
    https.get(lien, { maxRedirects: 0 }, (res) => {
      const location = res.headers.location
      if (location) {
        console.log(`🔗 Lien court résolu: ${location}`)
        resolve(location)
      } else {
        resolve(lien)
      }
    }).on('error', () => {
      console.log('⚠️ Impossible de résoudre le lien court')
      resolve(lien)
    })
  })
}

// Extraire la meilleure query pour Outscraper
function extraireQueryPourOutscraper(url) {
  try {
    // Cas 1 — lien direct vers un avis /maps/reviews/data=...
    // Extraire le place ID depuis !1s0x...
    const placeIdMatch = url.match(/!1s(0x[^!:]+:[^!&]+)/)
    if (placeIdMatch) {
      const placeId = decodeURIComponent(placeIdMatch[1])
      console.log(`📍 Place ID extrait depuis reviews: ${placeId}`)
      return placeId
    }

    // Cas 2 — /place/NomLieu/
    const placeMatch = url.match(/\/place\/([^/@?&]+)/)
    if (placeMatch) {
      const nom = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '))
      console.log(`📍 Extrait depuis /place/: ${nom}`)
      return nom
    }

    // Cas 3 — ?q=NomEtablissement,Adresse,Ville (format GPS)
    const qMatch = url.match(/[?&]q=([^&]+)/)
    if (qMatch) {
      const q = decodeURIComponent(qMatch[1].replace(/\+/g, ' '))
      const parts = q.split(',')
      if (parts.length >= 2) {
        const nom = parts[0].trim()
        const ville = parts[parts.length - 1].trim().replace(/\d{5}\s*/, '')
        const query = `${nom}, ${ville}`
        console.log(`📍 Extrait depuis ?q=: ${query}`)
        return query
      }
      console.log(`📍 Extrait depuis ?q= (simple): ${q}`)
      return q
    }

    // Cas 4 — URL complète comme fallback
    console.log(`📍 Fallback URL complète`)
    return url
  } catch {
    return url
  }
}

async function attendreResultat(requestId, apiKey, maxTentatives = 15) {
  for (let i = 0; i < maxTentatives; i++) {
    await new Promise(r => setTimeout(r, 10000))
    try {
      const response = await axios.get(`https://api.app.outscraper.com/requests/${requestId}`, {
        headers: { 'X-API-KEY': apiKey },
        timeout: 30000,
      })
      const data = response.data
      console.log(`⏳ Tentative ${i + 1} — statut: ${data?.status}`)
      if (data?.status === 'Success') return { success: true, data: data?.data || [] }
      if (data?.status === 'Error') {
        console.error('Outscraper erreur:', data)
        return { success: false, error: true, raison: 'Erreur Outscraper' }
      }
    } catch (e) {
      console.error(`Erreur tentative ${i + 1}:`, e.message)
    }
  }
  return { success: false, error: true, raison: 'Timeout après toutes les tentatives' }
}

async function verifierViaOutscraper(lienMaps, texteAttendu, nbEtoilesAttendu) {
  try {
    const apiKey = process.env.OUTSCRAPER_API_KEY
    if (!apiKey) {
      console.error('❌ OUTSCRAPER_API_KEY manquant')
      return { trouve: false, erreur: true, raison: 'API non configurée' }
    }

    // Étape 1 — résoudre les liens courts
    const lienResolu = await resoudreLienCourt(lienMaps)

    // Étape 2 — extraire la meilleure query pour Outscraper
    const query = extraireQueryPourOutscraper(lienResolu)
    console.log(`📍 Query finale Outscraper: ${query}`)

    const response = await axios.get('https://api.app.outscraper.com/maps/reviews-v3', {
      params: {
        query: query,
        reviewsLimit: 50,
        language: 'fr',
        sort: 'newest',
        async: true,
      },
      headers: { 'X-API-KEY': apiKey },
      timeout: 30000,
    })

    const data = response.data
    console.log(`📊 Statut initial: ${data?.status}, ID: ${data?.id}`)

    let reviews = []

    if (data?.status === 'Success') {
      reviews = data?.data?.[0]?.reviews_data || []
    } else if (data?.status === 'Pending' && data?.id) {
      const result = await attendreResultat(data.id, apiKey)
      if (result.error) {
        return { trouve: false, erreur: true, raison: result.raison }
      }
      reviews = result.data?.[0]?.reviews_data || []
    } else {
      return { trouve: false, erreur: true, raison: `Statut inconnu: ${data?.status}` }
    }

    console.log(`📊 ${reviews.length} avis récupérés`)

    if (reviews.length === 0) {
      return { trouve: false, erreur: false, raison: 'Aucun avis retourné par Outscraper' }
    }

    let meilleurScore = 0
    let meilleurAvis = null

    for (const review of reviews) {
      const texteReview = review.review_text || ''
      if (!texteReview) continue
      const score = similarite(texteAttendu, texteReview)
      if (score > meilleurScore) {
        meilleurScore = score
        meilleurAvis = review
      }
    }

    console.log(`📊 Meilleur score : ${(meilleurScore * 100).toFixed(0)}%`)

    if (meilleurScore >= 0.75) {
      if (nbEtoilesAttendu && meilleurAvis?.review_rating) {
        if (parseInt(meilleurAvis.review_rating) !== parseInt(nbEtoilesAttendu)) {
          return {
            trouve: false,
            erreur: false,
            raison: `Note incorrecte : ${meilleurAvis.review_rating}⭐ au lieu de ${nbEtoilesAttendu}⭐`,
          }
        }
      }
      return {
        trouve: true,
        erreur: false,
        raison: `Avis trouvé (${(meilleurScore * 100).toFixed(0)}% similarité, ${meilleurAvis?.review_rating}⭐)`,
      }
    }

    return {
      trouve: false,
      erreur: false,
      raison: `Avis non trouvé parmi ${reviews.length} avis (score max: ${(meilleurScore * 100).toFixed(0)}%)`,
    }
  } catch (e) {
    console.error('Erreur Outscraper:', e.message)
    return { trouve: false, erreur: true, raison: `Erreur API: ${e.message}` }
  }
}

async function verifierAvisToujours(lienMaps, texte, nbEtoiles) {
  try {
    const result = await verifierViaOutscraper(lienMaps, texte, nbEtoiles)
    return result.trouve
  } catch {
    return true
  }
}

async function verifierAvis(avis) {
  return true
}

async function jobVerificationQuotidienne() {
  console.log('🔍 Vérification quotidienne des avis...')

  try {
    const verifRes = await db.execute({
      sql: `SELECT v.*, a.lien_maps, a.lien_avis_poste, a.texte, a.nb_etoiles,
              a.prix, a.client_id, a.valide_at, a.reserve_at, a.delai_paiement
            FROM verifications v
            JOIN avis a ON v.avis_id = a.id
            WHERE v.statut = 'actif' AND a.statut = 'valide'`,
      args: [],
    })

    console.log(`📋 ${verifRes.rows.length} avis à vérifier`)

    for (const verif of verifRes.rows) {
      try {
        console.log(`🔍 Vérification avis #${verif.avis_id}...`)

        const result = await verifierViaOutscraper(
          verif.lien_maps,
          verif.texte,
          verif.nb_etoiles
        )

        await db.execute({
          sql: 'UPDATE verifications SET last_check = CURRENT_TIMESTAMP, nb_checks = nb_checks + 1 WHERE id = ?',
          args: [verif.id],
        })

        if (result.erreur) {
          console.log(`⚠️ Avis #${verif.avis_id} : erreur API — ${result.raison} (on retente demain)`)
          continue
        }

        if (!result.trouve) {
          console.log(`❌ Avis #${verif.avis_id} non trouvé : ${result.raison}`)

          await db.execute({
            sql: "UPDATE avis SET statut = 'refuse' WHERE id = ?",
            args: [verif.avis_id],
          })
          await db.execute({
            sql: "UPDATE verifications SET statut = 'inactif' WHERE id = ?",
            args: [verif.id],
          })

          const transRes = await db.execute({
            sql: "SELECT * FROM transactions WHERE avis_id = ? AND type = 'credit'",
            args: [verif.avis_id],
          })

          if (transRes.rows.length) {
            const montant = parseFloat(transRes.rows[0].montant)
            await db.execute({
              sql: 'UPDATE users SET solde = MAX(0, solde - ?) WHERE id = ?',
              args: [montant, verif.user_id],
            })
            await db.execute({
              sql: "INSERT INTO transactions (user_id, type, montant, note, avis_id) VALUES (?, 'penalite', ?, ?, ?)",
              args: [verif.user_id, montant, 'Avis supprimé de Google Maps', verif.avis_id],
            })
          }

          await db.execute({
            sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
            args: [verif.user_id, '⚠️ Avis supprimé', "Ton avis n'a pas été trouvé sur Google Maps."],
          })

          continue
        }

        console.log(`✅ Avis #${verif.avis_id} trouvé : ${result.raison}`)

        // Fix — utiliser reserve_at au lieu de valide_at pour calculer les 30 jours
        const dateRef = verif.reserve_at ? new Date(verif.reserve_at) : new Date(verif.valide_at)
        const joursEcoules = (Date.now() - dateRef.getTime()) / (1000 * 60 * 60 * 24)

        console.log(`📅 Jours écoulés depuis réservation : ${joursEcoules.toFixed(1)}j / ${verif.delai_paiement}j requis`)

        if (joursEcoules >= verif.delai_paiement) {
          const dejaCredite = await db.execute({
            sql: "SELECT id FROM transactions WHERE avis_id = ? AND type = 'credit'",
            args: [verif.avis_id],
          })

          if (!dejaCredite.rows.length) {
            await db.execute({
              sql: 'UPDATE users SET solde = solde + ? WHERE id = ?',
              args: [verif.prix, verif.user_id],
            })
            await db.execute({
              sql: "INSERT INTO transactions (user_id, type, montant, note, avis_id) VALUES (?, 'credit', ?, ?, ?)",
              args: [verif.user_id, verif.prix, `Avis validé après ${verif.delai_paiement} jours`, verif.avis_id],
            })
            await db.execute({
              sql: "UPDATE avis SET statut = 'paye', paye_at = CURRENT_TIMESTAMP WHERE id = ?",
              args: [verif.avis_id],
            })
            await db.execute({
              sql: "UPDATE verifications SET statut = 'paye' WHERE id = ?",
              args: [verif.id],
            })
            await db.execute({
              sql: 'INSERT INTO notifications (user_id, titre, message) VALUES (?,?,?)',
              args: [verif.user_id, '💰 Solde crédité !', `${parseFloat(verif.prix).toFixed(2)}€ ont été ajoutés à ton solde !`],
            })
            console.log(`✅ Avis #${verif.avis_id} — ${verif.prix}€ crédité`)
          }
        }
      } catch (e) {
        console.error(`Erreur vérif avis #${verif.avis_id}:`, e.message)
      }
    }

    // Libérer les réservations expirées
    await db.execute({
      sql: `UPDATE avis SET statut = 'disponible', reserve_par = NULL, reserve_at = NULL
            WHERE statut = 'reserve' AND reserve_at <= datetime('now', '-1 hour', 'utc')`,
      args: [],
    })

    console.log('✅ Vérification quotidienne terminée')
  } catch (e) {
    console.error('Erreur job quotidien:', e)
  }
}

module.exports = { verifierAvis, verifierViaOutscraper, jobVerificationQuotidienne }
