// =============================================
// Babicard.ci — Shopping Cart & Checkout
// =============================================

let cart = [];

// ============ CART STORAGE ============
function loadCart() {
  try {
    cart = JSON.parse(localStorage.getItem('cart') || '[]');
  } catch {
    cart = [];
  }
  updateCartUI();
}

function saveCart() {
  localStorage.setItem('cart', JSON.stringify(cart));
}

// ============ CART OPERATIONS ============
function addToCart(productId) {
  const product = (typeof allProducts !== 'undefined' ? allProducts : []).find(p => p.id === productId);
  if (!product) return;

  if (product.available_stock <= 0) {
    showToast('❌ Ce produit est en rupture de stock.', 'error');
    return;
  }

  const existingItem = cart.find(item => item.id === productId);
  const currentQty = existingItem ? existingItem.quantity : 0;

  if (currentQty >= product.available_stock) {
    showToast(`⚠️ Stock maximum atteint (${product.available_stock} disponible${product.available_stock > 1 ? 's' : ''}).`, 'warning');
    return;
  }

  if (existingItem) {
    existingItem.quantity++;
  } else {
    cart.push({
      id: product.id,
      name: product.name,
      platform: product.platform,
      denomination: product.denomination,
      price: product.price,
      category: product.category,
      quantity: 1,
      max_stock: product.available_stock
    });
  }

  saveCart();
  updateCartUI();
  showToast(`✅ "${product.name}" ajouté au panier!`, 'success');

  // Auto open cart
  openCart();
}

function removeFromCart(productId) {
  cart = cart.filter(item => item.id !== productId);
  saveCart();
  updateCartUI();
}

function updateQuantity(productId, delta) {
  const item = cart.find(i => i.id === productId);
  if (!item) return;

  item.quantity += delta;

  if (item.quantity <= 0) {
    removeFromCart(productId);
    return;
  }

  if (item.quantity > (item.max_stock || 99)) {
    item.quantity = item.max_stock || 99;
    showToast('Stock maximum atteint.', 'warning');
  }

  saveCart();
  updateCartUI();
}

function getCartTotal() {
  return cart.reduce((total, item) => total + item.price * item.quantity, 0);
}

function getCartItemCount() {
  return cart.reduce((total, item) => total + item.quantity, 0);
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

function formatPrice(amount) {
  return new Intl.NumberFormat('fr-FR').format(amount) + ' FCFA';
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

  cartItems.innerHTML = cart.map(item => `
    <div class="cart-item">
      <div class="cart-item-icon bg-${item.category || 'other'}">
        ${getCategoryIcon(item.category)}
      </div>
      <div class="cart-item-info">
        <div class="cart-item-name">${item.name}</div>
        <div class="cart-item-price">${formatPrice(item.price)}</div>
      </div>
      <div class="cart-item-controls">
        <button class="qty-btn" onclick="updateQuantity(${item.id}, -1)">−</button>
        <span class="qty-val">${item.quantity}</span>
        <button class="qty-btn" onclick="updateQuantity(${item.id}, 1)">+</button>
        <button class="cart-item-remove" onclick="removeFromCart(${item.id})" title="Supprimer">🗑</button>
      </div>
    </div>
  `).join('');

  if (cartTotal) {
    cartTotal.textContent = formatPrice(total);
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
    // Prepare order items
    const items = cart.map(item => ({
      product_id: item.id,
      quantity: item.quantity
    }));

    // Create order
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

    // Initiate payment
    const paymentBody = { order_id: orderId };
    if (paymentMethod === 'orange_money' && phone) {
      paymentBody.phone = phone;
    }

    const paymentEndpoint = paymentMethod === 'wave' ? '/payment/wave/initiate' : '/payment/orange/initiate';
    const paymentRes = await authFetch(paymentEndpoint, {
      method: 'POST',
      body: JSON.stringify(paymentBody)
    });

    if (!paymentRes || !paymentRes.ok) {
      const err = await paymentRes?.json();
      throw new Error(err?.error || 'Erreur lors de l\'initialisation du paiement');
    }

    const paymentData = await paymentRes.json();

    if (paymentData.demo_mode) {
      showToast('🧪 Mode démo: Simulation du paiement...', 'info');

      // In demo mode, simulate payment directly
      setTimeout(async () => {
        try {
          const simRes = await authFetch('/payment/simulate', {
            method: 'POST',
            body: JSON.stringify({ payment_ref: paymentData.payment_ref, success: true })
          });
          await simRes.json();

          if (simRes.ok) {
            // Clear cart
            cart = [];
            saveCart();
            updateCartUI();
            toggleCart();
            showToast('✅ Paiement simulé! Codes envoyés par email.', 'success');
            setTimeout(() => {
              window.location.href = `/dashboard?order=${orderId}&status=success`;
            }, 2000);
          } else {
            const errData = await simRes.json().catch(() => ({}));
            showToast('Erreur paiement: ' + (errData.error || simRes.status), 'error');
          }
        } catch (e) {
          showToast('Erreur simulation: ' + e.message, 'error');
        }
      }, 1500);
    } else {
      // Clear cart and redirect to payment
      cart = [];
      saveCart();
      showToast('Redirection vers la page de paiement...', 'info');
      setTimeout(() => {
        window.location.href = paymentData.payment_url;
      }, 800);
    }

  } catch (err) {
    showToast(err.message || 'Erreur lors du paiement', 'error');
  } finally {
    if (checkoutBtn) {
      checkoutBtn.disabled = false;
      checkoutBtn.textContent = originalText;
    }
  }
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
