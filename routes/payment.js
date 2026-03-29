const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/db');
const { authenticateToken } = require('../middleware/auth');
const { processDelivery } = require('../services/delivery');

// ===== WAVE CI =====

// POST /api/payment/wave/initiate (protected)
router.post('/wave/initiate', authenticateToken, async (req, res) => {
  try {
    const { order_id } = req.body;
    const db = getDb();

    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order_id, req.user.id);
    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée.' });
    }

    if (order.payment_status !== 'pending') {
      return res.status(400).json({ error: 'Cette commande a déjà été traitée.' });
    }

    const paymentRef = `WAVE-${uuidv4().split('-')[0].toUpperCase()}-${order_id}`;
    const callbackUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/api/payment/wave/callback`;
    const successUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/dashboard?order=${order_id}&status=success`;
    const errorUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/dashboard?order=${order_id}&status=failed`;

    // Update order with payment ref
    db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(paymentRef, order_id);

    // Try to call Wave API if key is configured
    if (process.env.WAVE_API_KEY && process.env.WAVE_API_KEY !== 'your_wave_api_key') {
      try {
        const waveResponse = await axios.post(
          'https://api.wave.com/v1/checkout/sessions',
          {
            amount: order.total_amount,
            currency: 'XOF',
            error_url: errorUrl,
            success_url: successUrl,
            client_reference: paymentRef
          },
          {
            headers: {
              'Authorization': `Bearer ${process.env.WAVE_API_KEY}`,
              'Content-Type': 'application/json'
            }
          }
        );

        return res.json({
          payment_url: waveResponse.data.wave_launch_url || waveResponse.data.checkout_url,
          payment_ref: paymentRef,
          order_id
        });
      } catch (waveErr) {
        console.error('Erreur Wave API:', waveErr.response?.data || waveErr.message);
      }
    }

    // Demo mode: simulate payment flow
    const demoPaymentUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/payment-demo.html?ref=${paymentRef}&order=${order_id}&method=wave&amount=${order.total_amount}`;

    res.json({
      payment_url: demoPaymentUrl,
      payment_ref: paymentRef,
      order_id,
      demo_mode: true,
      message: 'Mode démonstration: aucune clé Wave configurée.'
    });
  } catch (err) {
    console.error('Erreur Wave initiate:', err);
    res.status(500).json({ error: 'Erreur lors de l\'initialisation du paiement Wave.' });
  }
});

// POST /api/payment/wave/callback (webhook)
router.post('/wave/callback', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { client_reference, status, payment_id } = body;

    if (!client_reference) {
      return res.status(400).json({ error: 'Référence manquante.' });
    }
    // Validate payment_ref format (basic protection)
    if (!client_reference || typeof client_reference !== 'string' || client_reference.length > 100) {
      return res.status(400).json({ error: 'Invalid reference.' });
    }

    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE payment_ref = ?').get(client_reference);

    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée.' });
    }

    if (status === 'succeeded' || status === 'paid' || status === 'complete') {
      // Mark as paid
      db.prepare(`
        UPDATE orders SET payment_status = 'paid', paid_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(order.id);

      // Process delivery
      await processDelivery(order.id);
    } else if (status === 'failed' || status === 'cancelled') {
      db.prepare(`UPDATE orders SET payment_status = 'failed' WHERE id = ?`).run(order.id);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Erreur Wave callback:', err);
    res.status(500).json({ error: 'Erreur traitement callback.' });
  }
});

// ===== ORANGE MONEY CI =====

// POST /api/payment/orange/initiate (protected)
router.post('/orange/initiate', authenticateToken, async (req, res) => {
  try {
    const { order_id, phone } = req.body;
    const db = getDb();

    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(order_id, req.user.id);
    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée.' });
    }

    if (order.payment_status !== 'pending') {
      return res.status(400).json({ error: 'Cette commande a déjà été traitée.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const paymentPhone = phone || user.phone;

    if (!paymentPhone) {
      return res.status(400).json({ error: 'Numéro de téléphone requis pour Orange Money.' });
    }

    const paymentRef = `OM-${uuidv4().split('-')[0].toUpperCase()}-${order_id}`;
    db.prepare('UPDATE orders SET payment_ref = ? WHERE id = ?').run(paymentRef, order_id);

    // Try Orange Money API if configured
    if (process.env.ORANGE_CLIENT_ID && process.env.ORANGE_CLIENT_ID !== 'your_orange_client_id') {
      try {
        // Step 1: Get access token
        const tokenResponse = await axios.post(
          'https://api.orange.com/oauth/v3/token',
          'grant_type=client_credentials',
          {
            headers: {
              'Authorization': `Basic ${Buffer.from(`${process.env.ORANGE_CLIENT_ID}:${process.env.ORANGE_CLIENT_SECRET}`).toString('base64')}`,
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );

        const accessToken = tokenResponse.data.access_token;

        // Step 2: Initiate payment
        const omResponse = await axios.post(
          'https://api.orange.com/orange-money-webpay/ci/v1/webpayment',
          {
            merchant_key: process.env.ORANGE_MERCHANT_KEY,
            currency: 'OUV',
            order_id: paymentRef,
            amount: order.total_amount,
            return_url: `${process.env.SITE_URL}/api/payment/orange/callback`,
            cancel_url: `${process.env.SITE_URL}/dashboard?order=${order_id}&status=failed`,
            notif_url: `${process.env.SITE_URL}/api/payment/orange/callback`,
            lang: 'fr',
            reference: paymentRef
          },
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        return res.json({
          payment_url: omResponse.data.payment_url,
          payment_ref: paymentRef,
          order_id
        });
      } catch (omErr) {
        console.error('Erreur Orange Money API:', omErr.response?.data || omErr.message);
      }
    }

    // Demo mode
    const demoPaymentUrl = `${process.env.SITE_URL || 'http://localhost:3000'}/payment-demo.html?ref=${paymentRef}&order=${order_id}&method=orange&amount=${order.total_amount}&phone=${paymentPhone}`;

    res.json({
      payment_url: demoPaymentUrl,
      payment_ref: paymentRef,
      order_id,
      demo_mode: true,
      message: 'Mode démonstration: aucune clé Orange Money configurée.'
    });
  } catch (err) {
    console.error('Erreur Orange initiate:', err);
    res.status(500).json({ error: 'Erreur lors de l\'initialisation du paiement Orange Money.' });
  }
});

// POST /api/payment/orange/callback (webhook)
router.post('/orange/callback', async (req, res) => {
  try {
    const { status, order_id: paymentRef, txnid } = req.body;
    // Validate payment_ref format (basic protection)
    if (!paymentRef || typeof paymentRef !== 'string' || paymentRef.length > 100) {
      return res.status(400).json({ error: 'Invalid reference.' });
    }
    const db = getDb();

    const order = db.prepare('SELECT * FROM orders WHERE payment_ref = ?').get(paymentRef);
    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée.' });
    }

    if (status === '00' || status === 'SUCCESS' || status === 'paid') {
      db.prepare(`
        UPDATE orders SET payment_status = 'paid', paid_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(order.id);

      await processDelivery(order.id);
    } else {
      db.prepare(`UPDATE orders SET payment_status = 'failed' WHERE id = ?`).run(order.id);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Erreur Orange callback:', err);
    res.status(500).json({ error: 'Erreur traitement callback.' });
  }
});

// POST /api/payment/simulate - Demo payment simulation (for testing)
router.post('/simulate', authenticateToken, async (req, res) => {
  // TODO: re-enable when real payment API is integrated
  // if (process.env.NODE_ENV === 'production') {
  //   return res.status(404).json({ error: 'Not found.' });
  // }
  try {
    const { payment_ref, success = true } = req.body;
    const db = getDb();

    const order = db.prepare('SELECT * FROM orders WHERE payment_ref = ?').get(payment_ref);
    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée.' });
    }

    if (order.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Accès refusé.' });
    }

    if (success) {
      db.prepare(`
        UPDATE orders SET payment_status = 'paid', paid_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(order.id);

      const result = await processDelivery(order.id);
      res.json({ message: 'Paiement simulé avec succès!', delivery: result });
    } else {
      db.prepare(`UPDATE orders SET payment_status = 'failed' WHERE id = ?`).run(order.id);
      res.json({ message: 'Paiement simulé comme échoué.' });
    }
  } catch (err) {
    console.error('Erreur simulate payment:', err);
    res.status(500).json({ error: 'Erreur simulation paiement.' });
  }
});

module.exports = router;
