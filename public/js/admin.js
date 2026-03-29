// =============================================
// Babicard.ci — Admin Panel JavaScript
// =============================================

const API = '/api';

// Échappement HTML — protection XSS sur toutes les données dynamiques
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const STATUS_LABELS = {
  paid: '💰 Payée',
  pending: '⏳ En attente',
  failed: '❌ Échouée',
  cancelled: '🚫 Annulée',
  delivered: '📬 Livrée',
  processing: '⚙️ En cours',
  refunded: '↩️ Remboursée'
};
function statusLabel(s) { return STATUS_LABELS[s] || s; }
let authToken = null;
let currentSection = 'dashboard';
let currentOrderId = null;
let editingProductId = null;

// ============ INIT ============
window.addEventListener('DOMContentLoaded', async () => {
  authToken = localStorage.getItem('token');

  if (!authToken) {
    window.location.href = '/login?redirect=/admin';
    return;
  }

  try {
    const res = await fetch(`${API}/auth/me`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();

    if (!res.ok || data.user.role !== 'admin') {
      showToast('Accès refusé. Admin requis.', 'error');
      setTimeout(() => { window.location.href = '/'; }, 1500);
      return;
    }

    document.getElementById('adminAvatar').textContent = data.user.name.charAt(0).toUpperCase();
    document.getElementById('adminName').textContent = data.user.name;
    document.getElementById('adminEmail').textContent = data.user.email;

    // Apply brand accent color from settings
    fetch(`${API}/settings`).then(r => r.json()).then(d => {
      if (d.logo && d.logo.accent_color) {
        document.documentElement.style.setProperty('--logo-accent-color', d.logo.accent_color);
      }
    }).catch(() => {});

    // Set date
    document.getElementById('topbarDate').textContent = new Date().toLocaleDateString('fr-FR', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });

    loadDashboard();

    // Ouvrir la section via hash URL (ex: /admin#withdrawals)
    if (window.location.hash) {
      const section = window.location.hash.replace('#', '');
      const menuEl = document.querySelector(`[data-section="${section}"]`);
      setTimeout(() => showSection(section, menuEl), 300);
    }
  } catch (err) {
    window.location.href = '/login';
  }
});

// ============ NAVIGATION ============
function showSection(name, el) {
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));

  const section = document.getElementById(`section-${name}`);
  if (section) section.classList.add('active');
  if (el) el.classList.add('active');

  currentSection = name;
  const titles = {
    dashboard: 'Tableau de bord',
    products: 'Gestion des Produits',
    cards: 'Gestion des Codes',
    orders: 'Gestion des Commandes',
    users: 'Gestion des Utilisateurs',
    sellers: 'Gestion des Vendeurs',
    withdrawals: 'Demandes de Retrait',
    appearance: 'Apparence du site'
  };
  document.getElementById('topbarTitle').textContent = titles[name] || name;

  // Load section data
  switch (name) {
    case 'dashboard': loadDashboard(); break;
    case 'products': loadAdminProducts(); break;
    case 'cards': loadCardsSection(); break;
    case 'orders': loadAdminOrders(); break;
    case 'users': loadUsers(); break;
    case 'sellers': loadAdminSellers(); break;
    case 'withdrawals': loadAdminWithdrawals(); break;
    case 'appearance': loadAppearanceSettings(); break;
  }

  return false;
}

function refreshCurrentSection() {
  showSection(currentSection);
}

function toggleSidebar() {
  document.getElementById('adminSidebar').classList.toggle('mobile-open');
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = '/login';
}

async function adminChangePassword() {
  const alertEl = document.getElementById('adminPwdAlerts');
  alertEl.innerHTML = '';
  const current = document.getElementById('adminCurrentPwd').value;
  const newPwd = document.getElementById('adminNewPwd').value;
  const confirm = document.getElementById('adminConfirmPwd').value;
  if (!current || !newPwd || !confirm) {
    alertEl.innerHTML = '<div style="padding:10px;border-radius:6px;background:#fee;color:#c00;margin-bottom:12px;">Veuillez remplir tous les champs.</div>'; return;
  }
  if (newPwd !== confirm) {
    alertEl.innerHTML = '<div style="padding:10px;border-radius:6px;background:#fee;color:#c00;margin-bottom:12px;">Les mots de passe ne correspondent pas.</div>'; return;
  }
  if (newPwd.length < 6) {
    alertEl.innerHTML = '<div style="padding:10px;border-radius:6px;background:#fee;color:#c00;margin-bottom:12px;">Le nouveau mot de passe doit contenir au moins 6 caractères.</div>'; return;
  }
  const res = await adminFetch('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ current_password: current, new_password: newPwd })
  });
  const data = await res.json();
  if (res.ok) {
    alertEl.innerHTML = '<div style="padding:10px;border-radius:6px;background:#e6f9ee;color:#1a7a40;margin-bottom:12px;">Mot de passe modifié avec succès.</div>';
    document.getElementById('adminCurrentPwd').value = '';
    document.getElementById('adminNewPwd').value = '';
    document.getElementById('adminConfirmPwd').value = '';
  } else {
    alertEl.innerHTML = `<div style="padding:10px;border-radius:6px;background:#fee;color:#c00;margin-bottom:12px;">${data.error || 'Erreur'}</div>`;
  }
}

// ============ API HELPER ============
async function adminFetch(url, options = {}) {
  const isFormData = options.body instanceof FormData;
  const headers = {
    'Authorization': `Bearer ${authToken}`,
    ...options.headers
  };
  if (!isFormData) headers['Content-Type'] = 'application/json';

  const res = await fetch(API + url, {
    ...options,
    headers
  });

  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/login';
    return;
  }
  return res;
}

function formatPrice(amount) {
  return new Intl.NumberFormat('fr-FR').format(amount) + ' FCFA';
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

// ============ DASHBOARD ============
async function loadDashboard() {
  try {
    const res = await adminFetch('/admin/stats');
    const data = await res.json();
    const { stats, alerts, recentOrders, topProducts } = data;

    // Render alerts
    const alertsContainer = document.getElementById('alertsContainer');
    const alertsList = document.getElementById('alertsList');
    const alertItems = [];
    if (alerts.pendingSellers > 0) alertItems.push(`
      <div class="alert-card alert-purple" onclick="showSection('sellers')">
        <div class="alert-card-icon">🏪</div>
        <div class="alert-card-text">
          <span class="alert-card-count">${alerts.pendingSellers}</span>
          <span class="alert-card-label">Demande${alerts.pendingSellers > 1 ? 's' : ''} vendeur en attente</span>
        </div>
      </div>`);
    if (alerts.pendingWithdrawals > 0) alertItems.push(`
      <div class="alert-card alert-yellow" onclick="showSection('withdrawals')">
        <div class="alert-card-icon">💸</div>
        <div class="alert-card-text">
          <span class="alert-card-count">${alerts.pendingWithdrawals}</span>
          <span class="alert-card-label">Retrait${alerts.pendingWithdrawals > 1 ? 's' : ''} en attente</span>
        </div>
      </div>`);
    if (alerts.pendingOrders > 0) alertItems.push(`
      <div class="alert-card alert-orange" onclick="showSection('orders')">
        <div class="alert-card-icon">📦</div>
        <div class="alert-card-text">
          <span class="alert-card-count">${alerts.pendingOrders}</span>
          <span class="alert-card-label">Commande${alerts.pendingOrders > 1 ? 's' : ''} en attente</span>
        </div>
      </div>`);
    if (alerts.outOfStockProducts > 0) alertItems.push(`
      <div class="alert-card alert-red" onclick="showSection('products')">
        <div class="alert-card-icon">🚫</div>
        <div class="alert-card-text">
          <span class="alert-card-count">${alerts.outOfStockProducts}</span>
          <span class="alert-card-label">Produit${alerts.outOfStockProducts > 1 ? 's' : ''} en rupture de stock</span>
        </div>
      </div>`);
    if (alerts.lowStockProducts > 0) alertItems.push(`
      <div class="alert-card alert-yellow" onclick="showSection('products')">
        <div class="alert-card-icon">⚠️</div>
        <div class="alert-card-text">
          <span class="alert-card-count">${alerts.lowStockProducts}</span>
          <span class="alert-card-label">Produit${alerts.lowStockProducts > 1 ? 's' : ''} stock faible (≤5)</span>
        </div>
      </div>`);

    if (alertItems.length > 0) {
      alertsList.innerHTML = alertItems.join('');
      alertsContainer.style.display = 'block';
    } else {
      alertsContainer.style.display = 'none';
    }

    document.getElementById('stat-users').textContent = stats.totalUsers;
    document.getElementById('stat-revenue').textContent = formatPrice(stats.totalRevenue);
    document.getElementById('stat-orders').textContent = `${stats.paidOrders}/${stats.totalOrders}`;
    document.getElementById('stat-cards').textContent = stats.availableCards;
    document.getElementById('stat-benefits').textContent = formatPrice(stats.adminBenefits);
    document.getElementById('stat-benefits-month').textContent = formatPrice(stats.adminBenefitsMonth);
    document.getElementById('stat-commissions').textContent = formatPrice(stats.totalCommissions);
    document.getElementById('stat-direct').textContent = formatPrice(stats.directRevenue);

    // Recent orders
    document.getElementById('recentOrders').innerHTML = recentOrders.length ? recentOrders.map(order => `
      <div class="recent-order-row" onclick="viewOrderDetail(${order.id})" style="cursor:pointer">
        <div class="order-user">
          ${esc(order.user_name)}
          <small>${esc(order.user_email)}</small>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="badge badge-${order.payment_status}">${statusLabel(order.payment_status)}</span>
          <span class="order-amount-sm">${formatPrice(order.total_amount)}</span>
        </div>
      </div>
    `).join('') : '<div class="loading-row" style="color:var(--text-muted);font-size:0.85rem;padding:20px;text-align:center">Aucune commande</div>';

    // Top products
    document.getElementById('topProducts').innerHTML = topProducts.length ? topProducts.map((p, i) => `
      <div class="top-product-row">
        <div class="product-rank">${i + 1}</div>
        <div class="product-info-sm">
          <strong>${esc(p.name)}</strong>
          <span>${esc(p.platform)}</span>
        </div>
        <div class="product-sales">${p.sales} ventes</div>
      </div>
    `).join('') : '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:0.85rem">Aucune donnée</div>';

  } catch (err) {
    console.error('Dashboard error:', err);
    showToast('Erreur chargement tableau de bord', 'error');
  }
}

// ============ PRODUCTS ============
async function loadAdminProducts() {
  document.getElementById('productsTable').innerHTML = `<div class="loading-center"><div class="loading-spinner"></div></div>`;
  try {
    const res = await adminFetch('/admin/products');
    const data = await res.json();
    const products = data.products || [];

    if (products.length === 0) {
      document.getElementById('productsTable').innerHTML = `
        <div class="admin-table-wrap"><div class="empty-table"><div class="empty-icon">🎁</div><p>Aucun produit</p></div></div>
      `;
      return;
    }

    const catColors = {
      apple:'#888', playstation:'#003087', xbox:'#107C10',
      google:'#4285F4', steam:'#1b2838', netflix:'#E50914',
      amazon:'#FF9900', other:'#6C63FF'
    };

    document.getElementById('productsTable').innerHTML = `
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Produit</th>
              <th>Plateforme</th>
              <th>Prix</th>
              <th>Stock</th>
              <th>Vendus</th>
              <th>Statut</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${products.map(p => `
              <tr>
                <td>
                  <div style="display:flex;align-items:center;gap:10px">
                    <div style="width:40px;height:40px;border-radius:8px;overflow:hidden;flex-shrink:0;background:${catColors[p.category] || '#6C63FF'}22;display:flex;align-items:center;justify-content:center;border:1px solid var(--admin-border)">
                      ${p.image_url
                        ? `<img src="${esc(p.image_url)}" alt="" style="width:100%;height:100%;object-fit:cover">`
                        : `<span style="font-size:1.2rem">${{apple:'🍎',playstation:'🎮',xbox:'🎮',google:'▶️',steam:'🎮',netflix:'🎬',amazon:'📦'}[p.category] || '🎁'}</span>`
                      }
                    </div>
                    <div>
                      <strong>${esc(p.name)}</strong>
                      <div style="font-size:0.72rem;color:var(--text-muted)">${esc(p.denomination)}</div>
                    </div>
                  </div>
                </td>
                <td>${esc(p.platform)}</td>
                <td><strong style="color:#a78bfa">${formatPrice(p.price)}</strong></td>
                <td><span style="color:${p.available_cards > 0 ? '#86efac' : '#fca5a5'}">${p.available_cards}</span></td>
                <td>${p.sold_cards}</td>
                <td><span class="badge ${p.is_active ? 'badge-active' : 'badge-inactive'}">${p.is_active ? 'Actif' : 'Inactif'}</span></td>
                <td>
                  <div class="td-actions">
                    <button class="btn-edit" onclick="editProduct(${p.id})">✏️ Modifier</button>
                    <button class="btn-danger" onclick="deleteProduct(${p.id})">🗑</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    showToast('Erreur chargement produits', 'error');
  }
}

let uploadedProductImageUrl = null;

function resetProductImgZone(currentUrl = '') {
  uploadedProductImageUrl = currentUrl || null;
  const preview = document.getElementById('productImgPreview');
  const placeholder = document.getElementById('productImgPlaceholder');
  const status = document.getElementById('productImgStatus');
  if (currentUrl) {
    preview.src = currentUrl;
    preview.style.display = 'block';
    placeholder.style.display = 'none';
    status.textContent = '';
  } else {
    preview.src = '';
    preview.style.display = 'none';
    placeholder.style.display = '';
    status.textContent = '';
  }
  document.getElementById('productImgInput').value = '';
}

async function onProductImgSelect(input) {
  const file = input.files[0];
  if (!file) return;
  const status = document.getElementById('productImgStatus');
  status.textContent = '⏳ Envoi en cours…';
  status.style.color = 'var(--text-muted)';

  const form = new FormData();
  form.append('image', file);
  try {
    const res = await adminFetch('/admin/products/upload-image', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    uploadedProductImageUrl = data.url;
    const preview = document.getElementById('productImgPreview');
    preview.src = data.url;
    preview.style.display = 'block';
    document.getElementById('productImgPlaceholder').style.display = 'none';
    status.textContent = '✅ Image uploadée';
    status.style.color = '#22c55e';
  } catch (err) {
    status.textContent = '❌ ' + err.message;
    status.style.color = '#ef4444';
  }
}

function showProductForm(productId = null) {
  editingProductId = productId;
  document.getElementById('productModalTitle').textContent = productId ? 'Modifier le produit' : 'Ajouter un produit';
  document.getElementById('productForm').reset();
  resetProductImgZone();

  if (!productId) {
    document.getElementById('productModal').classList.add('active');
    document.getElementById('productModalOverlay').classList.add('active');
  }
}

async function editProduct(productId) {
  try {
    const res = await adminFetch('/admin/products');
    const data = await res.json();
    const product = data.products.find(p => p.id === productId);
    if (!product) return;

    editingProductId = productId;
    document.getElementById('productModalTitle').textContent = 'Modifier le produit';
    document.getElementById('pName').value = product.name;
    document.getElementById('pPlatform').value = product.platform;
    document.getElementById('pCategory').value = product.category;
    document.getElementById('pDenomination').value = product.denomination;
    document.getElementById('pPrice').value = product.price;
    document.getElementById('pActive').value = product.is_active ? '1' : '0';
    document.getElementById('pDescription').value = product.description || '';
    resetProductImgZone(product.image_url || '');

    document.getElementById('productModal').classList.add('active');
    document.getElementById('productModalOverlay').classList.add('active');
  } catch (err) {
    showToast('Erreur chargement produit', 'error');
  }
}

async function saveProduct(e) {
  e.preventDefault();
  const btn = document.getElementById('productSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Enregistrement...';

  const body = {
    name: document.getElementById('pName').value,
    platform: document.getElementById('pPlatform').value,
    category: document.getElementById('pCategory').value,
    denomination: document.getElementById('pDenomination').value,
    price: document.getElementById('pPrice').value,
    is_active: document.getElementById('pActive').value === '1' ? 1 : 0,
    description: document.getElementById('pDescription').value,
    image_url: uploadedProductImageUrl || ''
  };

  try {
    const url = editingProductId ? `/admin/products/${editingProductId}` : '/admin/products';
    const method = editingProductId ? 'PUT' : 'POST';

    const res = await adminFetch(url, { method, body: JSON.stringify(body) });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error);

    showToast(editingProductId ? 'Produit modifié!' : 'Produit créé!', 'success');
    closeProductModal();
    loadAdminProducts();
  } catch (err) {
    showToast(err.message || 'Erreur sauvegarde', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enregistrer';
  }
}

async function deleteProduct(id) {
  if (!confirm(`Désactiver ce produit ?`)) return;
  try {
    const res = await adminFetch(`/admin/products/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Produit désactivé', 'success');
    loadAdminProducts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function closeProductModal() {
  document.getElementById('productModal').classList.remove('active');
  document.getElementById('productModalOverlay').classList.remove('active');
  editingProductId = null;
}

// ============ CARDS / CODES ============
async function loadCardsSection() {
  // Populate product filter
  try {
    const res = await adminFetch('/admin/products');
    const data = await res.json();
    const select = document.getElementById('cardProductFilter');
    const bulkSelect = document.getElementById('bulkProductId');

    const options = data.products.map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.denomination)})</option>`).join('');
    if (select) select.innerHTML = `<option value="">Tous les produits</option>${options}`;
    if (bulkSelect) bulkSelect.innerHTML = `<option value="">Sélectionner...</option>${options}`;
  } catch (e) {}

  // Populate seller filter
  try {
    const res = await adminFetch('/admin/sellers?status=approved&limit=100');
    const data = await res.json();
    const sel = document.getElementById('cardSellerFilter');
    if (sel && data.sellers) {
      const opts = data.sellers.map(s => `<option value="${s.user_id}">${esc(s.shop_name || s.name)}</option>`).join('');
      sel.innerHTML = `<option value="">Tous les vendeurs</option><option value="admin">👤 Admin</option>${opts}`;
    }
  } catch (e) {}

  loadCards();
}

let allCardsData = [];

async function loadCards() {
  document.getElementById('cardsTable').innerHTML = `<div class="loading-center"><div class="loading-spinner"></div></div>`;

  const productId = document.getElementById('cardProductFilter')?.value;
  const status = document.getElementById('cardStatusFilter')?.value;
  const sellerId = document.getElementById('cardSellerFilter')?.value;

  try {
    const params = new URLSearchParams();
    if (productId) params.set('product_id', productId);
    if (status) params.set('status', status);
    if (sellerId) params.set('seller_id', sellerId);
    params.set('limit', 500);

    const res = await adminFetch(`/admin/cards?${params}`);
    const data = await res.json();
    allCardsData = data.cards || [];
    filterCardsTable();
  } catch (err) {
    showToast('Erreur chargement cartes', 'error');
  }
}

function renderCardsTable(cards) {
  if (cards.length === 0) {
    document.getElementById('cardsTable').innerHTML = `
      <div class="admin-table-wrap"><div class="empty-table"><div class="empty-icon">🃏</div><p>Aucune carte trouvée</p><p style="font-size:0.8rem;margin-top:8px;color:var(--text-muted)">Ajoutez des codes via le bouton "Ajouter des codes"</p></div></div>
    `;
    return;
  }

  document.getElementById('cardsTable').innerHTML = `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Produit</th>
            <th>Code</th>
            <th>PIN</th>
            <th>Vendeur</th>
            <th>Statut</th>
            <th>Ajouté le</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${cards.map(card => `
            <tr>
              <td><strong>${esc(card.product_name)}</strong></td>
              <td><span class="code-cell">${esc(card.code)}</span></td>
              <td>${card.pin ? `<span class="code-cell">${esc(card.pin)}</span>` : '-'}</td>
              <td style="font-size:0.82rem;">
                ${card.seller_name
                  ? `<span style="color:#a78bfa;font-weight:600;">${esc(card.shop_name || card.seller_name)}</span>`
                  : `<span style="color:#888;">👤 Admin</span>`}
              </td>
              <td><span class="badge badge-${card.status}">${card.status === 'available' ? '✓ Disponible' : '✕ Vendu'}</span></td>
              <td style="font-size:0.78rem">${formatDate(card.added_at)}</td>
              <td>
                ${card.status === 'available' ?
                  `<button class="btn-danger" onclick="deleteCard(${card.id})">🗑</button>` :
                  `<span style="font-size:0.75rem;color:var(--text-muted)">Vendu</span>`
                }
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div style="padding:12px 20px;font-size:0.82rem;color:var(--text-muted);border-top:1px solid var(--admin-border)">
      ${cards.length} carte(s) affichée(s)${allCardsData.length !== cards.length ? ` sur ${allCardsData.length}` : ''}
    </div>
  `;
}

function filterCardsTable() {
  const q = (document.getElementById('cardSearchInput')?.value || '').toLowerCase().trim();
  if (!q) { renderCardsTable(allCardsData); return; }
  const filtered = allCardsData.filter(c =>
    c.code.toLowerCase().includes(q) ||
    (c.product_name || '').toLowerCase().includes(q) ||
    (c.pin || '').toLowerCase().includes(q) ||
    (c.seller_name || '').toLowerCase().includes(q) ||
    (c.shop_name || '').toLowerCase().includes(q)
  );
  renderCardsTable(filtered);
}

// ============ CSV IMPORT ============
let csvParsedCards = [];

function switchImportTab(tab) {
  document.getElementById('tabManuel').classList.toggle('active', tab === 'manuel');
  document.getElementById('tabCsv').classList.toggle('active', tab === 'csv');
  document.getElementById('panelManuel').style.display = tab === 'manuel' ? '' : 'none';
  document.getElementById('panelCsv').style.display = tab === 'csv' ? '' : 'none';
}

function onCsvSelect(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('Fichier trop lourd (max 5 Mo)', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (e) => parseCsvContent(e.target.result, file.name);
  reader.readAsText(file, 'UTF-8');
}

function cleanCsvValue(v) {
  v = (v || '').trim();
  // Excel ="value" or ='value'
  if (v.startsWith('="') && v.endsWith('"')) return v.slice(2, -1).trim();
  if (v.startsWith("='") && v.endsWith("'")) return v.slice(2, -1).trim();
  // Simple quoted "value" or 'value'
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') return v.slice(1, -1).trim();
  if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") return v.slice(1, -1).trim();
  return v;
}

// Properly split a CSV line respecting quoted fields (handles embedded separators inside quotes)
function splitCsvLine(line, sep) {
  const result = [];
  let cur = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true; quoteChar = ch; cur += ch;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false; cur += ch;
    } else if (!inQuote && ch === sep) {
      result.push(cleanCsvValue(cur)); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cleanCsvValue(cur));
  return result;
}

function parseCsvContent(text, filename) {
  // Split lines, remove \r, remove blank lines
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length) { showToast('Fichier CSV vide', 'error'); return; }

  // Remove "sep=X" declaration line
  if (/^sep=/i.test(lines[0])) lines = lines.slice(1);
  if (!lines.length) { showToast('Fichier CSV vide après en-tête.', 'error'); return; }

  // Detect separator from header line
  const sep = lines[0].includes(';') ? ';' : ',';

  // Parse header
  const headers = splitCsvLine(lines[0], sep).map(h => h.toLowerCase());
  const codeIdx = headers.findIndex(h => h === 'code');

  csvParsedCards = [];
  let errors = 0;
  const dataLines = lines.slice(1);

  if (codeIdx !== -1) {
    // Supplier format: auto-detect Code column by header name
    dataLines.forEach((line) => {
      const parts = splitCsvLine(line, sep);
      if (parts.length <= codeIdx) { errors++; return; }
      const code = parts[codeIdx];
      if (!code) { errors++; return; }
      csvParsedCards.push({ card_name: '', card_price: '', code });
    });
  } else {
    // Manual format: nom, prix, code (columns 0,1,2)
    const isHeader = headers.some(h => ['nom','prix','name','price','code'].includes(h));
    const rows = isHeader ? dataLines : lines;
    rows.forEach(line => {
      const parts = splitCsvLine(line, sep);
      const code = parts[2] || parts[0] || '';
      if (!code) { errors++; return; }
      csvParsedCards.push({ card_name: parts[0] || '', card_price: parts[1] || '', code });
    });
  }

  const zone = document.getElementById('csvDropZone');
  zone.classList.add('has-file');
  const nameEl = document.getElementById('csvFileName');
  nameEl.textContent = `✅ ${filename}`;
  nameEl.style.display = 'block';

  const countEl = document.getElementById('csvPreviewCount');
  const tableEl = document.getElementById('csvPreviewTable');
  document.getElementById('csvPreview').style.display = '';
  countEl.textContent = `${csvParsedCards.length} code(s) prêts à importer${errors ? ` — ⚠️ ${errors} ligne(s) ignorée(s)` : ''}`;

  const rows = csvParsedCards.slice(0, 10).map(c =>
    `<div style="display:grid;grid-template-columns:2fr 1fr 2fr;gap:6px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
      <span style="color:#888">${c.card_name || '—'}</span>
      <span style="color:#22c55e">${c.card_price ? c.card_price + ' FCFA' : '—'}</span>
      <span style="font-family:monospace;color:#a78bfa">${c.code}</span>
    </div>`
  ).join('');
  tableEl.innerHTML =
    `<div style="display:grid;grid-template-columns:2fr 1fr 2fr;gap:6px;padding:3px 0;margin-bottom:4px;font-weight:700;color:var(--text-secondary)"><span>Nom</span><span>Prix</span><span>Code</span></div>` +
    rows +
    (csvParsedCards.length > 10 ? `<div style="text-align:center;color:#888;padding:6px;font-size:11px">… et ${csvParsedCards.length - 10} autre(s)</div>` : '');
}

function clearCsvFile() {
  csvParsedCards = [];
  document.getElementById('csvFileInput').value = '';
  document.getElementById('csvDropZone').classList.remove('has-file');
  document.getElementById('csvFileName').style.display = 'none';
  document.getElementById('csvPreview').style.display = 'none';
}

// Drag & drop sur la zone CSV
function initCsvDragDrop() {
  const zone = document.getElementById('csvDropZone');
  if (!zone || zone._ddBound) return;
  zone._ddBound = true;
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!file.name.endsWith('.csv') && file.type !== 'text/csv') { showToast('Fichier CSV uniquement', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => parseCsvContent(ev.target.result, file.name);
    reader.readAsText(file, 'UTF-8');
  });
}

function showBulkCardForm() {
  loadCardsSection();

  // Reset both panels
  document.getElementById('bulkCodes').value = '';
  document.getElementById('codeCount').textContent = '0 codes détectés';
  clearCsvFile();
  switchImportTab('manuel');

  document.getElementById('cardsModal').classList.add('active');
  document.getElementById('cardsModalOverlay').classList.add('active');

  document.getElementById('bulkCodes').addEventListener('input', function() {
    const lines = this.value.split('\n').filter(l => l.trim());
    document.getElementById('codeCount').textContent = `${lines.length} code(s) détecté(s)`;
  });

  // Init drag & drop after modal is open
  setTimeout(initCsvDragDrop, 100);
}

async function addBulkCards() {
  const productId = document.getElementById('bulkProductId').value;
  if (!productId) { showToast('Sélectionnez un produit', 'error'); return; }

  // Determine active tab
  const isCsvTab = document.getElementById('tabCsv').classList.contains('active');
  let cards;

  if (isCsvTab) {
    if (!csvParsedCards.length) { showToast('Importez un fichier CSV d\'abord', 'error'); return; }
    cards = csvParsedCards;
  } else {
    const codesText = document.getElementById('bulkCodes').value;
    if (!codesText.trim()) { showToast('Entrez au moins un code', 'error'); return; }
    const lines = codesText.split('\n').filter(l => l.trim());
    cards = lines.map(line => {
      const parts = line.trim().split('|');
      return { code: parts[0]?.trim() || '', pin: parts[1]?.trim() || null, serial: parts[2]?.trim() || null };
    }).filter(c => c.code);
  }

  if (cards.length === 0) {
    showToast('Aucun code valide trouvé', 'error');
    return;
  }

  const btn = document.getElementById('bulkSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Ajout en cours...';

  try {
    const res = await adminFetch('/admin/cards/bulk', {
      method: 'POST',
      body: JSON.stringify({ product_id: parseInt(productId), cards })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast(`✅ ${data.inserted} code(s) ajouté(s)! ${data.skipped > 0 ? `${data.skipped} ignoré(s).` : ''}`, 'success');
    closeCardsModal();
    loadCards();
    loadAdminProducts();
  } catch (err) {
    showToast(err.message || 'Erreur ajout cartes', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ajouter les codes';
  }
}

async function deleteCard(id) {
  if (!confirm('Supprimer cette carte?')) return;
  try {
    const res = await adminFetch(`/admin/cards/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Carte supprimée', 'success');
    loadCards();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function closeCardsModal() {
  document.getElementById('cardsModal').classList.remove('active');
  document.getElementById('cardsModalOverlay').classList.remove('active');
}

// ============ ORDERS ============
async function loadAdminOrders() {
  document.getElementById('ordersTable').innerHTML = `<div class="loading-center"><div class="loading-spinner"></div></div>`;

  const paymentStatus = document.getElementById('orderPaymentFilter')?.value;
  const deliveryStatus = document.getElementById('orderDeliveryFilter')?.value;

  try {
    const params = new URLSearchParams();
    if (paymentStatus) params.set('payment_status', paymentStatus);
    if (deliveryStatus) params.set('delivery_status', deliveryStatus);

    const res = await adminFetch(`/admin/orders?${params}`);
    const data = await res.json();
    const orders = data.orders || [];

    if (orders.length === 0) {
      document.getElementById('ordersTable').innerHTML = `
        <div class="admin-table-wrap"><div class="empty-table"><div class="empty-icon">📦</div><p>Aucune commande</p></div></div>
      `;
      return;
    }

    document.getElementById('ordersTable').innerHTML = `
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Client</th>
              <th>Méthode</th>
              <th>Montant</th>
              <th>Paiement</th>
              <th>Livraison</th>
              <th>Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${orders.map(o => `
              <tr>
                <td><strong>#${o.id}</strong></td>
                <td>
                  <strong>${esc(o.user_name)}</strong>
                  <div style="font-size:0.72rem;color:var(--text-muted)">${esc(o.user_email)}</div>
                </td>
                <td>${o.payment_method === 'wave' ? '🌊 Wave' : '🟠 Orange'}</td>
                <td><strong style="color:#a78bfa">${formatPrice(o.total_amount)}</strong></td>
                <td><span class="badge badge-${o.payment_status}">${statusLabel(o.payment_status)}</span></td>
                <td><span class="badge badge-${o.delivery_status}">${statusLabel(o.delivery_status)}</span></td>
                <td style="font-size:0.75rem">${formatDate(o.created_at)}</td>
                <td>
                  <div class="td-actions">
                    <button class="btn-view" onclick="viewOrderDetail(${o.id})">👁 Voir</button>
                    ${o.payment_status === 'paid' ? `<button class="btn-edit" onclick="redeliverOrder(${o.id})">📬 Reliv.</button>` : ''}
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    showToast('Erreur chargement commandes', 'error');
  }
}

async function viewOrderDetail(orderId) {
  currentOrderId = orderId;
  document.getElementById('orderDetailTitle').textContent = `Commande #${orderId}`;
  document.getElementById('orderDetailBody').innerHTML = `<div class="loading-center"><div class="loading-spinner"></div></div>`;
  document.getElementById('orderDetailModal').classList.add('active');
  document.getElementById('orderDetailOverlay').classList.add('active');

  try {
    const res = await adminFetch(`/admin/orders/${orderId}`);
    const data = await res.json();
    const order = data.order;
    const items = order.items || [];

    document.getElementById('redeliverBtn').style.display = order.payment_status === 'paid' ? 'inline-flex' : 'none';

    document.getElementById('orderDetailBody').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div style="background:var(--admin-card);padding:16px;border-radius:8px;border:1px solid var(--admin-border)">
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:1px">Client</div>
          <strong style="display:block;margin-bottom:4px">${esc(order.user_name)}</strong>
          <span style="font-size:0.82rem;color:var(--text-secondary)">${esc(order.user_email)}</span>
          ${order.user_phone ? `<div style="font-size:0.82rem;color:var(--text-secondary)">${esc(order.user_phone)}</div>` : ''}
        </div>
        <div style="background:var(--admin-card);padding:16px;border-radius:8px;border:1px solid var(--admin-border)">
          <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:1px">Paiement</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <span class="badge badge-${order.payment_status}">${statusLabel(order.payment_status)}</span>
            <span class="badge badge-${order.delivery_status}">${statusLabel(order.delivery_status)}</span>
          </div>
          <div style="font-size:0.82rem;color:var(--text-secondary)">${order.payment_method === 'wave' ? '🌊 Wave CI' : '🟠 Orange Money'}</div>
          <div style="font-size:0.78rem;color:var(--text-muted);font-family:monospace;margin-top:4px">${esc(order.payment_ref || 'N/A')}</div>
          <div style="font-size:1.1rem;font-weight:700;color:#a78bfa;margin-top:8px">${formatPrice(order.total_amount)}</div>
        </div>
      </div>

      <div style="background:var(--admin-card);border:1px solid var(--admin-border);border-radius:8px;overflow:hidden">
        <div style="padding:12px 16px;border-bottom:1px solid var(--admin-border);font-size:0.82rem;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted)">
          Articles (${items.length})
        </div>
        ${items.map(item => `
          <div style="padding:14px 16px;border-bottom:1px solid rgba(108,99,255,0.1)">
            <div style="display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <strong>${esc(item.product_name)}</strong>
                <div style="font-size:0.75rem;color:var(--text-muted)">${esc(item.platform)} • ${esc(item.denomination || '')}</div>
              </div>
              <strong style="color:#a78bfa">${formatPrice(item.unit_price)}</strong>
            </div>
            ${item.card_code ? `
              <div style="margin-top:10px;background:rgba(108,99,255,0.07);padding:10px;border-radius:6px;border:1px dashed rgba(108,99,255,0.3)">
                <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px">CODE DE LA CARTE</div>
                <code id="card-code-${item.card_id}" style="font-size:1rem;color:#a78bfa;letter-spacing:2px">${esc(item.card_code)}</code>
                <span id="card-pin-${item.card_id}" style="font-size:0.82rem;color:var(--text-secondary);margin-top:4px;display:block">${item.card_pin ? `PIN: <strong>****</strong>` : ''}</span>
                <button onclick="revealCard(${item.card_id})" style="margin-top:6px;font-size:0.72rem;background:rgba(108,99,255,0.2);border:1px solid rgba(108,99,255,0.4);color:#a78bfa;padding:3px 10px;border-radius:4px;cursor:pointer;">👁 Voir le vrai code</button>
                <div style="margin-top:8px;font-size:0.75rem;border-top:1px solid rgba(108,99,255,0.15);padding-top:6px;color:${item.seller_name ? '#22d3ee' : '#fb923c'}">
                  Vendeur : <strong>${item.seller_name ? esc(item.seller_shop || item.seller_name) : '👤 Admin'}</strong>
                </div>
              </div>
            ` : `<div style="margin-top:8px;font-size:0.78rem;color:#fcd34d">⚠️ Aucune carte assignée</div>`}
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    document.getElementById('orderDetailBody').innerHTML = `<p style="color:var(--admin-danger);padding:20px">Erreur chargement</p>`;
  }
}

async function revealCard(cardId) {
  try {
    const res = await adminFetch(`/admin/cards/${cardId}/reveal`);
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur', 'error'); return; }
    const codeEl = document.getElementById(`card-code-${cardId}`);
    const pinEl = document.getElementById(`card-pin-${cardId}`);
    if (codeEl) codeEl.textContent = data.code || '';
    if (pinEl && data.pin) pinEl.innerHTML = `PIN: <strong>${data.pin}</strong>`;
  } catch(e) {
    showToast('Erreur réseau.', 'error');
  }
}

async function redeliverOrder(orderId) {
  if (!confirm(`Relancer la livraison pour la commande #${orderId}?`)) return;

  try {
    const res = await adminFetch(`/admin/orders/${orderId}/redeliver`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast(`✅ Livraison relancée! ${data.result?.cards_assigned || 0} carte(s) livrée(s).`, 'success');
    if (currentOrderId === orderId) viewOrderDetail(orderId);
    loadAdminOrders();
  } catch (err) {
    showToast(err.message || 'Erreur re-livraison', 'error');
  }
}

function closeOrderDetail() {
  document.getElementById('orderDetailModal').classList.remove('active');
  document.getElementById('orderDetailOverlay').classList.remove('active');
  currentOrderId = null;
}

// ============ USERS ============
async function loadUsers() {
  document.getElementById('usersTable').innerHTML = `<div class="loading-center"><div class="loading-spinner"></div></div>`;

  const search = document.getElementById('userSearch')?.value || '';

  try {
    const params = new URLSearchParams();
    if (search) params.set('search', search);

    const res = await adminFetch(`/admin/users?${params}`);
    const data = await res.json();
    const users = data.users || [];

    if (users.length === 0) {
      document.getElementById('usersTable').innerHTML = `
        <div class="admin-table-wrap"><div class="empty-table"><div class="empty-icon">👥</div><p>Aucun utilisateur trouvé</p></div></div>
      `;
      return;
    }

    document.getElementById('usersTable').innerHTML = `
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Email</th>
              <th>Téléphone</th>
              <th>Rôle</th>
              <th>Commandes</th>
              <th>Dépenses</th>
              <th>Inscrit le</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${users.map(u => `
              <tr>
                <td>
                  <div style="display:flex;align-items:center;gap:8px">
                    <div style="width:30px;height:30px;background:linear-gradient(135deg,var(--admin-primary),#8b5cf6);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.8rem;flex-shrink:0">${esc(u.name.charAt(0).toUpperCase())}</div>
                    <strong>${esc(u.name)}</strong>
                  </div>
                </td>
                <td style="font-size:0.82rem">${esc(u.email)}</td>
                <td style="font-size:0.82rem">${esc(u.phone || '-')}</td>
                <td><span class="badge ${u.role === 'admin' ? 'badge-paid' : 'badge-pending'}">${u.role}</span></td>
                <td>${u.total_orders || 0}</td>
                <td style="color:#a78bfa;font-weight:600">${formatPrice(u.total_spent || 0)}</td>
                <td style="font-size:0.75rem">${formatDate(u.created_at)}</td>
                <td style="display:flex;gap:6px;flex-wrap:wrap;">
                  ${u.role !== 'seller' ? `
                    <button class="btn-sm ${u.role === 'admin' ? 'btn-secondary' : 'btn-primary'}"
                      onclick="changeUserRole(${u.id}, '${u.role === 'admin' ? 'client' : 'admin'}')"
                      title="${u.role === 'admin' ? 'Rétrograder en client' : 'Promouvoir en admin'}">
                      ${u.role === 'admin' ? '👤 Rétrograder' : '🛡️ Admin'}
                    </button>
                  ` : ''}
                  ${u.role !== 'admin' ? `
                    <button class="btn-sm btn-danger" onclick="deleteUser(${u.id})" title="Supprimer l'utilisateur">
                      🗑️
                    </button>
                  ` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    showToast('Erreur chargement utilisateurs', 'error');
  }
}

async function changeUserRole(userId, newRole) {
  const label = newRole === 'admin' ? 'administrateur' : 'client';
  if (!confirm(`Changer le rôle de cet utilisateur en ${label} ?`)) return;
  try {
    const res = await adminFetch(`/admin/users/${userId}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role: newRole })
    });
    const data = await res.json();
    if (res.ok) { showToast(data.message, 'success'); loadUsers(); }
    else showToast(data.error || 'Erreur', 'error');
  } catch (err) {
    showToast('Erreur réseau', 'error');
  }
}

async function deleteUser(userId) {
  if (!confirm(`Supprimer définitivement cet utilisateur ?\n\nSes commandes et données seront conservées mais son compte sera supprimé. Cette action est irréversible.`)) return;
  try {
    const res = await adminFetch(`/admin/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) { showToast(data.message, 'success'); loadUsers(); }
    else showToast(data.error || 'Erreur', 'error');
  } catch (err) {
    showToast('Erreur réseau', 'error');
  }
}

// ============ SELLERS ============
let allSellersData = [];

async function loadAdminSellers() {
  const container = document.getElementById('sellersTable');
  if (!container) return;
  container.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';

  try {
    const status = document.getElementById('sellerStatusFilter')?.value || '';
    const url = status ? `/admin/sellers?status=${status}` : '/admin/sellers';
    const res = await adminFetch(url);
    const data = await res.json();
    allSellersData = data.sellers || [];

    if (allSellersData.length === 0) {
      container.innerHTML = '<div class="loading-row" style="text-align:center;padding:40px;color:#888">Aucun vendeur trouvé.</div>';
      return;
    }

    const statusBadge = (s) => {
      const map = { pending: 'badge-warning', approved: 'badge-paid', rejected: 'badge-failed', suspended: 'badge-cancelled' };
      const labels = { pending: '⏳ En attente', approved: '✅ Approuvé', rejected: '❌ Rejeté', suspended: '🚫 Suspendu' };
      return `<span class="badge ${map[s] || ''}">${labels[s] || s}</span>`;
    };

    container.innerHTML = `
      <div style="overflow-x:auto">
        <table class="admin-table">
          <thead>
            <tr>
              <th>Boutique</th>
              <th>Vendeur</th>
              <th>Email</th>
              <th>Téléphone</th>
              <th>Produits</th>
              <th>Gains totaux</th>
              <th>Commission</th>
              <th>Statut</th>
              <th>Candidature</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${allSellersData.map(s => `
              <tr>
                <td><strong>${esc(s.shop_name)}</strong></td>
                <td>${esc(s.name)}</td>
                <td>${esc(s.email)}</td>
                <td>${esc(s.phone || '-')}</td>
                <td>${s.product_count}</td>
                <td>${formatPrice(s.total_earnings)}</td>
                <td>${s.commission_rate}%</td>
                <td>${statusBadge(s.status)}</td>
                <td>${formatDate(s.created_at)}</td>
                <td>
                  <button class="btn-sm btn-primary" onclick="openSellerModalById(${s.user_id})">
                    ✏️ Gérer
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch(err) {
    container.innerHTML = '<div style="padding:20px;color:#ef4444">Erreur chargement vendeurs.</div>';
  }
}

function openSellerModalById(userId) {
  const s = allSellersData.find(x => x.user_id === userId);
  if (!s) return;
  openSellerModal(s.user_id, s.status, s.commission_rate, s.admin_note || '', s.shop_name, s.id_doc_url || '', s.address_doc_url || '', s.contact_email || '');
}

function openSellerModal(userId, status, commission, note, shopName, idDocUrl, addressDocUrl, contactEmail) {
  document.getElementById('sellerModalUserId').value = userId;
  document.getElementById('sellerModalTitle').textContent = `Gérer: ${shopName}`;
  document.getElementById('sellerModalStatus').value = status;
  document.getElementById('sellerModalCommission').value = commission;
  document.getElementById('sellerModalNote').value = note || '';

  // Contact email
  const emailEl = document.getElementById('sellerModalEmail');
  if (emailEl) emailEl.textContent = contactEmail || '—';

  // Documents
  const docsEl = document.getElementById('sellerModalDocs');
  if (docsEl) {
    const isImg = url => /\.(jpg|jpeg|png|webp)$/i.test(url);
    const docLink = (label, url) => {
      if (!url) return `<div class="doc-item doc-missing">📄 ${label} — <em>Non fourni</em></div>`;
      if (isImg(url)) {
        return `<div class="doc-item">
          <span class="doc-label">📄 ${label}</span>
          <a href="${url}" target="_blank"><img src="${url}" class="doc-thumb" alt="${label}"></a>
          <a href="${url}" target="_blank" class="doc-link">Voir en grand ↗</a>
        </div>`;
      }
      return `<div class="doc-item">
        <span class="doc-label">📄 ${label}</span>
        <a href="${url}" target="_blank" class="doc-link">📎 Ouvrir le fichier ↗</a>
      </div>`;
    };
    docsEl.innerHTML =
      docLink("Pièce d'identité", idDocUrl) +
      docLink("Registre de commerce", addressDocUrl);
  }

  document.getElementById('sellerModalOverlay').style.display = 'block';
  document.getElementById('sellerModal').classList.add('active');
}

function closeSellerModal() {
  document.getElementById('sellerModalOverlay').style.display = 'none';
  document.getElementById('sellerModal').classList.remove('active');
}

async function saveSellerStatus() {
  const userId = document.getElementById('sellerModalUserId').value;
  const status = document.getElementById('sellerModalStatus').value;
  const commission = parseFloat(document.getElementById('sellerModalCommission').value);
  const note = document.getElementById('sellerModalNote').value;

  try {
    const res = await adminFetch(`/admin/sellers/${userId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status, commission_rate: commission, admin_note: note })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      closeSellerModal();
      loadAdminSellers();
    } else {
      showToast(data.error || 'Erreur.', 'error');
    }
  } catch(e) {
    showToast('Erreur réseau.', 'error');
  }
}

// ============ WITHDRAWALS ============
let allWithdrawalsData = [];

async function loadAdminWithdrawals() {
  const container = document.getElementById('withdrawalsTable');
  if (!container) return;
  container.innerHTML = '<div class="loading-center"><div class="loading-spinner"></div></div>';

  try {
    const status = document.getElementById('withdrawalStatusFilter')?.value || '';
    const url = status ? `/admin/withdrawals?status=${status}` : '/admin/withdrawals';
    const res = await adminFetch(url);
    const data = await res.json();
    allWithdrawalsData = data.withdrawals || [];

    if (allWithdrawalsData.length === 0) {
      container.innerHTML = '<div class="loading-row" style="text-align:center;padding:40px;color:#888">Aucune demande de retrait.</div>';
      return;
    }

    const statusBadge = (s) => {
      const map = { pending: 'badge-warning', approved: 'badge-pending', paid: 'badge-paid', rejected: 'badge-failed' };
      const labels = { pending: '⏳ En attente', approved: '✅ Approuvé', paid: '💰 Payé', rejected: '❌ Rejeté' };
      return `<span class="badge ${map[s] || ''}">${labels[s] || s}</span>`;
    };

    container.innerHTML = `
      <div style="overflow-x:auto">
        <table class="admin-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Boutique</th>
              <th>Vendeur</th>
              <th>Montant</th>
              <th>Méthode</th>
              <th>Numéro</th>
              <th>Statut</th>
              <th>Note admin</th>
              <th>Date demande</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${allWithdrawalsData.map(w => `
              <tr>
                <td>#${w.id}</td>
                <td><strong>${esc(w.shop_name)}</strong></td>
                <td>${esc(w.seller_name)}</td>
                <td style="font-weight:700;color:#22c55e">${formatPrice(w.amount)}</td>
                <td>${w.payment_method === 'wave' ? '🌊 Wave CI' : '🟠 Orange Money'}</td>
                <td>${esc(w.payment_number)}</td>
                <td>${statusBadge(w.status)}</td>
                <td>${esc(w.admin_note || '-')}</td>
                <td>${formatDate(w.created_at)}</td>
                <td>
                  ${w.status !== 'paid' && w.status !== 'rejected' ? `
                    <button class="btn-sm btn-primary" onclick="openWithdrawalModalById(${w.id})">
                      ⚙️ Traiter
                    </button>
                  ` : '-'}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch(err) {
    container.innerHTML = '<div style="padding:20px;color:#ef4444">Erreur chargement retraits.</div>';
  }
}

function openWithdrawalModalById(id) {
  const w = allWithdrawalsData.find(x => x.id === id);
  if (!w) return;
  openWithdrawalModal(w.id, w.shop_name, w.amount, w.payment_method, w.payment_number);
}

function openWithdrawalModal(id, shopName, amount, method, number) {
  document.getElementById('withdrawalModalId').value = id;
  document.getElementById('withdrawalModalInfo').innerHTML = `
    <strong>${esc(shopName)}</strong> demande le retrait de <strong style="color:#22c55e">${formatPrice(amount)}</strong>
    via <strong>${method === 'wave' ? '🌊 Wave CI' : '🟠 Orange Money'}</strong> sur le numéro <strong>${esc(number)}</strong>
  `;
  document.getElementById('withdrawalModalStatus').value = 'approved';
  document.getElementById('withdrawalModalNote').value = '';
  // Generate random 4-digit confirmation code
  const code = String(Math.floor(1000 + Math.random() * 9000));
  document.getElementById('withdrawalConfirmCode').textContent = code;
  document.getElementById('withdrawalConfirmCode').dataset.code = code;
  document.getElementById('withdrawalConfirmInput').value = '';
  document.getElementById('withdrawalModalOverlay').style.display = 'block';
  document.getElementById('withdrawalModal').classList.add('active');
  setTimeout(() => document.getElementById('withdrawalConfirmInput').focus(), 300);
}

function closeWithdrawalModal() {
  document.getElementById('withdrawalModalOverlay').style.display = 'none';
  document.getElementById('withdrawalModal').classList.remove('active');
}

async function saveWithdrawalStatus() {
  const id = document.getElementById('withdrawalModalId').value;
  const status = document.getElementById('withdrawalModalStatus').value;
  const note = document.getElementById('withdrawalModalNote').value;

  // Verify confirmation code
  const expectedCode = document.getElementById('withdrawalConfirmCode').dataset.code;
  const enteredCode = document.getElementById('withdrawalConfirmInput').value.trim();
  if (enteredCode !== expectedCode) {
    document.getElementById('withdrawalConfirmInput').style.borderColor = '#ef4444';
    showToast('Code de confirmation incorrect.', 'error');
    document.getElementById('withdrawalConfirmInput').focus();
    return;
  }
  document.getElementById('withdrawalConfirmInput').style.borderColor = '';

  try {
    const res = await adminFetch(`/admin/withdrawals/${id}/process`, {
      method: 'PUT',
      body: JSON.stringify({ status, admin_note: note })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      closeWithdrawalModal();
      loadAdminWithdrawals();
    } else {
      showToast(data.error || 'Erreur.', 'error');
    }
  } catch(e) {
    showToast('Erreur réseau.', 'error');
  }
}

// ============ MIGRATE ENCRYPT CARDS ============
async function migrateEncryptCards() {
  const resultEl = document.getElementById('migrateResult');
  if (!confirm('Chiffrer toutes les anciennes cartes ? Assurez-vous d\'avoir fait un backup avant.')) return;
  resultEl.innerHTML = '<span style="color:#a0a0c0;font-size:0.85rem;">Migration en cours...</span>';
  try {
    const res = await adminFetch('/admin/migrate-encrypt-cards', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      resultEl.innerHTML = `<span style="color:#22c55e;font-size:0.85rem;">✅ ${data.encrypted} carte(s) chiffrée(s), ${data.already_encrypted} déjà chiffrée(s), ${data.errors} erreur(s).</span>`;
    } else {
      resultEl.innerHTML = `<span style="color:#ef4444;font-size:0.85rem;">❌ ${data.error}</span>`;
    }
  } catch(e) {
    resultEl.innerHTML = '<span style="color:#ef4444;font-size:0.85rem;">❌ Erreur réseau.</span>';
  }
}

// ============ DATABASE BACKUP ============
async function downloadBackup() {
  const resultEl = document.getElementById('backupResult');
  resultEl.innerHTML = '<span style="color:#a0a0c0;font-size:0.85rem;">Préparation du backup...</span>';
  try {
    const token = localStorage.getItem('token');
    const res = await fetch('/api/admin/backup', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      resultEl.innerHTML = `<span style="color:#ef4444;font-size:0.85rem;">❌ ${data.error || 'Erreur'}</span>`;
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    a.download = match ? match[1] : 'babicard-backup.db';
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
    resultEl.innerHTML = '<span style="color:#22c55e;font-size:0.85rem;">✅ Backup téléchargé.</span>';
  } catch(e) {
    resultEl.innerHTML = '<span style="color:#ef4444;font-size:0.85rem;">❌ Erreur réseau.</span>';
  }
}

// ============ SMS TEST ============
async function sendTestSMS() {
  const phone = document.getElementById('smsTestPhone').value.trim();
  const resultEl = document.getElementById('smsTestResult');
  if (!phone) { resultEl.innerHTML = '<div class="alert-box error">Entrez un numéro.</div>'; return; }

  resultEl.innerHTML = '<div class="alert-box" style="color:#a0a0c0;">Envoi en cours...</div>';
  try {
    const res = await adminFetch('/admin/test-sms', {
      method: 'POST',
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      resultEl.innerHTML = `<div class="alert-box success">✅ SMS envoyé à ${phone}${data.demo ? ' <em>(mode démo — variables non configurées)</em>' : ''}</div>`;
    } else {
      resultEl.innerHTML = `<div class="alert-box error">❌ Échec: ${data.error || 'Erreur inconnue'}</div>`;
    }
  } catch(e) {
    resultEl.innerHTML = '<div class="alert-box error">Erreur réseau.</div>';
  }
}

// ============ TOAST ============
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ============ APPEARANCE ============
let appearanceData = { logo: null, sliders: [] };

async function loadAppearanceSettings() {
  try {
    const res = await fetch(`${API}/settings/admin`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur chargement.', 'error'); return; }
    appearanceData = data;
    renderLogoEditor(data.logo);
    renderSlidersEditor(data.sliders);
  } catch(e) {
    showToast('Erreur réseau.', 'error');
  }
}

function renderLogoEditor(logo) {
  const tab = logo.type || 'emoji';
  // Apply accent color globally
  const accentColor = logo.accent_color || '#6C63FF';
  document.documentElement.style.setProperty('--logo-accent-color', accentColor);
  // Populate fields
  if (document.getElementById('logoEmoji')) document.getElementById('logoEmoji').value = logo.emoji || '🎮';
  if (document.getElementById('logoText')) document.getElementById('logoText').value = logo.text || 'GiftCard';
  if (document.getElementById('logoAccent')) document.getElementById('logoAccent').value = logo.accent || 'CI';
  if (document.getElementById('logoAccentColor')) document.getElementById('logoAccentColor').value = accentColor;
  if (document.getElementById('logoAccentColorHex')) document.getElementById('logoAccentColorHex').value = accentColor;
  if (document.getElementById('lpAccent')) document.getElementById('lpAccent').style.color = accentColor;
  if (logo.image_url) {
    const imgEl = document.getElementById('logoImgPreview');
    const imgContainer = document.getElementById('logoCurrentImage');
    if (imgEl) imgEl.src = logo.image_url;
    if (imgContainer) imgContainer.style.display = '';
    const urlInput = document.getElementById('logoImageUrl');
    if (urlInput) urlInput.value = logo.image_url;
  }
  switchLogoTab(tab);
}

function switchLogoTab(tab) {
  // Update tab button states
  const tabEmoji = document.getElementById('tabEmoji');
  const tabImage = document.getElementById('tabImage');
  if (tabEmoji) tabEmoji.classList.toggle('active', tab === 'emoji');
  if (tabImage) tabImage.classList.toggle('active', tab === 'image');

  const emojiPanel = document.getElementById('logoEmojiForm');
  const imagePanel = document.getElementById('logoImageForm');
  if (emojiPanel) emojiPanel.style.display = tab === 'emoji' ? '' : 'none';
  if (imagePanel) imagePanel.style.display = tab === 'image' ? '' : 'none';

  updateLogoPreview();
}

function updateLogoPreview() {
  // Live preview uses lpIcon, lpText, lpAccent elements
  const activeTab = document.getElementById('tabImage') && document.getElementById('tabImage').classList.contains('active') ? 'image' : 'emoji';
  const logo = appearanceData.logo || {};

  if (activeTab === 'image') {
    const url = (document.getElementById('logoImageUrl') || {}).value || logo.image_url || '';
    const lpIcon = document.getElementById('lpIcon');
    const lpText = document.getElementById('lpText');
    const lpAccent = document.getElementById('lpAccent');
    if (url && lpIcon) {
      lpIcon.innerHTML = '<img src="' + url + '" style="max-height:36px;vertical-align:middle;">';
      if (lpText) lpText.textContent = '';
      if (lpAccent) lpAccent.textContent = '';
    }
  } else {
    const emoji = (document.getElementById('logoEmoji') || {}).value || logo.emoji || '🎮';
    const text = (document.getElementById('logoText') || {}).value || logo.text || 'GiftCard';
    const accent = (document.getElementById('logoAccent') || {}).value || logo.accent || 'CI';
    const accentColor = (document.getElementById('logoAccentColor') || {}).value || logo.accent_color || '#6C63FF';
    // Sync hex input with color picker
    const hexInput = document.getElementById('logoAccentColorHex');
    if (hexInput) hexInput.value = accentColor;
    const lpIcon = document.getElementById('lpIcon');
    const lpText = document.getElementById('lpText');
    const lpAccent = document.getElementById('lpAccent');
    if (lpIcon) lpIcon.textContent = emoji;
    if (lpText) lpText.textContent = text;
    if (lpAccent) { lpAccent.textContent = accent; lpAccent.style.color = accentColor; }
  }
}

function syncColorFromHex() {
  const hex = (document.getElementById('logoAccentColorHex').value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
    document.getElementById('logoAccentColor').value = hex;
    updateLogoPreview();
  }
}

function updateLogoPreviewImage() {
  const url = (document.getElementById('logoImageUrl') || {}).value || '';
  if (url) {
    const imgEl = document.getElementById('logoImgPreview');
    const imgContainer = document.getElementById('logoCurrentImage');
    if (imgEl) { imgEl.src = url; }
    if (imgContainer) imgContainer.style.display = '';
    if (appearanceData.logo) appearanceData.logo.image_url = url;
  }
  updateLogoPreview();
}

async function uploadLogoFile(inputEl) {
  const input = inputEl || document.getElementById('logoFileInput');
  if (!input || !input.files[0]) { showToast('Sélectionnez un fichier image.', 'error'); return; }
  const status = document.getElementById('logoUploadStatus');
  if (status) status.textContent = 'Envoi en cours...';
  const formData = new FormData();
  formData.append('logo', input.files[0]);
  try {
    const res = await fetch(`${API}/settings/admin/logo/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
      body: formData
    });
    const data = await res.json();
    if (!res.ok) {
      if (status) status.textContent = data.error || 'Erreur upload.';
      showToast(data.error || 'Erreur upload.', 'error');
      return;
    }
    showToast('Logo uploadé !', 'success');
    if (status) status.textContent = 'Uploadé !';
    appearanceData.logo = data.logo;
    const imgEl = document.getElementById('logoImgPreview');
    const imgContainer = document.getElementById('logoCurrentImage');
    if (imgEl) imgEl.src = data.image_url;
    if (imgContainer) imgContainer.style.display = '';
    const urlInput = document.getElementById('logoImageUrl');
    if (urlInput) urlInput.value = data.image_url;
    updateLogoPreview();
  } catch(e) {
    if (status) status.textContent = 'Erreur réseau.';
    showToast('Erreur réseau.', 'error');
  }
}

async function saveLogo() {
  const isImage = document.getElementById('tabImage') && document.getElementById('tabImage').classList.contains('active');
  const tab = isImage ? 'image' : 'emoji';
  let payload;
  const accentColor = (document.getElementById('logoAccentColor') || {}).value || '#6C63FF';
  if (tab === 'emoji') {
    payload = {
      type: 'emoji',
      emoji: document.getElementById('logoEmoji').value.trim() || '🎮',
      text: document.getElementById('logoText').value.trim() || 'GiftCard',
      accent: document.getElementById('logoAccent').value.trim() || 'CI',
      accent_color: accentColor,
      image_url: (appearanceData.logo && appearanceData.logo.image_url) || ''
    };
  } else {
    const urlVal = (document.getElementById('logoImageUrl') || {}).value || '';
    payload = {
      type: 'image',
      emoji: (appearanceData.logo && appearanceData.logo.emoji) || '🎮',
      text: (appearanceData.logo && appearanceData.logo.text) || 'GiftCard',
      accent: (appearanceData.logo && appearanceData.logo.accent) || 'CI',
      accent_color: accentColor,
      image_url: urlVal || (appearanceData.logo && appearanceData.logo.image_url) || ''
    };
  }
  try {
    const res = await fetch(`${API}/settings/admin/logo`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur.', 'error'); return; }
    showToast('Logo sauvegardé !', 'success');
    appearanceData.logo = data.logo;
  } catch(e) {
    showToast('Erreur réseau.', 'error');
  }
}

function renderSlidersEditor(sliders) {
  const container = document.getElementById('slidersEditor');
  if (!container) return;
  container.innerHTML = '';
  sliders.forEach((slide, idx) => {
    container.appendChild(renderSliderCard(slide, idx));
  });
}

function renderSliderCard(slide, idx) {
  const div = document.createElement('div');
  div.className = 'slider-card';
  div.dataset.idx = idx;

  const pricesHtml = (slide.prices || []).map((p, pi) =>
    '<div class="price-row" data-pi="' + pi + '">' +
    '<input class="form-control price-input" value="' + p + '" placeholder="10$ → 6 500 FCFA">' +
    '<button class="btn-icon" onclick="removePrice(' + idx + ',' + pi + ')">✕</button>' +
    '</div>'
  ).join('');

  div.innerHTML =
    '<div class="slider-card-header" onclick="toggleSlideCard(' + idx + ')">' +
    '<span class="slide-num">Slide ' + (idx + 1) + '</span>' +
    '<span class="slide-title-preview">' + (slide.title || '') + ' ' + (slide.title_accent || '') + '</span>' +
    '<label class="toggle-switch" onclick="event.stopPropagation()">' +
    '<input type="checkbox" ' + (slide.active !== false ? 'checked' : '') + ' onchange="toggleSlideActive(' + idx + ',this.checked)">' +
    '<span class="toggle-slider-bg"></span>' +
    '</label>' +
    '<span class="collapse-arrow">▼</span>' +
    '</div>' +
    '<div class="slider-card-body" id="slideBody_' + idx + '">' +
    '<div class="form-row">' +
    '<div class="form-group"><label>Tag</label><input class="form-control slide-tag" value="' + (slide.tag || '') + '" placeholder="🎮 Gaming"></div>' +
    '<div class="form-group"><label>Icône emoji</label><input class="form-control slide-icon-emoji" value="' + (slide.icon_emoji || '') + '" placeholder="🎮"></div>' +
    '</div>' +
    '<div class="form-row">' +
    '<div class="form-group"><label>Titre</label><input class="form-control slide-title" value="' + (slide.title || '') + '" placeholder="PlayStation"></div>' +
    '<div class="form-group"><label>Accent titre</label><input class="form-control slide-title-accent" value="' + (slide.title_accent || '') + '" placeholder="Network Cards"></div>' +
    '</div>' +
    '<div class="form-group"><label>Description</label><textarea class="form-control slide-desc" rows="2" placeholder="Description...">' + (slide.description || '') + '</textarea></div>' +
    '<div class="form-group"><label>Image de fond (optionnel)</label>' +
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">' +
    '<input class="form-control slide-image-url" value="' + (slide.image_url || '') + '" placeholder="URL ou uploader ci-dessous" style="flex:1;min-width:200px;">' +
    '<label class="btn btn-outline" style="cursor:pointer;white-space:nowrap;">📁 Uploader<input type="file" accept="image/*" style="display:none;" onchange="uploadSlideImage(this,' + idx + ')"></label>' +
    '</div>' +
    (slide.image_url ? '<img src="' + slide.image_url + '" style="margin-top:8px;max-height:80px;border-radius:6px;object-fit:cover;" id="slideImgPreview_' + idx + '">' : '<img id="slideImgPreview_' + idx + '" style="display:none;margin-top:8px;max-height:80px;border-radius:6px;object-fit:cover;">') +
    '</div>' +
    '<div class="form-group"><label>Gradient CSS</label><input class="form-control slide-gradient" value="' + (slide.bg_gradient || '') + '" placeholder="linear-gradient(...)"></div>' +
    '<div class="form-group"><label>Icône couleur fond</label><input class="form-control slide-icon-bg" value="' + (slide.icon_bg || '') + '" placeholder="#003087"></div>' +
    '<div class="form-group"><label>Texte bouton</label><input class="form-control slide-cta" value="' + (slide.cta_text || 'Acheter →') + '"></div>' +
    '<div class="form-group"><label>Prix affichés</label><div class="prices-list" id="pricesList_' + idx + '">' + pricesHtml + '</div>' +
    '<button class="btn btn-sm btn-outline" onclick="addPrice(' + idx + ')">+ Ajouter un prix</button></div>' +
    '</div>';

  return div;
}

function toggleSlideCard(idx) {
  const body = document.getElementById('slideBody_' + idx);
  if (!body) return;
  body.classList.toggle('open');
  const card = body.closest('.slider-card');
  if (card) card.classList.toggle('expanded');
}

function toggleSlideActive(idx, val) {
  if (appearanceData.sliders[idx]) appearanceData.sliders[idx].active = val;
}

function addPrice(idx) {
  const list = document.getElementById('pricesList_' + idx);
  if (!list) return;
  const pi = list.querySelectorAll('.price-row').length;
  const div = document.createElement('div');
  div.className = 'price-row';
  div.dataset.pi = pi;
  div.innerHTML =
    '<input class="form-control price-input" value="" placeholder="10$ → 6 500 FCFA">' +
    '<button class="btn-icon" onclick="removePrice(' + idx + ',' + pi + ')">✕</button>';
  list.appendChild(div);
}

function removePrice(idx, pi) {
  const list = document.getElementById('pricesList_' + idx);
  if (!list) return;
  const rows = list.querySelectorAll('.price-row');
  if (rows[pi]) rows[pi].remove();
}

async function uploadSlideImage(input, idx) {
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('image', file);
  try {
    const res = await adminFetch('/admin/products/upload-image', { method: 'POST', body: form });
    const data = await res.json();
    if (data.url) {
      const urlInput = document.querySelector(`#slideBody_${idx} .slide-image-url`);
      if (urlInput) urlInput.value = data.url;
      const preview = document.getElementById(`slideImgPreview_${idx}`);
      if (preview) { preview.src = data.url; preview.style.display = 'block'; }
      showToast('Image uploadée !', 'success');
    }
  } catch(e) {
    showToast('Erreur upload image.', 'error');
  }
}

function collectSlidersData() {
  const cards = document.querySelectorAll('#slidersEditor .slider-card');
  const sliders = [];
  cards.forEach((card, idx) => {
    const prices = Array.from(card.querySelectorAll('.price-input'))
      .map(i => i.value.trim()).filter(Boolean);
    sliders.push({
      id: idx + 1,
      active: card.querySelector('input[type="checkbox"]').checked,
      tag: (card.querySelector('.slide-tag') || {}).value || '',
      title: (card.querySelector('.slide-title') || {}).value || '',
      title_accent: (card.querySelector('.slide-title-accent') || {}).value || '',
      description: (card.querySelector('.slide-desc') || {}).value || '',
      bg_gradient: (card.querySelector('.slide-gradient') || {}).value || '',
      icon_emoji: (card.querySelector('.slide-icon-emoji') || {}).value || '',
      icon_bg: (card.querySelector('.slide-icon-bg') || {}).value || '',
      cta_text: (card.querySelector('.slide-cta') || {}).value || 'Acheter →',
      image_url: (card.querySelector('.slide-image-url') || {}).value || '',
      prices
    });
  });
  return sliders;
}

async function saveSliders() {
  const sliders = collectSlidersData();
  if (!sliders.length) { showToast('Aucun slider à sauvegarder.', 'error'); return; }
  try {
    const res = await fetch(`${API}/settings/admin/sliders`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sliders })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erreur.', 'error'); return; }
    showToast(data.message || 'Sliders sauvegardés !', 'success');
    appearanceData.sliders = sliders;
  } catch(e) {
    showToast('Erreur réseau.', 'error');
  }
}

function addNewSlide() {
  const newSlide = {
    id: appearanceData.sliders.length + 1,
    active: true,
    tag: 'Nouveau',
    title: 'Nouveau Slide',
    title_accent: '',
    description: '',
    bg_gradient: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
    icon_emoji: '🎁',
    icon_bg: '#6c63ff',
    cta_text: 'Acheter →',
    prices: []
  };
  appearanceData.sliders.push(newSlide);
  renderSlidersEditor(appearanceData.sliders);
}

async function saveAllAppearance() {
  await saveLogo();
  await saveSliders();
}

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
