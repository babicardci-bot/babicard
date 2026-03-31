const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb } = require('../database/db');
const { authenticateToken, generateToken } = require('../middleware/auth');
const { sendPasswordResetEmail, sendWelcomeEmail, sendEmailVerificationEmail } = require('../services/email');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nom, email et mot de passe sont obligatoires.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse email invalide.' });
    }

    const db = getDb();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const result = db.prepare(
      `INSERT INTO users (name, email, phone, password_hash, role, email_verified) VALUES (?, ?, ?, ?, 'client', 0)`
    ).run(name.trim(), email.toLowerCase().trim(), phone || null, password_hash);

    const userId = result.lastInsertRowid;
    const user = db.prepare('SELECT id, name, email, phone, role, created_at FROM users WHERE id = ?').get(userId);

    // Generate email verification token (24h)
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, verifyToken, expiresAt);

    const baseUrl = process.env.SITE_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const verifyLink = `${baseUrl}/api/auth/verify-email?token=${verifyToken}`;

    sendEmailVerificationEmail(user, verifyLink).catch(() => {});

    res.status(201).json({
      message: 'Compte créé ! Vérifiez votre email pour activer votre compte.',
      email_verification_required: true
    });
  } catch (err) {
    console.error('Erreur register:', err);
    res.status(500).json({ error: 'Erreur lors de la création du compte.' });
  }
});

// GET /api/auth/verify-email?token=xxx
router.get('/verify-email', (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string' || token.length > 100) {
      return res.redirect('/login?verify_error=1');
    }

    const db = getDb();
    const record = db.prepare('SELECT * FROM email_verification_tokens WHERE token = ? AND used = 0').get(token);

    if (!record) return res.redirect('/login?verify_error=1');
    if (new Date(record.expires_at) < new Date()) return res.redirect('/login?verify_expired=1');

    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(record.user_id);
    db.prepare('UPDATE email_verification_tokens SET used = 1 WHERE id = ?').run(record.id);

    res.redirect('/login?verified=1');
  } catch (err) {
    console.error('Erreur verify-email:', err);
    res.redirect('/login?verify_error=1');
  }
});

// POST /api/auth/resend-verification
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obligatoire.' });

    const db = getDb();
    const user = db.prepare('SELECT id, name, email, email_verified FROM users WHERE email = ?').get(email.toLowerCase().trim());

    // Always return success to avoid email enumeration
    if (!user || user.email_verified) {
      return res.json({ message: 'Si cet email existe et n\'est pas encore vérifié, un lien a été envoyé.' });
    }

    // Invalidate old tokens
    db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(user.id);

    const verifyToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, verifyToken, expiresAt);

    const baseUrl = process.env.SITE_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const verifyLink = `${baseUrl}/api/auth/verify-email?token=${verifyToken}`;

    await sendEmailVerificationEmail(user, verifyLink);

    res.json({ message: 'Si cet email existe et n\'est pas encore vérifié, un lien a été envoyé.' });
  } catch (err) {
    console.error('Erreur resend-verification:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe sont obligatoires.' });
    }

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (!user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
    }

    // Block unverified accounts — only allow login if explicitly verified (= 1)
    if (user.email_verified !== 1) {
      return res.status(403).json({
        error: 'Veuillez vérifier votre adresse email avant de vous connecter.',
        email_not_verified: true
      });
    }

    const token = generateToken(user.id, user.token_version || 0);
    res.json({
      message: 'Connexion réussie!',
      token,
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role, created_at: user.created_at }
    });
  } catch (err) {
    console.error('Erreur login:', err);
    res.status(500).json({ error: 'Erreur lors de la connexion.' });
  }
});

// POST /api/auth/logout — invalide le token côté serveur
router.post('/logout', authenticateToken, (req, res) => {
  try {
    const db = getDb();
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
    res.json({ message: 'Déconnexion réussie.' });
  } catch (err) {
    console.error('Erreur logout:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/auth/me
router.get('/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// PUT /api/auth/me — mettre à jour nom et téléphone
router.put('/me', authenticateToken, (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Le nom est obligatoire.' });
    }
    if (name.trim().length < 2) {
      return res.status(400).json({ error: 'Le nom doit contenir au moins 2 caractères.' });
    }

    const phoneVal = phone?.trim() || null;
    if (phoneVal) {
      const cleaned = phoneVal.replace(/[\s\-\(\)\.]/g, '');
      const normalized = cleaned.startsWith('00225') ? '+' + cleaned.slice(2)
        : cleaned.startsWith('+225') ? cleaned
        : cleaned.startsWith('225') ? '+' + cleaned
        : '+225' + cleaned;
      if (!/^\+225\d{10}$/.test(normalized)) {
        return res.status(400).json({ error: 'Numéro de téléphone invalide. Format attendu : +225 suivi de 10 chiffres.' });
      }
    }

    const db = getDb();
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name.trim(), phoneVal, req.user.id);

    const updated = db.prepare('SELECT id, name, email, phone, role, created_at FROM users WHERE id = ?').get(req.user.id);
    res.json({ message: 'Profil mis à jour avec succès.', user: updated });
  } catch (err) {
    console.error('Erreur update profile:', err);
    res.status(500).json({ error: 'Erreur lors de la mise à jour du profil.' });
  }
});

// DELETE /api/auth/me — supprimer son compte (RGPD)
router.delete('/me', authenticateToken, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Mot de passe requis pour confirmer la suppression.' });

    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Compte introuvable.' });

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Mot de passe incorrect.' });

    if (user.role === 'admin') return res.status(403).json({ error: 'Un compte administrateur ne peut pas être supprimé.' });

    // Check no pending orders
    const pendingOrder = db.prepare("SELECT id FROM orders WHERE user_id = ? AND payment_status = 'pending'").get(req.user.id);
    if (pendingOrder) return res.status(400).json({ error: 'Annulez vos commandes en attente avant de supprimer votre compte.' });

    const deleteAccount = db.transaction(() => {
      // Release any reserved cards
      db.prepare("UPDATE cards SET status = 'available', order_id = NULL WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?) AND status = 'reserved'").run(req.user.id);
      // Anonymize orders (keep for accounting, remove personal data)
      db.prepare("UPDATE orders SET delivery_email = '', delivery_phone = '' WHERE user_id = ?").run(req.user.id);
      // Delete tokens
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(req.user.id);
      db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(req.user.id);
      // Delete seller profile if exists
      db.prepare('DELETE FROM seller_profiles WHERE user_id = ?').run(req.user.id);
      // Delete the user account
      db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    });

    deleteAccount();
    res.json({ message: 'Compte supprimé avec succès. Vos données personnelles ont été effacées.' });
  } catch (err) {
    console.error('Erreur delete account:', err);
    res.status(500).json({ error: 'Erreur lors de la suppression du compte.' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe sont obligatoires.' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères.' });
    }

    const db = getDb();
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const isValid = await bcrypt.compare(current_password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
    }

    const new_hash = await bcrypt.hash(new_password, 12);
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(new_hash, req.user.id);
    res.json({ message: 'Mot de passe modifié avec succès.' });
  } catch (err) {
    console.error('Erreur change-password:', err);
    res.status(500).json({ error: 'Erreur lors du changement de mot de passe.' });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obligatoire.' });

    const db = getDb();
    const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email.toLowerCase().trim());

    // Always return success to avoid email enumeration
    if (!user) return res.json({ message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' });

    // Generate token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    // Invalidate old tokens for this user
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);

    // Save new token
    db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(user.id, token, expiresAt);

    const baseUrl = process.env.SITE_URL || process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resetLink = `${baseUrl}/reset-password?token=${token}`;

    await sendPasswordResetEmail(user, resetLink);

    res.json({ message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' });
  } catch (err) {
    console.error('Erreur forgot-password:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) return res.status(400).json({ error: 'Token et nouveau mot de passe obligatoires.' });
    if (new_password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });

    const db = getDb();
    const record = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0').get(token);

    if (!record) return res.status(400).json({ error: 'Lien invalide ou déjà utilisé.' });
    if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: 'Ce lien a expiré. Veuillez faire une nouvelle demande.' });

    const new_hash = await bcrypt.hash(new_password, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(new_hash, record.user_id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(record.id);

    res.json({ message: 'Mot de passe réinitialisé avec succès. Vous pouvez maintenant vous connecter.' });
  } catch (err) {
    console.error('Erreur reset-password:', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// GET /api/auth/unsubscribe — Unsubscribe from marketing emails (no auth required)
router.get('/unsubscribe', (req, res) => {
  try {
    const { token, uid } = req.query;
    if (!token || !uid) return res.status(400).send('Lien invalide.');

    const db = getDb();
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(parseInt(uid));
    if (!user) return res.status(404).send('Compte introuvable.');

    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret')
      .update(`unsub:${user.id}:${user.email}`)
      .digest('hex');

    if (token !== expected) return res.status(400).send('Lien invalide ou expiré.');

    db.prepare('UPDATE users SET marketing_emails = 0 WHERE id = ?').run(user.id);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Désinscription</title></head>
<body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f0f7;">
<h2 style="color:#6C63FF;">✓ Désinscription confirmée</h2>
<p>Vous ne recevrez plus d'emails marketing de Babicard.ci.</p>
<p><a href="${process.env.SITE_URL || 'https://babicard.ci'}" style="color:#6C63FF;">Retour au site</a></p>
</body></html>`);
  } catch (err) {
    console.error('Erreur unsubscribe:', err);
    res.status(500).send('Erreur serveur.');
  }
});

module.exports = router;
