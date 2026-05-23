const axios = require('axios');

function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('00')) p = p.substring(2);
  if (p.startsWith('0') && p.length === 10) p = '225' + p.substring(1);
  if (!p.startsWith('225')) p = '225' + p;
  return '+' + p;
}

async function sendWhatsApp(phone, message) {
  const instance = process.env.ULTRAMSG_INSTANCE;
  const token = process.env.ULTRAMSG_TOKEN;
  if (!instance || !token) return null;

  const to = normalizePhone(phone);
  if (!to) return null;

  try {
    const res = await axios.post(`https://api.ultramsg.com/${instance}/messages/chat`, {
      token,
      to,
      body: message
    }, { timeout: 8000 });
    console.log(`[WHATSAPP] Envoyé à ${to} — id: ${res.data?.id || 'ok'}`);
    return { success: true };
  } catch (err) {
    console.error(`[WHATSAPP] Erreur envoi à ${to}:`, err.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

function buildDeliveryMessage(user, order, trackingUrl) {
  const siteUrl = process.env.SITE_URL || 'https://babicard.ci';
  return `✅ *Babicard.ci — Commande livrée !*

Bonjour ${user.name},

Votre commande *#${order.id}* a été livrée avec succès. 🎉

📧 Vos codes de cartes cadeaux ont été envoyés à *${user.email}*
_(Vérifiez vos spams si vous ne trouvez pas l'email)_

🔍 Suivre ma commande :
${trackingUrl}

Merci pour votre confiance !
📱 Support : +225 07 08 59 80 80
🌐 ${siteUrl}`;
}

module.exports = { sendWhatsApp, buildDeliveryMessage, normalizePhone };
