const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../database/db');
const { authenticateToken, requireSeller } = require('../middleware/auth');
const { sendWithdrawalRequestEmail } = require('../services/email');

// Multer — seller document upload (one file at a time)
const docUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, '../public/uploads/seller-docs');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `seller_doc_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|webp)|application\/pdf/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Format non accepté. JPG, PNG, WEBP ou PDF uniquement.'));
  }
});

// POST /api/sellers/upload-doc — Upload a single document file, returns URL
router.post('/upload-doc', authenticateToken, (req, res) => {
  docUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
    res.json({ url: `/uploads/seller-docs/${req.file.filename}` });
  });
});

// POST /api/sellers/apply - Apply to become a seller (JSON body + pre-uploaded doc URLs)
router.post('/apply', authenticateToken, (req, res) => {
  try {
    const { shop_name, description, wave_number, orange_number, contact_email, id_doc_url, address_doc_url } = req.body;
    const db = getDb();

    if (!shop_name || shop_name.trim().length < 3) {
      return res.status(400).json({ error: 'Le nom de la boutique doit contenir au moins 3 caractères.' });
    }
    if (!contact_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email.trim())) {
      return res.status(400).json({ error: 'Une adresse email de contact valide est obligatoire.' });
    }
    if (!id_doc_url) {
      return res.status(400).json({ error: 'La pièce d\'identité (CNI ou passeport) est obligatoire.' });
    }
    if (!address_doc_url) {
      return res.status(400).json({ error: 'Le registre de commerce est obligatoire.' });
    }

    const existing = db.prepare('SELECT id FROM seller_profiles WHERE user_id = ?').get(req.user.id);
    if (existing) {
      return res.status(409).json({ error: 'Vous avez déjà soumis une demande vendeur.' });
    }

    const shopExists = db.prepare('SELECT id FROM seller_profiles WHERE shop_name = ?').get(shop_name.trim());
    if (shopExists) {
      return res.status(409).json({ error: 'Ce nom de boutique est déjà pris.' });
    }

    db.prepare(`
      INSERT INTO seller_profiles (user_id, shop_name, description, wave_number, orange_number, contact_email, id_doc_url, address_doc_url, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(req.user.id, shop_name.trim(), description || '', wave_number || '', orange_number || '', contact_email.trim(), id_doc_url, address_doc_url || '');

    res.status(201).json({ message: "Demande vendeur soumise avec succès. En attente de validation par l'administrateur." });
  } catch (err) {
    console.error('Erreur apply seller:', err);
    res.status(500).json({ error: 'Erreur lors de la soumission.' });
  }
});

// GET /api/sellers/me - Get my seller profile
router.get('/me', authenticateToken, (req, res) => {
  try {
    const db = getDb();
    const profile = db.prepare(`
      SELECT sp.*, u.name, u.email, u.phone
      FROM seller_profiles sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.user_id = ?
    `).get(req.user.id);

    if (!profile) {
      return res.status(404).json({ error: 'Profil vendeur non trouvé.' });
    }

    // Stats — requêtes séparées pour éviter la multiplication des lignes via JOIN
    const productsCount = db.prepare(`
      SELECT COUNT(*) as total_products FROM products WHERE seller_id = ? AND is_active = 1
    `).get(req.user.id);

    const earningsStats = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status != 'pending' THEN net_amount ELSE 0 END), 0) as total_earnings,
        COALESCE(SUM(CASE WHEN status = 'available' THEN net_amount ELSE 0 END), 0) as gross_available,
        COALESCE(SUM(CASE WHEN status = 'withdrawn' THEN net_amount ELSE 0 END), 0) as withdrawn_total,
        COUNT(DISTINCT CASE WHEN id IS NOT NULL THEN order_id END) as total_sales
      FROM seller_earnings WHERE seller_id = ?
    `).get(req.user.id);

    const stats = { ...productsCount, ...earningsStats };

    // Déduire les retraits en cours (pending + approved) du solde disponible
    const pendingWithdrawals = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM withdrawal_requests
      WHERE seller_id = ? AND status IN ('pending', 'approved')
    `).get(req.user.id).total;

    stats.available_balance = Math.max(0, stats.gross_available - pendingWithdrawals);
    stats.pending_withdrawal = pendingWithdrawals;
    delete stats.gross_available;

    res.json({ profile, stats });
  } catch (err) {
    console.error('Erreur seller me:', err);
    res.status(500).json({ error: 'Erreur chargement profil.' });
  }
});

// PUT /api/sellers/me - Update seller profile
router.put('/me', authenticateToken, requireSeller, (req, res) => {
  try {
    const { description, wave_number, orange_number, logo_url } = req.body;
    const db = getDb();

    db.prepare(`
      UPDATE seller_profiles SET description = ?, wave_number = ?, orange_number = ?, logo_url = ?
      WHERE user_id = ?
    `).run(description || '', wave_number || '', orange_number || '', logo_url || '', req.user.id);

    res.json({ message: 'Profil mis à jour.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur mise à jour profil.' });
  }
});

// GET /api/sellers/products - My products
router.get('/products', authenticateToken, requireSeller, (req, res) => {
  try {
    const db = getDb();
    const products = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id AND status = 'available') as available_cards,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id AND status = 'sold') as sold_cards
      FROM products p
      WHERE p.seller_id = ?
      ORDER BY p.created_at DESC
    `).all(req.user.id);
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: 'Erreur chargement produits.' });
  }
});

// POST /api/sellers/products - Create product
router.post('/products', authenticateToken, requireSeller, (req, res) => {
  try {
    const { name, description, category, image_url, price, denomination, platform } = req.body;
    const db = getDb();

    if (!name || !category || !price || !denomination || !platform) {
      return res.status(400).json({ error: 'Champs obligatoires: name, category, price, denomination, platform.' });
    }
    if (parseInt(price) < 500) {
      return res.status(400).json({ error: 'Le prix minimum est 500 FCFA.' });
    }

    const result = db.prepare(`
      INSERT INTO products (name, description, category, image_url, price, denomination, platform, stock_count, is_active, seller_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
    `).run(name, description || '', category, image_url || '', parseInt(price), denomination, platform, req.user.id);

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ message: 'Produit créé.', product });
  } catch (err) {
    console.error('Erreur create seller product:', err);
    res.status(500).json({ error: 'Erreur création produit.' });
  }
});

// PUT /api/sellers/products/:id - Update own product
router.put('/products/:id', authenticateToken, requireSeller, (req, res) => {
  try {
    const { name, description, category, image_url, price, denomination, platform, is_active } = req.body;
    const db = getDb();

    const product = db.prepare('SELECT * FROM products WHERE id = ? AND seller_id = ?').get(req.params.id, req.user.id);
    if (!product) return res.status(404).json({ error: 'Produit non trouvé.' });

    db.prepare(`
      UPDATE products SET name=?, description=?, category=?, image_url=?, price=?, denomination=?, platform=?, is_active=?
      WHERE id = ? AND seller_id = ?
    `).run(
      name || product.name,
      description !== undefined ? description : product.description,
      category || product.category,
      image_url !== undefined ? image_url : product.image_url,
      price ? parseInt(price) : product.price,
      denomination || product.denomination,
      platform || product.platform,
      is_active !== undefined ? (is_active ? 1 : 0) : product.is_active,
      req.params.id, req.user.id
    );

    res.json({ message: 'Produit mis à jour.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur mise à jour.' });
  }
});

// POST /api/sellers/cards/bulk - Add cards to own product
router.post('/cards/bulk', authenticateToken, requireSeller, (req, res) => {
  try {
    const { product_id, cards } = req.body;
    const db = getDb();

    if (!product_id || !cards || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ error: 'product_id et tableau de cartes requis.' });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ? AND seller_id = ?').get(product_id, req.user.id);
    if (!product) return res.status(404).json({ error: 'Produit non trouvé ou non autorisé.' });

    const insertCard = db.prepare(`INSERT INTO cards (product_id, code, pin, serial, card_name, card_price, status) VALUES (?, ?, ?, ?, ?, ?, 'available')`);
    const insertMany = db.transaction((cards) => {
      let inserted = 0, skipped = 0;
      for (const card of cards) {
        if (!card.code || !card.code.trim()) { skipped++; continue; }
        try {
          insertCard.run(product_id, card.code.trim(), card.pin || null, card.serial || null, card.card_name || null, card.card_price ? parseFloat(card.card_price) : null);
          inserted++;
        }
        catch(e) { skipped++; }
      }
      return { inserted, skipped };
    });

    const result = insertMany(cards);
    const stockCount = db.prepare('SELECT COUNT(*) as count FROM cards WHERE product_id = ? AND status = ?').get(product_id, 'available').count;
    db.prepare('UPDATE products SET stock_count = ? WHERE id = ?').run(stockCount, product_id);

    res.status(201).json({ message: `${result.inserted} carte(s) ajoutée(s). ${result.skipped} ignorée(s).`, inserted: result.inserted, total_stock: stockCount });
  } catch (err) {
    console.error('Erreur seller bulk cards:', err);
    res.status(500).json({ error: 'Erreur ajout cartes.' });
  }
});

// GET /api/sellers/sales - My sales (order items with my products)
router.get('/sales', authenticateToken, requireSeller, (req, res) => {
  try {
    const db = getDb();
    const { page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const sales = db.prepare(`
      SELECT oi.*, o.created_at as order_date, o.payment_status, o.payment_method,
        p.name as product_name, p.platform, p.denomination,
        u.name as buyer_name,
        se.net_amount, se.commission_amount, se.status as earning_status
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      JOIN users u ON o.user_id = u.id
      LEFT JOIN seller_earnings se ON se.order_item_id = oi.id
      WHERE p.seller_id = ?
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.user.id, parseInt(limit), offset);

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      JOIN products p ON oi.product_id = p.id
      WHERE p.seller_id = ?
    `).get(req.user.id).count;

    res.json({ sales, total, page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: 'Erreur chargement ventes.' });
  }
});

// GET /api/sellers/earnings - Earnings summary
router.get('/earnings', authenticateToken, requireSeller, (req, res) => {
  try {
    const db = getDb();

    const raw = db.prepare(`
      SELECT
        COALESCE(SUM(net_amount), 0) as total_earned,
        COALESCE(SUM(CASE WHEN status = 'available' THEN net_amount ELSE 0 END), 0) as gross_available,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN net_amount ELSE 0 END), 0) as pending_balance,
        COALESCE(SUM(CASE WHEN status = 'withdrawn' THEN net_amount ELSE 0 END), 0) as total_withdrawn,
        COUNT(*) as total_transactions
      FROM seller_earnings WHERE seller_id = ?
    `).get(req.user.id);

    // Déduire les retraits en cours du solde disponible
    const pendingWd = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM withdrawal_requests
      WHERE seller_id = ? AND status IN ('pending', 'approved')
    `).get(req.user.id).total;

    const summary = {
      ...raw,
      available_balance: Math.max(0, raw.gross_available - pendingWd),
      pending_withdrawal: pendingWd
    };
    delete summary.gross_available;

    const recent = db.prepare(`
      SELECT se.*, o.payment_method, p.name as product_name
      FROM seller_earnings se
      JOIN orders o ON se.order_id = o.id
      JOIN order_items oi ON se.order_item_id = oi.id
      JOIN products p ON oi.product_id = p.id
      WHERE se.seller_id = ?
      ORDER BY se.created_at DESC LIMIT 20
    `).all(req.user.id);

    res.json({ summary, recent });
  } catch (err) {
    res.status(500).json({ error: 'Erreur chargement gains.' });
  }
});

// POST /api/sellers/withdraw - Request withdrawal
router.post('/withdraw', authenticateToken, requireSeller, (req, res) => {
  try {
    const { amount, payment_method, payment_number } = req.body;
    const db = getDb();

    if (!amount || parseInt(amount) < 1000) {
      return res.status(400).json({ error: 'Le montant minimum de retrait est 1 000 FCFA.' });
    }
    if (!payment_method || !['wave', 'orange_money'].includes(payment_method)) {
      return res.status(400).json({ error: 'Méthode de paiement invalide.' });
    }
    if (!payment_number || payment_number.trim().length < 8) {
      return res.status(400).json({ error: 'Numéro de paiement invalide.' });
    }

    // Solde disponible = gains available - retraits en cours
    const grossAvailable = db.prepare(`
      SELECT COALESCE(SUM(net_amount), 0) as total
      FROM seller_earnings WHERE seller_id = ? AND status = 'available'
    `).get(req.user.id).total;

    const pendingWdAmount = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM withdrawal_requests WHERE seller_id = ? AND status IN ('pending', 'approved')
    `).get(req.user.id).total;

    const balance = Math.max(0, grossAvailable - pendingWdAmount);

    if (parseInt(amount) > balance) {
      return res.status(400).json({ error: `Solde insuffisant. Disponible: ${balance.toLocaleString('fr-FR')} FCFA` });
    }

    // Check no pending withdrawal
    const pendingWithdrawal = db.prepare(`SELECT id FROM withdrawal_requests WHERE seller_id = ? AND status = 'pending'`).get(req.user.id);
    if (pendingWithdrawal) {
      return res.status(400).json({ error: 'Vous avez déjà une demande de retrait en cours.' });
    }

    db.prepare(`
      INSERT INTO withdrawal_requests (seller_id, amount, payment_method, payment_number, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(req.user.id, parseInt(amount), payment_method, payment_number.trim());

    // Notifier l'admin par email
    const sellerProfile = db.prepare('SELECT shop_name FROM seller_profiles WHERE user_id = ?').get(req.user.id);
    sendWithdrawalRequestEmail(req.user, sellerProfile?.shop_name || req.user.name, parseInt(amount), payment_method, payment_number.trim())
      .catch(err => console.error('[WITHDRAWAL EMAIL ERROR]', err.message));

    res.status(201).json({ message: "Demande de retrait soumise. L'admin va traiter votre demande sous 24h." });
  } catch (err) {
    console.error('Erreur withdraw:', err);
    res.status(500).json({ error: 'Erreur demande retrait.' });
  }
});

// GET /api/sellers/withdrawals - My withdrawal history
router.get('/withdrawals', authenticateToken, requireSeller, (req, res) => {
  try {
    const db = getDb();
    const withdrawals = db.prepare(`
      SELECT * FROM withdrawal_requests WHERE seller_id = ? ORDER BY created_at DESC
    `).all(req.user.id);
    res.json({ withdrawals });
  } catch (err) {
    res.status(500).json({ error: 'Erreur chargement retraits.' });
  }
});

module.exports = router;
