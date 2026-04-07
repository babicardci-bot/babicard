const { getDb } = require('../database/db');
const { sendOrderConfirmationEmail, sendLowStockEmail, sendDeliveryFailedEmail, sendSellerSaleNotificationEmail } = require('./email');
const { decrypt } = require('./encryption');
const { sendToUser } = require('./notifications');

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

  // Vérifier si seller_id existe sur cards (une seule fois, hors transaction)
  const cardCols = db.prepare("PRAGMA table_info(cards)").all().map(c => c.name);
  const hasSellerCol = cardCols.includes('seller_id');

  // Transaction unique : assignation des cartes + création des gains vendeur (atomique)
  const assignCardsAndEarnings = db.transaction(() => {
    for (const item of orderItems) {
      // Skip only if card was already fully delivered (status = sold)
      if (item.card_id) {
        const existingCard = db.prepare('SELECT * FROM cards WHERE id = ?').get(item.card_id);
        if (existingCard && existingCard.status === 'sold') {
          results.cards_assigned.push({
            order_item_id: item.id,
            product_name: item.product_name,
            card_id: existingCard.id,
            card_code: decrypt(existingCard.code),
            card_pin: decrypt(existingCard.pin),
            card_serial: decrypt(existingCard.serial)
          });
          continue;
        }
      }

      // Confirm or find a card for this order item
      let availableCard = null;

      if (item.card_id) {
        // Card was pre-reserved at order creation — just confirm it
        const confirmResult = db.prepare(
          "UPDATE cards SET status = 'sold', sold_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'reserved'"
        ).run(item.card_id);

        if (confirmResult.changes > 0 || db.prepare('SELECT status FROM cards WHERE id = ?').get(item.card_id)?.status === 'sold') {
          availableCard = db.prepare('SELECT * FROM cards WHERE id = ?').get(item.card_id);
        }
      } else {
        // Fallback for old orders without pre-assigned cards
        const updateResult = db.prepare(`
          UPDATE cards SET status = 'sold', sold_at = CURRENT_TIMESTAMP, order_id = ?
          WHERE id = (
            SELECT id FROM cards
            WHERE product_id = ? AND status = 'available'
            ORDER BY added_at ASC
            LIMIT 1
          )
        `).run(orderId, item.product_id);

        availableCard = updateResult.changes > 0
          ? db.prepare('SELECT * FROM cards WHERE product_id = ? AND status = ? AND order_id = ? ORDER BY sold_at DESC LIMIT 1').get(item.product_id, 'sold', orderId)
          : null;
      }

      if (availableCard) {
        // Card already marked as sold above

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
          card_code: decrypt(availableCard.code),
          card_pin: decrypt(availableCard.pin),
          card_serial: decrypt(availableCard.serial)
        });

        console.log(`[DELIVERY] Carte assignée: ${item.product_name} -> Code: ${availableCard.code.substring(0, 4)}****`);

        // Créer gains vendeur dans la même transaction (atomique avec l'assignation)
        if (hasSellerCol && availableCard.seller_id) {
          const sellerProfile = db.prepare('SELECT commission_rate FROM seller_profiles WHERE user_id = ?').get(availableCard.seller_id);
          if (sellerProfile) {
            const commissionRate = sellerProfile.commission_rate || 10;
            const saleAmount = item.unit_price;
            const commissionAmount = Math.round(saleAmount * commissionRate / 100);
            const netAmount = saleAmount - commissionAmount;

            db.prepare(`
              INSERT INTO seller_earnings (seller_id, order_id, order_item_id, sale_amount, commission_amount, net_amount, status)
              VALUES (?, ?, ?, ?, ?, ?, 'available')
            `).run(availableCard.seller_id, orderId, item.id, saleAmount, commissionAmount, netAmount);

            console.log(`[DELIVERY] Gains vendeur #${availableCard.seller_id}: +${netAmount} FCFA (commission: ${commissionAmount})`);

            // Notify seller by email (non-blocking)
            const sellerUser = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(availableCard.seller_id);
            if (sellerUser && sellerUser.email) {
              sendSellerSaleNotificationEmail(sellerUser, item.product_name, saleAmount, netAmount).catch(() => {});
            }
          }
        }
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
    assignCardsAndEarnings();
  } catch (err) {
    console.error('[DELIVERY] Erreur assignation cartes/gains:', err);
    db.prepare("UPDATE orders SET delivery_status = 'failed' WHERE id = ?").run(orderId);
    return { success: false, error: 'Erreur lors de l\'assignation des cartes' };
  }

  const allAssigned = results.cards_failed.length === 0;
  const anyAssigned = results.cards_assigned.length > 0;

  // Check stock and alert sellers if their cards are low (<= 5 remaining for this product)
  const LOW_STOCK_THRESHOLD = 5;
  const checkedSellerProducts = new Set();
  if (hasSellerCol) {
    for (const assigned of results.cards_assigned) {
      const item = orderItems.find(i => i.id === assigned.order_item_id);
      if (!item) continue;
      const card = db.prepare('SELECT seller_id FROM cards WHERE id = ?').get(assigned.card_id);
      if (!card || !card.seller_id) continue;
      const key = `${item.product_id}-${card.seller_id}`;
      if (checkedSellerProducts.has(key)) continue;
      checkedSellerProducts.add(key);

      const myStock = db.prepare(
        "SELECT COUNT(*) as count FROM cards WHERE product_id = ? AND seller_id = ? AND status = 'available'"
      ).get(item.product_id, card.seller_id).count;

      if (myStock <= LOW_STOCK_THRESHOLD) {
        const product = db.prepare('SELECT name FROM products WHERE id = ?').get(item.product_id);
        const seller = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(card.seller_id);
        if (seller && seller.email && product) {
          sendLowStockEmail(seller, product.name, myStock).catch(() => {});
        }
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

  // Send email with card codes
  try {
    results.email = await sendOrderConfirmationEmail(user, order, itemsForNotification);
    console.log(`[DELIVERY] Email ${results.email.success ? 'envoyé' : 'échoué'} à ${user.email}`);
    if (!results.email.success) {
      // Alert admin that delivery email failed — user won't receive their codes
      const adminEmail = process.env.ADMIN_EMAIL || 'support@babicard.ci';
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST, port: parseInt(process.env.EMAIL_PORT || '465'),
        secure: true, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      });
      transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: adminEmail,
        subject: `[ALERTE] Email livraison échoué — Commande #${orderId}`,
        text: `L'email de livraison pour la commande #${orderId} (${user.email}) a échoué.\nErreur: ${results.email.error}\nAction requise: renvoyer les codes manuellement.`
      }).catch(() => {});
    }
  } catch (emailErr) {
    console.error('[DELIVERY] Erreur email:', emailErr);
    results.email = { success: false, error: emailErr.message };
  }

  // Notify user if some items failed
  if (results.cards_failed.length > 0) {
    try {
      await sendDeliveryFailedEmail(user, order, results.cards_failed);
      console.log(`[DELIVERY] Email échec livraison envoyé à ${user.email} pour ${results.cards_failed.length} article(s).`);
    } catch (e) {
      console.error('[DELIVERY] Erreur email échec livraison:', e.message);
    }
  }

  // Push notifications Firebase
  try {
    if (anyAssigned) {
      await sendToUser(db, user.id,
        '✅ Commande livrée !',
        `Votre commande #${orderId} a été livrée. Vérifiez votre email pour les codes.`,
        { order_id: String(orderId), type: 'delivery' }
      );
    } else {
      await sendToUser(db, user.id,
        '⚠️ Problème de livraison',
        `Un problème est survenu avec la commande #${orderId}. Contactez le support.`,
        { order_id: String(orderId), type: 'delivery_failed' }
      );
    }
  } catch (fcmErr) {
    console.error('[DELIVERY] Erreur push notification:', fcmErr.message);
  }

  console.log(`[DELIVERY] Commande #${orderId} traitée: ${results.cards_assigned.length}/${orderItems.length} cartes livrées.`);

  return {
    success: anyAssigned,
    order_id: orderId,
    delivery_status: deliveryStatus,
    cards_assigned: results.cards_assigned.length,
    cards_failed: results.cards_failed.length,
    email_sent: results.email?.success || false,
    failed_items: results.cards_failed
  };
}

module.exports = { processDelivery };
