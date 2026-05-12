// =============================================
// Babicard.ci — Main JS (Slider + Products)
// =============================================

const REGION_WARNINGS = {
  'google play': { flag: '🇫🇷', label: 'France', msg: 'Cette carte est valable uniquement sur un compte Google Play configuré en France. Compte ivoirien non compatible.' },
  'psn':         { flag: '🇫🇷', label: 'France', msg: 'Cette carte PSN est valable uniquement sur un compte PlayStation configuré en France.' },
  'xbox':        { flag: '🌍', label: 'Global',  msg: null },
  'itunes':      { flag: '🇫🇷', label: 'France', msg: 'Cette carte iTunes/App Store est valable uniquement sur un compte Apple configuré en France.' },
};

function getProductRegion(product) {
  const name = (product.name + ' ' + (product.platform || '')).toLowerCase();
  for (const [key, val] of Object.entries(REGION_WARNINGS)) {
    if (name.includes(key)) return val;
  }
  return null;
}

function getRegionWarning(product) {
  const r = getProductRegion(product);
  return r && r.msg ? `${r.flag} <strong>Région ${r.label}</strong> — ${r.msg}` : null;
}

function getRegionGuide(product) {
  const name = (product.name + ' ' + (product.platform || '')).toLowerCase();
  if (name.includes('google play')) return `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(245,158,11,0.2);">
      <div style="font-size:0.78rem;color:#fbbf24;font-weight:600;margin-bottom:4px;">Comment changer votre région Google :</div>
      <ol style="margin:0;padding-left:16px;font-size:0.78rem;color:#d97706;line-height:1.8;">
        <li>Allez sur <strong>pay.google.com</strong></li>
        <li>Paramètres → Pays/Région → France</li>
        <li>Entrez une adresse française</li>
        <li>Puis entrez votre code cadeau</li>
      </ol>
    </div>`;
  if (name.includes('psn')) return `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(245,158,11,0.2);">
      <div style="font-size:0.78rem;color:#fbbf24;font-weight:600;margin-bottom:4px;">Comment utiliser sur PSN France :</div>
      <ol style="margin:0;padding-left:16px;font-size:0.78rem;color:#d97706;line-height:1.8;">
        <li>Créez un compte PSN avec région France</li>
        <li>PS5/PS4 → PlayStation Store → Entrer un code</li>
        <li>Saisissez votre code à 12 caractères</li>
      </ol>
    </div>`;
  if (name.includes('itunes')) return `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(245,158,11,0.2);">
      <div style="font-size:0.78rem;color:#fbbf24;font-weight:600;margin-bottom:4px;">Comment utiliser sur App Store France :</div>
      <ol style="margin:0;padding-left:16px;font-size:0.78rem;color:#d97706;line-height:1.8;">
        <li>Connectez-vous avec un Apple ID région France</li>
        <li>App Store → Profil → Entrer le code cadeau</li>
        <li>Saisissez votre code</li>
      </ol>
    </div>`;
  return '';
}

function getUsageInstructions(product) {
  const name = (product.name + ' ' + (product.platform || '')).toLowerCase();
  if (name.includes('google play')) return [
    'Ouvrez Google Play Store sur votre appareil',
    'Appuyez sur votre photo de profil → Paiements → Utiliser un code',
    'Entrez le code reçu par email',
    'Le crédit est ajouté immédiatement'
  ];
  if (name.includes('psn')) return [
    'Allez sur PlayStation Store (PS4/PS5 ou site web)',
    'Faites défiler vers le bas → "Entrer un code"',
    'Saisissez le code à 12 caractères reçu par email',
    'Le crédit est ajouté à votre portefeuille PSN'
  ];
  if (name.includes('xbox')) return [
    'Allez sur microsoft.com/redeem ou sur votre console Xbox',
    'Connectez-vous à votre compte Microsoft',
    'Entrez le code à 25 caractères reçu par email',
    'Le crédit est ajouté à votre compte Xbox'
  ];
  if (name.includes('itunes') || name.includes('apple')) return [
    'Ouvrez l\'App Store ou iTunes',
    'Appuyez sur votre profil → "Entrer le code cadeau"',
    'Saisissez le code reçu par email',
    'Le crédit est ajouté à votre Apple ID'
  ];
  if (name.includes('nintendo')) return [
    'Allez sur nintendo.com ou sur votre Nintendo Switch',
    'Nintendo eShop → Entrer le code',
    'Saisissez le code reçu par email',
    'Le crédit est ajouté à votre compte Nintendo'
  ];
  return [
    'Recevez votre code par email après paiement',
    'Suivez les instructions spécifiques à la plateforme',
    'Entrez le code dans la section appropriée',
    'Le crédit est ajouté immédiatement'
  ];
}

function getPromoCountdown(product) {
  if (!product.promo_price) return '';
  // Compte à rebours déterministe basé sur l'ID produit — se renouvelle toutes les 24h
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const seed = (product.id * 3600000) % dayMs;
  const dayStart = Math.floor(now / dayMs) * dayMs;
  let endTime = dayStart + seed;
  if (endTime < now) endTime += dayMs;
  const remaining = endTime - now;
  const h = Math.floor(remaining / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  return `<div id="promoCountdown" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:8px 14px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
    <span style="font-size:0.82rem;color:#ef4444;font-weight:600;">🔥 Prix promo expire dans</span>
    <span id="cdTimer" style="font-size:1rem;font-weight:700;color:#ef4444;font-variant-numeric:tabular-nums;">${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}</span>
  </div>`;
}

function getRegionBadge(product) {
  const r = getProductRegion(product);
  if (!r) return '';
  return `<span style="position:absolute;bottom:8px;left:8px;background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);border-radius:4px;padding:2px 7px;font-size:0.7rem;color:#fbbf24;font-weight:600;">${r.flag} ${r.label}</span>`;
}

// Init thème immédiatement (évite le flash blanc/noir)
(function() {
  const saved = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();


// ============ SLIDER ============
let currentSlide = 0;
let totalSlides = 0;
let sliderInterval = null;

function initSlider() {
  totalSlides = document.querySelectorAll('.slide').length;
  if (totalSlides === 0) return;
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
    renderPromoBanner(allProducts);
    // Ouvrir la modal directement si ?product=ID dans l'URL (lien depuis email)
    const productParam = new URLSearchParams(window.location.search).get('product');
    if (productParam) {
      const pid = parseInt(productParam);
      if (pid && allProducts.find(p => p.id === pid)) {
        openProductModal(pid);
      }
    }
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

function renderPromoBanner(products) {
  const section = document.getElementById('promoBannerSection');
  const grid = document.getElementById('promoBannerGrid');
  if (!section || !grid) return;
  const promos = products.filter(p => p.promo_price && p.available_stock > 0);
  if (promos.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  grid.innerHTML = promos.map(p => {
    const discount = Math.round((1 - p.promo_price / p.price) * 100);
    return `
    <div onclick="openProductModal(${p.id})" style="flex-shrink:0;min-width:180px;background:var(--bg-card);border:1px solid rgba(108,99,255,0.25);border-radius:12px;padding:14px;cursor:pointer;position:relative;transition:transform 0.2s;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='translateY(0)'">
      <span style="position:absolute;top:8px;right:8px;background:#ef4444;color:white;font-size:0.68rem;font-weight:700;padding:2px 7px;border-radius:20px;">-${discount}%</span>
      <div style="font-size:1.6rem;margin-bottom:8px;">${getCategoryIcon(p.category)}</div>
      <div style="font-size:0.82rem;font-weight:700;color:#e0e0ff;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;">${esc(p.name)}</div>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="text-decoration:line-through;color:var(--text-muted);font-size:0.75rem;">${formatPrice(p.price)}</span>
        <span style="color:#ef4444;font-weight:700;font-size:0.9rem;">${formatPrice(p.promo_price)}</span>
      </div>
    </div>`;
  }).join('');
}

function renderProducts(products) {
  const grid = document.getElementById('productsGrid');
  const noProducts = document.getElementById('noProducts');

  if (!grid) return;

  // Trier : produits en stock en premier, ruptures à la fin
  products = [...products].sort((a, b) => {
    const aStock = a.available_stock > 0 ? 1 : 0;
    const bStock = b.available_stock > 0 ? 1 : 0;
    return bStock - aStock;
  });

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
          ${product.promo_price ? `<span class="badge-promo">🔥 PROMO</span>` : ''}
          ${getRegionBadge(product)}
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
              ${product.promo_price
                ? `<div style="display:flex;flex-direction:column;line-height:1.3;"><span style="text-decoration:line-through;color:var(--text-muted);font-size:0.75rem;font-weight:400;">${formatPrice(product.price)}</span><span style="color:#ef4444;font-weight:700;">${formatPrice(product.promo_price)}</span></div>`
                : formatPrice(product.price)
              }
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

  const regionWarning = getRegionWarning(product);
  const regionGuide = getRegionGuide(product);
  const usageSteps = getUsageInstructions(product);
  const similar = allProducts.filter(p => p.id !== product.id && p.category === product.category && p.available_stock > 0).slice(0, 3);

  const avgRating = product.reviews_avg ? parseFloat(product.reviews_avg) : 4.5;
  const reviewCount = product.reviews_count || 0;
  const starsHtml = Array.from({length: 5}, (_, i) => i < Math.round(avgRating) ? '★' : '☆').join('');
  const displayPrice = product.promo_price || product.price;

  content.innerHTML = `
    <div style="position:relative;">
      <button onclick="closeModal()" class="pm-close-btn">✕</button>
      <div class="pm-layout">
        <!-- Colonne image -->
        <div class="pm-image-col">
          ${product.image_url
            ? `<img src="${product.image_url}" alt="${esc(product.name)}">`
            : `<div class="pm-image-icon">${icon}</div>`}
          <div class="pm-denomination-badge">${esc(product.denomination)}</div>
        </div>

        <!-- Colonne info -->
        <div class="pm-info-col">
          <div class="pm-region-row">
            <span class="pm-region-badge">${esc(product.platform).toUpperCase()}</span>
            <span class="pm-stock-badge ${inStock ? '' : 'out'}">
              ${inStock ? '✓ En stock' : '✕ Rupture de stock'}
            </span>
          </div>

          <h2 class="pm-title">${esc(product.name)}</h2>
          <div class="pm-denom">${esc(product.denomination)}</div>

          <div class="pm-stars">
            <span class="pm-stars-icons">${starsHtml}</span>
            ${reviewCount > 0 ? `<span class="pm-stars-count">(${reviewCount} avis)</span>` : ''}
          </div>

          ${product.promo_price ? `<div class="pm-price-old">${formatPrice(product.price)}</div>` : ''}
          <div class="pm-price">${formatPrice(displayPrice)}</div>

          ${regionWarning ? `<div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.35);border-radius:8px;padding:9px 12px;margin-bottom:12px;font-size:0.82rem;color:#f59e0b;line-height:1.5;">⚠️ ${regionWarning}</div>` : ''}

          <p class="pm-desc">${esc(product.description || 'Carte cadeau numérique. Livraison immédiate par email.')}</p>

          <ul class="pm-features">
            <li>Livraison par email : Instantanée</li>
            <li>Code valable pour votre région</li>
            <li>Aucune inscription requise</li>
            <li>Support client disponible</li>
          </ul>

          ${getPromoCountdown(product)}

          <!-- Boutons -->
          ${inStock ? `
          <div class="pm-buttons">
            <button class="pm-btn-cart" onclick="addToCart(${product.id}); closeModal();">
              🛒 Ajouter au panier
            </button>
            <button class="pm-btn-buy" onclick="addToCart(${product.id}); closeModal(); setTimeout(()=>document.getElementById('cartBtn')?.click(),100);">
              ⚡ Acheter maintenant
            </button>
          </div>` : `
          <div class="pm-buttons" style="flex-direction:column;">
            <button disabled style="width:100%;padding:13px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:10px;color:#ef4444;font-size:0.95rem;font-weight:700;cursor:not-allowed;">Stock épuisé</button>
            <button id="notifyBtn-${product.id}" onclick="subscribeStockNotification(${product.id})" style="width:100%;padding:11px;background:rgba(108,99,255,0.1);border:1px solid rgba(108,99,255,0.4);border-radius:10px;color:#a78bfa;font-size:0.88rem;font-weight:600;cursor:pointer;">🔔 Me notifier quand disponible</button>
          </div>`}

          <!-- Trust icons -->
          <div class="pm-trust">
            <div class="pm-trust-item"><span class="icon">⚡</span>Instantané</div>
            <div class="pm-trust-item"><span class="icon">🔒</span>Sécurisé</div>
            <div class="pm-trust-item"><span class="icon">✅</span>Garanti</div>
          </div>
        </div>
      </div>

      <!-- Produits similaires -->
      ${similar.length > 0 ? `
      <div class="pm-similar">
        <h3>Produits similaires</h3>
        <div class="pm-similar-grid">
          ${similar.map(p => `
            <div class="pm-similar-card" onclick="openProductModal(${p.id})">
              ${p.image_url
                ? `<img src="${p.image_url}" alt="${esc(p.name)}" style="width:100%;height:60px;object-fit:contain;margin-bottom:6px;border-radius:6px;">`
                : `<div class="icon">${getCategoryIcon(p.category)}</div>`}
              <div class="name">${esc(p.name)}</div>
              <div class="price">${formatPrice(p.promo_price || p.price)}</div>
            </div>`).join('')}
        </div>
      </div>` : ''}
    </div>
  `;

  modal.classList.add('active');
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';

  // Démarrer le compte à rebours promo
  if (product.promo_price) {
    clearInterval(window._promoTimer);
    const dayMs = 24 * 60 * 60 * 1000;
    const seed = (product.id * 3600000) % dayMs;
    const dayStart = Math.floor(Date.now() / dayMs) * dayMs;
    let endTime = dayStart + seed;
    if (endTime < Date.now()) endTime += dayMs;
    window._promoTimer = setInterval(() => {
      const el = document.getElementById('cdTimer');
      if (!el) { clearInterval(window._promoTimer); return; }
      const rem = endTime - Date.now();
      if (rem <= 0) { el.textContent = '00:00:00'; clearInterval(window._promoTimer); return; }
      const h = Math.floor(rem / 3600000);
      const m = Math.floor((rem % 3600000) / 60000);
      const s = Math.floor((rem % 60000) / 1000);
      el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }, 1000);
  }
}

function closeModal() {
  const modal = document.getElementById('productModal');
  const overlay = document.getElementById('modalOverlay');
  modal?.classList.remove('active');
  overlay?.classList.remove('active');
  document.body.style.overflow = '';
  clearInterval(window._promoTimer);
}

async function subscribeStockNotification(productId) {
  const token = localStorage.getItem('token');
  if (!token) {
    showToast('Connectez-vous pour être notifié', 'error');
    window.location.href = '/login';
    return;
  }
  const btn = document.getElementById(`notifyBtn-${productId}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Inscription...'; }
  try {
    const res = await fetch(`/api/products/${productId}/notify`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (res.ok) {
      if (btn) { btn.textContent = '✅ Vous serez notifié !'; btn.style.color = '#22c55e'; btn.style.borderColor = 'rgba(34,197,94,0.4)'; }
      showToast('Notification activée — nous vous préviendrons dès le retour en stock', 'success');
    } else {
      if (btn) { btn.disabled = false; btn.textContent = '🔔 Me notifier quand disponible'; }
      showToast(data.error || 'Erreur inscription', 'error');
    }
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = '🔔 Me notifier quand disponible'; }
    showToast('Erreur réseau', 'error');
  }
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
    // Validate URL before using in DOM
    try {
      const url = new URL(logo.image_url);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid protocol');
      const img = document.createElement('img');
      img.src = url.href;
      img.style.cssText = 'max-height:36px;vertical-align:middle;';
      iconEl.textContent = '';
      iconEl.appendChild(img);
    } catch(e) {
      iconEl.textContent = '🎮';
    }
    textEl.textContent = '';
  } else {
    iconEl.textContent = logo.emoji || '🎮';
    textEl.textContent = '';
    const mainText = document.createTextNode(logo.text || 'Babicard');
    const accent = document.createElement('span');
    accent.className = 'logo-accent';
    accent.textContent = logo.accent || '.ci';
    textEl.appendChild(mainText);
    textEl.appendChild(accent);
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
    const div = document.createElement('div');
    div.className = 'slide' + (idx === 0 ? ' active' : '');
    div.dataset.slide = idx;

    // Validate image URL — no CSS injection
    let bgStyle = slide.bg_gradient || 'linear-gradient(135deg,#1a1a2e,#16213e)';
    if (slide.image_url) {
      try {
        const u = new URL(slide.image_url);
        if (['https:', 'http:', 'data:'].includes(u.protocol)) {
          bgStyle += ';background-image:url(' + u.href.replace(/['"()]/g, '') + ');background-size:cover;background-position:center;background-blend-mode:overlay';
        }
      } catch(e) {}
    }

    // Validate icon_bg color — only allow safe CSS color values
    const safeIconBg = /^#[0-9a-fA-F]{3,8}$|^rgb|^hsl/.test(slide.icon_bg || '') ? slide.icon_bg : '#333';

    const slideBg = document.createElement('div');
    slideBg.className = 'slide-bg';
    slideBg.style.cssText = 'background:' + bgStyle;

    const pricesHtml = (slide.prices || []).map(p => '<span class="price-tag">' + esc(p) + '</span>').join('');

    const slideContent = document.createElement('div');
    slideContent.className = 'slide-content';
    slideContent.innerHTML =
      '<div class="slide-brand">' +
      '<div class="brand-badge" style="background:' + safeIconBg + ';width:60px;height:60px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2rem;">' + esc(slide.icon_emoji || '🎮') + '</div>' +
      '</div>' +
      '<div class="slide-text">' +
      '<span class="slide-tag">' + esc(slide.tag || '') + '</span>' +
      '<h1 class="slide-title">' + esc(slide.title || '') + '<br><span class="slide-title-accent">' + esc(slide.title_accent || '') + '</span></h1>' +
      '<p class="slide-desc">' + esc(slide.description || '') + '</p>' +
      '<div class="slide-prices">' + pricesHtml + '</div>' +
      '<a href="#products" class="slide-cta">' + esc(slide.cta_text || 'Acheter →') + '</a>' +
      '</div>' +
      '</div>';

    div.appendChild(slideBg);
    div.appendChild(slideContent);
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

// ============ PWA INSTALL PROMPT ============
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  showInstallBanner();
});

function showInstallBanner() {
  if (document.getElementById('pwaBanner')) return;
  if (localStorage.getItem('pwaBannerDismissed')) return;
  const banner = document.createElement('div');
  banner.id = 'pwaBanner';
  banner.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;background:linear-gradient(135deg,#1e1b4b,#13131f);border:1px solid rgba(108,99,255,0.4);border-radius:14px;padding:14px 18px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);max-width:340px;width:90%;';
  banner.innerHTML = `
    <img src="/icons/icon-72.png" style="width:40px;height:40px;border-radius:10px;flex-shrink:0;">
    <div style="flex:1;">
      <div style="font-size:0.85rem;font-weight:700;color:#e0e0ff;">Installer Babicard</div>
      <div style="font-size:0.75rem;color:#a0a0c0;">Accès rapide depuis votre téléphone</div>
    </div>
    <div style="display:flex;gap:6px;flex-shrink:0;">
      <button onclick="installPWA()" style="background:#6C63FF;color:white;border:none;border-radius:8px;padding:7px 12px;font-size:0.8rem;font-weight:600;cursor:pointer;">Installer</button>
      <button onclick="dismissInstallBanner()" style="background:rgba(255,255,255,0.08);color:#a0a0c0;border:none;border-radius:8px;padding:7px 10px;font-size:0.8rem;cursor:pointer;">✕</button>
    </div>
  `;
  document.body.appendChild(banner);
}

async function installPWA() {
  if (!_deferredInstallPrompt) return;
  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;
  _deferredInstallPrompt = null;
  dismissInstallBanner();
}

function dismissInstallBanner() {
  const b = document.getElementById('pwaBanner');
  if (b) b.remove();
  localStorage.setItem('pwaBannerDismissed', '1');
}

window.addEventListener('appinstalled', () => dismissInstallBanner());

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
