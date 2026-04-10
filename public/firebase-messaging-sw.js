importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDOEDLgEXLLjGlBsi3qtLXLDobu2pS5PhY",
  authDomain: "babicard-ci-689e8.firebaseapp.com",
  projectId: "babicard-ci-689e8",
  storageBucket: "babicard-ci-689e8.firebasestorage.app",
  messagingSenderId: "84378128568",
  appId: "1:84378128568:android:9b6d6f850904d3f689244d"
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
