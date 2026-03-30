const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');

// GET /api/products - Public, with filters
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { category, platform, min_price, max_price, search, page = 1, limit = 20 } = req.query;

    let baseWhere = `p.is_active = 1 AND (p.seller_id IS NULL OR sp.status = 'approved')`;
    const params = [];

    if (category) {
      baseWhere += ' AND p.category = ?';
      params.push(category);
    }

    if (platform) {
      baseWhere += ' AND p.platform LIKE ?';
      params.push(`%${platform}%`);
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
      baseWhere += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.platform LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countQuery = `SELECT COUNT(*) as total FROM products p LEFT JOIN seller_profiles sp ON p.seller_id = sp.user_id WHERE ${baseWhere}`;
    const total = db.prepare(countQuery).get(...params).total;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const query = `
      SELECT p.*,
        (SELECT COUNT(*) FROM cards WHERE product_id = p.id AND status = 'available') as available_stock,
        (SELECT COUNT(*) FROM cards c2
          JOIN seller_product_promos spp ON spp.seller_id = c2.seller_id AND spp.product_id = p.id AND spp.status = 'approved'
          WHERE c2.product_id = p.id AND c2.status = 'available') as promo_stock,
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
      ORDER BY p.category, p.price ASC
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

module.exports = router;
