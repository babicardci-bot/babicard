// =============================================
// Babicard.ci — Auth utility functions
// =============================================

const API_BASE = '/api';

// ============ BRAND COLOR (disponible sur toutes les pages) ============
(function applyBrandColor() {
  fetch('/api/settings').then(r => r.json()).then(data => {
    if (data.logo && data.logo.accent_color) {
      document.documentElement.style.setProperty('--logo-accent-color', data.logo.accent_color);
    }
  }).catch(() => {});
})();

// ============ THEME (disponible sur toutes les pages) ============
function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  applyTheme(saved, false);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next, true);
  localStorage.setItem('theme', next);
}

function applyTheme(theme, animate) {
  if (animate) {
    document.documentElement.style.transition = 'background-color 0.4s, color 0.4s';
    setTimeout(() => document.documentElement.style.transition = '', 500);
  }
  document.documentElement.setAttribute('data-theme', theme);
  const knob = document.getElementById('themeKnob');
  if (knob) knob.textContent = theme === 'dark' ? '🌙' : '☀️';
}

// Init thème dès le chargement du script (évite le flash)
(function() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();

function getToken() {
  return localStorage.getItem('token');
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}

function setAuth(token, user) {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
}

function clearAuth() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

function isLoggedIn() {
  return !!getToken();
}

function isAdmin() {
  const user = getUser();
  return user && user.role === 'admin';
}

function logout() {
  clearAuth();
  localStorage.removeItem('cart');
  localStorage.removeItem('lastActivity');
  window.location.href = '/';
}

// ============ AUTO-DÉCONNEXION après 15min d'inactivité ============
const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes

function updateActivity() {
  localStorage.setItem('lastActivity', Date.now().toString());
}

function checkInactivity() {
  if (!isLoggedIn()) return;
  const last = parseInt(localStorage.getItem('lastActivity') || '0');
  if (!last) { updateActivity(); return; }
  if (Date.now() - last > INACTIVITY_TIMEOUT) {
    clearAuth();
    localStorage.removeItem('cart');
    localStorage.removeItem('lastActivity');
    const redirectTo = window.location.pathname.startsWith('/admin') ? '/login?redirect=/admin' : '/login';
    window.location.href = redirectTo;
  }
}

// Démarrer le suivi d'inactivité si l'utilisateur est connecté
(function initInactivityTracker() {
  if (!isLoggedIn()) return;
  updateActivity();
  // Seulement les actions délibérées (pas mousemove)
  ['keydown', 'click', 'scroll', 'touchstart', 'mousedown'].forEach(evt => {
    document.addEventListener(evt, updateActivity, { passive: true });
  });
  // Vérifie toutes les 30 secondes
  setInterval(checkInactivity, 30 * 1000);
})();

// Authenticated fetch wrapper
async function authFetch(url, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { 'Authorization': `Bearer ${token}` }),
    ...options.headers
  };

  const response = await fetch(API_BASE + url, { ...options, headers });

  if (response.status === 401) {
    clearAuth();
    window.location.href = '/login?redirect=' + encodeURIComponent(window.location.pathname);
    return;
  }

  return response;
}

// Update navbar based on auth state
function updateNavbar() {
  const user = getUser();
  const navAuth = document.getElementById('navAuth');
  const navUser = document.getElementById('navUser');
  const navUserName = document.getElementById('navUserName');

  if (!navAuth) return;

  if (user) {
    navAuth.classList.add('hidden');
    navUser.classList.remove('hidden');
    if (navUserName) navUserName.textContent = user.name;
  } else {
    navAuth.classList.remove('hidden');
    navUser.classList.add('hidden');
  }
}

// Initialize on page load
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    updateNavbar();
    initNavbarScroll();
  });
}

function initNavbarScroll() {
  const navbar = document.getElementById('navbar');
  if (!navbar) return;
  window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  });
}

function toggleMobileNav() {
  const navLinks = document.getElementById('navLinks');
  if (navLinks) {
    navLinks.classList.toggle('mobile-open');
  }
}
