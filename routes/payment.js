const express = require('express');
const router = express.Router();
const axios = require('axios').create({ timeout: 10000 });
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { processDelivery } = require('../services/delivery');

const DJAMO_API_URL = process.env.DJAMO_API_URL || 'https://apibusiness.civ.staging.djam.ooo';
const DJAMO_ACCESS_TOKEN = process.env.DJAMO_ACCESS_TOKEN;
const DJAMO_COMPANY_ID = process.env.DJAMO_COMPANY_ID;
const DJAMO_WEBHOOK_SECRET = process.env.DJAMO_WEBHOOK_SECRET;

function djamoHeaders() {
  return {
    'Authorization': `Bearer ${DJAMO_ACCESS_TOKEN}`,
    'X-Company-Id': DJAMO_COMPANY_ID,
    'Content-Type': 'application/json'
  };
}

// ===== Transitions de statut communes =====
// Paiement confirmé : uniquement depuis pending / failed / cancelled (paiement tardif après expiration accepté
// car l'argent a été encaissé — une nouvelle carte est assignée à la livraison). Jamais depuis refunded.
function markOrderPaid(db, orderId) {
  const r = db.prepare("UPDATE orders SET payment_status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ? AND payment_status IN ('pending', 'failed', 'cancelled')").run(orderId);
  return r.changes > 0;
}
// Échec / annulation : uniquement si la commande est encore en attente
function markOrderFailed(db, orderId) {
  const tx = db.transaction(() => {
    const r = db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ? AND payment_status = 'pending'").run(orderId);
    if (r.changes === 0) return false;
    db.prepare("UPDATE cards SET status = 'available', order_id = NULL WHERE order_id = ? AND status = 'reserved'").run(orderId);
    db.prepare("UPDATE order_items SET card_id = NULL WHERE order_id = ? AND card_id IN (SELECT id FROM cards WHERE order_id IS NULL)").run(orderId);
    return true;
  });
  return tx();
}
// Remboursement confirmé par le prestataire : uniquement depuis paid — annule aussi les gains vendeur
function markOrderRefunded(db, orderId) {
  const tx = db.transaction(() => {
    const r = db.prepare("UPDATE orders SET payment_status = 'refunded', delivery_status = 'refunded' WHERE id = ? AND payment_status = 'paid'").run(orderId);
    if (r.changes === 0) return false;
    db.prepare("UPDATE cards SET status = 'disputed' WHERE order_id = ? AND status = 'sold'").run(orderId);
    db.prepare("UPDATE seller_earnings SET status = 'reversed' WHERE order_id = ? AND status IN ('pending', 'available')").run(orderId);
    return true;
  });
  return tx();
}

// ===== DJAMO =====

// POST /api/payment/djamo/initiate
router.post('/djamo/initiate', authenticateToken, async (req, res) => {
  try {
    const { order_id } = req.body;
    const db = getDb();

    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order_id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });
    if (order.payment_status !== 'pending') return res.status(400).json({ error: 'Cette commande a déjà été traitée.' });

    const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
    const externalId = `BABI-${uuidv4().split('-')[0].toUpperCase()}-${order_id}`;
    const successUrl = `${siteUrl}/dashboard#orders`;
    const cancelUrl  = `${siteUrl}/dashboard#orders`;

    db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(externalId, order_id);

    console.log('[DJAMO INITIATE] order_id:', order_id, '| amount:', order.total_amount, '| externalId:', externalId);
    // Appel API Djamo
    try {
      const chargeRes = await axios.post(
        `${DJAMO_API_URL}/v1/charges`,
        {
          amount: order.total_amount,
          currency: 'XOF',
          description: `Commande Babicard #${order_id}`,
          externalId,
          onCompletedRedirectionUrl: successUrl,
          onCanceledRedirectionUrl: cancelUrl
        },
        { headers: djamoHeaders() }
      );

      const charge = chargeRes.data?.data || chargeRes.data;
      const chargeId  = charge?.id;
      const paymentUrl = charge?.paymentUrl;

      console.log('[DJAMO INITIATE] Réponse Djamo — chargeId:', chargeId, '| paymentUrl:', paymentUrl ? 'OK' : 'ABSENT');
      if (!paymentUrl) throw new Error('paymentUrl absent de la réponse Djamo');

      db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(chargeId || externalId, order_id);

      return res.json({ payment_url: paymentUrl, payment_ref: chargeId || externalId, order_id });
    } catch (djamoErr) {
      console.error('Erreur Djamo API:', djamoErr.response?.data || djamoErr.message);
      // Annuler la commande et libérer les cartes réservées
      db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ?").run(order_id);
      db.prepare("UPDATE cards SET status = 'available', order_id = NULL WHERE order_id = ? AND status = 'reserved'").run(order_id);
      return res.status(502).json({ error: 'Erreur lors de l\'initialisation du paiement. Réessayez.' });
    }
  } catch (err) {
    console.error('Erreur Djamo initiate:', err);
    res.status(500).json({ error: 'Erreur lors de l\'initialisation du paiement.' });
  }
});

// GET /api/payment/djamo/status/:chargeId
router.get('/djamo/status/:chargeId', authenticateToken, async (req, res) => {
  try {
    const { chargeId } = req.params;
    if (!chargeId || chargeId.length > 100) return res.status(400).json({ error: 'chargeId invalide.' });

    const db = getDb();
    const order = db.prepare('SELECT id, payment_status, delivery_status FROM orders WHERE payment_ref = ? AND user_id = ?').get(chargeId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });

    // Si déjà payé en DB → retourner directement sans appeler Djamo
    // Mais si la livraison est encore pending, la relancer (cas d'échec de delivery après paiement)
    if (order.payment_status === 'paid' || order.payment_status === 'delivered') {
      if (order.delivery_status === 'pending') {
        processDelivery(order.id).catch(err => console.error('[STATUS POLL] Retry livraison échoué:', err.message));
      }
      return res.json({ chargeId, status: 'paid', order_id: order.id });
    }

    if (!DJAMO_ACCESS_TOKEN || DJAMO_ACCESS_TOKEN === 'your_djamo_access_token') {
      return res.json({ chargeId, status: order.payment_status, order_id: order.id });
    }

    const chargeRes = await axios.get(`${DJAMO_API_URL}/v1/charges/${chargeId}`, { headers: djamoHeaders() });
    const charge = chargeRes.data?.data || chargeRes.data;
    const djamoStatus = charge?.status;

    // Normaliser le statut Djamo → statut interne
    const normalizedStatus = ['charged', 'completed', 'success', 'paid'].includes(djamoStatus)
      ? 'paid'
      : ['failed', 'cancelled', 'expired'].includes(djamoStatus)
        ? 'failed'
        : djamoStatus;

    // Mettre à jour la DB si payé et déclencher la livraison
    if (normalizedStatus === 'paid') {
      if (markOrderPaid(db, order.id)) {
        // Première confirmation de paiement — lancer la livraison
        processDelivery(order.id).catch(err => console.error('[STATUS POLL] Erreur livraison:', err.message));
      }
    }

    res.json({ chargeId, status: normalizedStatus, order_id: order.id });
  } catch (err) {
    console.error('Erreur Djamo status:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erreur vérification statut.' });

  }
});

// GET /api/payment/order-status/:orderId — vérification statut par orderId (Mobile Money)
router.get('/order-status/:orderId', authenticateToken, (req, res) => {
  try {
    const { orderId } = req.params;
    const db = getDb();
    const order = db.prepare('SELECT id, payment_status FROM orders WHERE id = ? AND user_id = ?').get(orderId, req.user.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });
    const status = (order.payment_status === 'paid' || order.payment_status === 'delivered') ? 'paid'
      : order.payment_status === 'failed' ? 'failed'
      : 'pending';
    res.json({ status, order_id: order.id });
  } catch (err) {
    res.status(500).json({ error: 'Erreur vérification statut.' });
  }
});

// POST /api/payment/djamo/webhook — Djamo charge events
router.post('/djamo/webhook', async (req, res) => {
  try {
    // req.rawBody capturé avant express.json() dans server.js
    const rawStr = req.rawBody || (Buffer.isBuffer(req.body) ? req.body.toString('utf8')
                 : typeof req.body === 'string' ? req.body
                 : JSON.stringify(req.body));
    let body;
    try { body = JSON.parse(rawStr); } catch { return res.status(400).json({ error: 'Body JSON invalide.' }); }

    // Vérification signature HMAC-SHA256
    if (!DJAMO_WEBHOOK_SECRET) {
      console.error('[DJAMO WEBHOOK] DJAMO_WEBHOOK_SECRET manquant — webhook rejeté');
      return res.status(401).json({ error: 'Webhook non configuré.' });
    }
    const signature = req.headers['x-webhook-signature'] || req.headers['x-djamo-signature']
      || req.headers['x-signature'] || req.headers['signature'];
    if (!signature) {
      // Logger les noms d'en-têtes (pas les valeurs) pour identifier l'en-tête de signature Djamo
      console.warn('[DJAMO WEBHOOK] Signature absente — vérification via API Djamo obligatoire | IP:', req.ip, '| headers:', Object.keys(req.headers).join(','));
      // Pas de rejet immédiat mais on vérifiera le statut via l'API avant toute livraison
      req._djamoNoSignature = true;
    } else {
      const sigToCheck = signature.startsWith('sha256=') ? signature.slice(7) : signature;
      const expected = crypto.createHmac('sha256', DJAMO_WEBHOOK_SECRET).update(rawStr).digest('hex');
      const sigBuf = Buffer.from(String(sigToCheck), 'hex');
      const expBuf = Buffer.from(expected, 'hex');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        console.warn('[DJAMO WEBHOOK] Signature invalide — rejeté');
        return res.status(401).json({ error: 'Signature invalide.' });
      }
    }

   

    // Reject webhooks older than 10 minutes (anti-replay) — seulement si timestamp présent
    if (body.timestamp) {
      const webhookAge = Date.now() - new Date(body.timestamp).getTime();
      if (webhookAge > 10 * 60 * 1000) {
        console.warn('[WEBHOOK] Webhook expiré ignoré, age:', Math.round(webhookAge/1000), 's');
        return res.status(400).json({ error: 'Webhook expiré.' });
      }
    }

    console.log('[WEBHOOK] Topic:', body.topic, '| Status:', body.data?.status, '| ChargeId:', body.data?.id);

    if (body.topic !== 'charge/events') return res.json({ received: true, skipped: 'unknown_topic' });

    const { id: chargeId, externalId } = body.data || {};
    let status = body.data?.status;
    if (!chargeId || typeof chargeId !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(chargeId)) {
      return res.status(400).json({ error: 'chargeId invalide.' });
    }

    const db = getDb();
    // Chercher par chargeId (enregistré côté serveur à l'initiation)
    let order = db.prepare('SELECT * FROM orders WHERE payment_ref = ?').get(chargeId);
    // Fallback externalId UNIQUEMENT si le webhook est signé — sinon un attaquant pourrait
    // rattacher le chargeId d'une autre commande payée à sa commande.
    if (!order && externalId && !req._djamoNoSignature) {
      const match = String(externalId).match(/BABI-[A-Z0-9]+-(\d+)$/);
      if (match) order = db.prepare('SELECT * FROM orders WHERE id = ?').get(parseInt(match[1]));
    }
    if (!order) {
      console.warn('[WEBHOOK] Commande non trouvée pour chargeId:', chargeId, '| externalId:', externalId);
      return res.status(404).json({ error: 'Commande non trouvée.' });
    }
    // Mettre à jour payment_ref uniquement pour un webhook signé
    if (order.payment_ref !== chargeId && !req._djamoNoSignature) {
      db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(chargeId, order.id);
    }

    // Webhook non signé : ne jamais faire confiance au statut du body — le statut réel vient de l'API Djamo
    if (req._djamoNoSignature) {
      try {
        const verifyRes = await axios.get(`${DJAMO_API_URL}/v1/charges/${encodeURIComponent(chargeId)}`, { headers: djamoHeaders() });
        const charge = verifyRes.data?.data || verifyRes.data || {};
        const realStatus = charge.status;
        if (charge.id && charge.id !== chargeId) {
          console.warn('[DJAMO WEBHOOK] chargeId API différent du webhook — rejeté');
          return res.status(400).json({ error: 'Paiement non confirmé.' });
        }
        if (charge.amount != null && Number(charge.amount) !== Number(order.total_amount)) {
          console.warn('[DJAMO WEBHOOK] Montant API', charge.amount, '≠ commande', order.total_amount, '— rejeté');
          return res.status(400).json({ error: 'Montant incohérent.' });
        }
        status = ['charged', 'completed', 'success', 'paid'].includes(realStatus) ? 'paid'
          : ['dropped', 'cancelled', 'failed', 'expired'].includes(realStatus) ? 'cancelled'
          : realStatus === 'refunded' ? 'refunded'
          : realStatus;
        console.log('[DJAMO WEBHOOK] Statut vérifié via API:', realStatus, '| commande', order.id);
      } catch (verifyErr) {
        console.error('[DJAMO WEBHOOK] Impossible de vérifier le paiement via API:', verifyErr.message);
        return res.status(502).json({ error: 'Vérification paiement impossible.' });
      }
    }

    if (status === 'paid') {
      if (order.payment_status === 'paid') return res.json({ received: true, skipped: 'already_paid' });

      if (order.payment_status !== 'pending') console.warn('[DJAMO WEBHOOK] Paiement tardif sur commande', order.id, '(statut', order.payment_status + ')');
      if (!markOrderPaid(db, order.id)) return res.json({ received: true, skipped: 'not_payable' });
      await processDelivery(order.id);

    } else if (status === 'dropped' || status === 'cancelled') {
      if (!markOrderFailed(db, order.id)) return res.json({ received: true, skipped: 'not_pending' });

    } else if (status === 'refunded') {
      if (!markOrderRefunded(db, order.id)) return res.json({ received: true, skipped: 'not_paid' });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Erreur Djamo webhook:', err);
    res.status(500).json({ error: 'Erreur traitement webhook.' });
  }
});

// POST /api/payment/simulate — Staging uniquement (admin)
// Utilise POST /v1/charges/:id/pay de Djamo staging
router.post('/simulate', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { order_id, success = true } = req.body;
    const db = getDb();

    if (!order_id) return res.status(400).json({ error: 'order_id requis.' });

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });

    // Si pas de token Djamo configuré, simuler localement
    if (!DJAMO_ACCESS_TOKEN || DJAMO_ACCESS_TOKEN === 'your_djamo_access_token') {
      if (success) {
        db.prepare("UPDATE orders SET payment_status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(order.id);
        const result = await processDelivery(order.id);
        return res.json({ message: 'Paiement simulé avec succès !', delivery: result });
      } else {
        db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ?").run(order.id);
        db.prepare("UPDATE cards SET status = 'available', order_id = NULL WHERE order_id = ? AND status = 'reserved'").run(order.id);
        return res.json({ message: 'Paiement simulé comme échoué.' });
      }
    }

    const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
    let chargeId = order.payment_ref;

    // Si pas de charge Djamo valide, en créer un nouveau
    if (!chargeId || chargeId.startsWith('BABI-')) {
      const externalId = `BABI-SIM-${uuidv4().split('-')[0].toUpperCase()}-${order.id}`;
      const chargeRes = await axios.post(
        `${DJAMO_API_URL}/v1/charges`,
        {
          amount: order.total_amount,
          currency: 'XOF',
          description: `Simulation Babicard #${order.id}`,
          externalId,
          onCompletedRedirectionUrl: `${siteUrl}/dashboard`,
          onCanceledRedirectionUrl: `${siteUrl}/dashboard`
        },
        { headers: djamoHeaders() }
      );
      const charge = chargeRes.data?.data || chargeRes.data;
      chargeId = charge?.id;
      if (!chargeId) return res.status(502).json({ error: 'Impossible de créer le charge Djamo.' });
      db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(chargeId, order.id);
    }

    // Appel POST /v1/charges/:id/pay — le webhook Djamo se chargera de mettre à jour la commande
    const testPhone = success ? '2250747000000' : '2251212121205';
    const payRes = await axios.post(
      `${DJAMO_API_URL}/v1/charges/${chargeId}/pay`,
      { recipientMsisdn: testPhone },
      { headers: djamoHeaders() }
    );
    console.log('[SIMULATE] /pay réponse status:', payRes.data?.status);
    return res.json({ message: `Paiement ${success ? 'succès' : 'échec'} envoyé à Djamo (status: ${payRes.data?.status}). Le webhook va mettre à jour la commande.` });
  } catch (err) {
    console.error('Erreur simulate payment:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erreur simulation paiement.' });
  }
});

// ============ MOBILE MONEY (GeniusPay) ============
const GENIUS_API_URL = 'https://pay.genius.ci/api/v1/merchant';
const GENIUS_API_KEY = process.env.GENIUS_API_KEY;
const GENIUS_API_SECRET = process.env.GENIUS_API_SECRET;

// Normalise un numéro ivoirien au format E.164 (+225XXXXXXXXXX) — null si invalide
function normalizeCiPhone(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  const n = c.startsWith('00225') ? '+' + c.slice(2)
    : c.startsWith('+225') ? c
    : c.startsWith('225') && c.length === 13 ? '+' + c
    : '+225' + c;
  return /^\+225\d{10}$/.test(n) ? n : null;
}

function geniusHeaders() {
  return {
    'X-API-Key': GENIUS_API_KEY,
    'X-API-Secret': GENIUS_API_SECRET,
    'Content-Type': 'application/json'
  };
}

// POST /api/payment/mobilemoney/initiate
router.post('/mobilemoney/initiate', authenticateToken, async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) return res.status(400).json({ error: 'order_id requis.' });

    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order_id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });
    if (order.payment_status !== 'pending') return res.status(400).json({ error: 'Commande déjà traitée.' });

    if (!GENIUS_API_KEY || !GENIUS_API_SECRET) {
      return res.status(503).json({ error: 'Mobile Money non configuré.' });
    }

    if (order.total_amount < 200) {
      return res.status(400).json({ error: 'Le montant minimum pour Mobile Money est 200 FCFA.' });
    }

    const siteUrl = process.env.SITE_URL || 'http://localhost:3000';
    const reference = `BABI-G-${uuidv4().split('-')[0].toUpperCase()}-${order_id}`;

    // Informations client exigées par GeniusPay (conformité partenaires) : nom, email, téléphone
    const customer = db.prepare('SELECT name, email, phone FROM users WHERE id = ?').get(req.user.id) || {};
    const customerPhone = normalizeCiPhone(customer.phone) || normalizeCiPhone(order.delivery_phone);
    const customerFields = {
      customer_name: customer.name || undefined,
      customer_email: customer.email || order.delivery_email || undefined,
      customer_phone: customerPhone || undefined,
      // Doublé en metadata (champ libre accepté par l'API GeniusPay)
      metadata: {
        order_id: String(order_id),
        customer_name: customer.name || null,
        customer_email: customer.email || order.delivery_email || null,
        customer_phone: customerPhone || null
      }
    };
    if (!customerPhone) console.warn('[MOBILE MONEY] Commande', order_id, ': aucun téléphone client connu — transmis sans téléphone');

    const basePayload = {
      amount: order.total_amount,
      currency: 'XOF',
      description: `Commande Babicard #${order_id}`,
      reference,
      callback_url: `${siteUrl}/api/payment/mobilemoney/webhook`,
      success_url: `${siteUrl}/dashboard?order=${order_id}&status=success`,
      error_url: `${siteUrl}/dashboard?order=${order_id}&status=failed`
    };

    let paymentRes;
    try {
      paymentRes = await axios.post(`${GENIUS_API_URL}/payments`, { ...basePayload, ...customerFields },
        { headers: geniusHeaders(), timeout: 25000 });
    } catch (firstErr) {
      // Si l'API v1 rejette les champs client (validation), réessayer sans eux pour ne pas bloquer le paiement
      const st = firstErr.response?.status;
      if (st === 400 || st === 422) {
        console.error('[MOBILE MONEY] Champs client refusés par GeniusPay (HTTP', st, '):', JSON.stringify(firstErr.response?.data), '— nouvel essai sans');
        paymentRes = await axios.post(`${GENIUS_API_URL}/payments`, basePayload, { headers: geniusHeaders(), timeout: 25000 });
      } else {
        throw firstErr;
      }
    }

    console.log('[MOBILE MONEY] Réponse GeniusPay brute:', JSON.stringify(paymentRes.data));

    const checkout_url = paymentRes.data?.data?.checkout_url || paymentRes.data?.checkout_url
      || paymentRes.data?.data?.payment_url || paymentRes.data?.payment_url
      || paymentRes.data?.data?.url || paymentRes.data?.url;
    const payRef = paymentRes.data?.data?.reference || paymentRes.data?.reference || reference;

    if (!checkout_url) {
      console.error('[MOBILE MONEY] checkout_url introuvable dans la réponse:', JSON.stringify(paymentRes.data));
      throw new Error('checkout_url absent de la réponse GeniusPay');
    }

    db.prepare('UPDATE orders SET payment_ref = ?, payment_method = ? WHERE id = ?').run(payRef, 'mobile_money', order_id);

    console.log('[MOBILE MONEY] Paiement initié — ref:', payRef, '| checkout_url: OK');
    res.json({ payment_url: checkout_url, payment_ref: payRef, order_id });
  } catch (err) {
    const httpStatus = err.response?.status;
    const errData = err.response?.data || err.message;
    console.error('[MOBILE MONEY] Erreur initiate (HTTP', httpStatus || 'network', '):', JSON.stringify(errData));

    // Erreur 4xx = problème de config/données → annuler la commande et libérer les cartes
    // Erreur 5xx / réseau / timeout = panne temporaire → garder la commande pending pour retry
    const isClientError = httpStatus && httpStatus >= 400 && httpStatus < 500;
    if (isClientError) {
      const db = getDb();
      db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ?").run(req.body.order_id);
      db.prepare("UPDATE cards SET status = 'available', order_id = NULL WHERE order_id = ? AND status = 'reserved'").run(req.body.order_id);
      return res.status(502).json({ error: 'Erreur initialisation Mobile Money. Réessayez.' });
    }
    // Panne temporaire du prestataire — garder la commande en pending, le client peut réessayer
    res.status(503).json({ error: 'Le service Mobile Money est temporairement indisponible. Réessayez dans quelques minutes.', retryable: true });
  }
});

// POST /api/payment/mobilemoney/webhook
router.post('/mobilemoney/webhook', async (req, res) => {
  console.log('[MOBILE MONEY WEBHOOK] Reçu');
  try {
    // req.rawBody capturé avant express.json() dans server.js
    const rawStr = req.rawBody || (Buffer.isBuffer(req.body) ? req.body.toString('utf8')
                 : typeof req.body === 'string' ? req.body
                 : JSON.stringify(req.body));

    // Vérification signature HMAC-SHA256
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const webhookSecret = process.env.GENIUS_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[MOBILE MONEY WEBHOOK] GENIUS_WEBHOOK_SECRET manquant — webhook rejeté');
      return res.status(401).json({ error: 'Webhook non configuré.' });
    }
    if (!signature) {
      console.warn('[MOBILE MONEY WEBHOOK] Signature manquante — rejeté');
      return res.status(401).json({ error: 'Signature manquante.' });
    }
    const sigToCheck = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const secretFull = webhookSecret;
    const secretStripped = webhookSecret.startsWith('whsec_') ? webhookSecret.slice(6) : webhookSecret;
    const payloadWithTs = timestamp ? `${timestamp}.${rawStr}` : rawStr;

    const timingSafeCompare = (hexA, hexB) => {
      try {
        const a = Buffer.from(hexA, 'hex');
        const b = Buffer.from(hexB, 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      } catch (_) { return false; }
    };

    const candidates = [
      () => crypto.createHmac('sha256', secretStripped).update(payloadWithTs).digest('hex'),
      () => crypto.createHmac('sha256', secretFull).update(payloadWithTs).digest('hex'),
      () => crypto.createHmac('sha256', secretStripped).update(rawStr).digest('hex'),
    ];
    let sigValid = false;
    for (const compute of candidates) {
      try { if (timingSafeCompare(compute(), sigToCheck)) { sigValid = true; break; } } catch (_) {}
    }
    if (!sigValid) {
      console.warn('[MOBILE MONEY WEBHOOK] Signature invalide — rejeté');
      return res.status(401).json({ error: 'Signature invalide.' });
    }
    console.log('[MOBILE MONEY WEBHOOK] Signature valide');

    let body;
    try { body = JSON.parse(rawStr); } catch { return res.status(400).json({ error: 'Body invalide.' }); }

    const event = req.headers['x-webhook-event'] || body.event;
    const data = body.data || body;
    const reference = data.reference;

    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE payment_ref = ?').get(reference);
    if (!order) {
      // Chercher par externalId format BABI-G-XXXX-{orderId}
      const match = reference?.match(/BABI-G-[A-Z0-9]+-(\d+)$/);
      if (match) {
        const foundOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(parseInt(match[1]));
        if (foundOrder) {
          db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(reference, foundOrder.id);
        }
      }
    }

    const targetOrder = order || (() => {
      const match = reference?.match(/BABI-G-[A-Z0-9]+-(\d+)$/);
      return match ? db.prepare('SELECT * FROM orders WHERE id = ?').get(parseInt(match[1])) : null;
    })();

    if (!targetOrder) {
      console.warn('[MOBILE MONEY WEBHOOK] Commande non trouvée pour ref:', reference);
      return res.json({ received: true });
    }

    if (event === 'payment.success') {
      if (targetOrder.payment_status === 'paid') return res.json({ received: true, skipped: 'already_paid' });
      if (targetOrder.payment_status !== 'pending') console.warn('[MOBILE MONEY WEBHOOK] Paiement tardif sur commande', targetOrder.id, '(statut', targetOrder.payment_status + ')');
      if (!markOrderPaid(db, targetOrder.id)) return res.json({ received: true, skipped: 'not_payable' });
      await processDelivery(targetOrder.id);
      console.log('[MOBILE MONEY WEBHOOK] Commande', targetOrder.id, 'payée et livrée.');

    } else if (['payment.failed', 'payment.cancelled', 'payment.expired'].includes(event)) {
      if (!markOrderFailed(db, targetOrder.id)) return res.json({ received: true, skipped: 'not_pending' });

    } else if (event === 'payment.refunded') {
      if (!markOrderRefunded(db, targetOrder.id)) return res.json({ received: true, skipped: 'not_paid' });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[MOBILE MONEY WEBHOOK] Erreur:', err);
    res.status(500).json({ error: 'Erreur traitement webhook.' });
  }
});

module.exports = router;
