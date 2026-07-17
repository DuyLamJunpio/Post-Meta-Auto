const crypto = require("crypto");

// Mã hóa đối xứng cho token lưu trong DB. Định dạng chuỗi lưu trữ:
//   v1:<base64( iv(12) | authTag(16) | ciphertext )>
// Khóa 32 byte suy ra từ TOKEN_ENCRYPTION_KEY (hoặc SESSION_SECRET) bằng scrypt.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = "v1:";
const KEY_SALT = "post-meta-auto/token-store";

let cachedKey = null;

function getKey() {
  if (cachedKey) {
    return cachedKey;
  }

  const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.SESSION_SECRET;

  if (!secret) {
    throw new Error(
      "Thiếu TOKEN_ENCRYPTION_KEY hoặc SESSION_SECRET để mã hóa token trong DB."
    );
  }

  cachedKey = crypto.scryptSync(secret, KEY_SALT, 32);
  return cachedKey;
}

function encrypt(plainText) {
  if (plainText === null || plainText === undefined || String(plainText).length === 0) {
    return null;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return PREFIX + Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decrypt(stored) {
  if (stored === null || stored === undefined || String(stored).length === 0) {
    return null;
  }

  const value = String(stored);

  if (!value.startsWith(PREFIX)) {
    // Giá trị chưa mã hóa (dữ liệu cũ hoặc lỗi) — trả nguyên để không mất token.
    return value;
  }

  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

module.exports = {
  encrypt,
  decrypt
};
