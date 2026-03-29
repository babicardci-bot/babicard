// =============================================
// Babicard.ci — Main JS (Slider + Products)
// =============================================

// Init thème immédiatement (évite le flash blanc/noir)
(function() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();

// Échappement HTML — protection XSS
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============ SLIDER ============
let currentSlide = 0;
let totalSlides = 5;
let sliderInterval = null;

function initSlider() {
  clearInterval(sliderInterval);
  sliderInterval = setInterval(() => {
    changeSlide(1);
  }, 4500);

  // Pause on hover — attach only once
  const slider = document.getElementById('heroSlider');
  if (slider && !slider._sliderHoverBound) {
    slider._sliderHoverBound = true;
    slider.addEventListener('mouseenter', () => clearInterval(sliderInterval));
    slider.addEventListener('mouseleave', () => {
      clearInterval(sliderInterval);
      sliderInterval = setInterval(() => changeSlide(1), 4500);
    });
  }
}

function changeSlide(direction) {
  const slides = document.querySelectorAll('.slide');
  const dots = document.querySelectorAll('.dot');
  if (!slides.length) return;

  slides[currentSlide].classList.remove('active');
  dots[currentSlide]?.classList.remove('active');

  currentSlide = (currentSlide + direction + totalSlides) % totalSlides;

  slides[currentSlide].classList.add('active');
  dots[currentSlide]?.classList.add('active');
}

function goToSlide(index) {
  const slides = document.querySelectorAll('.slide');
  const dots = document.querySelectorAll('.dot');
  if (!slides.length) return;

  slides[currentSlide].classList.remove('active');
  dots[currentSlide]?.classList.remove('active');

  currentSlide = index;
  slides[currentSlide].classList.add('active');
  dots[currentSlide]?.classList.add('active');

  // Reset timer
  clearInterval(sliderInterval);
  sliderInterval = setInterval(() => changeSlide(1), 4500);
}

// ============ PRODUCTS ============
let allProducts = [];
let currentCategory = '';
let currentSearch = '';

async function loadProducts() {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;

  grid.innerHTML = `<div class="loading-products"><div class="loading-spinner"></div><p>Chargement des produits...</p></div>`;

  try {
    const params = new URLSearchParams({ limit: 50 });
    const response = await fetch(`/api/products?${params}`);
    const data = await response.json();
    allProducts = data.products || [];
    renderProducts(allProducts);
  } catch (err) {
    grid.innerHTML = `
      <div class="no-products">
        <div class="no-products-icon">⚠️</div>
        <p>Erreur lors du chargement des produits.</p>
        <button onclick="loadProducts()" class="btn-secondary">Réessayer</button>
      </div>
    `;
  }
}

function filterProducts(category) {
  currentCategory = category;
  currentSearch = '';
  if (document.getElementById('searchInput')) {
    document.getElementById('searchInput').value = '';
  }

  // Update active category button
  document.querySelectorAll('.category-card').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.category === category);
  });

  const filtered = allProducts.filter(p =>
    category === '' || p.category === category
  );

  renderProducts(filtered);

  // Smooth scroll to products
  const productsSection = document.getElementById('products');
  if (productsSection) {
    productsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function searchProducts(query) {
  currentSearch = query.toLowerCase().trim();
  const filtered = allProducts.filter(p => {
    const matchSearch = !currentSearch ||
      p.name.toLowerCase().includes(currentSearch) ||
      p.platform.toLowerCase().includes(currentSearch) ||
      p.denomination.toLowerCase().includes(currentSearch);
    const matchCategory = !currentCategory || p.category === currentCategory;
    return matchSearch && matchCategory;
  });
  renderProducts(filtered);
}

function getCategoryIcon(category) {
  const icons = {
    apple: '🍎',
    playstation: '🎮',
    xbox: '🟢',
    google: '🎯',
    steam: '🖥️',
    netflix: '🎬',
    amazon: '📦',
    other: '🎁'
  };
  return icons[category] || '🎁';
}

function getCategoryLabel(category) {
  const labels = {
    apple: 'Apple',
    playstation: 'PlayStation',
    xbox: 'Xbox',
    google: 'Google Play',
    steam: 'Steam',
    netflix: 'Netflix',
    amazon: 'Amazon',
    other: 'Autre'
  };
  return labels[category] || category;
}

function formatPrice(amount) {
  return new Intl.NumberFormat('fr-FR').format(amount) + ' FCFA';
}

function renderProducts(products) {
  const grid = document.getElementById('productsGrid');
  const noProducts = document.getElementById('noProducts');

  if (!grid) return;

  if (products.length === 0) {
    grid.innerHTML = '';
    noProducts?.classList.remove('hidden');
    return;
  }

  noProducts?.classList.add('hidden');

  grid.innerHTML = products.map(product => {
    const inStock = product.available_stock > 0;
    const icon = getCategoryIcon(product.category);

    return `
      <div class="product-card animate-in" onclick="openProductModal(${product.id})" data-product-id="${product.id}">
        <div class="product-card-image bg-${product.category || 'other'}">
          <span class="product-badge ${inStock ? 'badge-instock' : 'badge-outofstock'}">
            ${inStock ? '✓ Disponible' : '✕ Rupture'}
          </span>
          ${product.image_url
            ? `<img src="${esc(product.image_url)}" alt="${esc(product.name)}" class="product-card-img-cover">`
            : `<span class="card-brand-icon">${icon}</span><span class="card-brand-name">${getCategoryLabel(product.category)}</span>`
          }
        </div>
        <div class="product-card-body">
          <div class="product-platform">${esc(product.platform)}</div>
          <div class="product-name">${esc(product.name)}</div>
          <div class="product-denomination">${esc(product.denomination)}</div>
          ${product.seller_shop_name ? `<div class="product-seller">🏪 ${esc(product.seller_shop_name)}</div>` : '<div class="product-seller" style="color:var(--color-primary-light);font-size:0.7rem;">✓ Babicard.ci Officiel</div>'}
          <div class="product-footer">
            <div class="product-price">
              ${formatPrice(product.price)}
              <small>≈ ${product.denomination}</small>
            </div>
            <button
              class="btn-add-cart"
              onclick="event.stopPropagation(); addToCart(${product.id})"
              ${!inStock ? 'disabled' : ''}
            >
              ${inStock ? '+ Panier' : 'Épuisé'}
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function openProductModal(productId) {
  const product = allProducts.find(p => p.id === productId);
  if (!product) return;

  const modal = document.getElementById('productModal');
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');

  const inStock = product.available_stock > 0;
  const icon = getCategoryIcon(product.category);

  content.innerHTML = `
    <div class="modal-product-image bg-${product.category || 'other'}" style="width:100%;height:200px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:4rem;overflow:hidden;position:relative;border-radius:var(--radius-lg) var(--radius-lg) 0 0;">
      ${product.image_url
        ? `<img src="${product.image_url}" alt="${product.name}" style="width:100%;height:100%;object-fit:cover;display:block;position:absolute;inset:0;">`
        : icon
      }
      <button onclick="closeModal()" style="position:absolute;top:12px;right:12px;width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,0.5);backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,0.15);color:#fff;font-size:1rem;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2;">✕</button>
    </div>
    <div style="padding:24px;">
      <div style="color:var(--color-primary-light);font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">${esc(product.platform)}</div>
      <h2 style="font-size:1.4rem;font-weight:700;margin-bottom:8px">${esc(product.name)}</h2>
      <p style="color:var(--text-secondary);font-size:0.9rem;line-height:1.6;margin-bottom:20px">${esc(product.description || 'Carte cadeau numérique. Livraison immédiate par email et SMS.')}</p>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
        <div style="background:var(--bg-card);padding:12px;border-radius:8px;border:1px solid var(--border-color);">
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">Valeur</div>
          <div style="font-size:1.1rem;font-weight:700;color:var(--color-primary-light)">${product.denomination}</div>
        </div>
        <div style="background:var(--bg-card);padding:12px;border-radius:8px;border:1px solid var(--border-color);">
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">Prix</div>
          <div style="font-size:1.1rem;font-weight:700;color:var(--color-primary-light)">${formatPrice(product.price)}</div>
        </div>
        <div style="background:var(--bg-card);padding:12px;border-radius:8px;border:1px solid var(--border-color);">
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">Plateforme</div>
          <div style="font-size:0.9rem;font-weight:600">${esc(product.platform)}</div>
        </div>
        <div style="background:var(--bg-card);padding:12px;border-radius:8px;border:1px solid var(--border-color);">
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">Disponibilité</div>
          <div style="font-size:0.9rem;font-weight:600;color:${inStock ? 'var(--color-green)' : '#ef4444'}">${inStock ? '✓ En stock' : '✕ Rupture de stock'}</div>
        </div>
      </div>

      <div style="display:flex;gap:12px">
        <button
          onclick="addToCart(${product.id}); closeModal();"
          style="flex:1;padding:14px;background:linear-gradient(135deg,var(--color-primary),#8b5cf6);border:none;border-radius:12px;color:white;font-size:1rem;font-weight:700;cursor:pointer;transition:all 0.3s"
          ${!inStock ? 'disabled style="opacity:0.5;cursor:not-allowed"' : ''}
        >
          ${inStock ? '🛒 Ajouter au panier' : '❌ Stock épuisé'}
        </button>
      </div>
    </div>
  `;

  modal.classList.add('active');
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  const modal = document.getElementById('productModal');
  const overlay = document.getElementById('modalOverlay');
  modal?.classList.remove('active');
  overlay?.classList.remove('active');
  document.body.style.overflow = '';
}

// ============ PARTICLES (CSS-based) ============
function createParticles() {
  const container = document.getElementById('particles');
  if (!container) return;

  // Add pulsing glow elements
  for (let i = 0; i < 5; i++) {
    const glow = document.createElement('div');
    glow.style.cssText = `
      position: absolute;
      width: ${200 + Math.random() * 300}px;
      height: ${200 + Math.random() * 300}px;
      border-radius: 50%;
      background: radial-gradient(circle, ${i % 2 === 0 ? 'rgba(108, 99, 255, 0.08)' : 'rgba(0, 212, 255, 0.05)'} 0%, transparent 70%);
      top: ${Math.random() * 100}%;
      left: ${Math.random() * 100}%;
      transform: translate(-50%, -50%);
      animation: pulse ${4 + Math.random() * 4}s ease-in-out infinite;
      animation-delay: ${Math.random() * 4}s;
    `;
    container.appendChild(glow);
  }

  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse {
      0%, 100% { opacity: 0.3; transform: translate(-50%, -50%) scale(1); }
      50% { opacity: 0.8; transform: translate(-50%, -50%) scale(1.2); }
    }
  `;
  document.head.appendChild(style);
}

// ============ THEME ============
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

// ============ DYNAMIC SETTINGS (logo + sliders) ============
async function loadSiteSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const data = await res.json();
    if (data.logo) applyLogo(data.logo);
    if (data.sliders && data.sliders.length) applySliders(data.sliders);
  } catch(e) {
    // Fallback to static HTML — do nothing
  }
}

function applyLogo(logo) {
  // Apply accent color as CSS variable globally → affects ALL pages
  if (logo.accent_color) {
    document.documentElement.style.setProperty('--logo-accent-color', logo.accent_color);
  }

  const iconEl = document.querySelector('.nav-logo .logo-icon');
  const textEl = document.querySelector('.nav-logo .logo-text');
  if (!iconEl || !textEl) return;

  if (logo.type === 'image' && logo.image_url) {
    iconEl.innerHTML = '<img src="' + logo.image_url + '" style="max-height:36px;vertical-align:middle;">';
    textEl.textContent = '';
  } else {
    iconEl.textContent = logo.emoji || '🎮';
    textEl.innerHTML = (logo.text || 'Babicard') + '<span class="logo-accent">' + (logo.accent || '.ci') + '</span>';
  }
}

function applySliders(sliders) {
  const container = document.getElementById('heroSlider');
  if (!container) return;

  // Keep nav arrows and dots wrapper if present
  const prevBtn = container.querySelector('.slider-prev');
  const nextBtn = container.querySelector('.slider-next');
  const dotsWrapper = container.querySelector('.slider-dots');

  // Remove existing slides
  container.querySelectorAll('.slide').forEach(s => s.remove());

  // Re-insert slides before arrows
  sliders.forEach((slide, idx) => {
    const pricesHtml = (slide.prices || []).map(p => '<span class="price-tag">' + p + '</span>').join('');
    const div = document.createElement('div');
    div.className = 'slide' + (idx === 0 ? ' active' : '');
    div.dataset.slide = idx;
    div.innerHTML =
      '<div class="slide-bg" style="background:' + (slide.bg_gradient || 'linear-gradient(135deg,#1a1a2e,#16213e)') + ';' + (slide.image_url ? 'background-image:url(' + slide.image_url + ');background-size:cover;background-position:center;background-blend-mode:overlay;' : '') + '"></div>' +
      '<div class="slide-content">' +
      '<div class="slide-brand">' +
      '<div class="brand-badge" style="background:' + (slide.icon_bg || '#333') + ';width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2rem;">' + (slide.icon_emoji || '🎮') + '</div>' +
      '</div>' +
      '<div class="slide-text">' +
      '<span class="slide-tag">' + (slide.tag || '') + '</span>' +
      '<h1 class="slide-title">' + (slide.title || '') + '<br><span class="slide-title-accent">' + (slide.title_accent || '') + '</span></h1>' +
      '<p class="slide-desc">' + (slide.description || '') + '</p>' +
      '<div class="slide-prices">' + pricesHtml + '</div>' +
      '<a href="#products" class="slide-cta">' + (slide.cta_text || 'Acheter →') + '</a>' +
      '</div>' +
      '</div>';
    // Insert before arrows or append
    if (prevBtn) container.insertBefore(div, prevBtn);
    else container.appendChild(div);
  });

  // Update dots
  if (dotsWrapper) {
    dotsWrapper.innerHTML = sliders.map((_, i) =>
      '<span class="dot' + (i === 0 ? ' active' : '') + '" onclick="goToSlide(' + i + ')"></span>'
    ).join('');
  }

  // Reset slider state
  currentSlide = 0;
  totalSlides = sliders.length;
  clearInterval(sliderInterval);
  initSlider();
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  loadSiteSettings();
  initSlider();
  createParticles();
  loadProducts();
  updateNavbar();

  // Keyboard navigation for slider
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') changeSlide(-1);
    if (e.key === 'ArrowRight') changeSlide(1);
    if (e.key === 'Escape') closeModal();
  });

  // Intersection observer for animations
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.animationDelay = '0s';
        entry.target.classList.add('animate-in');
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.step-card, .payment-card, .testimonial-card').forEach(el => {
    observer.observe(el);
  });
});

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
