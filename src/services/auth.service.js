const crypto = require("crypto");

const { getSql, isEnabled } = require("../db/postgres");

// Hệ tài khoản: mật khẩu băm bằng scrypt (built-in, không cần thư viện ngoài) + salt ngẫu nhiên.
// Lưu dạng "salt:hash" (hex). So sánh bằng timingSafeEqual chống timing attack.

const KEY_LEN = 64;

function createPublicError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  return error;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== "string" || !stored.includes(":")) {
    return false;
  }
  const [salt, hash] = stored.split(":");
  const hashBuffer = Buffer.from(hash, "hex");
  const testBuffer = crypto.scryptSync(password, salt, KEY_LEN);
  return hashBuffer.length === testBuffer.length && crypto.timingSafeEqual(hashBuffer, testBuffer);
}

function ensureEnabled() {
  if (!isEnabled()) {
    throw createPublicError(503, "Chưa cấu hình cơ sở dữ liệu tài khoản (DATABASE_URL). Vui lòng thử lại sau.");
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function publicUser(row) {
  if (!row) {
    return null;
  }
  return { id: Number(row.id), email: row.email, name: row.name, phone: row.phone, createdAt: row.created_at };
}

async function findByEmail(email) {
  const sql = getSql();
  const rows = await sql`SELECT * FROM users WHERE email = ${normalizeEmail(email)} LIMIT 1`;
  return rows[0] || null;
}

async function getUserById(id) {
  ensureEnabled();
  const sql = getSql();
  const rows = await sql`SELECT * FROM users WHERE id = ${Number(id)} LIMIT 1`;
  return publicUser(rows[0]);
}

async function registerUser({ email, password, name, phone }) {
  ensureEnabled();

  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw createPublicError(400, "Email không hợp lệ.");
  }
  if (typeof password !== "string" || password.length < 8) {
    throw createPublicError(400, "Mật khẩu phải từ 8 ký tự trở lên.");
  }

  const existing = await findByEmail(normalizedEmail);
  if (existing) {
    throw createPublicError(409, "Email này đã được đăng ký.");
  }

  const sql = getSql();
  const rows = await sql`
    INSERT INTO users (email, phone, name, password_hash)
    VALUES (${normalizedEmail}, ${String(phone || "").trim() || null}, ${String(name || "").trim() || null}, ${hashPassword(password)})
    RETURNING *
  `;
  return publicUser(rows[0]);
}

async function authenticate(email, password) {
  ensureEnabled();
  const user = await findByEmail(email);
  if (!user || !verifyPassword(String(password || ""), user.password_hash)) {
    throw createPublicError(401, "Email hoặc mật khẩu không đúng.");
  }
  return publicUser(user);
}

module.exports = {
  registerUser,
  authenticate,
  getUserById
};
