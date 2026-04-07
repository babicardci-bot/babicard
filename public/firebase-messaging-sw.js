importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAJJWhEHCr1CBbn2AA0UJ3gdS2HYPrsPK8",
  authDomain: "babicard-ci.firebaseapp.com",
  projectId: "babicard-ci",
  storageBucket: "babicard-ci.firebasestorage.app",
  messagingSenderId: "1003419055824",
  appId: "1:1003419055824:web:f3f828e3c69f6c746d50d5"
});

const messaging = firebase.messaging();

// Notification en arrière-plan
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification;
  self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    vibrate: [200, 100, 200],
    data: { url: payload.data?.link || '/dashboard#orders' }
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || '/dashboard#orders'));
});
