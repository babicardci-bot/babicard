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

    // Validate all items and calculate total
    let total_amount = 0;
    const validatedItems = [];

    for (const item of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(item.product_id);
      if (!product) {
        return res.status(400).json({ error: `Produit ID ${item.product_id} non trouvé.` });
      }

      const quantity = parseInt(item.quantity) || 1;
      const availableCards = db.prepare(
        'SELECT COUNT(*) as count FROM cards WHERE product_id = ? AND status = ?'
      ).get(product.id, 'available');

      if (availableCards.count < quantity) {
        return res.status(400).json({
          error: `Stock insuffisant pour "${product.name}". Disponible: ${availableCards.count}, demandé: ${quantity}.`
        });
      }

      total_amount += product.price * quantity;
      validatedItems.push({ product, quantity });
    }

    // Create order in transaction
    const createOrder = db.transaction(() => {
      const orderResult = db.prepare(`
        INSERT INTO orders (user_id, total_amount, payment_method, payment_status, delivery_status, delivery_email, delivery_phone)
        VALUES (?, ?, ?, 'pending', 'pending', ?, ?)
      `).run(req.user.id, total_amount, payment_method, delivery_email || '', delivery_phone || '');

      const orderId = orderResult.lastInsertRowid;

      for (const { product, quantity } of validatedItems) {
        for (let i = 0; i < quantity; i++) {
          db.prepare(`
            INSERT INTO order_items (order_id, product_id, quantity, unit_price)
            VALUES (?, ?, 1, ?)
          `).run(orderId, product.id, product.price);
        }
      }

      return orderId;
    });

    const orderId = createOrder();

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
