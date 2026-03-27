const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../database/db');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// Multer config — upload logo
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `logo_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|png|gif|webp|svg\+xml)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Seules les images sont acceptées (JPG, PNG, GIF, WEBP, SVG).'));
  }
});

// Default slider config
const DEFAULT_SLIDERS = [
  {
    id: 1, active: true,
    tag: '🎮 Gaming',
    title: 'PlayStation',
    title_accent: 'Network Cards',
    description: 'Rechargez votre PSN. Achetez des jeux, DLC, PS Plus directement depuis votre PS4/PS5.',
    prices: ['10$ → 6 500 FCFA', '20$ → 12 500 FCFA', '50$ → 30 500 FCFA'],
    cta_text: 'Acheter maintenant →',
    bg_gradient: 'linear-gradient(135deg, #000814 0%, #001a4d 30%, #003087 60%, #0055a5 85%, #1a1a2e 100%)',
    icon_emoji: '🎮', icon_bg: '#003087'
  },
  {
    id: 2, active: true,
    tag: '🟢 Microsoft',
    title: 'Xbox',
    title_accent: 'Gift Cards',
    description: 'Alimentez votre Xbox Wallet. Jeux, add-ons, Xbox Game Pass Ultimate à portée de main.',
    prices: ['10$ → 6 500 FCFA', '25$ → 15 500 FCFA'],
    cta_text: 'Découvrir →',
    bg_gradient: 'linear-gradient(135deg, #000a00 0%, #001a00 30%, #107C10 65%, #1db31d 85%, #0a1a0a 100%)',
    icon_emoji: '🟢', icon_bg: '#107C10'
  },
  {
    id: 3, active: true,
    tag: '🍎 Apple',
    title: 'iTunes &',
    title_accent: 'App Store Cards',
    description: 'Achetez apps, musiques, films, séries sur l\'App Store et iTunes. Valable pour les comptes US.',
    prices: ['5$ → 3 200 FCFA', '10$ → 6 200 FCFA', '25$ → 15 200 FCFA'],
    cta_text: 'Acheter →',
    bg_gradient: 'linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 30%, #555 60%, #888 80%, #1a1a1a 100%)',
    icon_emoji: '🍎', icon_bg: '#555'
  },
  {
    id: 4, active: true,
    tag: '🖥️ PC Gaming',
    title: 'Steam',
    title_accent: 'Wallet Cards',
    description: 'Des milliers de jeux PC sur Steam. Rechargez votre wallet et profitez des meilleures promos.',
    prices: ['10$ → 6 500 FCFA', '20$ → 12 500 FCFA'],
    cta_text: 'Explorer →',
    bg_gradient: 'linear-gradient(135deg, #000000 0%, #0a1520 30%, #1b2838 60%, #2a475e 80%, #0a0f1a 100%)',
    icon_emoji: '🖥️', icon_bg: '#1b2838'
  },
  {
    id: 5, active: true,
    tag: '🎯 Android',
    title: 'Google Play',
    title_accent: 'Gift Cards',
    description: 'Apps, jeux, films, livres sur le Google Play Store. Compatible avec tout appareil Android.',
    prices: ['10$ → 6 200 FCFA', '25$ → 15 200 FCFA'],
    cta_text: 'Acheter →',
    bg_gradient: 'linear-gradient(135deg, #001a3d 0%, #0033a0 30%, #4285F4 60%, #34A853 80%, #001a3d 100%)',
    icon_emoji: '▶', icon_bg: '#4285F4'
  }
];

const DEFAULT_LOGO = {
  type: 'emoji',   // 'emoji' or 'image'
  emoji: '🎮',
  text: 'GiftCard',
  accent: 'CI',
  image_url: ''
};

// Helper: get setting value
function getSetting(db, key, defaultVal) {
  const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(key);
  if (!row) return defaultVal;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

// Helper: set setting value
function setSetting(db, key, value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare(`
    INSERT INTO site_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, str);
}

// ===== PUBLIC =====

// GET /api/settings — Public: return logo + sliders for the frontend
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const logo = getSetting(db, 'logo', DEFAULT_LOGO);
    const sliders = getSetting(db, 'sliders', DEFAULT_SLIDERS);
    res.json({ logo, sliders: sliders.filter(s => s.active !== false) });
  } catch (err) {
    res.json({ logo: DEFAULT_LOGO, sliders: DEFAULT_SLIDERS });
  }
});

// ===== ADMIN =====

// GET /api/admin/settings — Admin: all settings including inactive sliders
router.get('/admin', authenticateToken, requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const logo = getSetting(db, 'logo', DEFAULT_LOGO);
    const sliders = getSetting(db, 'sliders', DEFAULT_SLIDERS);
    res.json({ logo, sliders });
  } catch (err) {
    res.status(500).json({ error: 'Erreur chargement paramètres.' });
  }
});

// PUT /api/admin/settings/logo — Update logo config (text/emoji)
router.put('/admin/logo', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { type, emoji, text, accent, accent_color, image_url } = req.body;
    const db = getDb();
    const current = getSetting(db, 'logo', DEFAULT_LOGO);
    const updated = {
      type: type || current.type,
      emoji: emoji !== undefined ? emoji : current.emoji,
      text: text !== undefined ? text : current.text,
      accent: accent !== undefined ? accent : current.accent,
      accent_color: accent_color !== undefined ? accent_color : (current.accent_color || '#6C63FF'),
      image_url: image_url !== undefined ? image_url : current.image_url
    };
    setSetting(db, 'logo', updated);
    res.json({ message: 'Logo mis à jour.', logo: updated });
  } catch (err) {
    res.status(500).json({ error: 'Erreur mise à jour logo.' });
  }
});

// POST /api/admin/settings/logo/upload — Upload logo image file
router.post('/admin/logo/upload', authenticateToken, requireAdmin, upload.single('logo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu.' });
    const db = getDb();
    const imageUrl = `/uploads/${req.file.filename}`;
    const current = getSetting(db, 'logo', DEFAULT_LOGO);
    // Delete old uploaded logo if it was one
    if (current.image_url && current.image_url.startsWith('/uploads/')) {
      const oldPath = path.join(__dirname, '../public', current.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    const updated = { ...current, type: 'image', image_url: imageUrl };
    setSetting(db, 'logo', updated);
    res.json({ message: 'Logo uploadé avec succès.', image_url: imageUrl, logo: updated });
  } catch (err) {
    console.error('Erreur upload logo:', err);
    res.status(500).json({ error: err.message || 'Erreur upload.' });
  }
});

// PUT /api/admin/settings/sliders — Update all sliders
router.put('/admin/sliders', authenticateToken, requireAdmin, (req, res) => {
  try {
    const { sliders } = req.body;
    if (!Array.isArray(sliders) || sliders.length === 0) {
      return res.status(400).json({ error: 'Tableau de sliders invalide.' });
    }
    // Validate each slide has required fields
    for (const s of sliders) {
      if (!s.title || !s.description) {
        return res.status(400).json({ error: 'Chaque slide doit avoir un titre et une description.' });
      }
    }
    const db = getDb();
    setSetting(db, 'sliders', sliders);
    res.json({ message: `${sliders.length} slide(s) sauvegardé(s).`, sliders });
  } catch (err) {
    res.status(500).json({ error: 'Erreur sauvegarde sliders.' });
  }
});

module.exports = router;
module.exports.DEFAULT_SLIDERS = DEFAULT_SLIDERS;
module.exports.DEFAULT_LOGO = DEFAULT_LOGO;
