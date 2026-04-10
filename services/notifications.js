const admin = require('firebase-admin');

let initialized = false;

function initFirebase() {
  if (initialized) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    console.warn('[FCM] Variables Firebase manquantes — notifications désactivées.');
    return;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey })
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
  results.forEach((r, i) => {
    if (!r.success && r.error?.includes('registration-token')) {
      db.prepare('DELETE FROM fcm_tokens WHERE token = ?').run(tokens[i].token);
    }
  });
}

module.exports = { initFirebase, sendPushNotification, sendToUser };
