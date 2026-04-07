// ============ FIREBASE PUSH NOTIFICATIONS ============
const VAPID_KEY = 'BOGqWh6UsWH8UZ0Y0X3C1iSkYtIk1s7bkf1KYX-PTGQcxDD72WeS8aPD3FIzUripOrJl-Bqzzyw0klFbqELBfaM';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAJJWhEHCr1CBbn2AA0UJ3gdS2HYPrsPK8",
  authDomain: "babicard-ci.firebaseapp.com",
  projectId: "babicard-ci",
  storageBucket: "babicard-ci.firebasestorage.app",
  messagingSenderId: "1003419055824",
  appId: "1:1003419055824:web:f3f828e3c69f6c746d50d5"
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
