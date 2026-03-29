require('dotenv').config();
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

// Rate limiting global — 200 requêtes par 15 minutes par IP
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
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

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// SEO files
app.get('/sitemap.xml', (req, res) => {
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.sendFile(require('path').join(__dirname, 'public/sitemap.xml'));
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
app.use('/api/payment', require('./routes/payment'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/sellers', require('./routes/sellers'));
app.use('/api/settings', require('./routes/settings'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Babicard.ci API is running', timestamp: new Date().toISOString() });
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
  })
  .catch(err => {
    console.error('Erreur initialisation base de données:', err);
    process.exit(1);
  });

module.exports = app;
