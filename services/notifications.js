const admin = require('firebase-admin');
const path = require('path');

let initialized = false;

function initFirebase() {
  if (initialized) return;
  try {
    const serviceAccount = require('./firebase-service-account.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    initialized = true;
    console.log('[FCM] Firebase Admin initialisé (FCM V1).');
  } catch (err) {
    console.warn('[FCM] Erreur initialisation Firebase:', err.message);
  }
}

async function sendPushNotification(fcmToken, title, body, data = {}) {
  if (!initialized) return { success: false, error: 'Firebase non initialisé' };
  try {
    await admin.messaging().send({
      token: fcmToken,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: {
        notification: { icon: 'ic_launcher', color: '#6C63FF' }
      },
      webpush: {
        notification: { icon: '/icons/icon-192.png', badge: '/icons/icon-72.png', vibrate: [200, 100, 200] },
        fcmOptions: { link: '/dashboard#orders' }
      }
    });
    return { success: true };
  } catch (err) {
    console.error('[FCM] Erreur envoi:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendToUser(db, userId, title, body, data = {}) {
  const tokens = db.prepare('SELECT token FROM fcm_tokens WHERE user_id = ?').all(userId);
  if (!tokens.length) return;
  const results = await Promise.all(tokens.map(t => sendPushNotification(t.token, title, body, data)));
  // Supprimer les tokens invalides
  results.forEach((r, i) => {
    if (!r.success && r.error?.includes('registration-token')) {
      db.prepare('DELETE FROM fcm_tokens WHERE token = ?').run(tokens[i].token);
    }
  });
}

module.exports = { initFirebase, sendPushNotification, sendToUser };
