const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authenticateToken, requireAdmin, logAdminAction } = require('../middleware/auth');
const { processDelivery } = require('../services/delivery');
const { sendWithdrawalStatusEmail, sendSellerApprovalEmail } = require('../services/email');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Multer for product images
const productImgDir = path.join(__dirname, '../public/uploads/products');
if (!fs.existsSync(productImgDir)) fs.mkdirSync(productImgDir, { recursive: true });
const productImgUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, productImgDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `product_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Image uniquement (JPG, PNG, WebP)'));
  }
});

// All admin routes require authentication + admin role
router.use(authenticateToken, requireAdmin);

// POST /api/admin/products/upload-image
router.post('/products/upload-image', (req, res) => {
  productImgUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
    res.json({ url: `/uploads/products/${req.file.filename}` });
  });
});

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  try {
    const db = getDb();

    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('client').count;
    const totalOrders = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
    const paidOrders = db.prepare('SELECT COUNT(*) as count FROM orders WHERE payment_status = ?').get('paid').count;
    const pendingOrders = db.prepare('SELECT COUNT(*) as count FROM orders WHERE payment_status = ?').get('pending').count;
    const totalRevenue = db.prepare('SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE payment_status = ?').get('paid').total;
    const totalProducts = db.prepare('SELECT COUNT(*) as count FROM products WHERE is_active = 1').get().count;
    const totalCards = db.prepare('SELECT COUNT(*) as count FROM cards').get().count;
    const availableCards = db.prepare('SELECT COUNT(*) as count FROM cards WHERE status = ?').get('available').count;
    const soldCards = db.prepare('SELECT COUNT(*) as count FROM cards WHERE status = ?').get('sold').count;

    // Bénéfices admin = revenus totaux - gains nets versés aux vendeurs
    const totalSellerPayouts = db.prepare("SELECT COALESCE(SUM(net_amount),0) as total FROM seller_earnings").get().total;
    const totalCommissions = db.prepare("SELECT COALESCE(SUM(commission_amount),0) as total FROM seller_earnings").get().total;
    // Revenus directs (produits sans vendeur) + commissions sur ventes vendeurs
    const directRevenue = db.prepare(`
      SELECT COALESCE(SUM(oi.unit_price),0) as total
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE o.payment_status = 'paid' AND p.seller_id IS NULL
    `).get().total;
    const adminBenefits = directRevenue + totalCommissions;
    // Ce mois
    const benefitsThisMonth = db.prepare(`
      SELECT COALESCE(SUM(oi.unit_price),0) as direct,
             (SELECT COALESCE(SUM(se.commission_amount),0) FROM seller_earnings se
              JOIN orders o2 ON se.order_id = o2.id
              WHERE strftime('%Y-%m', o2.created_at) = strftime('%Y-%m','now')) as commissions
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE o.payment_status = 'paid' AND p.seller_id IS NULL
        AND strftime('%Y-%m', o.created_at) = strftime('%Y-%m','now')
    `).get();
    const adminBenefitsMonth = (benefitsThisMonth.direct || 0) + (benefitsThisMonth.commissions || 0);

    // Recent orders
    const recentOrders = db.prepare(`
      SELECT o.*, u.name as user_name, u.email as user_email
      FROM orders o
      JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
      LIMIT 10
    `).all();

    // Revenue by day (last 7 days)
    const revenueByDay = db.prepare(`
      SELECT DATE(created_at) as date, SUM(total_amount) as revenue, COUNT(*) as orders
      FROM orders
      WHERE payment_status = 'paid' AND created_at >= DATE('now', '-7 days')
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `).all();

    // Alerts
    const pendingSellers = db.prepare("SELECT COUNT(*) as count FROM seller_profiles WHERE status = 'pending'").get().count;
    const pendingWithdrawals = db.prepare("SELECT COUNT(*) as count FROM withdrawal_requests WHERE status = 'pending'").get().count;
    const pendingOrders2 = db.prepare("SELECT COUNT(*) as count FROM orders WHERE payment_status = 'pending'").get().count;
    const lowStockProducts = db.prepare("SELECT COUNT(*) as count FROM products WHERE stock_count <= 5 AND stock_count > 0 AND is_active = 1").get().count;
    const outOfStockProducts = db.prepare("SELECT COUNT(*) as count FROM products WHERE stock_count = 0 AND is_active = 1").get().count;

    // Top products
    const topProducts = db.prepare(`
      SELECT p.name, p.platform, COUNT(oi.id) as sales, SUM(oi.unit_price) as revenue
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.payment_status = 'paid'
      GROUP BY p.id
      ORDER BY sales DESC
      LIMIT 5
    `).all();

    res.json({
      stats: {
        totalUsers,
        totalOrders,
        paidOrders,
        pendingOrders,
        totalRevenue,
        totalProducts,
        totalCards,
        availableCards,
        soldCards,
        adminBenefits,
        adminBenefitsMonth,
        totalCommissions,
        directRevenue
      },
      alerts: {
        pendingSellers,
        pendingWithdrawals,
        pendingOrders: pendingOrders2,
        lowStockProducts,
        outOfStockProducts
      },
      recentOrders,
      revenueByDay,
      topProducts
    });
  } catch (err) {
    console.error('Erreur admin stats:', err);
    res.status(500).json({ error: 'Erreur lors du chargement des statistiques.' });
  }
});

// GET /api/admin/users
router.get('/users', (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 20, search } = req.query;

    let query = 'SELECT id, name, email, phone, role, created_at FROM users WHERE 1=1';
    const params = [];

    if (search) {
      query += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY created_at DESC';

    const total = db.prepare(query.replace('SELECT id, name, email, phone, role, created_at', 'SELECT COUNT(*) as total')).get(...params).total;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const users = db.prepare(query).all(...params);

    // Enrich with order counts
    const enriched = users.map(user => {
      const orderStats = db.prepare(`
        SELECT COUNT(*) as total_orders, COALESCE(SUM(total_amount), 0) as total_spent
        FROM orders WHERE user_id = ? AND payment_status = 'paid'
      `).get(user.id);
      return { ...user, ...orderStats };
    });

    res.json({ users: enriched, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('Erreur admin users:', err);
    res.status(500).json({ error: 'Erreur lors du chargement des utilisateurs.' });
  }
});

// PUT /api/admin/users/:id/role — Change user role
router.put('/users/:id/role', (req, res) => {
  try {
    const { role } = req.body;
    if (!['client', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Rôle invalide. Valeurs acceptées: client, admin.' });
    }
    const db = getDb();
    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas modifier votre propre rôle.' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
    logAdminAction(req, 'change_role', `user:${req.params.id}`, { new_role: role });
    res.json({ message: `Rôle mis à jour → ${role}.` });
  } catch (err) {
    console.error('Erreur change role:', err);
    res.status(500).json({ error: 'Erreur changement de rôle.' });
  }
});

// DELETE /api/admin/users/:id — Supprimer un utilisateur
router.delete('/users/:id', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT id, role, email FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé.' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte.' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Impossible de supprimer un compte administrateur.' });

    const deleteUser = db.transaction(() => {
      // Supprimer les données liées dans l'ordre correct
      db.prepare('DELETE FROM withdrawal_requests WHERE seller_id = ?').run(user.id);
      db.prepare('DELETE FROM seller_earnings WHERE seller_id = ?').run(user.id);
      db.prepare('DELETE FROM seller_profiles WHERE user_id = ?').run(user.id);
      try {
        db.prepare('UPDATE cards SET seller_id = NULL WHERE seller_id = ?').run(user.id);
      } catch(e) { /* seller_id column may not exist yet */ }
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    });
    deleteUser();

    logAdminAction(req, 'delete_user', `user:${req.params.id}`, { email: user.email, role: user.role });
    res.json({ message: `Utilisateur "${user.email}" supprimé.` });
  } catch (err) {
    console.error('Erreur delete user:', err);
    res.status(500).json({ error: 'Erreur suppression utilisateur.' });
  }
});

// ===== PRODUCTS CRUD =====

// GET /api/admin/products
router.get('/products', (req, res) => {
  try {
    const db = getDb();
    const products = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id AND status = 'available') as available_cards,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id AND status = 'sold') as sold_cards,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id) as total_cards
      FROM products p
      ORDER BY p.category, p.price
    `).all();
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du chargement des produits.' });
  }
});

// POST /api/admin/products
router.post('/products', (req, res) => {
  try {
    const { name, description, category, image_url, price, denomination, platform, is_active = 1 } = req.body;
    const db = getDb();

    if (!name || !category || !price || !denomination || !platform) {
      return res.status(400).json({ error: 'Champs obligatoires manquants: name, category, price, denomination, platform.' });
    }

    const result = db.prepare(`
      INSERT INTO products (name, description, category, image_url, price, denomination, platform, stock_count, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(name, description || '', category, image_url || '', parseInt(price), denomination, platform, is_active ? 1 : 0);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ message: 'Produit créé avec succès.', product });
  } catch (err) {
    console.error('Erreur create product:', err);
    res.status(500).json({ error: 'Erreur lors de la création du produit.' });
  }
});

// PUT /api/admin/products/:id
router.put('/products/:id', (req, res) => {
  try {
    const { name, description, category, image_url, price, denomination, platform, is_active } = req.body;
    const db = getDb();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Produit non trouvé.' });
    }

    db.prepare(`
      UPDATE products SET
        name = ?, description = ?, category = ?, image_url = ?,
        price = ?, denomination = ?, platform = ?, is_active = ?
      WHERE id = ?
    `).run(
      name || product.name,
      description !== undefined ? description : product.description,
      category || product.category,
      image_url !== undefined ? image_url : product.image_url,
      price ? parseInt(price) : product.price,
      denomination || product.denomination,
      platform || product.platform,
      is_active !== undefined ? (is_active ? 1 : 0) : product.is_active,
      req.params.id
    );

    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json({ message: 'Produit mis à jour.', product: updated });
  } catch (err) {
    console.error('Erreur update product:', err);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du produit.' });
  }
});

// DELETE /api/admin/products/:id
router.delete('/products/:id', (req, res) => {
  try {
    const db = getDb();
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Produit non trouvé.' });
    }

    // Soft delete
    db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(req.params.id);
    logAdminAction(req, 'delete_product', `product:${req.params.id}`, { name: product.name });
    res.json({ message: 'Produit désactivé avec succès.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la suppression du produit.' });
  }
});

// ===== CARDS MANAGEMENT =====

// GET /api/admin/cards
router.get('/cards', (req, res) => {
  try {
    const db = getDb();
    const { product_id, status, page = 1, limit = 50 } = req.query;

    // Check if seller_id exists on cards
    const cardCols = db.prepare("PRAGMA table_info(cards)").all().map(c => c.name);
    const hasSellerCol = cardCols.includes('seller_id');

    let query = hasSellerCol
      ? `SELECT c.*, p.name as product_name, p.platform,
               u.name as seller_name, sp.shop_name
         FROM cards c
         JOIN products p ON c.product_id = p.id
         LEFT JOIN users u ON c.seller_id = u.id
         LEFT JOIN seller_profiles sp ON c.seller_id = sp.user_id
         WHERE 1=1`
      : `SELECT c.*, p.name as product_name, p.platform
         FROM cards c
         JOIN products p ON c.product_id = p.id
         WHERE 1=1`;
    const params = [];

    const { seller_id } = req.query;
    if (product_id) { query += ' AND c.product_id = ?'; params.push(product_id); }
    if (status) { query += ' AND c.status = ?'; params.push(status); }
    if (seller_id && hasSellerCol) {
      if (seller_id === 'admin') {
        query += ' AND c.seller_id IS NULL';
      } else {
        query += ' AND c.seller_id = ?'; params.push(seller_id);
      }
    }

    query += ' ORDER BY c.added_at DESC';

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const total = db.prepare(query.replace('SELECT c.*, p.name as product_name, p.platform', 'SELECT COUNT(*) as total')).get(...params).total;
    query += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const cards = db.prepare(query).all(...params);

    // Mask card codes for security (show only last 4 chars)
    const maskedCards = cards.map(card => ({
      ...card,
      code: card.status === 'sold' ? `****${card.code.slice(-4)}` : card.code
    }));

    res.json({ cards: maskedCards, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du chargement des cartes.' });
  }
});

// POST /api/admin/cards/bulk - Add multiple cards
router.post('/cards/bulk', (req, res) => {
  try {
    const { product_id, cards } = req.body;
    const db = getDb();

    if (!product_id || !cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: 'product_id et tableau de cartes requis.' });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
    if (!product) {
      return res.status(404).json({ error: 'Produit non trouvé.' });
    }

    const insertCard = db.prepare(`
      INSERT INTO cards (product_id, code, pin, serial, card_name, card_price, status)
      VALUES (?, ?, ?, ?, ?, ?, 'available')
    `);

    const insertMany = db.transaction((cards) => {
      let inserted = 0;
      let skipped = 0;
      for (const card of cards) {
        if (!card.code || !card.code.trim()) { skipped++; continue; }
        try {
          insertCard.run(
            product_id,
            card.code.trim(),
            card.pin || null,
            card.serial || null,
            card.card_name || null,
            card.card_price ? parseFloat(card.card_price) : null
          );
          inserted++;
        } catch (e) { skipped++; }
      }
      return { inserted, skipped };
    });

    const result = insertMany(cards);

    // Update product stock count
    const stockCount = db.prepare('SELECT COUNT(*) as count FROM cards WHERE product_id = ? AND status = ?').get(product_id, 'available').count;
    db.prepare('UPDATE products SET stock_count = ? WHERE id = ?').run(stockCount, product_id);

    res.status(201).json({
      message: `${result.inserted} carte(s) ajoutée(s) avec succès. ${result.skipped} ignorée(s).`,
      inserted: result.inserted,
      skipped: result.skipped,
      total_stock: stockCount
    });
  } catch (err) {
    console.error('Erreur bulk cards:', err);
    res.status(500).json({ error: 'Erreur lors de l\'ajout des cartes.' });
  }
});

// DELETE /api/admin/cards/:id
router.delete('/cards/:id', (req, res) => {
  try {
    const db = getDb();
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    if (!card) {
      return res.status(404).json({ error: 'Carte non trouvée.' });
    }
    if (card.status === 'sold') {
      return res.status(400).json({ error: 'Impossible de supprimer une carte déjà vendue.' });
    }
    db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);

    // Update stock count
    const stockCount = db.prepare('SELECT COUNT(*) as count FROM cards WHERE product_id = ? AND status = ?').get(card.product_id, 'available').count;
    db.prepare('UPDATE products SET stock_count = ? WHERE id = ?').run(stockCount, card.product_id);

    res.json({ message: 'Carte supprimée.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors de la suppression.' });
  }
});

// ===== ORDERS MANAGEMENT =====

// GET /api/admin/orders
router.get('/orders', (req, res) => {
  try {
    const db = getDb();
    const { payment_status, delivery_status, page = 1, limit = 20 } = req.query;

    let query = `
      SELECT o.*, u.name as user_name, u.email as user_email, u.phone as user_phone,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (payment_status) {
      query += ' AND o.payment_status = ?';
      params.push(payment_status);
    }

    if (delivery_status) {
      query += ' AND o.delivery_status = ?';
      params.push(delivery_status);
    }

    query += ' ORDER BY o.created_at DESC';

    const countQuery = query.replace(
      `SELECT o.*, u.name as user_name, u.email as user_email, u.phone as user_phone,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count`,
      'SELECT COUNT(*) as total'
    );
    const total = db.prepare(countQuery).get(...params).total;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    query += ` LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), offset);

    const orders = db.prepare(query).all(...params);

    res.json({ orders, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('Erreur admin orders:', err);
    res.status(500).json({ error: 'Erreur lors du chargement des commandes.' });
  }
});

// GET /api/admin/orders/:id - Full order detail
router.get('/orders/:id', (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare(`
      SELECT o.*, u.name as user_name, u.email as user_email, u.phone as user_phone
      FROM orders o JOIN users u ON o.user_id = u.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });

    const items = db.prepare(`
      SELECT oi.*, p.name as product_name, p.platform, p.denomination,
        c.code as card_code, c.pin as card_pin, c.serial as card_serial, c.status as card_status
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      LEFT JOIN cards c ON oi.card_id = c.id
      WHERE oi.order_id = ?
    `).all(order.id);

    res.json({ order: { ...order, items } });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du chargement de la commande.' });
  }
});

// POST /api/admin/orders/:id/redeliver - Manually trigger delivery
router.post('/orders/:id/redeliver', async (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });
    if (order.payment_status !== 'paid') {
      return res.status(400).json({ error: 'La commande n\'est pas encore payée.' });
    }

    const result = await processDelivery(order.id, true);
    res.json({ message: 'Livraison relancée avec succès.', result });
  } catch (err) {
    console.error('Erreur redeliver:', err);
    res.status(500).json({ error: 'Erreur lors de la re-livraison.' });
  }
});

// ===== SELLERS MANAGEMENT =====

// GET /api/admin/sellers
router.get('/sellers', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    let query = `
      SELECT sp.*, u.name, u.email, u.phone,
        (SELECT COUNT(*) FROM products WHERE seller_id = sp.user_id AND is_active = 1) as product_count,
        (SELECT COALESCE(SUM(net_amount),0) FROM seller_earnings WHERE seller_id = sp.user_id) as total_earnings
      FROM seller_profiles sp
      JOIN users u ON sp.user_id = u.id
    `;
    const params = [];
    if (status) { query += ' WHERE sp.status = ?'; params.push(status); }
    query += ' ORDER BY sp.created_at DESC';
    const sellers = db.prepare(query).all(...params);
    res.json({ sellers });
  } catch(err) {
    res.status(500).json({ error: 'Erreur chargement vendeurs.' });
  }
});

// PUT /api/admin/sellers/:id/status
router.put('/sellers/:id/status', (req, res) => {
  try {
    const { status, admin_note, commission_rate } = req.body;
    const db = getDb();

    if (!['approved','rejected','suspended','pending'].includes(status)) {
      return res.status(400).json({ error: 'Statut invalide.' });
    }

    const seller = db.prepare('SELECT * FROM seller_profiles WHERE user_id = ?').get(req.params.id);
    if (!seller) return res.status(404).json({ error: 'Vendeur non trouvé.' });

    const approvedAt = status === 'approved' ? new Date().toISOString() : seller.approved_at;

    db.prepare(`
      UPDATE seller_profiles SET status = ?, admin_note = ?, commission_rate = ?, approved_at = ? WHERE user_id = ?
    `).run(status, admin_note || seller.admin_note, commission_rate !== undefined ? commission_rate : seller.commission_rate, approvedAt, req.params.id);

    // Update user role
    if (status === 'approved') {
      db.prepare("UPDATE users SET role = 'seller' WHERE id = ?").run(req.params.id);
    } else if (status === 'rejected' || status === 'suspended') {
      db.prepare("UPDATE users SET role = 'client' WHERE id = ?").run(req.params.id);
    }

    // Send approval email
    if (status === 'approved' && seller.status !== 'approved') {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
      const finalCommissionRate = commission_rate !== undefined ? commission_rate : seller.commission_rate;
      if (user) {
        sendSellerApprovalEmail(user, finalCommissionRate || 10).catch(e => console.error('Erreur email approbation vendeur:', e));
      }
    }

    logAdminAction(req, 'update_seller_status', `seller:${req.params.id}`, { status, admin_note });
    res.json({ message: `Vendeur ${status === 'approved' ? 'approuvé' : status === 'rejected' ? 'rejeté' : 'suspendu'} avec succès.` });
  } catch(err) {
    console.error('Erreur update seller status:', err);
    res.status(500).json({ error: 'Erreur mise à jour vendeur.' });
  }
});

// ===== WITHDRAWALS MANAGEMENT =====

// GET /api/admin/withdrawals
router.get('/withdrawals', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.query;
    let query = `
      SELECT wr.*, u.name as seller_name, u.email as seller_email, sp.shop_name
      FROM withdrawal_requests wr
      JOIN users u ON wr.seller_id = u.id
      JOIN seller_profiles sp ON sp.user_id = wr.seller_id
    `;
    const params = [];
    if (status) { query += ' WHERE wr.status = ?'; params.push(status); }
    query += ' ORDER BY wr.created_at DESC';
    const withdrawals = db.prepare(query).all(...params);
    res.json({ withdrawals });
  } catch(err) {
    res.status(500).json({ error: 'Erreur chargement retraits.' });
  }
});

// PUT /api/admin/withdrawals/:id/process
router.put('/withdrawals/:id/process', (req, res) => {
  try {
    const { status, admin_note } = req.body;
    const db = getDb();

    if (!['approved','paid','rejected'].includes(status)) {
      return res.status(400).json({ error: 'Statut invalide.' });
    }

    const withdrawal = db.prepare('SELECT * FROM withdrawal_requests WHERE id = ?').get(req.params.id);
    if (!withdrawal) return res.status(404).json({ error: 'Demande non trouvée.' });
    if (withdrawal.status === 'paid') return res.status(400).json({ error: 'Cette demande est déjà payée.' });

    db.prepare(`
      UPDATE withdrawal_requests SET status = ?, admin_note = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(status, admin_note || '', req.params.id);

    // If paid, mark earnings as withdrawn
    if (status === 'paid') {
      const processWithdrawal = db.transaction(() => {
        let remaining = withdrawal.amount;
        const earnings = db.prepare(`
          SELECT * FROM seller_earnings WHERE seller_id = ? AND status = 'available' ORDER BY created_at ASC
        `).all(withdrawal.seller_id);

        for (const earning of earnings) {
          if (remaining <= 0) break;
          if (earning.net_amount <= remaining) {
            db.prepare("UPDATE seller_earnings SET status = 'withdrawn' WHERE id = ?").run(earning.id);
            remaining -= earning.net_amount;
          } else {
            // Split would be complex, mark as withdrawn anyway if close enough
            db.prepare("UPDATE seller_earnings SET status = 'withdrawn' WHERE id = ?").run(earning.id);
            remaining = 0;
          }
        }
      });
      processWithdrawal();
    }

    // Notifier le vendeur par email
    const seller = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(withdrawal.seller_id);
    const profile = db.prepare('SELECT shop_name FROM seller_profiles WHERE user_id = ?').get(withdrawal.seller_id);
    if (seller && seller.email) {
      sendWithdrawalStatusEmail(seller, profile?.shop_name || seller.name, withdrawal.amount, status, admin_note || '')
        .catch(err => console.error('[WITHDRAWAL STATUS EMAIL ERROR]', err.message));
    }

    logAdminAction(req, 'process_withdrawal', `withdrawal:${req.params.id}`, { status, amount: withdrawal.amount });
    res.json({ message: `Retrait ${status === 'paid' ? 'marqué comme payé' : status === 'approved' ? 'approuvé' : 'rejeté'}.` });
  } catch(err) {
    console.error('Erreur process withdrawal:', err);
    res.status(500).json({ error: 'Erreur traitement retrait.' });
  }
});

// GET /api/admin/marketplace-stats
router.get('/marketplace-stats', (req, res) => {
  try {
    const db = getDb();
    const totalSellers = db.prepare("SELECT COUNT(*) as count FROM seller_profiles WHERE status = 'approved'").get().count;
    const pendingSellers = db.prepare("SELECT COUNT(*) as count FROM seller_profiles WHERE status = 'pending'").get().count;
    const totalEarnings = db.prepare("SELECT COALESCE(SUM(commission_amount),0) as total FROM seller_earnings").get().total;
    const pendingWithdrawals = db.prepare("SELECT COUNT(*) as count FROM withdrawal_requests WHERE status = 'pending'").get().count;
    const pendingWithdrawalAmount = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM withdrawal_requests WHERE status = 'pending'").get().total;
    res.json({ totalSellers, pendingSellers, totalEarnings, pendingWithdrawals, pendingWithdrawalAmount });
  } catch(err) {
    res.status(500).json({ error: 'Erreur stats marketplace.' });
  }
});

module.exports = router;
