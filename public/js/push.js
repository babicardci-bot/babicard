// ============ FIREBASE PUSH NOTIFICATIONS ============
const VAPID_KEY = 'BC_4VMOqBClpJ1AlGrd75Y7YFgi1XOThtDTnfmGZvEJ2u0SbttdmQFDvRFUnG75kwQ-11sEF7GBY65IT_Fayy0A';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDOEDLgEXLLjGlBsi3qtLXLDobu2pS5PhY",
  authDomain: "babicard-ci-689e8.firebaseapp.com",
  projectId: "babicard-ci-689e8",
  storageBucket: "babicard-ci-689e8.firebasestorage.app",
  messagingSenderId: "84378128568",
  appId: "1:84378128568:android:9b6d6f850904d3f689244d"
};

async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    console.warn('[FCM] Push non supporté sur ce navigateur.');
    return;
  }
  if (!localStorage.getItem('token')) return;

  try {
    // Enregistrer le service worker
    const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    console.log('[FCM] Service worker enregistré.');

    // Initialiser Firebase si pas déjà fait
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const messaging = firebase.messaging();

    // Demander permission
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      console.log('[FCM] Permission:', perm);
      if (perm !== 'granted') return;
    }
    if (Notification.permission !== 'granted') return;

    // Obtenir le token FCM
    const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (token) {
      await saveFcmToken(token);
      console.log('[FCM] Token enregistré avec succès.');
    }

    // Notifications en premier plan
    messaging.onMessage(payload => {
      console.log('[FCM] Message reçu:', payload);
      const { title, body } = payload.notification || {};
      if (title && typeof showToast === 'function') {
        showToast(`${title} — ${body}`, 'success');
      }
      if (typeof loadOrders === 'function') loadOrders();
    });

  } catch (err) {
    console.error('[FCM] Erreur:', err.message);
  }
}

async function saveFcmToken(token) {
  const authToken = localStorage.getItem('token');
  if (!authToken) return;
  await fetch('/api/notifications/token', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(initPushNotifications, 2000);
});
