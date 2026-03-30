// =============================================
// Babicard.ci — Shopping Cart & Checkout
// =============================================


let cart = [];

// ============ CART STORAGE ============
function cartKey() {
  const user = typeof getUser === 'function' ? getUser() : null;
  return user ? `cart_${user.id}` : 'cart_guest';
}

function loadCart() {
  try {
    const stored = JSON.parse(localStorage.getItem(cartKey()) || '[]');
    // Migrate old format (quantity > 1) → individual items
    cart = [];
    for (const item of stored) {
      const qty = item.quantity || 1;
      for (let i = 0; i < qty; i++) {
        cart.push({ ...item, quantity: 1 });
      }
    }
  } catch {
    cart = [];
  }
  updateCartUI();
}

function saveCart() {
  localStorage.setItem(cartKey(), JSON.stringify(cart));
}

// ============ CART OPERATIONS ============
function addToCart(productId) {
  const product = (typeof allProducts !== 'undefined' ? allProducts : []).find(p => p.id === productId);
  if (!product) return;

  if (product.available_stock <= 0) {
    showToast('❌ Ce produit est en rupture de stock.', 'error');
    return;
  }

  const unitsInCart = cart.filter(item => item.id === productId).length;

  if (unitsInCart >= product.available_stock) {
    showToast(`⚠️ Stock maximum atteint (${product.available_stock} disponible${product.available_stock > 1 ? 's' : ''}).`, 'warning');
    return;
  }

  // Determine price: promo price for first N units (where N = promo_stock), then regular
  const promoStock = product.promo_stock || 0;
  const promoUnitsInCart = cart.filter(item => item.id === productId && item.original_price).length;
  const usePromo = product.promo_price && product.promo_price > 0 && promoUnitsInCart < promoStock;

  cart.push({
    id: product.id,
    name: product.name,
    platform: product.platform,
    denomination: product.denomination,
    price: usePromo ? product.promo_price : product.price,
    original_price: usePromo ? product.price : null,
    category: product.category,
    quantity: 1,
    max_stock: product.available_stock
  });

  saveCart();
  updateCartUI();
  showToast(`✅ "${product.name}" ajouté au panier!`, 'success');
  openCart();
}

// Remove one specific unit by index
function removeUnit(index) {
  cart.splice(index, 1);
  saveCart();
  updateCartUI();
}

// Remove all units of a product (trash button)
function removeFromCart(productId) {
  cart = cart.filter(item => item.id !== productId);
  saveCart();
  updateCartUI();
}

// + adds a new unit, - removes last unit of that product
function updateQuantity(productId, delta) {
  if (delta > 0) {
    addToCart(productId);
    return;
  }
  // Remove the last unit of this product
  for (let i = cart.length - 1; i >= 0; i--) {
    if (cart[i].id === productId) {
      cart.splice(i, 1);
      break;
    }
  }
  saveCart();
  updateCartUI();
}

function getCartTotal() {
  return cart.reduce((total, item) => total + item.price, 0);
}

function getCartItemCount() {
  return cart.length;
}

// ============ CART UI ============
function getCategoryIcon(category) {
  const icons = {
    apple: '🍎', playstation: '🎮', xbox: '🟢',
    google: '🎯', steam: '🖥️', netflix: '🎬',
    amazon: '📦', other: '🎁'
  };
  return icons[category] || '🎁';
}

function updateCartUI() {
  const cartCount = document.getElementById('cartCount');
  const cartItems = document.getElementById('cartItems');
  const cartTotal = document.getElementById('cartTotal');
  const cartFooter = document.getElementById('cartFooter');

  const count = getCartItemCount();
  const total = getCartTotal();

  // Update badge
  if (cartCount) {
    cartCount.textContent = count;
    cartCount.style.display = count > 0 ? 'flex' : 'none';
  }

  if (!cartItems) return;

  if (cart.length === 0) {
    cartItems.innerHTML = `
      <div class="cart-empty">
        <div class="cart-empty-icon">🛒</div>
        <p>Votre panier est vide</p>
        <button onclick="toggleCart()" class="btn-secondary" style="margin-top:8px">Continuer vos achats</button>
      </div>
    `;
    if (cartFooter) cartFooter.style.display = 'none';
    return;
  }

  if (cartFooter) cartFooter.style.display = 'block';

  // Group items by product for display, but keep individual pricing
  const groups = {};
  cart.forEach((item, index) => {
    if (!groups[item.id]) groups[item.id] = { item, indices: [] };
    groups[item.id].indices.push(index);
  });

  cartItems.innerHTML = Object.values(groups).map(({ item, indices }) => {
    const count = indices.length;
    const unitsHtml = indices.map((idx, i) => {
      const unit = cart[idx];
      const unitLabel = count > 1 ? ` <span style="color:#606080;font-size:0.75rem;">#${i + 1}</span>` : '';
      return `
        <div class="cart-item" style="${i > 0 ? 'border-top:1px solid rgba(255,255,255,0.04);' : ''}">
          <div class="cart-item-icon bg-${unit.category || 'other'}" style="${i > 0 ? 'visibility:hidden;' : ''}">
            ${getCategoryIcon(unit.category)}
          </div>
          <div class="cart-item-info">
            <div class="cart-item-name">${esc(unit.name)}${unitLabel}</div>
            <div class="cart-item-price">
              ${unit.original_price ? `<span style="text-decoration:line-through;color:#888;font-size:0.75rem;margin-right:4px;">${formatPrice(unit.original_price)}</span>` : ''}
              <span style="${unit.original_price ? 'color:#ef4444;font-weight:700;' : ''}">${formatPrice(unit.price)}</span>
            </div>
          </div>
          <div class="cart-item-controls">
            <button class="cart-item-remove" onclick="removeUnit(${idx})" title="Retirer">🗑</button>
          </div>
        </div>`;
    }).join('');

    return `
      <div style="margin-bottom:4px;">
        ${unitsHtml}
        <div style="display:flex;justify-content:flex-end;gap:6px;padding:4px 0 8px;">
          <button class="qty-btn" onclick="updateQuantity(${item.id}, -1)" title="Retirer un">−</button>
          <button class="qty-btn" onclick="updateQuantity(${item.id}, 1)" title="Ajouter un">+</button>
        </div>
      </div>`;
  }).join('');

  // Check if any item has a promo price (meaning actual total may differ per seller)
  const hasPromoItems = cart.some(item => item.original_price && item.quantity >= 1);

  if (cartTotal) {
    cartTotal.textContent = formatPrice(total);
  }

  // Show/hide estimated price warning
  let estimateNote = document.getElementById('cartEstimateNote');
  if (hasPromoItems) {
    if (!estimateNote) {
      estimateNote = document.createElement('p');
      estimateNote.id = 'cartEstimateNote';
      estimateNote.style.cssText = 'font-size:0.72rem;color:#f97316;margin:6px 0 0;text-align:right;';
      cartTotal?.parentElement?.appendChild(estimateNote);
    }
    estimateNote.textContent = '* Prix estimé — total exact confirmé à la commande';
  } else if (estimateNote) {
    estimateNote.remove();
  }

  // Show/hide phone input for Orange Money
  const paymentRadios = document.querySelectorAll('input[name="paymentMethod"]');
  const phoneInput = document.getElementById('paymentPhone');
  paymentRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (phoneInput) {
        phoneInput.style.display = radio.value === 'orange_money' ? 'block' : 'none';
      }
    });
  });
}

// ============ CART SIDEBAR ============
function toggleCart() {
  const sidebar = document.getElementById('cartSidebar');
  const overlay = document.getElementById('cartOverlay');

  if (!sidebar) return;

  sidebar.classList.toggle('active');
  overlay.classList.toggle('active');
  document.body.style.overflow = sidebar.classList.contains('active') ? 'hidden' : '';
}

function openCart() {
  const sidebar = document.getElementById('cartSidebar');
  const overlay = document.getElementById('cartOverlay');
  if (sidebar && !sidebar.classList.contains('active')) {
    sidebar.classList.add('active');
    overlay?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
}

// ============ DELIVERY CONFIRMATION MODAL ============
function openDeliveryModal() {
  if (cart.length === 0) { showToast('Votre panier est vide.', 'error'); return; }
  if (!isLoggedIn()) {
    showToast('Connectez-vous pour finaliser votre achat.', 'warning');
    setTimeout(() => { window.location.href = '/login?redirect=/'; }, 1500);
    return;
  }
  // Pre-fill with user account info
  const user = getUser();
  const emailInput = document.getElementById('deliveryEmail');
  const phoneInput = document.getElementById('deliveryPhone');
  if (emailInput && user?.email) emailInput.value = user.email;
  if (phoneInput && user?.phone) phoneInput.value = user.phone;

  const overlay = document.getElementById('deliveryModalOverlay');
  const modal = document.getElementById('deliveryModal');
  if (overlay) overlay.classList.add('active');
  if (modal) modal.style.display = 'block';
}

function closeDeliveryModal() {
  const overlay = document.getElementById('deliveryModalOverlay');
  const modal = document.getElementById('deliveryModal');
  if (overlay) overlay.classList.remove('active');
  if (modal) modal.style.display = 'none';
}

async function confirmDeliveryAndPay() {
  const email = document.getElementById('deliveryEmail')?.value.trim();
  const phone = document.getElementById('deliveryPhone')?.value.trim();

  if (!email) {
    document.getElementById('deliveryEmail').style.borderColor = '#ef4444';
    document.getElementById('deliveryEmail').focus();
    showToast('Veuillez entrer votre email de livraison.', 'error');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('deliveryEmail').style.borderColor = '#ef4444';
    showToast('Email invalide.', 'error');
    return;
  }
  document.getElementById('deliveryEmail').style.borderColor = '';

  closeDeliveryModal();
  await checkout(email, phone);
}

// ============ CHECKOUT ============
async function checkout(deliveryEmail, deliveryPhone) {
  const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked')?.value || 'wave';
  const phone = deliveryPhone || document.getElementById('paymentPhone')?.value;

  const checkoutBtn = document.getElementById('checkoutBtn');
  const originalText = checkoutBtn?.textContent;
  if (checkoutBtn) {
    checkoutBtn.disabled = true;
    checkoutBtn.textContent = '⏳ Traitement...';
  }

  try {
    const items = cart.map(item => ({
      product_id: item.id,
      quantity: item.quantity
    }));

    const orderRes = await authFetch('/orders', {
      method: 'POST',
      body: JSON.stringify({ items, payment_method: paymentMethod, delivery_email: deliveryEmail, delivery_phone: deliveryPhone })
    });

    if (!orderRes || !orderRes.ok) {
      const err = await orderRes?.json();
      throw new Error(err?.error || 'Erreur lors de la création de la commande');
    }

    const orderData = await orderRes.json();
    const orderId = orderData.order.id;
    const actualTotal = orderData.order.total_amount;

    // Show order confirmation with real per-card prices before payment
    showOrderConfirmModal(orderId, actualTotal, orderData.items || [], paymentMethod, phone);

  } catch (err) {
    showToast(err.message || 'Erreur lors du paiement', 'error');
  } finally {
    if (checkoutBtn) {
      checkoutBtn.disabled = false;
      checkoutBtn.textContent = originalText;
    }
  }
}

// ---- ORDER CONFIRMATION MODAL ----
function buildOrderConfirmModal() {
  const overlay = document.createElement('div');
  overlay.id = 'orderConfirmOverlay';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:2000;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#13131f;border:1px solid rgba(108,99,255,0.3);border-radius:16px;padding:28px;max-width:460px;width:92%;max-height:85vh;overflow-y:auto;">
      <h3 style="margin:0 0 16px;font-size:1.1rem;color:#f0f0ff;">🧾 Récapitulatif de votre commande</h3>
      <div id="orderConfirmItems" style="margin-bottom:16px;"></div>
      <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:14px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#a0a0c0;font-size:0.9rem;">Total à payer</span>
        <span id="orderConfirmTotal" style="font-size:1.4rem;font-weight:700;color:#22c55e;"></span>
      </div>
      <div style="display:flex;gap:10px;">
        <button id="orderConfirmPayBtn" style="flex:2;background:#6C63FF;color:white;border:none;border-radius:8px;padding:12px;font-size:0.95rem;font-weight:600;cursor:pointer;">💳 Confirmer et payer</button>
        <button onclick="cancelPendingOrder()" style="flex:1;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:8px;padding:12px;cursor:pointer;font-size:0.9rem;">Annuler</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

let _pendingOrderId = null, _pendingPaymentMethod = null, _pendingPhone = null;

function showOrderConfirmModal(orderId, total, items, paymentMethod, phone) {
  if (!document.getElementById('orderConfirmOverlay')) buildOrderConfirmModal();

  _pendingOrderId = orderId;
  _pendingPaymentMethod = paymentMethod;
  _pendingPhone = phone;

  // Group items by product name to show summary
  const grouped = {};
  for (const item of items) {
    const key = item.product_name;
    if (!grouped[key]) grouped[key] = { name: item.product_name, prices: [] };
    grouped[key].prices.push(item.unit_price);
  }

  document.getElementById('orderConfirmItems').innerHTML = Object.values(grouped).map(g => {
    if (g.prices.length === 1) {
      return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.9rem;">
        <span style="color:#d0d0f0;">${esc(g.name)}</span>
        <span style="font-weight:600;">${formatPrice(g.prices[0])}</span>
      </div>`;
    }
    // Multiple cards — show each price
    return g.prices.map((p, i) => `
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.9rem;">
        <span style="color:#d0d0f0;">${esc(g.name)} <span style="color:#a0a0c0;font-size:0.8rem;">#${i+1}</span></span>
        <span style="font-weight:600;">${formatPrice(p)}</span>
      </div>`).join('');
  }).join('');

  document.getElementById('orderConfirmTotal').textContent = formatPrice(total);
  document.getElementById('orderConfirmPayBtn').onclick = proceedToPayment;

  document.getElementById('orderConfirmOverlay').style.display = 'flex';
}

async function proceedToPayment() {
  const orderId = _pendingOrderId;
  const paymentMethod = _pendingPaymentMethod;
  const phone = _pendingPhone;

  const btn = document.getElementById('orderConfirmPayBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Traitement...'; }

  document.getElementById('orderConfirmOverlay').style.display = 'none';

  try {
    const paymentBody = { order_id: orderId };
    if (paymentMethod === 'orange_money' && phone) paymentBody.phone = phone;

    const paymentEndpoint = paymentMethod === 'wave' ? '/payment/wave/initiate' : '/payment/orange/initiate';
    const paymentRes = await authFetch(paymentEndpoint, {
      method: 'POST',
      body: JSON.stringify(paymentBody)
    });

    if (!paymentRes || !paymentRes.ok) {
      const err = await paymentRes?.json();
      throw new Error(err?.error || 'Erreur initialisation paiement');
    }

    const paymentData = await paymentRes.json();

    if (paymentData.demo_mode) {
      showToast('🧪 Mode démo: Simulation du paiement...', 'info');
      setTimeout(async () => {
        try {
          const simRes = await authFetch('/payment/simulate', {
            method: 'POST',
            body: JSON.stringify({ payment_ref: paymentData.payment_ref, success: true })
          });
          if (simRes.ok) {
            cart = []; saveCart(); updateCartUI(); toggleCart();
            showToast('✅ Paiement simulé! Codes envoyés par email.', 'success');
            setTimeout(() => { window.location.href = `/dashboard?order=${orderId}&status=success`; }, 2000);
          } else {
            showToast('Erreur paiement simulation', 'error');
          }
        } catch (e) { showToast('Erreur: ' + e.message, 'error'); }
      }, 1500);
    } else {
      cart = []; saveCart();
      showToast('Redirection vers la page de paiement...', 'info');
      setTimeout(() => { window.location.href = paymentData.payment_url; }, 800);
    }
  } catch (err) {
    showToast(err.message || 'Erreur paiement', 'error');
    if (btn) { btn.disabled = false; btn.textContent = '💳 Confirmer et payer'; }
  }
}

async function cancelPendingOrder() {
  const orderId = _pendingOrderId;
  document.getElementById('orderConfirmOverlay').style.display = 'none';
  if (!orderId) return;
  try {
    await authFetch(`/orders/${orderId}/cancel`, { method: 'DELETE' });
  } catch(e) { /* silent */ }
  showToast('Commande annulée.', 'info');
  _pendingOrderId = null;
}

// ============ TOAST ============
function showToast(message, type = 'info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => toast.classList.add('show'));
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
  loadCart();
});
