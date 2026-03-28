const axios = require('axios');

function formatPhone(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('00225')) cleaned = '+' + cleaned.slice(2);
  else if (cleaned.startsWith('225') && !cleaned.startsWith('+')) cleaned = '+' + cleaned;
  else if (!cleaned.startsWith('+')) cleaned = '+225' + cleaned;
  return cleaned;
}

async function sendSMS(phone, message) {
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) {
    console.log('[SMS] Numéro de téléphone invalide.');
    return { success: false, error: 'Numéro invalide' };
  }

  const AT_USERNAME = process.env.AT_USERNAME;
  const AT_API_KEY = process.env.AT_API_KEY;

  if (!AT_USERNAME || !AT_API_KEY) {
    console.log(`\n[SMS DEMO] ==================`);
    console.log(`[SMS DEMO] À: ${formattedPhone}`);
    console.log(`[SMS DEMO] Message: ${message}`);
    console.log(`[SMS DEMO] ==================\n`);
    return { success: true, demo: true, phone: formattedPhone, message };
  }

  try {
    const apiUrl = AT_USERNAME === 'sandbox'
      ? 'https://api.sandbox.africastalking.com/version1/messaging'
      : 'https://api.africastalking.com/version1/messaging';

    const params = { username: AT_USERNAME, to: formattedPhone, message: message };
    // Only add sender ID if explicitly set and not in sandbox
    if (process.env.AT_SENDER_ID && AT_USERNAME !== 'sandbox') {
      params.from = process.env.AT_SENDER_ID;
    }

    const response = await axios.post(
      apiUrl,
      new URLSearchParams(params).toString(),
      {
        headers: {
          'apiKey': AT_API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      }
    );

    const result = response.data;
    if (result.SMSMessageData && result.SMSMessageData.Recipients) {
      const recipient = result.SMSMessageData.Recipients[0];
      if (recipient && recipient.status === 'Success') {
        console.log(`[SMS] Envoyé à ${formattedPhone}: ${recipient.messageId}`);
        return { success: true, messageId: recipient.messageId };
      }
    }

    console.error('[SMS] Réponse inattendue:', JSON.stringify(result));
    return { success: false, error: 'Réponse inattendue', data: result };
  } catch (err) {
    console.error('[SMS] Erreur Africa\'s Talking:', err.response?.data || err.message);
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
