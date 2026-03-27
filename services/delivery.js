const { getDb } = require('../database/db');
const { sendOrderConfirmationEmail, sendLowStockEmail } = require('./email');
const { sendCardDeliveredSMS, sendPaymentConfirmationSMS } = require('./sms');

async function processDelivery(orderId, forceRedeliver = false) {
  const db = getDb();
  console.log(`\n[DELIVERY] Traitement livraison commande #${orderId}...`);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) {
    console.error(`[DELIVERY] Commande #${orderId} non trouvée.`);
    return { success: false, error: 'Commande non trouvée' };
  }

  if (order.payment_status !== 'paid') {
    console.log(`[DELIVERY] Commande #${orderId} non payée (status: ${order.payment_status}).`);
    return { success: false, error: 'Commande non payée' };
  }

  if (order.delivery_status === 'delivered' && !forceRedeliver) {
    console.log(`[DELIVERY] Commande #${orderId} déjà livrée.`);
    return { success: true, already_delivered: true };
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
  if (!user) {
    console.error(`[DELIVERY] Utilisateur non trouvé pour commande #${orderId}.`);
    return { success: false, error: 'Utilisateur non trouvé' };
  }

  // Get order items that need cards assigned
  const orderItems = db.prepare(`
    SELECT oi.*, p.name as product_name, p.platform, p.denomination, p.category
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
  `).all(orderId);

  const results = {
    cards_assigned: [],
    cards_failed: [],
    email: null,
    sms: null
  };

  // Assign available cards to each order item
  const assignCards = db.transaction(() => {
    for (const item of orderItems) {
      // Check if card already assigned
      if (item.card_id) {
        const existingCard = db.prepare('SELECT * FROM cards WHERE id = ?').get(item.card_id);
        if (existingCard) {
          results.cards_assigned.push({
            order_item_id: item.id,
            product_name: item.product_name,
            card_id: existingCard.id,
            card_code: existingCard.code,
            card_pin: existingCard.pin,
            card_serial: existingCard.serial
          });
          continue;
        }
      }

      // Find an available card for this product
      const availableCard = db.prepare(`
        SELECT * FROM cards
        WHERE product_id = ? AND status = 'available'
        ORDER BY added_at ASC
        LIMIT 1
      `).get(item.product_id);

      if (availableCard) {
        // Mark card as sold
        db.prepare(`
          UPDATE cards SET
            status = 'sold',
            sold_at = CURRENT_TIMESTAMP,
            order_id = ?
          WHERE id = ?
        `).run(orderId, availableCard.id);

        // Link card to order item
        db.prepare('UPDATE order_items SET card_id = ? WHERE id = ?').run(availableCard.id, item.id);

        // Update product stock
        const newStock = db.prepare(
          'SELECT COUNT(*) as count FROM cards WHERE product_id = ? AND status = ?'
        ).get(item.product_id, 'available').count;
        db.prepare('UPDATE products SET stock_count = ? WHERE id = ?').run(newStock, item.product_id);

        results.cards_assigned.push({
          order_item_id: item.id,
          product_name: item.product_name,
          platform: item.platform,
          denomination: item.denomination,
          category: item.category,
          card_id: availableCard.id,
          card_code: availableCard.code,
          card_pin: availableCard.pin,
          card_serial: availableCard.serial
        });

        console.log(`[DELIVERY] Carte assignée: ${item.product_name} -> Code: ${availableCard.code.substring(0, 4)}****`);
      } else {
        console.error(`[DELIVERY] Pas de carte disponible pour ${item.product_name} (product_id: ${item.product_id})`);
        results.cards_failed.push({
          order_item_id: item.id,
          product_name: item.product_name,
          error: 'Aucune carte disponible en stock'
        });
      }
    }
  });

  try {
    assignCards();
  } catch (err) {
    console.error('[DELIVERY] Erreur assignation cartes:', err);
    db.prepare("UPDATE orders SET delivery_status = 'failed' WHERE id = ?").run(orderId);
    return { success: false, error: 'Erreur lors de l\'assignation des cartes' };
  }

  const allAssigned = results.cards_failed.length === 0;
  const anyAssigned = results.cards_assigned.length > 0;

  // Create seller earnings for each assigned card
  const createEarnings = db.transaction(() => {
    for (const assigned of results.cards_assigned) {
      const item = orderItems.find(i => i.id === assigned.order_item_id);
      if (!item) continue;
      const product = db.prepare('SELECT seller_id FROM products WHERE id = ?').get(item.product_id);
      if (!product || !product.seller_id) continue; // Admin product, no earning

      const sellerProfile = db.prepare('SELECT commission_rate FROM seller_profiles WHERE user_id = ?').get(product.seller_id);
      if (!sellerProfile) continue;

      const commissionRate = sellerProfile.commission_rate || 10;
      const saleAmount = item.unit_price;
      const commissionAmount = Math.round(saleAmount * commissionRate / 100);
      const netAmount = saleAmount - commissionAmount;

      db.prepare(`
        INSERT INTO seller_earnings (seller_id, order_id, order_item_id, sale_amount, commission_amount, net_amount, status)
        VALUES (?, ?, ?, ?, ?, ?, 'available')
      `).run(product.seller_id, orderId, assigned.order_item_id, saleAmount, commissionAmount, netAmount);
    }
  });
  try { createEarnings(); } catch(e) { console.error('[DELIVERY] Erreur création gains vendeurs:', e); }

  // Check stock and alert sellers if stock <= 5
  const LOW_STOCK_THRESHOLD = 5;
  const checkedProducts = new Set();
  for (const assigned of results.cards_assigned) {
    const item = orderItems.find(i => i.id === assigned.order_item_id);
    if (!item || checkedProducts.has(item.product_id)) continue;
    checkedProducts.add(item.product_id);

    const product = db.prepare('SELECT id, name, stock_count, seller_id FROM products WHERE id = ?').get(item.product_id);
    if (!product || !product.seller_id) continue;
    if (product.stock_count <= LOW_STOCK_THRESHOLD) {
      const seller = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(product.seller_id);
      if (seller && seller.email) {
        sendLowStockEmail(seller, product.name, product.stock_count).catch(() => {});
      }
    }
  }

  // Update delivery status
  const deliveryStatus = allAssigned ? 'delivered' : (anyAssigned ? 'delivered' : 'failed');
  db.prepare(`UPDATE orders SET delivery_status = ? WHERE id = ?`).run(deliveryStatus, orderId);

  // Build items list for email/SMS with full card info
  const itemsForNotification = orderItems.map(item => {
    const assigned = results.cards_assigned.find(a => a.order_item_id === item.id);
    return {
      ...item,
      card_code: assigned ? assigned.card_code : null,
      card_pin: assigned ? assigned.card_pin : null,
      card_serial: assigned ? assigned.card_serial : null
    };
  });

  // Send payment confirmation SMS immediately
  try {
    results.sms_payment = await sendPaymentConfirmationSMS(user.phone, user.name, orderId, order.total_amount);
  } catch (smsErr) {
    console.error('[DELIVERY] Erreur SMS paiement:', smsErr);
  }

  // Send email with card codes
  try {
    results.email = await sendOrderConfirmationEmail(user, order, itemsForNotification);
    console.log(`[DELIVERY] Email ${results.email.success ? 'envoyé' : 'échoué'} à ${user.email}`);
  } catch (emailErr) {
    console.error('[DELIVERY] Erreur email:', emailErr);
    results.email = { success: false, error: emailErr.message };
  }

  // Send SMS with card codes
  try {
    if (anyAssigned) {
      results.sms = await sendCardDeliveredSMS(user.phone, user.name, orderId, results.cards_assigned);
      console.log(`[DELIVERY] SMS ${results.sms.success ? 'envoyé' : 'échoué'} à ${user.phone}`);
    }
  } catch (smsErr) {
    console.error('[DELIVERY] Erreur SMS livraison:', smsErr);
    results.sms = { success: false, error: smsErr.message };
  }

  console.log(`[DELIVERY] Commande #${orderId} traitée: ${results.cards_assigned.length}/${orderItems.length} cartes livrées.`);

  return {
    success: anyAssigned,
    order_id: orderId,
    delivery_status: deliveryStatus,
    cards_assigned: results.cards_assigned.length,
    cards_failed: results.cards_failed.length,
    email_sent: results.email?.success || false,
    sms_sent: results.sms?.success || false,
    failed_items: results.cards_failed
  };
}

module.exports = { processDelivery };
