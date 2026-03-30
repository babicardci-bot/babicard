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

    if (!payment_method || !['wave', 'orange_money'].includes(payment_method)) {
      return res.status(400).json({ error: 'Méthode de paiement invalide. Choisissez wave ou orange_money.' });
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

module.exports = router;
