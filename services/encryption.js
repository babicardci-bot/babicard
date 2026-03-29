const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'ENC:';

function getKey() {
  const key = process.env.CARD_ENCRYPTION_KEY;
  if (!key) return null;
  // Doit être 64 caractères hex (= 32 octets)
  if (key.length !== 64) {
    console.error('[ENCRYPTION] CARD_ENCRYPTION_KEY doit faire 64 caractères hex.');
    return null;
  }
  return Buffer.from(key, 'hex');
}

/**
 * Chiffre une valeur. Retourne "ENC:<iv>:<authTag>:<ciphertext>" en hex.
 * Si la clé n'est pas configurée, retourne la valeur en clair (avec warning).
 */
function encrypt(value) {
  if (value == null) return null;
  const key = getKey();
  if (!key) {
    console.warn('[ENCRYPTION] CARD_ENCRYPTION_KEY non configurée — carte stockée en clair.');
    return String(value);
  }

  const iv = crypto.randomBytes(12); // 96 bits pour GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Déchiffre une valeur. Si elle ne commence pas par "ENC:", retourne telle quelle (ancienne carte).
 */
function decrypt(value) {
  if (value == null) return null;
  if (!String(value).startsWith(PREFIX)) return String(value); // ancienne carte non chiffrée

  const key = getKey();
  if (!key) {
    console.error('[ENCRYPTION] CARD_ENCRYPTION_KEY manquante — impossible de déchiffrer.');
    return null;
  }

  try {
    const raw = String(value).slice(PREFIX.length);
    const parts = raw.split(':');
    if (parts.length !== 3) throw new Error('Format invalide');

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch (err) {
    console.error('[ENCRYPTION] Échec déchiffrement:', err.message);
    return null;
  }
}

/**
 * Vérifie si une valeur est chiffrée.
 */
function isEncrypted(value) {
  return value != null && String(value).startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted };
