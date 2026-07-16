import crypto from 'crypto';
import config from '../config/config';
import logger from './logger';

const ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_PREFIX = 'enc:aes256gcm:';

let encryptionKeyBuffer: Buffer | null = null;

function getKeyBuffer(): Buffer {
  if (encryptionKeyBuffer) return encryptionKeyBuffer;
  const key = config.database.encryptionKey;
  // Use SHA-256 to ensure we always have exactly 32 bytes
  encryptionKeyBuffer = crypto.createHash('sha256').update(key).digest();
  return encryptionKeyBuffer;
}

export function encrypt(text: string | null | undefined): string | null | undefined {
  if (text === null || text === undefined) return text;
  
  try {
    const key = getKeyBuffer();
    const iv = crypto.randomBytes(12); // GCM standard IV size is 12 bytes
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag().toString('hex');
    
    // Format: prefix + iv + ':' + authTag + ':' + ciphertext
    return `${ENCRYPTION_PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to encrypt database value');
    throw err;
  }
}

export function decrypt(text: string | null | undefined): string | null | undefined {
  if (text === null || text === undefined) return text;
  if (!text.startsWith(ENCRYPTION_PREFIX)) {
    // Return as-is for backward compatibility with unencrypted values/seed data
    return text;
  }

  try {
    const parts = text.substring(ENCRYPTION_PREFIX.length).split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted text format');
    }

    const [ivHex, authTagHex, ciphertextHex] = parts;
    const key = getKeyBuffer();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to decrypt database value');
    return '⚠️ Decryption Failed';
  }
}
