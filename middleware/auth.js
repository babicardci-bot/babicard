const jwt = require('jsonwebtoken');
const { getDb } = require('../database/db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set.');
  process.exit(1);
}

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Accès refusé. Token manquant.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const user = await db.prepare('SELECT id, name, email, phone, role FROM users WHERE id = ?').get(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: 'Utilisateur non trouvé.' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expirée. Veuillez vous reconnecter.' });
    }
    return res.status(403).json({ error: 'Token invalide.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé aux administrateurs.' });
  }
  next();
}

function requireSeller(req, res, next) {
  const db = require('../database/db').getDb();
  const profile = db.prepare("SELECT status FROM seller_profiles WHERE user_id = ?").get(req.user.id);
  if (!profile || profile.status !== 'approved') {
    return res.status(403).json({ error: 'Accès refusé. Compte vendeur non approuvé.' });
  }
  next();
}

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '24h' });
}

function logAdminAction(req, action, target = null, details = null) {
  try {
    const db = getDb();
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
    db.prepare(`INSERT INTO admin_logs (admin_id, admin_email, action, target, details, ip) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, req.user.email, action, target, details ? JSON.stringify(details) : null, ip);
  } catch (e) {
    console.error('[ADMIN LOG ERROR]', e.message);
  }
}

module.exports = { authenticateToken, requireAdmin, requireSeller, generateToken, logAdminAction };
