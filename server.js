require('dotenv').config();

// Clé de chiffrement obligatoire — les codes de cartes doivent être chiffrés au repos
if (!process.env.CARD_ENCRYPTION_KEY || !/^[0-9a-f]{64}$/i.test(process.env.CARD_ENCRYPTION_KEY)) {
  console.error('[FATAL] CARD_ENCRYPTION_KEY manquante ou invalide (doit faire 64 caractères hexadécimaux). Arrêt du serveur.');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();

// Confiance au proxy Railway
app.set('trust proxy', 1);

// Sécurité — headers HTTP
app.use(helmet({
  contentSecurityPolicy: false, // désactivé car on sert des fichiers HTML avec scripts inline
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true },
  frameguard: { action: 'deny' },
  xContentTypeOptions: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// CORS — accepter seulement les origines connues
const allowedOrigins = [
  'https://babicard.ci',
  'https://www.babicard.ci',
  'https://babicard-production.up.railway.app',
  'http://localhost:3000',
  'http://localhost:8080'
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS non autorisé'));
  },
  credentials: true
}));

// Rate limiting global — 500 requêtes par 15 minutes par IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Trop de requêtes, réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
}));

// Rate limiting strict sur login — 5 tentatives par 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de tentatives de connexion, réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiting souple sur mot de passe oublié — 5 par heure
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de demandes de réinitialisation, réessayez dans 1 heure.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiting sur les paiements — 10 initiations par 15 minutes
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de tentatives de paiement, réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Rate limiting sur les retraits vendeur — 3 demandes par heure
const withdrawalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Trop de demandes de retrait, réessayez dans 1 heure.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    if (req.path.includes('/webhook')) req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.apk')) {
      res.setHeader('Content-Type', 'application/vnd.android.package-archive');
      res.setHeader('Content-Disposition', 'attachment; filename="Babicard.apk"');
    }
  }
}));

// SEO files — sitemap dynamique incluant les produits actifs
app.get('/sitemap.xml', (req, res) => {
  try {
    const { getDb } = require('./database/db');
    const db = getDb();
    const baseUrl = process.env.SITE_URL || 'https://www.babicard.ci';
    const staticPages = ['', '/about', '/faq', '/cgu'];
    const products = db.prepare("SELECT id FROM products WHERE is_active = 1").all();

    const urls = [
      ...staticPages.map(p => `<url><loc>${baseUrl}${p}</loc><changefreq>weekly</changefreq><priority>${p === '' ? '1.0' : '0.7'}</priority></url>`),
      ...products.map(p => `<url><loc>${baseUrl}/?product=${p.id}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`)
    ].join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(xml);
  } catch(e) {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.sendFile(require('path').join(__dirname, 'public/sitemap.xml'));
  }
});
app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(require('path').join(__dirname, 'public/robots.txt'));
});

// Serve uploads from persistent volume (/data/uploads) if available, fallback to public/uploads
const persistentUploadsDir = process.env.DB_PATH
  ? require('path').join(require('path').dirname(process.env.DB_PATH), 'uploads')
  : null;
if (persistentUploadsDir) {
  require('fs').mkdirSync(persistentUploadsDir, { recursive: true });
  app.use('/uploads', require('express').static(persistentUploadsDir));
}

// Ensure upload directories exist
const uploadDirs = ['public/uploads', 'public/uploads/seller-docs'];
uploadDirs.forEach(dir => {
  const fullPath = path.join(__dirname, dir);
  if (!require('fs').existsSync(fullPath)) require('fs').mkdirSync(fullPath, { recursive: true });
});

// API Routes — login/register limité à 10/15min, forgot-password à 5/heure
const authRouter = require('./routes/auth');
app.use('/api/auth/forgot-password', forgotPasswordLimiter);
app.use('/api/auth/reset-password', forgotPasswordLimiter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/products', require('./routes/products'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/payment/djamo/initiate', paymentLimiter);
app.use('/api/payment/djamo/status', rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Trop de requêtes.' } }));
app.use('/api/payment', require('./routes/payment'));

// Rate limiting admin — 200 requêtes par 15 minutes
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Trop de requêtes admin, réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/admin', adminLimiter, require('./routes/admin'));
app.use('/api/sellers/withdraw', withdrawalLimiter);
app.use('/api/sellers', require('./routes/sellers'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/promos', require('./routes/promos'));

// Health check
app.get('/api/health', (req, res) => {
  try {
    const db = require('./database/db').getDb();
    const usersCount  = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const ordersCount = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
    const cardsCount  = db.prepare("SELECT COUNT(*) as c FROM cards WHERE status = 'available'").get().c;
    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      db: 'connected',
      stats: { users: usersCount, orders: ordersCount, cards_available: cardsCount }
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message, timestamp: new Date().toISOString() });
  }
});

// SPA fallback
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/seller', (req, res) => res.sendFile(path.join(__dirname, 'public', 'seller-dashboard.html')));
app.get('/seller-register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'seller-register.html')));
app.get('/forgot-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot-password.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));
app.get('/2fa-setup', (_req, res) => res.sendFile(path.join(__dirname, 'public', '2fa-setup.html')));
app.get('/about', (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/faq', (req, res) => res.sendFile(path.join(__dirname, 'public', 'faq.html')));
app.get('/cgu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cgu.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 404 for unknown API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Route API non trouvée' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err.stack);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || 'Erreur interne du serveur',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

const PORT = process.env.PORT || 3000;

// Auto-cancel pending orders older than 30 minutes
function cancelExpiredOrders() {
  try {
    const { getDb } = require('./database/db');
    const db = getDb();
    const expiredOrders = db.prepare(`
      SELECT id FROM orders
      WHERE payment_status = 'pending'
      AND created_at <= datetime('now', '-30 minutes')
    `).all();

    if (expiredOrders.length === 0) return;

    const cancelOrder = db.transaction((orders) => {
      for (const order of orders) {
        db.prepare("UPDATE orders SET payment_status = 'failed' WHERE id = ?").run(order.id);
        db.prepare("UPDATE cards SET status = 'available', order_id = NULL WHERE order_id = ? AND status = 'reserved'").run(order.id);
      }
    });

    cancelOrder(expiredOrders);
    console.log(`[AUTO-CANCEL] ${expiredOrders.length} commande(s) expirée(s) annulée(s).`);
  } catch (err) {
    console.error('[AUTO-CANCEL] Erreur:', err.message);
  }
}

// Initialize Firebase
const { initFirebase } = require('./services/notifications');
initFirebase();

// Initialize DB then start server
const { initializeDatabase } = require('./database/db');
initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n========================================`);
      console.log(`  Babicard.ci — Serveur démarré`);
      console.log(`  URL:   http://localhost:${PORT}`);
      console.log(`  Admin: http://localhost:${PORT}/admin`);
      console.log(`  API:   http://localhost:${PORT}/api/health`);
      console.log(`========================================\n`);
    });

    // Run every 10 minutes
    setInterval(cancelExpiredOrders, 10 * 60 * 1000);
    cancelExpiredOrders(); // run once on startup
  })
  .catch(err => {
    console.error('Erreur initialisation base de données:', err);
    process.exit(1);
  });

module.exports = app;
