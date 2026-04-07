// ============ FIREBASE PUSH NOTIFICATIONS ============
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAJJWhEHCr1CBbn2AA0UJ3gdS2HYPrsPK8",
  authDomain: "babicard-ci.firebaseapp.com",
  projectId: "babicard-ci",
  storageBucket: "babicard-ci.firebasestorage.app",
  messagingSenderId: "1003419055824",
  appId: "1:1003419055824:web:f3f828e3c69f6c746d50d5"
};

// VAPID key — à remplacer avec ta clé publique Firebase Cloud Messaging
const VAPID_KEY = 'BOGqWh6UsWH8UZ0Y0X3C1iSkYtIk1s7bkf1KYX-PTGQcxDD72WeS8aPD3FIzUripOrJl-Bqzzyw0klFbqELBfaM';

let firebaseApp = null;
let messaging = null;

async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
  if (!localStorage.getItem('token')) return; // Seulement si connecté

  try {
    const { initializeApp, getApps } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js');
    const { getMessaging, getToken, onMessage } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging.js');

    if (!getApps().length) {
      firebaseApp = initializeApp(FIREBASE_CONFIG);
    } else {
      firebaseApp = getApps()[0];
    }
    messaging = getMessaging(firebaseApp);

    // Enregistrer le service worker
    const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');

    // Demander permission si pas encore accordée
    if (Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
    }
    if (Notification.permission !== 'granted') return;

    // Obtenir le token FCM
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: swReg });
    if (token) {
      await saveFcmToken(token);
      console.log('[FCM] Token enregistré.');
    }

    // Notifications en premier plan
    onMessage(messaging, payload => {
      const { title, body } = payload.notification || {};
      if (title && typeof showToast === 'function') {
        showToast(`${title} — ${body}`, 'success');
      }
      // Rafraîchir les commandes si sur le dashboard
      if (typeof loadOrders === 'function') loadOrders();
    });

  } catch (err) {
    console.warn('[FCM] Erreur init push:', err.message);
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

// Initialiser automatiquement
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(initPushNotifications, 2000); // Délai pour ne pas bloquer le chargement
});
