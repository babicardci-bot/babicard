const nodemailer = require('nodemailer');
const axios = require('axios');

// Envoi via SendGrid HTTP API (contourne le blocage SMTP de Railway)
async function sendViaSendGrid(mailOptions) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) return null;

  const response = await axios.post('https://api.sendgrid.com/v3/mail/send', {
    personalizations: [{ to: [{ email: mailOptions.to }] }],
    from: { email: process.env.EMAIL_USER || 'noreply@babicard.ci', name: 'Babicard.ci' },
    subject: mailOptions.subject,
    content: [{ type: 'text/html', value: mailOptions.html }]
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });

  console.log(`[EMAIL] SendGrid envoyé à ${mailOptions.to} — status: ${response.status}`);
  return { success: true };
}

let transporter = null;

function getTransporter() {
  if (!transporter) {
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS &&
        process.env.EMAIL_USER !== 'your@gmail.com') {
      const port = parseInt(process.env.EMAIL_PORT || '465');
      console.log(`[EMAIL] Init transporter SMTP: ${process.env.EMAIL_HOST}:${port} user=${process.env.EMAIL_USER}`);
      transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'mail1.netim.hosting',
        port: port,
        secure: port === 465,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });
    } else {
      console.log('[EMAIL] SMTP non configuré');
      transporter = null;
    }
  }
  return transporter;
}

async function sendEmail(mailOptions) {
  // Priorité : SendGrid si dispo, sinon SMTP
  if (process.env.SENDGRID_API_KEY) {
    return sendViaSendGrid(mailOptions);
  }
  const t = getTransporter();
  if (!t) {
    console.log('[EMAIL] Aucun service email configuré');
    return null;
  }
  const info = await t.sendMail(mailOptions);
  console.log(`[EMAIL] SMTP envoyé à ${mailOptions.to}: ${info.messageId}`);
  return { success: true, messageId: info.messageId };
}

function formatPrice(amount) {
  return new Intl.NumberFormat('fr-FR').format(amount) + ' FCFA';
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getCategoryColor(category) {
  const colors = {
    apple:       '#2a2a2a',
    playstation: '#003087',
    xbox:        '#107C10',
    google:      '#4285F4',
    steam:       '#1b2838',
    netflix:     '#E50914',
    amazon:      '#FF9900',
    other:       '#6C63FF'
  };
  return colors[category] || colors.other;
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

async function sendOrderConfirmationEmail(user, order, items) {

  const itemsHtml = items.map(item => {
    const icon = getCategoryIcon(item.category || 'other');
    const color = getCategoryColor(item.category || 'other');
    let codeSection = '';

    if (item.card_code) {
      codeSection = `
        <div style="background: #f8f9fa; border: 2px dashed #6C63FF; border-radius: 8px; padding: 16px; margin: 12px 0; text-align: center;">
          <p style="margin: 0 0 8px; font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Code de la carte</p>
          <p style="margin: 0; font-size: 20px; font-weight: bold; color: #1a1a2e; letter-spacing: 3px; font-family: 'Courier New', monospace;">${escHtml(item.card_code)}</p>
          ${item.card_pin ? `<p style="margin: 8px 0 0; font-size: 14px; color: #555;">PIN: <strong>${escHtml(item.card_pin)}</strong></p>` : ''}
          ${item.card_serial ? `<p style="margin: 4px 0 0; font-size: 12px; color: #888;">Série: ${escHtml(item.card_serial)}</p>` : ''}
        </div>
      `;
    }

    return `
      <div style="border: 1px solid #e0e0e0; border-radius: 12px; padding: 20px; margin-bottom: 16px; background: white;">
        <div style="display: flex; align-items: center; margin-bottom: 12px;">
          <div style="width: 50px; height: 50px; background: ${color}; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 24px; margin-right: 15px;">
            ${icon}
          </div>
          <div>
            <h3 style="margin: 0; font-size: 16px; color: #1a1a2e;">${escHtml(item.product_name)}</h3>
            <p style="margin: 4px 0 0; font-size: 14px; color: #666;">${escHtml(item.platform || '')} ${item.denomination ? '• ' + escHtml(item.denomination) : ''}</p>
          </div>
          <div style="margin-left: auto; text-align: right;">
            <p style="margin: 0; font-size: 16px; font-weight: bold; color: #6C63FF;">${formatPrice(item.unit_price)}</p>
          </div>
        </div>
        ${codeSection}
      </div>
    `;
  }).join('');

  const hasCards = items.some(item => item.card_code);

  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirmation de commande - Babicard.ci</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f0f7;">

  <!-- Header -->
  <div style="background: linear-gradient(135deg, #0a0a1f 0%, #1a1a3e 50%, #0d0d2e 100%); padding: 40px 20px; text-align: center;">
    <div style="font-size: 36px; margin-bottom: 8px;">🎮</div>
    <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800;">Babicard.ci</h1>
    <p style="margin: 8px 0 0; color: #a78bfa; font-size: 14px; letter-spacing: 2px; text-transform: uppercase;">Vos Cartes Cadeaux Gaming</p>
  </div>

  <!-- Main Content -->
  <div style="max-width: 600px; margin: 0 auto; padding: 30px 20px;">

    <!-- Success Banner -->
    <div style="background: linear-gradient(135deg, #10B981, #059669); border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
      <div style="font-size: 40px; margin-bottom: 8px;">✅</div>
      <h2 style="margin: 0; color: white; font-size: 22px;">${hasCards ? 'Paiement confirmé ! Voici vos codes' : 'Commande confirmée !'}</h2>
      <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">
        ${hasCards ? 'Vos cartes cadeaux sont prêtes à l\'emploi.' : 'Votre commande a été enregistrée.'}
      </p>
    </div>

    <!-- Greeting -->
    <div style="background: white; border-radius: 12px; padding: 24px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.08);">
      <h2 style="margin: 0 0 12px; color: #1a1a2e; font-size: 20px;">Bonjour ${escHtml(user.name)} 👋</h2>
      <p style="margin: 0; color: #555; line-height: 1.6;">
        ${hasCards
          ? `Merci pour votre achat ! Votre paiement de <strong>${formatPrice(order.total_amount)}</strong> a été confirmé. Retrouvez ci-dessous vos codes de cartes cadeaux.`
          : `Merci pour votre commande ! Votre paiement de <strong>${formatPrice(order.total_amount)}</strong> est en cours de traitement.`
        }
      </p>
    </div>

    <!-- Order Info -->
    <div style="background: white; border-radius: 12px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.08);">
      <h3 style="margin: 0 0 16px; color: #1a1a2e; font-size: 16px; border-bottom: 2px solid #f0f0f7; padding-bottom: 10px;">
        📋 Détails de la commande
      </h3>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px 0; color: #666; font-size: 14px;">N° Commande</td>
          <td style="padding: 8px 0; color: #1a1a2e; font-weight: bold; font-size: 14px; text-align: right;">#${order.id}</td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666; font-size: 14px;">Méthode de paiement</td>
          <td style="padding: 8px 0; color: #1a1a2e; font-size: 14px; text-align: right;">
            ${order.payment_method === 'wave' ? '🌊 Wave CI' : '🟠 Orange Money'}
          </td>
        </tr>
        <tr>
          <td style="padding: 8px 0; color: #666; font-size: 14px;">Référence paiement</td>
          <td style="padding: 8px 0; color: #6C63FF; font-size: 13px; text-align: right; font-family: monospace;">${escHtml(order.payment_ref || 'N/A')}</td>
        </tr>
        <tr style="border-top: 2px solid #f0f0f7;">
          <td style="padding: 12px 0 0; color: #1a1a2e; font-weight: bold; font-size: 16px;">Total payé</td>
          <td style="padding: 12px 0 0; color: #6C63FF; font-weight: bold; font-size: 18px; text-align: right;">${formatPrice(order.total_amount)}</td>
        </tr>
      </table>
    </div>

    <!-- Cards/Items -->
    <div style="margin-bottom: 24px;">
      <h3 style="color: #1a1a2e; margin-bottom: 16px; font-size: 18px;">
        🎁 ${hasCards ? 'Vos cartes cadeaux' : 'Articles commandés'}
      </h3>
      ${itemsHtml}
    </div>

    ${hasCards ? `
    <!-- Instructions -->
    <div style="background: #fffbeb; border: 1px solid #fbbf24; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
      <h4 style="margin: 0 0 12px; color: #92400e; font-size: 15px;">⚠️ Instructions importantes</h4>
      <ul style="margin: 0; padding-left: 20px; color: #78350f; font-size: 14px; line-height: 1.8;">
        <li>Gardez vos codes en lieu sûr — ils ne peuvent pas être récupérés si perdus.</li>
        <li>Ne partagez jamais vos codes avec qui que ce soit.</li>
        <li>Les codes sont à usage unique et non remboursables.</li>
        <li>En cas de problème, contactez notre support avec votre N° de commande.</li>
      </ul>
    </div>
    ` : ''}

    <!-- Support -->
    <div style="background: linear-gradient(135deg, #1a1a3e, #0d0d2e); border-radius: 12px; padding: 24px; text-align: center; color: white;">
      <p style="margin: 0 0 8px; font-size: 16px; font-weight: bold;">Besoin d'aide ? 🤝</p>
      <p style="margin: 0 0 16px; font-size: 14px; color: #a78bfa;">Notre équipe est disponible 7j/7</p>
      <p style="margin: 0; font-size: 14px;">
        📧 <a href="mailto:${process.env.ADMIN_EMAIL || 'support@babicard.ci'}" style="color: #60a5fa;">${process.env.ADMIN_EMAIL || 'support@babicard.ci'}</a>
      </p>
      <p style="margin: 8px 0 0; font-size: 14px;">📱 WhatsApp: +225 07 08 59 80 80</p>
    </div>

  </div>

  <!-- Footer -->
  <div style="text-align: center; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
    <p style="margin: 4px 0 0;">Merci de votre confiance! 🙏</p>
  </div>

</body>
</html>
  `;

  const mailOptions = {
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@giftcardci.com'}>`,
    to: user.email,
    subject: hasCards
      ? `✅ [Babicard.ci] Vos codes cartes cadeaux - Commande #${order.id}`
      : `📦 [Babicard.ci] Confirmation commande #${order.id}`,
    html: htmlContent,
    text: `Babicard.ci - Commande #${order.id}\n\nBonjour ${user.name},\n\nMerci pour votre achat de ${formatPrice(order.total_amount)}.\n\n${items.map(item => `${item.product_name}: ${item.card_code || 'En traitement'}`).join('\n')}\n\nContact: ${process.env.ADMIN_EMAIL || 'support@babicard.ci'}`
  };

  try {
    return await sendEmail(mailOptions);
  } catch (err) {
    console.error('Erreur envoi email:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendLowStockEmail(seller, productName, remainingStock) {

  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f7;">
  <div style="background:linear-gradient(135deg,#0a0a1f 0%,#1a1a3e 50%,#0d0d2e 100%);padding:40px 20px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">🎮</div>
    <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:800;">Babicard.ci</h1>
    <p style="margin:8px 0 0;color:#fbbf24;font-size:14px;letter-spacing:2px;text-transform:uppercase;">⚠️ Alerte Stock Faible</p>
  </div>
  <div style="max-width:600px;margin:0 auto;padding:30px 20px;">
    <div style="background:#fffbeb;border:2px solid #fbbf24;border-radius:12px;padding:24px;margin-bottom:20px;">
      <div style="font-size:48px;text-align:center;margin-bottom:12px;">⚠️</div>
      <h2 style="margin:0 0 12px;color:#92400e;text-align:center;">Stock presque épuisé !</h2>
      <p style="color:#78350f;margin:0 0 16px;line-height:1.6;">
        Bonjour <strong>${seller.name}</strong>,<br><br>
        Il ne reste que <strong style="font-size:20px;color:#dc2626;">${remainingStock} code${remainingStock > 1 ? 's' : ''}</strong> disponible${remainingStock > 1 ? 's' : ''} pour votre produit :
      </p>
      <div style="background:white;border-radius:8px;padding:16px;text-align:center;border:1px solid #fde68a;">
        <p style="margin:0;font-size:18px;font-weight:bold;color:#1a1a2e;">🎁 ${productName}</p>
      </div>
    </div>
    <div style="background:white;border-radius:12px;padding:24px;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
      <h3 style="margin:0 0 12px;color:#1a1a2e;">Action requise</h3>
      <p style="color:#555;line-height:1.6;margin:0 0 20px;">Pour éviter une rupture de stock et continuer à vendre, veuillez ajouter de nouveaux codes dès que possible depuis votre tableau de bord vendeur.</p>
      <div style="text-align:center;">
        <a href="${process.env.SITE_URL || 'https://babicard.ci'}/seller" style="background:linear-gradient(135deg,#6C63FF,#5a52d5);color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block;">📦 Ajouter des codes</a>
      </div>
    </div>
    <div style="background:linear-gradient(135deg,#1a1a3e,#0d0d2e);border-radius:12px;padding:20px;text-align:center;color:white;margin-top:20px;">
      <p style="margin:0;font-size:14px;">📧 <a href="mailto:${process.env.ADMIN_EMAIL || 'support@babicard.ci'}" style="color:#60a5fa;">${process.env.ADMIN_EMAIL || 'support@babicard.ci'}</a></p>
    </div>
  </div>
  <div style="text-align:center;padding:20px;color:#999;font-size:12px;">
    <p style="margin:0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
  </div>
</body>
</html>`;

  const mailOptions = {
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@babicard.ci'}>`,
    to: seller.email,
    subject: `⚠️ [Babicard.ci] Stock faible — ${productName} (${remainingStock} code${remainingStock > 1 ? 's' : ''} restant${remainingStock > 1 ? 's' : ''})`,
    html: htmlContent,
    text: `Babicard.ci - Alerte stock faible\n\nBonjour ${seller.name},\n\nIl ne reste que ${remainingStock} code(s) pour "${productName}".\n\nConnectez-vous pour en ajouter: ${process.env.SITE_URL || 'https://babicard.ci'}/seller`
  };

  try {
    return await sendEmail(mailOptions);
  } catch (err) {
    console.error('Erreur envoi email stock faible:', err.message);
    return { success: false };
  }
}

async function sendWithdrawalStatusEmail(seller, shopName, amount, status, adminNote) {
  const isPaid = status === 'paid';
  const isRejected = status === 'rejected';
  const isApproved = status === 'approved';

  const statusLabel = isPaid ? '💰 Paiement effectué' : isApproved ? '✅ Demande approuvée' : '❌ Demande rejetée';
  const statusColor = isPaid ? '#22c55e' : isApproved ? '#6C63FF' : '#ef4444';
  const statusBg = isPaid ? '#f0fdf4' : isApproved ? '#f5f3ff' : '#fef2f2';
  const statusBorder = isPaid ? '#86efac' : isApproved ? '#c4b5fd' : '#fca5a5';

  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f7;">
  <div style="background:linear-gradient(135deg,#0a0a1f 0%,#1a1a3e 50%,#0d0d2e 100%);padding:40px 20px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">🎮</div>
    <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:800;">Babicard.ci</h1>
    <p style="margin:8px 0 0;color:#a78bfa;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Demande de retrait</p>
  </div>
  <div style="max-width:600px;margin:0 auto;padding:30px 20px;">
    <div style="background:${statusBg};border:2px solid ${statusBorder};border-radius:12px;padding:24px;margin-bottom:20px;text-align:center;">
      <div style="font-size:48px;margin-bottom:8px;">${isPaid ? '💰' : isApproved ? '✅' : '❌'}</div>
      <h2 style="margin:0;color:${statusColor};font-size:22px;">${statusLabel}</h2>
    </div>
    <div style="background:white;border-radius:12px;padding:28px;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
      <p style="color:#555;line-height:1.6;margin:0 0 20px;">Bonjour <strong>${seller.name}</strong>,<br><br>
      ${isPaid
        ? `Votre demande de retrait de <strong style="color:#22c55e">${new Intl.NumberFormat('fr-FR').format(amount)} FCFA</strong> pour la boutique <strong>${shopName}</strong> a été <strong>payée</strong>. Les fonds ont été envoyés sur votre compte.`
        : isApproved
        ? `Votre demande de retrait de <strong style="color:#6C63FF">${new Intl.NumberFormat('fr-FR').format(amount)} FCFA</strong> pour la boutique <strong>${shopName}</strong> a été <strong>approuvée</strong>. Le paiement sera effectué très prochainement.`
        : `Votre demande de retrait de <strong>${new Intl.NumberFormat('fr-FR').format(amount)} FCFA</strong> pour la boutique <strong>${shopName}</strong> a été <strong>rejetée</strong>.`
      }</p>
      ${adminNote ? `
      <div style="background:#f8f9fa;border-left:4px solid ${statusColor};border-radius:4px;padding:14px;margin-top:16px;">
        <p style="margin:0;font-size:14px;color:#555;"><strong>Note de l'administrateur :</strong><br>${adminNote}</p>
      </div>` : ''}
      ${isRejected ? `
      <div style="text-align:center;margin-top:24px;">
        <a href="${process.env.SITE_URL || 'https://babicard.ci'}/seller" style="background:linear-gradient(135deg,#6C63FF,#5a52d5);color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block;">Faire une nouvelle demande</a>
      </div>` : ''}
    </div>
    <div style="background:linear-gradient(135deg,#1a1a3e,#0d0d2e);border-radius:12px;padding:20px;text-align:center;color:white;margin-top:20px;">
      <p style="margin:0;font-size:14px;">📧 <a href="mailto:${process.env.ADMIN_EMAIL || 'support@babicard.ci'}" style="color:#60a5fa;">${process.env.ADMIN_EMAIL || 'support@babicard.ci'}</a></p>
    </div>
  </div>
  <div style="text-align:center;padding:20px;color:#999;font-size:12px;">
    <p style="margin:0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
  </div>
</body>
</html>`;

  const subjectLabel = isPaid ? '💰 Retrait payé' : isApproved ? '✅ Retrait approuvé' : '❌ Retrait rejeté';
  const mailOptions = {
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@babicard.ci'}>`,
    to: seller.email,
    subject: `${subjectLabel} — ${new Intl.NumberFormat('fr-FR').format(amount)} FCFA — Babicard.ci`,
    html: htmlContent,
    text: `Babicard.ci - ${statusLabel}\n\nBonjour ${seller.name},\nVotre retrait de ${amount} FCFA pour "${shopName}" : ${statusLabel}.\n${adminNote ? 'Note: ' + adminNote : ''}`
  };

  try {
    return await sendEmail(mailOptions);
  } catch (err) {
    console.error('Erreur envoi email statut retrait:', err.message);
    return { success: false };
  }
}

async function sendWithdrawalRequestEmail(seller, shopName, amount, paymentMethod, paymentNumber) {
  const adminEmail = process.env.ADMIN_EMAIL || 'support@babicard.ci';
  const methodLabel = paymentMethod === 'wave' ? '🌊 Wave CI' : '🟠 Orange Money';

  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f7;">
  <div style="background:linear-gradient(135deg,#0a0a1f 0%,#1a1a3e 50%,#0d0d2e 100%);padding:40px 20px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">🎮</div>
    <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:800;">Babicard.ci</h1>
    <p style="margin:8px 0 0;color:#a78bfa;font-size:14px;letter-spacing:2px;text-transform:uppercase;">💸 Nouvelle demande de retrait</p>
  </div>
  <div style="max-width:600px;margin:0 auto;padding:30px 20px;">
    <div style="background:white;border-radius:12px;padding:32px;box-shadow:0 2px 10px rgba(0,0,0,0.08);margin-bottom:20px;">
      <h2 style="margin:0 0 20px;color:#1a1a2e;">💸 Demande de retrait reçue</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="border-bottom:1px solid #f0f0f7;">
          <td style="padding:12px 0;color:#666;font-size:14px;">Vendeur</td>
          <td style="padding:12px 0;color:#1a1a2e;font-weight:600;text-align:right;">${seller.name}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f7;">
          <td style="padding:12px 0;color:#666;font-size:14px;">Boutique</td>
          <td style="padding:12px 0;color:#1a1a2e;font-weight:600;text-align:right;">${shopName}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f7;">
          <td style="padding:12px 0;color:#666;font-size:14px;">Email</td>
          <td style="padding:12px 0;color:#6C63FF;text-align:right;">${seller.email}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f7;">
          <td style="padding:12px 0;color:#666;font-size:14px;">Montant demandé</td>
          <td style="padding:12px 0;color:#22c55e;font-weight:800;font-size:18px;text-align:right;">${new Intl.NumberFormat('fr-FR').format(amount)} FCFA</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f7;">
          <td style="padding:12px 0;color:#666;font-size:14px;">Méthode</td>
          <td style="padding:12px 0;color:#1a1a2e;font-weight:600;text-align:right;">${methodLabel}</td>
        </tr>
        <tr>
          <td style="padding:12px 0;color:#666;font-size:14px;">Numéro de paiement</td>
          <td style="padding:12px 0;color:#1a1a2e;font-weight:600;font-family:monospace;text-align:right;">${paymentNumber}</td>
        </tr>
      </table>
      <div style="text-align:center;margin-top:28px;">
        <a href="${process.env.SITE_URL || 'https://babicard.ci'}/admin#withdrawals" style="background:linear-gradient(135deg,#6C63FF,#5a52d5);color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;display:inline-block;">⚙️ Traiter la demande</a>
      </div>
    </div>
  </div>
  <div style="text-align:center;padding:20px;color:#999;font-size:12px;">
    <p style="margin:0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
  </div>
</body>
</html>`;

  const mailOptions = {
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@babicard.ci'}>`,
    to: adminEmail,
    subject: `💸 [Babicard.ci] Demande de retrait — ${shopName} — ${new Intl.NumberFormat('fr-FR').format(amount)} FCFA`,
    html: htmlContent,
    text: `Nouvelle demande de retrait\n\nVendeur: ${seller.name} (${seller.email})\nBoutique: ${shopName}\nMontant: ${amount} FCFA\nMéthode: ${methodLabel}\nNuméro: ${paymentNumber}\n\nConnectez-vous pour traiter: ${process.env.SITE_URL || 'https://babicard.ci'}/admin`
  };

  try {
    return await sendEmail(mailOptions);
  } catch (err) {
    console.error('Erreur envoi email retrait:', err.message);
    return { success: false };
  }
}

async function sendPasswordResetEmail(user, resetLink) {

  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f7;">
  <div style="background:linear-gradient(135deg,#0a0a1f 0%,#1a1a3e 50%,#0d0d2e 100%);padding:40px 20px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">🎮</div>
    <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:800;">Babicard.ci</h1>
    <p style="margin:8px 0 0;color:#a78bfa;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Réinitialisation de mot de passe</p>
  </div>
  <div style="max-width:600px;margin:0 auto;padding:30px 20px;">
    <div style="background:white;border-radius:12px;padding:32px;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
      <h2 style="margin:0 0 16px;color:#1a1a2e;">Bonjour ${escHtml(user.name)} 👋</h2>
      <p style="color:#555;line-height:1.6;margin:0 0 24px;">Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${resetLink}" style="background:linear-gradient(135deg,#6C63FF,#5a52d5);color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block;">🔒 Réinitialiser mon mot de passe</a>
      </div>
      <p style="color:#888;font-size:13px;margin:0 0 8px;">Ce lien est valable <strong>1 heure</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
      <p style="color:#aaa;font-size:12px;margin:0;word-break:break-all;">Ou copiez ce lien: ${resetLink}</p>
    </div>
    <div style="background:linear-gradient(135deg,#1a1a3e,#0d0d2e);border-radius:12px;padding:20px;text-align:center;color:white;margin-top:20px;">
      <p style="margin:0;font-size:14px;">📧 <a href="mailto:${process.env.ADMIN_EMAIL || 'support@babicard.ci'}" style="color:#60a5fa;">${process.env.ADMIN_EMAIL || 'support@babicard.ci'}</a></p>
    </div>
  </div>
  <div style="text-align:center;padding:20px;color:#999;font-size:12px;">
    <p style="margin:0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
  </div>
</body>
</html>`;

  const mailOptions = {
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@babicard.ci'}>`,
    to: user.email,
    subject: '🔒 [Babicard.ci] Réinitialisation de votre mot de passe',
    html: htmlContent,
    text: `Babicard.ci - Réinitialisation de mot de passe\n\nBonjour ${user.name},\n\nCliquez sur ce lien pour réinitialiser votre mot de passe:\n${resetLink}\n\nCe lien est valable 1 heure.`
  };

  try {
    return await sendEmail(mailOptions);
  } catch (err) {
    console.error('Erreur envoi email reset:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendWelcomeEmail(user) {
  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f7;">

  <div style="background:linear-gradient(135deg,#0a0a1f 0%,#1a1a3e 50%,#0d0d2e 100%);padding:40px 20px;text-align:center;">
    <div style="font-size:48px;margin-bottom:8px;">🎮</div>
    <h1 style="margin:0;color:#ffffff;font-size:32px;font-weight:800;">Babicard<span style="color:#a78bfa;">.ci</span></h1>
    <p style="margin:8px 0 0;color:#a78bfa;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Bienvenue !</p>
  </div>

  <div style="max-width:600px;margin:0 auto;padding:30px 20px;">

    <div style="background:white;border-radius:16px;padding:36px;box-shadow:0 4px 20px rgba(0,0,0,0.08);margin-bottom:20px;text-align:center;">
      <div style="font-size:56px;margin-bottom:16px;">🎉</div>
      <h2 style="margin:0 0 12px;color:#1a1a2e;font-size:24px;">Bonjour ${escHtml(user.name)} !</h2>
      <p style="color:#555;line-height:1.7;margin:0 0 24px;font-size:16px;">
        Votre compte <strong>Babicard.ci</strong> a été créé avec succès.<br>
        Découvrez notre sélection de cartes cadeaux numériques livrées instantanément par email.
      </p>
      <a href="https://www.babicard.ci" style="background:linear-gradient(135deg,#6C63FF,#5a52d5);color:white;padding:16px 40px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block;">🛍️ Découvrir les cartes</a>
    </div>

    <div style="background:white;border-radius:16px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,0.08);margin-bottom:20px;">
      <h3 style="margin:0 0 20px;color:#1a1a2e;font-size:18px;">✨ Pourquoi choisir Babicard.ci ?</h3>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="font-size:24px;">⚡</span>
          <div><strong style="color:#1a1a2e;">Livraison instantanée</strong><br><span style="color:#666;font-size:14px;">Vos codes sont envoyés par email dès le paiement confirmé</span></div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="font-size:24px;">🔒</span>
          <div><strong style="color:#1a1a2e;">Paiement sécurisé</strong><br><span style="color:#666;font-size:14px;">Wave CI et Orange Money acceptés</span></div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="font-size:24px;">🎁</span>
          <div><strong style="color:#1a1a2e;">Large catalogue</strong><br><span style="color:#666;font-size:14px;">PlayStation, Xbox, Steam, Netflix, Amazon et plus encore</span></div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <span style="font-size:24px;">🤝</span>
          <div><strong style="color:#1a1a2e;">Support 7j/7</strong><br><span style="color:#666;font-size:14px;">WhatsApp: +225 07 08 59 80 80</span></div>
        </div>
      </div>
    </div>

    <div style="background:linear-gradient(135deg,#1a1a3e,#0d0d2e);border-radius:12px;padding:24px;text-align:center;color:white;">
      <p style="margin:0 0 8px;font-size:16px;font-weight:bold;">Besoin d'aide ? 🤝</p>
      <p style="margin:0 0 12px;font-size:14px;color:#a78bfa;">Notre équipe est disponible 7j/7</p>
      <p style="margin:0;font-size:14px;">📧 <a href="mailto:${process.env.ADMIN_EMAIL || 'support@babicard.ci'}" style="color:#60a5fa;">${process.env.ADMIN_EMAIL || 'support@babicard.ci'}</a></p>
      <p style="margin:6px 0 0;font-size:14px;">📱 WhatsApp: +225 07 08 59 80 80</p>
    </div>

  </div>

  <div style="text-align:center;padding:20px;color:#999;font-size:12px;">
    <p style="margin:0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
  </div>

</body>
</html>`;

  const mailOptions = {
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@babicard.ci'}>`,
    to: user.email,
    subject: `🎉 Bienvenue sur Babicard.ci, ${user.name} !`,
    html: htmlContent
  };

  try {
    return await sendEmail(mailOptions);
  } catch (err) {
    console.error('Erreur envoi email bienvenue:', err.message);
    return { success: false };
  }
}

async function sendSellerApprovalEmail(user, commissionRate) {
  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f7;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#0a0a1f 0%,#1a1a3e 50%,#0d0d2e 100%);padding:40px 20px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">🎮</div>
    <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:800;">Babicard.ci</h1>
    <p style="margin:8px 0 0;color:#a78bfa;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Espace Vendeur</p>
  </div>

  <!-- Body -->
  <div style="max-width:600px;margin:0 auto;padding:32px 20px;">

    <!-- Congrats card -->
    <div style="background:linear-gradient(135deg,#6C63FF,#4f46e5);border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;color:white;">
      <div style="font-size:48px;margin-bottom:12px;">🎉</div>
      <h2 style="margin:0 0 8px;font-size:24px;font-weight:800;">Félicitations, ${escHtml(user.name)} !</h2>
      <p style="margin:0;font-size:16px;opacity:0.9;">Votre demande de vendeur a été <strong>approuvée</strong>.</p>
    </div>

    <!-- Details -->
    <div style="background:white;border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
      <h3 style="margin:0 0 16px;color:#1a1a2e;font-size:18px;">Vos conditions</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:10px 0;color:#666;font-size:14px;border-bottom:1px solid #f0f0f7;">Taux de commission</td>
          <td style="padding:10px 0;color:#1a1a2e;font-weight:bold;font-size:14px;text-align:right;border-bottom:1px solid #f0f0f7;">${commissionRate}%</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#666;font-size:14px;">Accès au tableau de bord</td>
          <td style="padding:10px 0;color:#22c55e;font-weight:bold;font-size:14px;text-align:right;">✓ Activé</td>
        </tr>
      </table>
    </div>

    <!-- Steps -->
    <div style="background:white;border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
      <h3 style="margin:0 0 16px;color:#1a1a2e;font-size:18px;">Comment commencer ?</h3>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <div style="background:#6C63FF;color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:13px;flex-shrink:0;line-height:28px;text-align:center;">1</div>
          <p style="margin:0;font-size:14px;color:#444;line-height:1.6;">Connectez-vous à votre compte et accédez à votre <strong>tableau de bord vendeur</strong>.</p>
        </div>
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <div style="background:#6C63FF;color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:13px;flex-shrink:0;line-height:28px;text-align:center;">2</div>
          <p style="margin:0;font-size:14px;color:#444;line-height:1.6;">Choisissez un produit et cliquez sur <strong>"Ajouter codes"</strong> pour importer vos cartes.</p>
        </div>
        <div style="display:flex;align-items:flex-start;gap:12px;">
          <div style="background:#6C63FF;color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:13px;flex-shrink:0;line-height:28px;text-align:center;">3</div>
          <p style="margin:0;font-size:14px;color:#444;line-height:1.6;">Vos gains sont calculés automatiquement à chaque vente. Vous pouvez faire une <strong>demande de retrait</strong> depuis le tableau de bord.</p>
        </div>
      </div>
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${process.env.SITE_URL || 'https://babicard.ci'}/seller" style="display:inline-block;background:linear-gradient(135deg,#6C63FF,#4f46e5);color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">
        Accéder à mon tableau de bord →
      </a>
    </div>

    <!-- Support -->
    <div style="background:linear-gradient(135deg,#1a1a3e,#0d0d2e);border-radius:12px;padding:24px;text-align:center;color:white;">
      <p style="margin:0 0 8px;font-size:16px;font-weight:bold;">Besoin d'aide ? 🤝</p>
      <p style="margin:0 0 16px;font-size:14px;color:#a78bfa;">Notre équipe est disponible 7j/7</p>
      <p style="margin:0;font-size:14px;">📧 <a href="mailto:${process.env.ADMIN_EMAIL || 'support@babicard.ci'}" style="color:#60a5fa;">${process.env.ADMIN_EMAIL || 'support@babicard.ci'}</a></p>
      <p style="margin:8px 0 0;font-size:14px;">📱 WhatsApp: +225 07 08 59 80 80</p>
    </div>

  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:20px;color:#999;font-size:12px;">
    <p style="margin:0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
    <p style="margin:4px 0 0;">Merci de votre confiance! 🙏</p>
  </div>

</body>
</html>
  `;

  const mailOptions = {
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@babicard.ci'}>`,
    to: user.email,
    subject: `🎉 [Babicard.ci] Votre compte vendeur est activé !`,
    html: htmlContent
  };

  try {
    return await sendEmail(mailOptions);
  } catch (err) {
    console.error('Erreur envoi email approbation vendeur:', err.message);
    return { success: false };
  }
}

async function sendDeliveryFailedEmail(user, order, failedItems) {
  const itemsHtml = failedItems.map(item => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f7;color:#1a1a2e;">${escHtml(item.product_name)}</td>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f7;color:#ef4444;text-align:right;">Rupture de stock</td>
    </tr>
  `).join('');

  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f7;">
  <div style="background:linear-gradient(135deg,#0a0a1f 0%,#1a1a3e 50%,#0d0d2e 100%);padding:40px 20px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">🎮</div>
    <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:800;">Babicard.ci</h1>
    <p style="margin:8px 0 0;color:#a78bfa;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Problème de livraison</p>
  </div>
  <div style="max-width:600px;margin:0 auto;padding:30px 20px;">
    <div style="background:#fef2f2;border:2px solid #fca5a5;border-radius:12px;padding:24px;margin-bottom:20px;text-align:center;">
      <div style="font-size:48px;margin-bottom:8px;">⚠️</div>
      <h2 style="margin:0;color:#ef4444;font-size:22px;">Livraison incomplète</h2>
    </div>
    <div style="background:white;border-radius:12px;padding:28px;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
      <p style="color:#555;line-height:1.6;margin:0 0 20px;">Bonjour <strong>${escHtml(user.name)}</strong>,<br><br>
      Votre paiement pour la commande <strong>#${order.id}</strong> a bien été reçu, mais certains articles sont temporairement en rupture de stock et n'ont pas pu être livrés :</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        ${itemsHtml}
      </table>
      <p style="color:#555;line-height:1.6;margin:0 0 20px;">Notre équipe a été notifiée et vous contactera dans les plus brefs délais. Vous serez remboursé(e) ou les articles vous seront livrés dès qu'ils seront disponibles.</p>
      <div style="text-align:center;margin-top:24px;">
        <a href="${process.env.SITE_URL || 'https://babicard.ci'}/dashboard" style="background:linear-gradient(135deg,#6C63FF,#5a52d5);color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block;">Voir mes commandes</a>
      </div>
    </div>
    <div style="background:linear-gradient(135deg,#1a1a3e,#0d0d2e);border-radius:12px;padding:20px;text-align:center;color:white;margin-top:20px;">
      <p style="margin:0;font-size:14px;">📧 <a href="mailto:${process.env.ADMIN_EMAIL || 'support@babicard.ci'}" style="color:#60a5fa;">${process.env.ADMIN_EMAIL || 'support@babicard.ci'}</a></p>
      <p style="margin:6px 0 0;font-size:14px;">📱 WhatsApp: +225 07 08 59 80 80</p>
    </div>
  </div>
  <div style="text-align:center;padding:20px;color:#999;font-size:12px;">
    <p style="margin:0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
  </div>
</body>
</html>`;

  const mailOptions = {
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@babicard.ci'}>`,
    to: user.email,
    subject: `⚠️ [Babicard.ci] Problème de livraison — Commande #${order.id}`,
    html: htmlContent,
    text: `Babicard.ci - Problème de livraison\n\nBonjour ${user.name},\nCertains articles de votre commande #${order.id} sont en rupture de stock. Notre équipe vous contactera rapidement.\n\nContactez-nous: ${process.env.ADMIN_EMAIL || 'support@babicard.ci'}`
  };

  try {
    return await sendEmail(mailOptions);
  } catch (err) {
    console.error('Erreur envoi email livraison échouée:', err.message);
    return { success: false };
  }
}

async function sendSellerSaleNotificationEmail(seller, productName, saleAmount, netAmount) {
  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f7;">
  <div style="background:linear-gradient(135deg,#0a0a1f 0%,#1a1a3e 50%,#0d0d2e 100%);padding:40px 20px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">🎮</div>
    <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:800;">Babicard.ci</h1>
    <p style="margin:8px 0 0;color:#a78bfa;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Nouvelle vente !</p>
  </div>
  <div style="max-width:600px;margin:0 auto;padding:30px 20px;">
    <div style="background:#f0fdf4;border:2px solid #86efac;border-radius:12px;padding:24px;margin-bottom:20px;text-align:center;">
      <div style="font-size:48px;margin-bottom:8px;">🎉</div>
      <h2 style="margin:0;color:#22c55e;font-size:22px;">Vente confirmée !</h2>
    </div>
    <div style="background:white;border-radius:12px;padding:28px;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
      <p style="color:#555;line-height:1.6;margin:0 0 20px;">Bonjour <strong>${escHtml(seller.name)}</strong>, votre carte <strong>${escHtml(productName)}</strong> vient d'être vendue.</p>
      <table style="width:100%;border-collapse:collapse;">
        <tr style="border-bottom:1px solid #f0f0f7;">
          <td style="padding:10px 0;color:#666;">Montant vente</td>
          <td style="padding:10px 0;font-weight:bold;text-align:right;">${new Intl.NumberFormat('fr-FR').format(saleAmount)} FCFA</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#666;">Vos gains nets</td>
          <td style="padding:10px 0;font-weight:bold;color:#22c55e;text-align:right;">+${new Intl.NumberFormat('fr-FR').format(netAmount)} FCFA</td>
        </tr>
      </table>
      <div style="text-align:center;margin-top:24px;">
        <a href="${process.env.SITE_URL || 'https://babicard.ci'}/seller" style="background:linear-gradient(135deg,#6C63FF,#5a52d5);color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block;">Voir mes gains</a>
      </div>
    </div>
  </div>
  <div style="text-align:center;padding:20px;color:#999;font-size:12px;">
    <p style="margin:0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
  </div>
</body>
</html>`;

  const mailOptions = {
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@babicard.ci'}>`,
    to: seller.email,
    subject: `🎉 [Babicard.ci] Nouvelle vente — ${productName} — +${new Intl.NumberFormat('fr-FR').format(netAmount)} FCFA`,
    html: htmlContent
  };

  try {
    return await sendEmail(mailOptions);
  } catch (err) {
    console.error('Erreur envoi email vente vendeur:', err.message);
    return { success: false };
  }
}

async function sendEmailVerificationEmail(user, verifyLink) {
  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f7;">
  <div style="background:linear-gradient(135deg,#0a0a1f 0%,#1a1a3e 50%,#0d0d2e 100%);padding:40px 20px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">🎮</div>
    <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:800;">Babicard.ci</h1>
    <p style="margin:8px 0 0;color:#a78bfa;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Vérification de votre email</p>
  </div>
  <div style="max-width:600px;margin:0 auto;padding:30px 20px;">
    <div style="background:white;border-radius:12px;padding:32px;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
      <h2 style="margin:0 0 16px;color:#1a1a2e;">Bonjour ${escHtml(user.name)} 👋</h2>
      <p style="color:#555;line-height:1.6;margin:0 0 24px;">Merci de vous être inscrit sur Babicard.ci ! Pour activer votre compte et commencer à acheter vos cartes cadeaux, cliquez sur le bouton ci-dessous.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${verifyLink}" style="background:linear-gradient(135deg,#6C63FF,#5a52d5);color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;display:inline-block;">✅ Vérifier mon adresse email</a>
      </div>
      <p style="color:#888;font-size:13px;margin:0 0 8px;">Ce lien est valable <strong>24 heures</strong>. Si vous n'avez pas créé de compte, ignorez cet email.</p>
      <p style="color:#aaa;font-size:12px;margin:0;word-break:break-all;">Ou copiez ce lien: ${verifyLink}</p>
    </div>
    <div style="background:linear-gradient(135deg,#1a1a3e,#0d0d2e);border-radius:12px;padding:20px;text-align:center;color:white;margin-top:20px;">
      <p style="margin:0;font-size:14px;">📧 <a href="mailto:${process.env.ADMIN_EMAIL || 'support@babicard.ci'}" style="color:#60a5fa;">${process.env.ADMIN_EMAIL || 'support@babicard.ci'}</a></p>
    </div>
  </div>
  <div style="text-align:center;padding:20px;color:#999;font-size:12px;">
    <p style="margin:0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
  </div>
</body>
</html>`;

  const mailOptions = {
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@babicard.ci'}>`,
    to: user.email,
    subject: '✅ [Babicard.ci] Vérifiez votre adresse email',
    html: htmlContent,
    text: `Babicard.ci - Vérification email\n\nBonjour ${user.name},\n\nCliquez sur ce lien pour vérifier votre email:\n${verifyLink}\n\nCe lien est valable 24 heures.`
  };

  try {
    return await sendEmail(mailOptions);
  } catch (err) {
    console.error('Erreur envoi email vérification:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendBroadcastEmail(user, subject, htmlBody) {
  const crypto = require('crypto');
  const unsubscribeToken = crypto.createHmac('sha256', process.env.JWT_SECRET || 'secret')
    .update(`unsub:${user.id}:${user.email}`)
    .digest('hex');
  const unsubscribeUrl = `${process.env.SITE_URL || 'https://babicard.ci'}/api/auth/unsubscribe?token=${unsubscribeToken}&uid=${user.id}`;

  const htmlContent = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f0f7;">
  <div style="background:linear-gradient(135deg,#0a0a1f 0%,#1a1a3e 50%,#0d0d2e 100%);padding:40px 20px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">🎮</div>
    <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:800;">Babicard.ci</h1>
    <p style="margin:8px 0 0;color:#a78bfa;font-size:14px;letter-spacing:2px;text-transform:uppercase;">Vos Cartes Cadeaux Gaming</p>
  </div>
  <div style="max-width:600px;margin:0 auto;padding:30px 20px;">
    <div style="background:white;border-radius:12px;padding:32px;box-shadow:0 2px 10px rgba(0,0,0,0.08);">
      <p style="margin:0 0 16px;color:#555;font-size:15px;">Bonjour ${escHtml(user.name)} 👋</p>
      <div style="color:#333;line-height:1.7;font-size:15px;">${htmlBody}</div>
    </div>
    <div style="background:linear-gradient(135deg,#1a1a3e,#0d0d2e);border-radius:12px;padding:20px;text-align:center;color:white;margin-top:20px;">
      <p style="margin:0;font-size:13px;color:#a78bfa;">Vous recevez cet email car vous êtes inscrit sur Babicard.ci</p>
      <p style="margin:6px 0 0;font-size:13px;">📧 <a href="mailto:${process.env.ADMIN_EMAIL || 'support@babicard.ci'}" style="color:#60a5fa;">${process.env.ADMIN_EMAIL || 'support@babicard.ci'}</a></p>
    </div>
  </div>
  <div style="text-align:center;padding:20px;color:#999;font-size:12px;">
    <p style="margin:0;">© ${new Date().getFullYear()} Babicard.ci — Abidjan, Côte d'Ivoire</p>
    <p style="margin:6px 0 0;"><a href="${unsubscribeUrl}" style="color:#aaa;font-size:11px;">Se désinscrire des emails marketing</a></p>
  </div>
</body>
</html>`;

  return sendEmail({
    from: `"Babicard.ci 🎮" <${process.env.EMAIL_USER || 'noreply@babicard.ci'}>`,
    to: user.email,
    subject,
    html: htmlContent,
    text: `Bonjour ${user.name},\n\n${htmlBody.replace(/<[^>]+>/g, '')}\n\nBabicard.ci`
  });
}

async function sendLoginOTPEmail(user, code) {
  const siteUrl = process.env.SITE_URL || 'https://babicard.ci';
  return sendEmail({
    to: user.email,
    subject: `${code} — Votre code de connexion Babicard.ci`,
    html: `
    <div style="font-family:Inter,Arial,sans-serif;background:#0d0d1a;padding:40px 0;min-height:100vh;">
      <div style="max-width:480px;margin:0 auto;background:#13131f;border-radius:16px;overflow:hidden;border:1px solid rgba(108,99,255,0.2);">
        <div style="background:linear-gradient(135deg,#6C63FF,#a78bfa);padding:32px;text-align:center;">
          <div style="font-size:2rem;margin-bottom:8px;">🔐</div>
          <h1 style="color:#fff;margin:0;font-size:1.4rem;font-weight:700;">Code de connexion</h1>
          <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;font-size:0.9rem;">Babicard.ci</p>
        </div>
        <div style="padding:32px;text-align:center;">
          <p style="color:#a0a0c0;font-size:0.9rem;margin:0 0 24px;">Bonjour <strong style="color:#f0f0ff;">${escHtml(user.name)}</strong>, voici votre code de connexion :</p>
          <div style="background:#1e1e30;border:2px solid #6C63FF;border-radius:12px;padding:24px;margin:0 auto 24px;display:inline-block;min-width:200px;">
            <div style="font-size:2.5rem;font-weight:800;letter-spacing:12px;color:#a78bfa;font-family:monospace;">${code}</div>
          </div>
          <p style="color:#ef4444;font-size:0.85rem;margin:0 0 8px;">⏰ Ce code expire dans <strong>10 minutes</strong>.</p>
          <p style="color:#a0a0c0;font-size:0.8rem;margin:0;">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
        </div>
        <div style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.06);text-align:center;">
          <p style="color:#606080;font-size:0.75rem;margin:0;">Babicard.ci — <a href="${siteUrl}" style="color:#6C63FF;text-decoration:none;">${siteUrl}</a></p>
        </div>
      </div>
    </div>`
  });
}

module.exports = { sendOrderConfirmationEmail, sendLowStockEmail, sendWithdrawalRequestEmail, sendWithdrawalStatusEmail, sendPasswordResetEmail, sendWelcomeEmail, sendSellerApprovalEmail, sendEmailVerificationEmail, sendDeliveryFailedEmail, sendSellerSaleNotificationEmail, sendBroadcastEmail, sendLoginOTPEmail };
