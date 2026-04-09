const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// POST /api/promos/validate — valider un code promo
router.post('/validate', authenticateToken, (req, res) => {
  try {
    const { code, order_amount } = req.body;
    if (!code || !order_amount) {
      return res.status(400).json({ error: 'Code et montant requis.' });
    }

    const db = getDb();
    const promo = db.prepare(`
      SELECT * FROM promo_codes
      WHERE LOWER(code) = LOWER(?)
        AND is_active = 1
        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        AND (max_uses IS NULL OR uses_count < max_uses)
    `).get(code.trim());

    if (!promo) {
      return res.status(404).json({ error: 'Code promo invalide ou expiré.' });
    }

    // Vérifier si l'utilisateur a déjà utilisé ce code
    const alreadyUsed = db.prepare(
      'SELECT id FROM promo_code_uses WHERE promo_code_id = ? AND user_id = ?'
    ).get(promo.id, req.user.id);

    if (alreadyUsed) {
      return res.status(400).json({ error: 'Vous avez déjà utilisé ce code promo.' });
    }

    // Vérifier le montant minimum
    if (order_amount < promo.min_order_amount) {
      return res.status(400).json({
        error: `Commande minimum de ${promo.min_order_amount} FCFA requise pour ce code.`
      });
    }

    // Calculer la réduction
    let discountAmount = 0;
    if (promo.discount_type === 'percent') {
      discountAmount = Math.round(order_amount * promo.discount_value / 100);
    } else {
      discountAmount = Math.min(promo.discount_value, order_amount);
    }

    res.json({
      valid: true,
      promo: {
        id: promo.id,
        code: promo.code,
        discount_type: promo.discount_type,
        discount_value: promo.discount_value,
        discount_amount: discountAmount,
        final_amount: order_amount - discountAmount,
      }
    });
  } catch (err) {
    console.error('Erreur validate promo:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ── Admin routes ──────────────────────────────────────────────────────────────

// GET /api/promos — liste des codes promo (admin)
router.get('/', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const promos = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM promo_code_uses WHERE promo_code_id = p.id) as uses_count
    FROM promo_codes p
    ORDER BY p.created_at DESC
  `).all();
  res.json({ promos });
});

// POST /api/promos — créer un code promo (admin)
router.post('/', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { code, discount_type, discount_value, min_order_amount = 0, max_uses, expires_at } = req.body;
    if (!code || !discount_type || !discount_value) {
      return res.status(400).json({ error: 'Code, type et valeur requis.' });
    }
    if (!['percent', 'fixed'].includes(discount_type)) {
      return res.status(400).json({ error: 'Type invalide (percent ou fixed).' });
    }
    if (discount_type === 'percent' && (discount_value < 1 || discount_value > 100)) {
      return res.status(400).json({ error: 'Pourcentage entre 1 et 100.' });
    }

    const db = getDb();
    const result = db.prepare(`
      INSERT INTO promo_codes (code, discount_type, discount_value, min_order_amount, max_uses, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(code.toUpperCase().trim(), discount_type, discount_value, min_order_amount, max_uses || null, expires_at || null);

    res.json({ message: 'Code promo créé.', id: result.lastInsertRowid });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Ce code existe déjà.' });
    }
    console.error('Erreur create promo:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// PUT /api/promos/:id — activer/désactiver (admin)
router.put('/:id', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  const { is_active } = req.body;
  db.prepare('UPDATE promo_codes SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, req.params.id);
  res.json({ message: 'Mis à jour.' });
});

// DELETE /api/promos/:id — supprimer (admin)
router.delete('/:id', authenticateToken, requireAdmin, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM promo_codes WHERE id = ?').run(req.params.id);
  res.json({ message: 'Supprimé.' });
});

module.exports = router;
