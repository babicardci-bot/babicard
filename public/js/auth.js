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
  // Clear cart
  localStorage.removeItem('cart');
  window.location.href = '/';
}

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
