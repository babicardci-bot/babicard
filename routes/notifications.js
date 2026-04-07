const express = require('express');
const router = express.Router();
const { getDb } = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

// POST /api/notifications/token — enregistrer le token FCM
router.post('/token', authenticateToken, (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.length > 500) {
    return res.status(400).json({ error: 'Token invalide.' });
  }
  const db = getDb();
  db.prepare(`
    INSERT INTO fcm_tokens (user_id, token)
    VALUES (?, ?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, created_at = CURRENT_TIMESTAMP
  `).run(req.user.id, token);
  res.json({ success: true });
});

// DELETE /api/notifications/token — supprimer le token FCM
router.delete('/token', authenticateToken, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token requis.' });
  const db = getDb();
  db.prepare('DELETE FROM fcm_tokens WHERE token = ? AND user_id = ?').run(token, req.user.id);
  res.json({ success: true });
});

module.exports = router;
