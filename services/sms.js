const axios = require('axios');

function formatPhone(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
  if (cleaned.startsWith('00225')) cleaned = '+' + cleaned.slice(2);
  else if (cleaned.startsWith('+225')) { /* déjà bon */ }
  else if (cleaned.startsWith('225')) cleaned = '+' + cleaned;
  else if (!cleaned.startsWith('+')) cleaned = '+225' + cleaned;

  if (!/^\+225\d{10}$/.test(cleaned)) {
    console.log(`[SMS] Numéro invalide ou incomplet: ${cleaned}`);
    return null;
  }
  return cleaned;
}

// Cache du token Orange (valide 1h)
let orangeToken = null;
let orangeTokenExpiry = 0;

async function getOrangeToken() {
  if (orangeToken && Date.now() < orangeTokenExpiry) return orangeToken;

  const clientId = process.env.ORANGE_CLIENT_ID;
  const clientSecret = process.env.ORANGE_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await axios.post(
    'https://api.orange.com/oauth/v3/token',
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    }
  );

  orangeToken = res.data.access_token;
  orangeTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000; // -60s de marge
  return orangeToken;
}

async function sendSMS(phone, message) {
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) {
    console.log('[SMS] Numéro de téléphone invalide.');
    return { success: false, error: 'Numéro invalide' };
  }

  const clientId = process.env.ORANGE_CLIENT_ID;
  const clientSecret = process.env.ORANGE_CLIENT_SECRET;
  const senderNumber = process.env.ORANGE_SENDER_NUMBER; // ex: +2250000000000
  const senderName = process.env.ORANGE_SENDER_NAME || 'Babicard';

  if (!clientId || !clientSecret || !senderNumber) {
    console.log(`[SMS DEMO] À: ${formattedPhone} | Message: ${message}`);
    return { success: true, demo: true, phone: formattedPhone, message };
  }

  try {
    const token = await getOrangeToken();
    const encodedSender = encodeURIComponent(senderNumber);

    const res = await axios.post(
      `https://api.orange.com/smsmessaging/v1/outbound/${encodedSender}/requests`,
      {
        outboundSMSMessageRequest: {
          address: `tel:${formattedPhone}`,
          senderAddress: `tel:${senderNumber}`,
          senderName,
          outboundSMSTextMessage: { message }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`[SMS] Orange — Envoyé à ${formattedPhone}`);
    return { success: true, data: res.data };
  } catch (err) {
    console.error('[SMS] Erreur Orange API:', err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

async function sendCardDeliveredSMS(phone, userName, orderId, cards) {
  if (!phone) return { success: false, error: 'Pas de téléphone' };

  let message;
  if (cards.length === 1) {
    const card = cards[0];
    message = `Babicard.ci - Bonjour ${userName.split(' ')[0]}!\nCommande #${orderId} confirmee.\n${card.product_name}\nCode: ${card.card_code}`;
    if (card.card_pin) message += `\nPIN: ${card.card_pin}`;
    message += `\nMerci!`;
  } else {
    message = `Babicard.ci - Commande #${orderId}: ${cards.length} cartes livrees. Consultez votre email pour les codes. Merci!`;
  }

  if (message.length > 160) {
    message = `Babicard.ci - Cmd #${orderId}: ${cards.length} carte(s) livree(s). Verifiez votre email. Merci!`;
  }

  return await sendSMS(phone, message);
}

async function sendPaymentConfirmationSMS(phone, userName, orderId, amount) {
  if (!phone) return { success: false, error: 'Pas de téléphone' };

  const message = `Babicard.ci - Bonjour ${userName.split(' ')[0]}! Paiement recu. Commande #${orderId} - ${new Intl.NumberFormat('fr-FR').format(amount)} FCFA. Livraison en cours...`;
  return await sendSMS(phone, message);
}

module.exports = { sendSMS, sendCardDeliveredSMS, sendPaymentConfirmationSMS };
