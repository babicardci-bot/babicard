const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

// POST /api/orders - Create order (protected)
router.post('/', authenticateToken, (req, res) => {
  try {
    const { items, payment_method, delivery_email, delivery_phone } = req.body;
    const db = getDb();

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Le panier est vide.' });
    }

    if (items.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 articles par commande.' });
    }

    if (!payment_method || !['djamo', 'mobile_money'].includes(payment_method)) {
      return res.status(400).json({ error: 'Méthode de paiement invalide.' });
    }

    // Pre-validate products exist (outside transaction — read-only, non-critical)
    const requestedItems = [];
    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(item.product_id);
      if (!product) {
        return res.status(400).json({ error: `Produit ID ${item.product_id} non trouvé.` });
      }
      requestedItems.push({ product, quantity: parseInt(item.quantity) || 1 });
    }

    // Auto-cancel any existing pending orders before creating a new one
    const existingPending = db.prepare(
      "SELECT id FROM orders WHERE user_id = ? AND payment_status = 'pending'"
    ).all(req.user.id);
    for (const old of existingPending) {
      db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ?").run(old.id);
      db.prepare("UPDATE cards SET status = 'available', order_id = NULL WHERE order_id = ? AND status = 'reserved'").run(old.id);
    }

    // Reserve cards + create order atomically to prevent race conditions
    let orderId;
    const createOrder = db.transaction(() => {
      // Release expired reservations (> 30 minutes) to free stuck cards
      db.prepare(`
        UPDATE cards SET status = 'available', order_id = NULL
        WHERE status = 'reserved' AND order_id IN (
          SELECT id FROM orders WHERE payment_status = 'pending'
            AND datetime(created_at) < datetime('now', '-30 minutes')
        )
      `).run();

      let total_amount = 0;
      const itemsToInsert = [];

      for (const { product, quantity } of requestedItems) {
        for (let i = 0; i < quantity; i++) {
          // Find the best-priced available card for this product
          const cardRow = db.prepare(`
            SELECT c.id,
              COALESCE(
                (SELECT spp.promo_price FROM seller_product_promos spp
                 WHERE spp.seller_id = c.seller_id AND spp.product_id = c.product_id AND spp.status = 'approved'
                 LIMIT 1),
                NULLIF(p.promo_price, 0),
                p.price
              ) as effective_price
            FROM cards c
            JOIN products p ON c.product_id = p.id
            WHERE c.product_id = ? AND c.status = 'available'
            ORDER BY effective_price ASC, c.added_at ASC
            LIMIT 1
          `).get(product.id);

          if (!cardRow) {
            throw Object.assign(new Error(`Stock insuffisant pour "${product.name}".`), { statusCode: 400 });
          }

          // Atomically reserve the card — prevents race conditions
          const reserved = db.prepare(
            "UPDATE cards SET status = 'reserved' WHERE id = ? AND status = 'available'"
          ).run(cardRow.id);

          if (reserved.changes === 0) {
            throw Object.assign(new Error(`Stock insuffisant pour "${product.name}". Réessayez.`), { statusCode: 400 });
          }

          total_amount += cardRow.effective_price;
          itemsToInsert.push({ productId: product.id, cardId: cardRow.id, effectivePrice: cardRow.effective_price });
        }
      }

      // Safety check: max order amount 5,000,000 FCFA
      if (total_amount > 5_000_000) {
        throw Object.assign(new Error('Commande trop importante. Montant maximum: 5 000 000 FCFA.'), { statusCode: 400 });
      }

      const orderResult = db.prepare(`
        INSERT INTO orders (user_id, total_amount, payment_method, payment_status, delivery_status, delivery_email, delivery_phone)
        VALUES (?, ?, ?, 'pending', 'pending', ?, ?)
      `).run(req.user.id, total_amount, payment_method, delivery_email || '', delivery_phone || '');

      const newOrderId = orderResult.lastInsertRowid;

      for (const { productId, cardId, effectivePrice } of itemsToInsert) {
        db.prepare('UPDATE cards SET order_id = ? WHERE id = ?').run(newOrderId, cardId);
        db.prepare(`
          INSERT INTO order_items (order_id, product_id, card_id, quantity, unit_price)
          VALUES (?, ?, ?, 1, ?)
        `).run(newOrderId, productId, cardId, effectivePrice);
      }

      return newOrderId;
    });

    try {
      orderId = createOrder();
    } catch (txErr) {
      if (txErr.statusCode === 400) return res.status(400).json({ error: txErr.message });
      throw txErr;
    }

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const orderItems = db.prepare(`
      SELECT oi.*, p.name as product_name, p.platform
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ?
    `).all(orderId);

    res.status(201).json({
      message: 'Commande créée avec succès.',
      order,
      items: orderItems
    });
  } catch (err) {
    console.error('Erreur create order:', err);
    res.status(500).json({ error: 'Erreur lors de la création de la commande.' });
  }
});

// DELETE /api/orders/:id/cancel — Cancel a pending order and release reserved cards
router.delete('/:id/cancel', authenticateToken, (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });
    if (order.payment_status !== 'pending') {
      return res.status(400).json({ error: 'Cette commande ne peut pas être annulée.' });
    }
    db.prepare("UPDATE cards SET status = 'available', order_id = NULL WHERE order_id = ? AND status = 'reserved'").run(order.id);
    db.prepare("UPDATE orders SET payment_status = 'cancelled' WHERE id = ?").run(order.id);
    res.json({ message: 'Commande annulée.' });
  } catch (err) {
    console.error('Erreur cancel order:', err);
    res.status(500).json({ error: 'Erreur annulation.' });
  }
});

// GET /api/orders/my - User's orders (protected)
router.get('/my', authenticateToken, (req, res) => {
  try {
    const db = getDb();
    const orders = db.prepare(`
      SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC
    `).all(req.user.id);

    if (orders.length === 0) return res.json({ orders: [] });

    // Single query for all items across all orders — no N+1
    const orderIds = orders.map(o => o.id);
    const placeholders = orderIds.map(() => '?').join(',');
    const allItems = db.prepare(`
      SELECT oi.*, p.name as product_name, p.platform, p.denomination,
        c.code as card_code, c.pin as card_pin, c.serial as card_serial
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      LEFT JOIN cards c ON oi.card_id = c.id
      WHERE oi.order_id IN (${placeholders})
    `).all(...orderIds);

    // Group items by order_id
    const itemsByOrder = {};
    for (const item of allItems) {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push(item);
    }

    const { decrypt } = require('../services/encryption');

    const enriched = orders.map(order => {
      const items = (itemsByOrder[order.id] || []).map(item => ({
        ...item,
        card_code: order.payment_status === 'paid' ? decrypt(item.card_code) : null,
        card_pin: order.payment_status === 'paid' ? decrypt(item.card_pin) : null,
        card_serial: order.payment_status === 'paid' ? decrypt(item.card_serial) : null
      }));
      return { ...order, items, item_count: items.length };
    });

    res.json({ orders: enriched });
  } catch (err) {
    console.error('Erreur my orders:', err);
    res.status(500).json({ error: 'Erreur lors du chargement des commandes.' });
  }
});

// GET /api/orders/:id - Order detail (protected)
router.get('/:id', authenticateToken, (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare(`
      SELECT * FROM orders WHERE id = ? AND user_id = ?
    `).get(req.params.id, req.user.id);

    if (!order) {
      return res.status(404).json({ error: 'Commande non trouvée.' });
    }

    const items = db.prepare(`
      SELECT oi.*, p.name as product_name, p.platform, p.denomination, p.description,
        c.code as card_code, c.pin as card_pin, c.serial as card_serial
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      LEFT JOIN cards c ON oi.card_id = c.id
      WHERE oi.order_id = ?
    `).all(order.id);

    const safeItems = items.map(item => ({
      ...item,
      card_code: order.payment_status === 'paid' ? item.card_code : null,
      card_pin: order.payment_status === 'paid' ? item.card_pin : null,
      card_serial: order.payment_status === 'paid' ? item.card_serial : null
    }));

    res.json({ order: { ...order, items: safeItems } });
  } catch (err) {
    console.error('Erreur order detail:', err);
    res.status(500).json({ error: 'Erreur lors du chargement de la commande.' });
  }
});

// POST /api/orders/:id/refund — Request a refund
router.post('/:id/refund', authenticateToken, (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({ error: 'Veuillez indiquer la raison du remboursement (min 10 caractères).' });
    }

    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });
    if (order.payment_status !== 'paid') return res.status(400).json({ error: 'Seules les commandes payées peuvent être remboursées.' });
    if (order.delivery_status === 'refunded') return res.status(400).json({ error: 'Cette commande a déjà été remboursée.' });
    if (order.delivery_status === 'delivered') return res.status(400).json({ error: 'Remboursement impossible : les codes ont déjà été livrés et sont considérés comme utilisés.' });

    // Max 48h after payment
    const paidAt = new Date(order.paid_at || order.created_at);
    const hoursElapsed = (Date.now() - paidAt.getTime()) / (1000 * 60 * 60);
    if (hoursElapsed > 48) {
      return res.status(400).json({ error: 'Le délai de remboursement est de 48h après le paiement.' });
    }

    // Check no existing request
    const existing = db.prepare('SELECT id, status FROM refund_requests WHERE order_id = ?').get(order.id);
    if (existing) {
      return res.status(400).json({ error: `Demande de remboursement déjà soumise (statut: ${existing.status}).` });
    }

    db.prepare('INSERT INTO refund_requests (order_id, user_id, reason) VALUES (?, ?, ?)').run(order.id, req.user.id, reason.trim());
    res.status(201).json({ message: 'Demande de remboursement soumise. L\'équipe vous contactera sous 24h.' });
  } catch (err) {
    console.error('Erreur refund request:', err);
    res.status(500).json({ error: 'Erreur lors de la demande de remboursement.' });
  }
});

// POST /api/orders/:id/resend-codes — Renvoyer les codes par email
router.post('/:id/resend-codes', authenticateToken, async (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });
    if (order.payment_status !== 'paid') return res.status(400).json({ error: 'Cette commande n\'a pas encore été payée.' });

    // Anti-spam : max 3 renvois par commande
    const resendCount = order.resend_count || 0;
    if (resendCount >= 3) return res.status(429).json({ error: 'Limite de renvoi atteinte (3 max). Contactez le support.' });

    // Récupérer les codes
    const cards = db.prepare(`
      SELECT c.code, c.pin, p.name as product_name
      FROM order_items oi
      JOIN cards c ON oi.card_id = c.id
      JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = ? AND c.code IS NOT NULL
    `).all(order.id);

    if (cards.length === 0) return res.status(400).json({ error: 'Aucun code disponible pour cette commande.' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const email = user?.email;
    if (!email) return res.status(400).json({ error: 'Email introuvable.' });

    // Construire le corps de l'email
    const codesHtml = cards.map(c =>
      `<tr><td style="padding:8px;border-bottom:1px solid #333"><b>${c.product_name}</b></td>
       <td style="padding:8px;border-bottom:1px solid #333;font-family:monospace;color:#10B981">${c.code}</td>
       ${c.pin ? `<td style="padding:8px;border-bottom:1px solid #333">PIN: ${c.pin}</td>` : '<td></td>'}</tr>`
    ).join('');

    // Utiliser nodemailer si configuré, sinon logger
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const mailOptions = {
      from: `"Babicard" <${process.env.SMTP_USER || 'noreply@babicard.ci'}>`,
      to: email,
      subject: `🎮 Vos codes — Commande #${order.id}`,
      html: `
        <div style="background:#0A0A0F;color:#fff;padding:32px;font-family:sans-serif;max-width:600px;margin:0 auto">
          <h1 style="color:#6C63FF;margin-bottom:8px">Babicard</h1>
          <p style="color:#aaa">Voici vos codes pour la commande <b>#${order.id}</b></p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr style="background:#1a1a2e"><th style="padding:8px;text-align:left">Produit</th><th style="padding:8px;text-align:left">Code</th><th style="padding:8px;text-align:left">PIN</th></tr>
            ${codesHtml}
          </table>
          <p style="color:#aaa;font-size:12px">Ne partagez pas ces codes. Toute utilisation est sous votre responsabilité.</p>
          <p style="color:#555;font-size:11px">Babicard.ci — Votre marketplace de cartes cadeaux</p>
        </div>
      `,
    };

    try {
      await transporter.sendMail(mailOptions);
    } catch (mailErr) {
      console.error('[RESEND CODES] Erreur email:', mailErr.message);
      // Ne pas bloquer si l'email échoue — logger et continuer
    }

    // Incrémenter le compteur de renvois
    db.prepare('UPDATE orders SET resend_count = COALESCE(resend_count, 0) + 1 WHERE id = ?').run(order.id);

    console.log(`[RESEND CODES] Commande #${order.id} — ${cards.length} code(s) renvoyé(s) à ${email}`);
    res.json({ message: `Codes renvoyés à ${email}`, count: cards.length });
  } catch (err) {
    console.error('Erreur resend-codes:', err);
    res.status(500).json({ error: 'Erreur lors du renvoi des codes.' });
  }
});

// GET /api/orders/:id/refund — Get refund status for an order
router.get('/:id/refund', authenticateToken, (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare('SELECT id FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });

    const refund = db.prepare('SELECT * FROM refund_requests WHERE order_id = ?').get(order.id);
    res.json({ refund: refund || null });
  } catch (err) {
    res.status(500).json({ error: 'Erreur.' });
  }
});

module.exports = router;
