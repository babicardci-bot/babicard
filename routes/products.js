const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

// GET /api/products - Public, with filters
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { category, platform, min_price, max_price, search, page = 1, limit = 20 } = req.query;
    const escapeLike = (s) => s.replace(/[%_\\]/g, '\\$&');

    let baseWhere = `p.is_active = 1 AND (p.seller_id IS NULL OR sp.status = 'approved')`;
    const params = [];

    if (category) {
      baseWhere += ' AND LOWER(p.category) = LOWER(?)';
      params.push(category);
    }

    if (platform) {
      baseWhere += " AND p.platform LIKE ? ESCAPE '\\'";
      params.push(`%${escapeLike(platform)}%`);
    }

    if (min_price) {
      baseWhere += ' AND p.price >= ?';
      params.push(parseInt(min_price));
    }

    if (max_price) {
      baseWhere += ' AND p.price <= ?';
      params.push(parseInt(max_price));
    }

    if (search) {
      const s = escapeLike(search);
      baseWhere += " AND (p.name LIKE ? OR p.description LIKE ? OR p.platform LIKE ? ESCAPE '\\')";
      params.push(`%${s}%`, `%${s}%`, `%${s}%`);
    }

    const countQuery = `SELECT COUNT(*) as total FROM products p LEFT JOIN seller_profiles sp ON p.seller_id = sp.user_id WHERE ${baseWhere}`;
    const total = db.prepare(countQuery).get(...params).total;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const query = `
      SELECT p.*,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id AND status = 'available') as available_stock,
        (SELECT ROUND(AVG(rating),1) FROM product_reviews WHERE product_id = p.id) as reviews_avg,
        (SELECT COUNT(*) FROM product_reviews WHERE product_id = p.id) as reviews_count,
        (SELECT COUNT(*) FROM cards c2
          LEFT JOIN seller_product_promos spp2 ON spp2.seller_id = c2.seller_id AND spp2.product_id = p.id AND spp2.status = 'approved'
          WHERE c2.product_id = p.id AND c2.status = 'available'
          AND (spp2.id IS NOT NULL OR (c2.seller_id IS NULL AND p.promo_price > 0))) as promo_stock,
        sp.shop_name as seller_shop_name,
        sp.status as seller_status,
        COALESCE(
          (SELECT MIN(spp.promo_price)
           FROM seller_product_promos spp
           JOIN cards c3 ON c3.seller_id = spp.seller_id AND c3.product_id = p.id AND c3.status = 'available'
           WHERE spp.product_id = p.id AND spp.status = 'approved'),
          NULLIF(p.promo_price, 0)
        ) as best_promo_price
      FROM products p
      LEFT JOIN seller_profiles sp ON p.seller_id = sp.user_id
      WHERE ${baseWhere}
      ORDER BY available_stock DESC, p.category, p.price ASC
      LIMIT ? OFFSET ?
    `;
    params.push(parseInt(limit), offset);

    const enriched = db.prepare(query).all(...params);

    res.json({
      products: enriched.map(p => ({ ...p, promo_price: p.best_promo_price || null })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error('Erreur products:', err);
    res.status(500).json({ error: 'Erreur lors du chargement des produits.' });
  }
});

// GET /api/products/categories - Get unique categories
router.get('/categories', (req, res) => {
  try {
    const db = getDb();
    const categories = db.prepare(
      'SELECT DISTINCT category, COUNT(*) as count FROM products WHERE is_active = 1 GROUP BY category ORDER BY category'
    ).all();
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: 'Erreur lors du chargement des catégories.' });
  }
});

// GET /api/products/featured - Top produits par ventes
router.get('/featured', (req, res) => {
  try {
    const db = getDb();
    const featured = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id AND status = 'available') as available_stock,
        COUNT(oi.id) as sales_count
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON oi.order_id = o.id AND o.payment_status = 'paid'
      LEFT JOIN seller_profiles sp ON p.seller_id = sp.user_id
      WHERE p.is_active = 1 AND (p.seller_id IS NULL OR sp.status = 'approved')
      GROUP BY p.id
      ORDER BY sales_count DESC, available_stock DESC
      LIMIT 8
    `).all();
    res.json({ products: featured });
  } catch (err) {
    console.error('Erreur featured:', err);
    res.status(500).json({ error: 'Erreur lors du chargement.' });
  }
});

// GET /api/products/:id - Public
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(req.params.id);

    if (!product) {
      return res.status(404).json({ error: 'Produit non trouvé.' });
    }

    const stockInfo = db.prepare(
      'SELECT COUNT(*) as available FROM cards WHERE product_id = ? AND status = ?'
    ).get(product.id, 'available');

    res.json({ product: { ...product, available_stock: stockInfo.available } });
  } catch (err) {
    console.error('Erreur product detail:', err);
    res.status(500).json({ error: 'Erreur lors du chargement du produit.' });
  }
});

// GET /api/products/:id/reviews - Public
router.get('/:id/reviews', (req, res) => {
  try {
    const db = getDb();
    const product = db.prepare('SELECT id FROM products WHERE id = ? AND is_active = 1').get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produit non trouvé.' });

    const reviews = db.prepare(`
      SELECT pr.id, pr.rating, pr.comment, pr.created_at,
             u.name as user_name
      FROM product_reviews pr
      JOIN users u ON pr.user_id = u.id
      WHERE pr.product_id = ?
      ORDER BY pr.created_at DESC
      LIMIT 50
    `).all(req.params.id);

    const stats = db.prepare(`
      SELECT COUNT(*) as total, AVG(rating) as avg_rating,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as r5,
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) as r4,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as r3,
        SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) as r2,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as r1
      FROM product_reviews WHERE product_id = ?
    `).get(req.params.id);

    res.json({
      reviews,
      stats: {
        total: stats.total || 0,
        avg_rating: stats.avg_rating ? Math.round(stats.avg_rating * 10) / 10 : 0,
        distribution: { 5: stats.r5 || 0, 4: stats.r4 || 0, 3: stats.r3 || 0, 2: stats.r2 || 0, 1: stats.r1 || 0 }
      }
    });
  } catch (err) {
    console.error('Erreur reviews GET:', err);
    res.status(500).json({ error: 'Erreur lors du chargement des avis.' });
  }
});

// POST /api/products/:id/reviews - Auth required
router.post('/:id/reviews', authenticateToken, (req, res) => {
  try {
    const db = getDb();
    const { rating, comment } = req.body;
    const productId = req.params.id;
    const userId = req.user.id;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'La note doit être entre 1 et 5.' });
    }

    const product = db.prepare('SELECT id FROM products WHERE id = ? AND is_active = 1').get(productId);
    if (!product) return res.status(404).json({ error: 'Produit non trouvé.' });

    // Vérifier que l'utilisateur a acheté ce produit
    const hasPurchased = db.prepare(`
      SELECT oi.id FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE oi.product_id = ? AND o.user_id = ? AND o.payment_status = 'paid'
      LIMIT 1
    `).get(productId, userId);
    if (!hasPurchased) return res.status(403).json({ error: 'Vous devez avoir acheté ce produit pour laisser un avis.' });

    // Check if user already reviewed this product
    const existing = db.prepare('SELECT id FROM product_reviews WHERE product_id = ? AND user_id = ?').get(productId, userId);
    if (existing) {
      // Update existing review
      db.prepare('UPDATE product_reviews SET rating = ?, comment = ? WHERE product_id = ? AND user_id = ?')
        .run(rating, comment || null, productId, userId);
    } else {
      db.prepare('INSERT INTO product_reviews (product_id, user_id, rating, comment) VALUES (?, ?, ?, ?)')
        .run(productId, userId, rating, comment || null);
    }

    const review = db.prepare(`
      SELECT pr.id, pr.rating, pr.comment, pr.created_at, u.name as user_name
      FROM product_reviews pr JOIN users u ON pr.user_id = u.id
      WHERE pr.product_id = ? AND pr.user_id = ?
    `).get(productId, userId);

    res.json({ review, message: existing ? 'Avis mis à jour.' : 'Avis publié.' });
  } catch (err) {
    console.error('Erreur reviews POST:', err);
    res.status(500).json({ error: 'Erreur lors de la publication de l\'avis.' });
  }
});

// POST /api/products/:id/notify — S'abonner aux alertes retour en stock
router.post('/:id/notify', authenticateToken, (req, res) => {
  try {
    const db = getDb();
    const productId = parseInt(req.params.id);
    const product = db.prepare('SELECT id, name FROM products WHERE id = ? AND is_active = 1').get(productId);
    if (!product) return res.status(404).json({ error: 'Produit non trouvé.' });
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.user.id);
    try {
      db.prepare('INSERT OR IGNORE INTO stock_notifications (product_id, user_id, email) VALUES (?, ?, ?)').run(productId, user.id, user.email);
    } catch(e) { /* déjà inscrit */ }
    res.json({ message: 'Vous serez notifié quand ce produit sera disponible.' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur inscription notification.' });
  }
});

module.exports = router;
