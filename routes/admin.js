const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { getDb } = require('../database/db');
const { authenticateToken, requireAdmin, logAdminAction } = require('../middleware/auth');
const { processDelivery } = require('../services/delivery');
const { encrypt, decrypt } = require('../services/encryption');
const { sendWithdrawalStatusEmail, sendSellerApprovalEmail, sendBroadcastEmail } = require('../services/email');

// Rate limiter for card reveal — max 30 reveals per 10 minutes per IP
const revealLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { error: 'Trop de révélations de codes. Réessayez dans 10 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Multer for product images — store in Railway persistent volume if available
const persistentBase = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : null;
const productImgDir = persistentBase
  ? path.join(persistentBase, 'uploads/products')
  : path.join(__dirname, '../public/uploads/products');
if (!fs.existsSync(productImgDir)) fs.mkdirSync(productImgDir, { recursive: true });
// Validate image magic bytes to prevent MIME spoofing
function validateImageMagicBytes(buffer) {
  if (buffer.length < 4) return false;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpeg';
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'webp';
  return false;
}

const productImgUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, productImgDir),
    filename: (req, file, cb) => {
      // Use UUID-based filename, ignore original extension to prevent path traversal
      const { v4: uuidv4 } = require('uuid');
      const mimeToExt = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
      const ext = mimeToExt[file.mimetype] || '.jpg';
      cb(null, `product_${uuidv4()}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Image uniquement (JPG, PNG, WebP). Max 2MB.'));
  }
});

// All admin routes require authentication + admin role
router.use(authenticateToken, requireAdmin);

// POST /api/admin/products/upload-image
router.post('/products/upload-image', (req, res) => {
  productImgUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
    // Verify magic bytes to prevent MIME spoofing
    const buffer = fs.readFileSync(req.file.path);
    const type = validateImageMagicBytes(buffer);
    if (!type) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Fichier invalide. Le contenu ne correspond pas à une image réelle.' });
    }
    res.json({ url: `/uploads/products/${req.file.filename}` });
  });
});

// GET /api/admin/stats
router.get('/stats', (req, res) => {
  try {
    const db = getDb();

    // 1 requête pour tous les compteurs orders
    const orderStats = db.prepare(`
      SELECT
        COUNT(*) as totalOrders,
        COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END), 0) as paidOrders,
        COALESCE(SUM(CASE WHEN payment_status = 'pending' THEN 1 ELSE 0 END), 0) as pendingOrders,
        COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0) as totalRevenue
      FROM orders
    `).get();

    // 1 requête pour users
    const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'client'").get().count;

    // 1 requête pour les cartes
    const cardStats = db.prepare(`
      SELECT
        COUNT(*) as totalCards,
        COALESCE(SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END), 0) as availableCards,
        COALESCE(SUM(CASE WHEN status = 'sold' THEN 1 ELSE 0 END), 0) as soldCards
      FROM cards
    `).get();

    // 1 requête pour les produits
    const productStats = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) as totalProducts,
        COALESCE(SUM(CASE WHEN stock_count <= 5 AND stock_count > 0 AND is_active = 1 THEN 1 ELSE 0 END), 0) as lowStockProducts,
        COALESCE(SUM(CASE WHEN stock_count = 0 AND is_active = 1 THEN 1 ELSE 0 END), 0) as outOfStockProducts
      FROM products
    `).get();

    // 1 requête pour les alertes vendeurs/retraits/promos
    const alertStats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM seller_profiles WHERE status = 'pending') as pendingSellers,
        (SELECT COUNT(*) FROM withdrawal_requests WHERE status = 'pending') as pendingWithdrawals,
        (SELECT COUNT(*) FROM seller_product_promos WHERE status = 'pending') as pendingPromoRequests
    `).get();

    // 1 requête pour les bénéfices
    const earningsStats = db.prepare(`
      SELECT
        COALESCE(SUM(commission_amount), 0) as totalCommissions,
        COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m','now') THEN commission_amount ELSE 0 END), 0) as commissionsThisMonth
      FROM seller_earnings
    `).get();

    const directRevenueStats = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN p.seller_id IS NULL THEN oi.unit_price ELSE 0 END), 0) as directRevenue,
        COALESCE(SUM(CASE WHEN p.seller_id IS NULL AND strftime('%Y-%m', o.created_at) = strftime('%Y-%m','now') THEN oi.unit_price ELSE 0 END), 0) as directRevenueMonth
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE o.payment_status = 'paid'
    `).get();

    const adminBenefits = directRevenueStats.directRevenue + earningsStats.totalCommissions;
    const adminBenefitsMonth = directRevenueStats.directRevenueMonth + earningsStats.commissionsThisMonth;

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

    const totalOrders = orderStats.totalOrders;
    const paidOrders = orderStats.paidOrders;
    const pendingOrders = orderStats.pendingOrders;
    const totalRevenue = orderStats.totalRevenue;
    const totalProducts = productStats.totalProducts;
    const totalCards = cardStats.totalCards;
    const availableCards = cardStats.availableCards;
    const soldCards = cardStats.soldCards;
    const totalCommissions = earningsStats.totalCommissions;
    const directRevenue = directRevenueStats.directRevenue;
    const pendingSellers = alertStats.pendingSellers;
    const pendingWithdrawals = alertStats.pendingWithdrawals;
    const lowStockProducts = productStats.lowStockProducts;
    const outOfStockProducts = productStats.outOfStockProducts;

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
        pendingPromoRequests: alertStats.pendingPromoRequests,
        pendingOrders,
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

    const countQuery = 'SELECT COUNT(*) as total FROM users WHERE 1=1' + (search ? ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)' : '');
    const total = db.prepare(countQuery).get(...(search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [])).total;

    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Single query with LEFT JOIN — no N+1
    let enrichQuery = `
      SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at,
        COUNT(o.id) as total_orders,
        COALESCE(SUM(CASE WHEN o.payment_status = 'paid' THEN o.total_amount ELSE 0 END), 0) as total_spent
      FROM users u
      LEFT JOIN orders o ON o.user_id = u.id
      WHERE 1=1
    `;
    const enrichParams = [];
    if (search) {
      enrichQuery += ' AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)';
      enrichParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    enrichQuery += ' GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
    enrichParams.push(parseInt(limit), offset);

    const enriched = db.prepare(enrichQuery).all(...enrichParams);

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
      const id = user.id;
      // Dépendances feuilles (pas de référence vers d'autres tables)
      try { db.prepare('DELETE FROM promo_code_uses WHERE user_id = ?').run(id); } catch(e) {}
      try { db.prepare('DELETE FROM refund_requests WHERE user_id = ?').run(id); } catch(e) {}
      try { db.prepare('DELETE FROM email_otp_tokens WHERE user_id = ?').run(id); } catch(e) {}
      try { db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(id); } catch(e) {}
      try { db.prepare('DELETE FROM login_otp_tokens WHERE user_id = ?').run(id); } catch(e) {}
      try { db.prepare('DELETE FROM fcm_tokens WHERE user_id = ?').run(id); } catch(e) {}
      try { db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(id); } catch(e) {}
      // Commandes et items
      try {
        const orderIds = db.prepare('SELECT id FROM orders WHERE user_id = ?').all(id).map(o => o.id);
        for (const oid of orderIds) {
          db.prepare('DELETE FROM refund_requests WHERE order_id = ?').run(oid);
          db.prepare('DELETE FROM order_items WHERE order_id = ?').run(oid);
        }
        db.prepare('DELETE FROM orders WHERE user_id = ?').run(id);
      } catch(e) {}
      // Vendeur
      try { db.prepare('DELETE FROM withdrawal_requests WHERE seller_id = ?').run(id); } catch(e) {}
      try { db.prepare('DELETE FROM seller_earnings WHERE seller_id = ?').run(id); } catch(e) {}
      try { db.prepare('DELETE FROM seller_profiles WHERE user_id = ?').run(id); } catch(e) {}
      try { db.prepare('UPDATE cards SET seller_id = NULL WHERE seller_id = ?').run(id); } catch(e) {}
      // Supprimer l'utilisateur
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
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
    const { page = 1, limit = 50, search, category } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let where = 'WHERE 1=1';
    const params = [];
    if (search) { where += ' AND (p.name LIKE ? OR p.platform LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (category) { where += ' AND p.category = ?'; params.push(category); }

    const total = db.prepare(`SELECT COUNT(*) as count FROM products p ${where}`).get(...params).count;

    const products = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id AND status = 'available') as available_cards,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id AND status = 'sold') as sold_cards,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id) as total_cards
      FROM products p
      ${where}
      ORDER BY p.category, p.price
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), offset);

    res.json({ products, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du chargement des produits.' });
  }
});

// POST /api/admin/products
router.post('/products', (req, res) => {
  try {
    const { name, description, category, image_url, price, promo_price, denomination, platform, is_active = 1 } = req.body;
    const db = getDb();

    if (!name || !category || !price || !denomination || !platform) {
      return res.status(400).json({ error: 'Champs obligatoires manquants: name, category, price, denomination, platform.' });
    }

    const promoVal = promo_price && parseInt(promo_price) > 0 && parseInt(promo_price) < parseInt(price) ? parseInt(promo_price) : null;

    const result = db.prepare(`
      INSERT INTO products (name, description, category, image_url, price, promo_price, denomination, platform, stock_count, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(name, description || '', category, image_url || '', parseInt(price), promoVal, denomination, platform, is_active ? 1 : 0);

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
    const { name, description, category, image_url, price, promo_price, denomination, platform, is_active } = req.body;
    const db = getDb();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: 'Produit non trouvé.' });
    }

    const newPrice = price ? parseInt(price) : product.price;
    const promoVal = promo_price !== undefined
      ? (parseInt(promo_price) > 0 && parseInt(promo_price) < newPrice ? parseInt(promo_price) : null)
      : product.promo_price;

    db.prepare(`
      UPDATE products SET
        name = ?, description = ?, category = ?, image_url = ?,
        price = ?, promo_price = ?, denomination = ?, platform = ?, is_active = ?
      WHERE id = ?
    `).run(
      name || product.name,
      description !== undefined ? description : product.description,
      category || product.category,
      image_url !== undefined ? image_url : product.image_url,
      newPrice,
      promoVal,
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

    // Decrypt codes then mask — never expose ciphertext or plaintext in the list
    const maskedCards = cards.map(card => {
      const plain = decrypt(card.code);
      const maskedCode = plain
        ? (plain.length > 8 ? `${plain.slice(0, 4)}****${plain.slice(-4)}` : '****')
        : '****';
      const plainPin = card.pin ? decrypt(card.pin) : null;
      const maskedPin = plainPin
        ? (plainPin.length > 4 ? `${plainPin.slice(0, 2)}**` : '**')
        : null;
      return { ...card, code: maskedCode, pin: maskedPin };
    });

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

    const crypto = require('crypto');
    const insertCard = db.prepare(`
      INSERT INTO cards (product_id, code, pin, serial, status, code_hash)
      VALUES (?, ?, ?, ?, 'available', ?)
    `);

    // Normalize and validate code format based on platform
    const platform = (product.platform || '').toLowerCase();
    const isPSN = platform.includes('psn') || platform.includes('playstation');
    const isItunes = platform.includes('itunes') || platform.includes('app store') || platform.includes('apple');
    const isXbox = platform.includes('xbox');
    const isNetflix = platform.includes('netflix');
    const isGooglePlay = platform.includes('google play') || platform.includes('google');
    const isSteam = platform.includes('steam');
    const isAmazon = platform.includes('amazon');
    const psnRegex = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
    const itunesRegex = /^[A-Z0-9]{16}$/i;
    const xboxRegex = /^\d{25}$/;
    const netflixRegex = /^[A-Z0-9]{11}$/i;
    const googlePlayRegex = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/i;
    const steamRegex = /^[A-Z0-9]{15}$/i;
    const amazonRegex = /^[A-Z0-9]{14,15}$/i;

    function normalizePSNCode(raw) {
      const clean = raw.replace(/[-\s]/g, '').toUpperCase();
      if (clean.length !== 12) return null;
      return `${clean.slice(0,4)}-${clean.slice(4,8)}-${clean.slice(8,12)}`;
    }

    function normalizeItunesCode(raw) {
      const clean = raw.replace(/[\s-]/g, '').toUpperCase();
      if (clean.length !== 16) return null;
      return clean;
    }

    function normalizeXboxCode(raw) {
      const clean = raw.replace(/[\s-]/g, '');
      if (clean.length !== 25 || !/^\d{25}$/.test(clean)) return null;
      return clean;
    }

    function normalizeNetflixCode(raw) {
      const clean = raw.replace(/[\s-]/g, '').toUpperCase();
      if (clean.length !== 11) return null;
      return clean;
    }

    function normalizeGooglePlayCode(raw) {
      const clean = raw.replace(/[\s-]/g, '').toUpperCase();
      if (clean.length !== 16) return null;
      return `${clean.slice(0,4)}-${clean.slice(4,8)}-${clean.slice(8,12)}-${clean.slice(12,16)}`;
    }

    function normalizeSteamCode(raw) {
      const clean = raw.replace(/[\s-]/g, '').toUpperCase();
      if (clean.length !== 15) return null;
      return clean;
    }

    function normalizeAmazonCode(raw) {
      const clean = raw.replace(/[\s-]/g, '').toUpperCase();
      if (clean.length < 14 || clean.length > 15) return null;
      return clean;
    }

    const insertMany = db.transaction((cards) => {
      let inserted = 0;
      let skipped = 0;
      const invalidCodes = [];
      for (const card of cards) {
        if (!card.code || !card.code.trim()) { skipped++; continue; }
        let code = card.code.trim();

        if (isPSN) {
          const normalized = normalizePSNCode(code);
          if (!normalized || !psnRegex.test(normalized)) {
            invalidCodes.push(code);
            skipped++;
            continue;
          }
          code = normalized;
        } else if (isItunes) {
          const normalized = normalizeItunesCode(code);
          if (!normalized || !itunesRegex.test(normalized)) {
            invalidCodes.push(code);
            skipped++;
            continue;
          }
          code = normalized;
        } else if (isXbox) {
          const normalized = normalizeXboxCode(code);
          if (!normalized || !xboxRegex.test(normalized)) {
            invalidCodes.push(code);
            skipped++;
            continue;
          }
          code = normalized;
        } else if (isNetflix) {
          const normalized = normalizeNetflixCode(code);
          if (!normalized || !netflixRegex.test(normalized)) {
            invalidCodes.push(code);
            skipped++;
            continue;
          }
          code = normalized;
        } else if (isGooglePlay) {
          const normalized = normalizeGooglePlayCode(code);
          if (!normalized || !googlePlayRegex.test(normalized)) {
            invalidCodes.push(code);
            skipped++;
            continue;
          }
          code = normalized;
        } else if (isSteam) {
          const normalized = normalizeSteamCode(code);
          if (!normalized || !steamRegex.test(normalized)) {
            invalidCodes.push(code);
            skipped++;
            continue;
          }
          code = normalized;
        } else if (isAmazon) {
          const normalized = normalizeAmazonCode(code);
          if (!normalized || !amazonRegex.test(normalized)) {
            invalidCodes.push(code);
            skipped++;
            continue;
          }
          code = normalized;
        }

        try {
          const codeHash = crypto.createHash('sha256').update(code.toUpperCase().trim()).digest('hex');
          insertCard.run(
            product_id,
            encrypt(code),
            card.pin ? encrypt(card.pin) : null,
            card.serial ? encrypt(card.serial) : null,
            codeHash
          );
          inserted++;
        } catch (e) {
          if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.message?.includes('UNIQUE')) {
            // Code en double — on l'ignore silencieusement
          }
          skipped++;
        }
      }
      return { inserted, skipped, invalidCodes };
    });

    const result = insertMany(cards);

    // Update product stock count
    const stockCount = db.prepare('SELECT COUNT(*) as count FROM cards WHERE product_id = ? AND status = ?').get(product_id, 'available').count;
    db.prepare('UPDATE products SET stock_count = ? WHERE id = ?').run(stockCount, product_id);

    const formatHint = isPSN ? 'format attendu: XXXX-XXXX-XXXX' : isItunes ? 'format attendu: 16 caractères sans espace' : isXbox ? 'format attendu: 25 chiffres numériques' : isNetflix ? 'format attendu: 11 caractères' : isGooglePlay ? 'format attendu: XXXX-XXXX-XXXX-XXXX' : isSteam ? 'format attendu: 15 caractères alphanumériques' : isAmazon ? 'format attendu: 14 ou 15 caractères alphanumériques' : '';
    const msg = result.invalidCodes && result.invalidCodes.length > 0
      ? `${result.inserted} carte(s) ajoutée(s). ${result.skipped} ignorée(s) dont ${result.invalidCodes.length} code(s) invalide(s) (${formatHint}).`
      : `${result.inserted} carte(s) ajoutée(s) avec succès. ${result.skipped} ignorée(s).`;

    res.status(201).json({
      message: msg,
      inserted: result.inserted,
      skipped: result.skipped,
      invalid_codes: result.invalidCodes || [],
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

    const cardCols = db.prepare("PRAGMA table_info(cards)").all().map(c => c.name);
    const hasSellerCol = cardCols.includes('seller_id');

    const itemsQuery = hasSellerCol
      ? `SELECT oi.*, p.name as product_name, p.platform, p.denomination,
           c.code as card_code, c.pin as card_pin, c.serial as card_serial, c.status as card_status,
           u.name as seller_name, sp.shop_name as seller_shop
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         LEFT JOIN cards c ON oi.card_id = c.id
         LEFT JOIN users u ON c.seller_id = u.id
         LEFT JOIN seller_profiles sp ON c.seller_id = sp.user_id
         WHERE oi.order_id = ?`
      : `SELECT oi.*, p.name as product_name, p.platform, p.denomination,
           c.code as card_code, c.pin as card_pin, c.serial as card_serial, c.status as card_status
         FROM order_items oi
         JOIN products p ON oi.product_id = p.id
         LEFT JOIN cards c ON oi.card_id = c.id
         WHERE oi.order_id = ?`;

    const items = db.prepare(itemsQuery).all(order.id).map(item => {
      const code = decrypt(item.card_code);
      const pin = decrypt(item.card_pin);
      const serial = decrypt(item.card_serial);
      return {
        ...item,
        card_code: code ? code.slice(0, 4) + '****' + code.slice(-4) : null,
        card_pin: pin ? '****' : null,
        card_serial: serial ? serial.slice(0, 4) + '...' : null,
        card_id: item.card_id
      };
    });

    res.json({ order: { ...order, items } });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du chargement de la commande.' });
  }
});

// GET /api/admin/cards/:id/reveal — voir le vrai code d'une carte (loggé)
router.get('/cards/:id/reveal', revealLimiter, (req, res) => {
  try {
    const db = getDb();
    const card = db.prepare('SELECT id, code, pin, serial FROM cards WHERE id = ?').get(req.params.id);
    if (!card) return res.status(404).json({ error: 'Carte non trouvée.' });

    logAdminAction(req, 'REVEAL_CARD', `card#${card.id}`);

    res.json({
      card_id: card.id,
      code: decrypt(card.code),
      pin: decrypt(card.pin),
      serial: decrypt(card.serial)
    });
  } catch(err) {
    console.error('Erreur reveal card:', err);
    res.status(500).json({ error: 'Erreur.' });
  }
});

// POST /api/admin/orders/:id/cancel - Cancel a pending order
router.post('/orders/:id/cancel', (req, res) => {
  try {
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });
    if (order.payment_status !== 'pending') {
      return res.status(400).json({ error: 'Seules les commandes en attente peuvent être annulées.' });
    }

    db.prepare("UPDATE orders SET payment_status = 'cancelled', delivery_status = 'cancelled' WHERE id = ?").run(order.id);
    db.prepare("UPDATE cards SET status = 'available', order_id = NULL WHERE order_id = ? AND status = 'reserved'").run(order.id);

    logAdminAction(req, 'cancel_order', `order:${order.id}`);
    res.json({ message: 'Commande annulée avec succès.' });
  } catch (err) {
    console.error('Erreur cancel order:', err);
    res.status(500).json({ error: 'Erreur lors de l\'annulation.' });
  }
});

// POST /api/admin/orders/:id/refund - Refund a paid order via Djamo
router.post('/orders/:id/refund', async (req, res) => {
  try {
    const { admin_note } = req.body;
    const db = getDb();
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Commande non trouvée.' });
    if (order.payment_status !== 'paid') return res.status(400).json({ error: 'Seules les commandes payées peuvent être remboursées.' });
    if (order.delivery_status === 'refunded') return res.status(400).json({ error: 'Cette commande a déjà été remboursée.' });

    const chargeId = order.payment_ref;
    const DJAMO_API_URL = process.env.DJAMO_API_URL || 'https://apibusiness.civ.staging.djam.ooo';
    const DJAMO_ACCESS_TOKEN = process.env.DJAMO_ACCESS_TOKEN;
    const DJAMO_COMPANY_ID = process.env.DJAMO_COMPANY_ID;

    // Appel Djamo refund si credentials disponibles
    if (DJAMO_ACCESS_TOKEN && chargeId && !chargeId.startsWith('BABI-')) {
      try {
        const axios = require('axios');
        await axios.post(
          `${DJAMO_API_URL}/v1/charges/${chargeId}/refund`,
          {},
          { headers: { 'Authorization': `Bearer ${DJAMO_ACCESS_TOKEN}`, 'X-Company-Id': DJAMO_COMPANY_ID, 'Content-Type': 'application/json' } }
        );
        console.log(`[REFUND] Remboursement Djamo OK pour chargeId: ${chargeId}`);
      } catch (djamoErr) {
        console.error('[REFUND] Erreur Djamo:', djamoErr.response?.data || djamoErr.message);
        return res.status(502).json({ error: 'Erreur lors du remboursement Djamo.', detail: djamoErr.response?.data });
      }
    }

    // Mettre à jour la base de données
    const processRefund = db.transaction(() => {
      db.prepare("UPDATE orders SET payment_status = 'refunded', delivery_status = 'refunded' WHERE id = ?").run(order.id);
      db.prepare("UPDATE cards SET status = 'disputed' WHERE order_id = ? AND status = 'sold'").run(order.id);
      db.prepare("UPDATE seller_earnings SET status = 'reversed' WHERE order_id = ?").run(order.id);
    });
    processRefund();

    logAdminAction(req, 'refund_order', `order:${order.id}`, { admin_note, chargeId });
    res.json({ message: 'Remboursement effectué avec succès.' });
  } catch (err) {
    console.error('Erreur refund order:', err);
    res.status(500).json({ error: 'Erreur lors du remboursement.' });
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


// POST /api/admin/migrate-encrypt-cards — chiffre toutes les cartes en clair (one-shot)
router.post('/migrate-encrypt-cards', (req, res) => {
  try {
    const { isEncrypted, encrypt } = require('../services/encryption');
    const db = getDb();

    const cards = db.prepare("SELECT id, code, pin, serial FROM cards WHERE status != 'deleted'").all();

    let encrypted = 0;
    let alreadyDone = 0;
    let errors = 0;

    const updateCard = db.prepare('UPDATE cards SET code = ?, pin = ?, serial = ? WHERE id = ?');

    const migrateAll = db.transaction(() => {
      for (const card of cards) {
        if (isEncrypted(card.code)) { alreadyDone++; continue; }
        try {
          updateCard.run(
            encrypt(card.code),
            card.pin ? encrypt(card.pin) : null,
            card.serial ? encrypt(card.serial) : null,
            card.id
          );
          encrypted++;
        } catch(e) {
          console.error(`[MIGRATE] Erreur carte #${card.id}:`, e.message);
          errors++;
        }
      }
    });

    migrateAll();

    logAdminAction(req, 'MIGRATE_ENCRYPT_CARDS', null, { total: cards.length, encrypted, alreadyDone, errors });

    res.json({
      message: `Migration terminée.`,
      total: cards.length,
      encrypted,
      already_encrypted: alreadyDone,
      errors
    });
  } catch(err) {
    console.error('Erreur migration chiffrement:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/backup — télécharger une copie de la base de données
router.get('/backup', (req, res) => {
  try {
    const db = getDb();
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../database/giftcard.db');

    if (!fs.existsSync(dbPath)) {
      return res.status(404).json({ error: 'Fichier base de données introuvable.' });
    }

    // WAL checkpoint pour s'assurer que toutes les données sont dans le fichier principal
    db.pragma('wal_checkpoint(FULL)');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `babicard-backup-${timestamp}.db`;

    logAdminAction(req, 'DATABASE_BACKUP', filename);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(dbPath);
  } catch (err) {
    console.error('Erreur backup DB:', err);
    res.status(500).json({ error: 'Erreur lors du backup.' });
  }
});

// ===== PROMO REQUESTS =====

// GET /api/admin/promo-requests — List seller promo requests
router.get('/promo-requests', (req, res) => {
  try {
    const db = getDb();
    const { status = 'pending' } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (status && status !== 'all') {
      where += ' AND spp.status = ?';
      params.push(status);
    }
    const requests = db.prepare(`
      SELECT spp.id, spp.promo_price as promo_price_requested, spp.status as promo_request_status,
        p.id as product_id, p.name, p.platform, p.price, p.promo_price, p.denomination,
        u.name as seller_name, sp.shop_name
      FROM seller_product_promos spp
      JOIN products p ON spp.product_id = p.id
      JOIN users u ON spp.seller_id = u.id
      LEFT JOIN seller_profiles sp ON sp.user_id = spp.seller_id
      ${where}
      ORDER BY spp.created_at DESC
    `).all(...params);
    res.json({ requests });
  } catch (err) {
    console.error('Erreur promo-requests:', err);
    res.status(500).json({ error: 'Erreur chargement demandes.' });
  }
});

// PUT /api/admin/promo-requests/:id/approve — Approve promo request
router.put('/promo-requests/:id/approve', (req, res) => {
  try {
    const db = getDb();
    const spp = db.prepare('SELECT * FROM seller_product_promos WHERE id = ?').get(req.params.id);
    if (!spp) return res.status(404).json({ error: 'Demande non trouvée.' });
    if (spp.status !== 'pending') return res.status(400).json({ error: 'Cette demande n\'est pas en attente.' });
    db.prepare("UPDATE seller_product_promos SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    logAdminAction(req, 'approve_promo_request', `spp:${req.params.id}`, { promo_price: spp.promo_price });
    res.json({ message: 'Prix promotionnel approuvé. Il s\'appliquera automatiquement aux cartes de ce vendeur.' });
  } catch (err) {
    console.error('Erreur approve promo:', err);
    res.status(500).json({ error: 'Erreur approbation.' });
  }
});

// PUT /api/admin/promo-requests/:id/reject — Reject promo request
router.put('/promo-requests/:id/reject', (req, res) => {
  try {
    const db = getDb();
    const spp = db.prepare('SELECT * FROM seller_product_promos WHERE id = ?').get(req.params.id);
    if (!spp) return res.status(404).json({ error: 'Demande non trouvée.' });
    if (spp.status !== 'pending') return res.status(400).json({ error: 'Cette demande n\'est pas en attente.' });
    db.prepare("UPDATE seller_product_promos SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
    logAdminAction(req, 'reject_promo_request', `spp:${req.params.id}`, {});
    res.json({ message: 'Demande de promotion rejetée.' });
  } catch (err) {
    console.error('Erreur reject promo:', err);
    res.status(500).json({ error: 'Erreur rejet.' });
  }
});

// POST /api/admin/broadcast — envoyer un email à tous les clients
router.post('/broadcast', async (req, res) => {
  try {
    const { subject, body } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Sujet obligatoire.' });
    if (!body || !body.trim()) return res.status(400).json({ error: 'Message obligatoire.' });

    const db = getDb();
    const users = db.prepare("SELECT id, name, email FROM users WHERE email_verified = 1 AND (marketing_emails IS NULL OR marketing_emails = 1)").all();

    if (users.length === 0) return res.json({ message: 'Aucun utilisateur à contacter.', sent: 0, failed: 0 });

    let sent = 0, failed = 0;
    const BATCH_SIZE = 20;
    const BATCH_DELAY_MS = 2000;

    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(batch.map(async user => {
        try {
          await sendBroadcastEmail(user, subject.trim(), body.trim());
          sent++;
        } catch (e) {
          failed++;
          console.error(`[BROADCAST] Échec envoi à ${user.email}:`, e.message);
        }
      }));
      // Pause entre les batches pour éviter de saturer le serveur SMTP
      if (i + BATCH_SIZE < users.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    logAdminAction(req, 'BROADCAST_EMAIL', null, { subject, sent, failed, total: users.length });
    console.log(`[BROADCAST] ${sent}/${users.length} emails envoyés.`);
    res.json({ message: `Email envoyé à ${sent} client(s).`, sent, failed, total: users.length });
  } catch (err) {
    console.error('Erreur broadcast:', err);
    res.status(500).json({ error: 'Erreur lors de l\'envoi.' });
  }
});

// GET /api/admin/refunds — List all refund requests
router.get('/refunds', (req, res) => {
  try {
    const db = getDb();
    const refunds = db.prepare(`
      SELECT rr.*, u.name as user_name, u.email as user_email,
        o.total_amount, o.payment_method, o.created_at as order_date
      FROM refund_requests rr
      JOIN users u ON rr.user_id = u.id
      JOIN orders o ON rr.order_id = o.id
      ORDER BY rr.created_at DESC
    `).all();
    res.json({ refunds });
  } catch (err) {
    console.error('Erreur get refunds:', err);
    res.status(500).json({ error: 'Erreur.' });
  }
});

// PUT /api/admin/refunds/:id/approve — Approve refund
router.put('/refunds/:id/approve', async (req, res) => {
  try {
    const { admin_note } = req.body;
    const db = getDb();
    const refund = db.prepare('SELECT * FROM refund_requests WHERE id = ?').get(req.params.id);
    if (!refund) return res.status(404).json({ error: 'Demande non trouvée.' });
    if (refund.status !== 'pending') return res.status(400).json({ error: 'Demande déjà traitée.' });

    const processRefund = db.transaction(() => {
      // Mark order cards as disputed
      db.prepare("UPDATE cards SET status = 'disputed' WHERE order_id = ? AND status = 'sold'").run(refund.order_id);
      // Mark order as refunded
      db.prepare("UPDATE orders SET delivery_status = 'refunded', payment_status = 'refunded' WHERE id = ?").run(refund.order_id);
      // Reverse seller earnings for this order
      db.prepare("UPDATE seller_earnings SET status = 'reversed' WHERE order_id = ?").run(refund.order_id);
      // Update refund request
      db.prepare("UPDATE refund_requests SET status = 'approved', admin_note = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?").run(admin_note || null, refund.id);
    });
    processRefund();

    // Notify user by email
    const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(refund.user_id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(refund.order_id);
    if (user && user.email) {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST, port: parseInt(process.env.EMAIL_PORT || '465'),
        secure: true, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      });
      transporter.sendMail({
        from: `"Babicard.ci" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: `✅ Remboursement approuvé — Commande #${refund.order_id}`,
        html: `<p>Bonjour ${user.name},</p><p>Votre demande de remboursement pour la commande <strong>#${refund.order_id}</strong> (${new Intl.NumberFormat('fr-FR').format(order.total_amount)} FCFA) a été <strong>approuvée</strong>.</p>${admin_note ? `<p>Note: ${admin_note}</p>` : ''}<p>Le remboursement sera effectué via votre méthode de paiement initiale sous 3-5 jours ouvrables.</p><p>Babicard.ci</p>`
      }).catch(() => {});
    }

    logAdminAction(req, 'APPROVE_REFUND', `order#${refund.order_id}`, { refund_id: refund.id });
    res.json({ message: 'Remboursement approuvé.' });
  } catch (err) {
    console.error('Erreur approve refund:', err);
    res.status(500).json({ error: 'Erreur.' });
  }
});

// PUT /api/admin/refunds/:id/reject — Reject refund
router.put('/refunds/:id/reject', async (req, res) => {
  try {
    const { admin_note } = req.body;
    if (!admin_note) return res.status(400).json({ error: 'Veuillez indiquer la raison du refus.' });

    const db = getDb();
    const refund = db.prepare('SELECT * FROM refund_requests WHERE id = ?').get(req.params.id);
    if (!refund) return res.status(404).json({ error: 'Demande non trouvée.' });
    if (refund.status !== 'pending') return res.status(400).json({ error: 'Demande déjà traitée.' });

    db.prepare("UPDATE refund_requests SET status = 'rejected', admin_note = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?").run(admin_note, refund.id);

    // Notify user
    const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(refund.user_id);
    if (user && user.email) {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST, port: parseInt(process.env.EMAIL_PORT || '465'),
        secure: true, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      });
      transporter.sendMail({
        from: `"Babicard.ci" <${process.env.EMAIL_USER}>`,
        to: user.email,
        subject: `❌ Remboursement refusé — Commande #${refund.order_id}`,
        html: `<p>Bonjour ${user.name},</p><p>Votre demande de remboursement pour la commande <strong>#${refund.order_id}</strong> a été <strong>refusée</strong>.</p><p>Raison: ${admin_note}</p><p>Contactez-nous: ${process.env.ADMIN_EMAIL || 'support@babicard.ci'}</p>`
      }).catch(() => {});
    }

    logAdminAction(req, 'REJECT_REFUND', `order#${refund.order_id}`, { refund_id: refund.id });
    res.json({ message: 'Remboursement refusé.' });
  } catch (err) {
    console.error('Erreur reject refund:', err);
    res.status(500).json({ error: 'Erreur.' });
  }
});

// DELETE /api/admin/fcm-tokens — Purger tous les tokens FCM invalides
router.delete('/fcm-tokens', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const result = db.prepare('DELETE FROM fcm_tokens').run();
    res.json({ message: `${result.changes} token(s) FCM supprimé(s).` });
  } catch (err) {
    res.status(500).json({ error: 'Erreur.' });
  }
});

// POST /api/admin/send-notification — Envoyer une notification push à tous les utilisateurs
router.post('/send-notification', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, body } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Titre et message requis.' });

    const db = getDb();
    const { sendToAll } = require('../services/notifications');
    const result = await sendToAll(db, title, body);

    logAdminAction(req, 'send_notification', 'all_users', { title, body, ...result });
    res.json({ message: `Notification envoyée: ${result.sent} reçue(s), ${result.failed} échouée(s).`, ...result });
  } catch (err) {
    console.error('Erreur send-notification:', err);
    res.status(500).json({ error: 'Erreur envoi notification.' });
  }
});

// POST /api/admin/reset-payments — TEMPORAIRE — réinitialise toutes les données de paiement
router.post('/reset-payments', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = getDb();
    db.pragma('foreign_keys = OFF');
    const reset = db.transaction(() => {
      const ri = db.prepare('DELETE FROM order_items').run();
      const ro = db.prepare('DELETE FROM orders').run();
      const rc = db.prepare("UPDATE cards SET status = 'available', order_id = NULL, sold_at = NULL").run();
      let se = 0, wr = 0, rr = 0;
      try { se = db.prepare('DELETE FROM seller_earnings').run().changes; } catch(e) {}
      try { wr = db.prepare('DELETE FROM withdrawal_requests').run().changes; } catch(e) {}
      try { rr = db.prepare('DELETE FROM refund_requests').run().changes; } catch(e) {}
      return { orders: ro.changes, items: ri.changes, cards_reset: rc.changes, earnings: se, withdrawals: wr, refunds: rr };
    });
    const result = reset();
    db.pragma('foreign_keys = ON');
    console.log('[ADMIN] Reset paiements effectué:', result);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Erreur reset paiements:', err);
    res.status(500).json({ error: 'Erreur reset.' });
  }
});

module.exports = router;
