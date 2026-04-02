const express = require('express');
const router = express.Router();
const axios = require('axios');
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
    const successUrl = `${siteUrl}/dashboard?order=${order_id}&status=success`;
    const cancelUrl  = `${siteUrl}/dashboard?order=${order_id}&status=failed`;

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

    if (!DJAMO_ACCESS_TOKEN || DJAMO_ACCESS_TOKEN === 'your_djamo_access_token') {
      return res.json({ chargeId, status: order.payment_status, order_id: order.id });
    }

    const chargeRes = await axios.get(`${DJAMO_API_URL}/v1/charges/${chargeId}`, { headers: djamoHeaders() });
    const charge = chargeRes.data?.data || chargeRes.data;
    const status = charge?.status;

    res.json({ chargeId, status, order_id: order.id });
  } catch (err) {
    console.error('Erreur Djamo status:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erreur vérification statut.' });
  }
});

// POST /api/payment/djamo/webhook — Djamo charge events
router.post('/djamo/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('[WEBHOOK] Reçu — headers:', JSON.stringify(req.headers));
  try {
    const rawBody = req.body;
    console.log('[WEBHOOK] Body brut:',JSON.stringify(rawBody));
    const rawStr = JSON.stringify(rawBody);
    let body;
    try { body = JSON.parse(rawStr); } catch { return res.status(400).json({ error: 'Body JSON invalide.' }); }

    // Verify HMAC signature if secret is configured
    if (DJAMO_WEBHOOK_SECRET) {
      const signature = req.headers['x-djamo-hmac-sha256'];
      if (!signature) return res.status(401).json({ error: 'Signature manquante.' });

      const expected = crypto
        .createHmac('sha256', DJAMO_WEBHOOK_SECRET)
        .update(rawStr)
        .digest('hex');

      if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
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

    const { id: chargeId, status } = body.data || {};
    if (!chargeId) return res.status(400).json({ error: 'chargeId manquant.' });

    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE payment_ref = ?').get(chargeId);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });

    if (status === 'paid') {
      if (order.payment_status === 'paid') return res.json({ received: true, skipped: 'already_paid' });
      db.prepare("UPDATE orders SET payment_status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").run(order.id);
      await processDelivery(order.id);

    } else if (status === 'dropped' || status === 'cancelled') {
      if (order.payment_status !== 'pending') return res.json({ received: true, skipped: 'not_pending' });
      db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ?").run(order.id);
      db.prepare("UPDATE cards SET status = 'available', order_id = NULL WHERE order_id = ? AND status = 'reserved'").run(order.id);

    } else if (status === 'refunded') {
      db.prepare("UPDATE orders SET payment_status = 'refunded', delivery_status = 'refunded' WHERE id = ?").run(order.id);
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

module.exports = router;
