const postgres = require("postgres");

// Kết nối PostgreSQL (Supabase) — dùng cho hệ tài khoản đa người dùng (bền qua redeploy).
// Cổng 6543 = transaction pooler (pgBouncer): BẮT BUỘC prepare:false (không hỗ trợ prepared statement),
// và SSL. Nếu chưa đặt DATABASE_URL thì tính năng tài khoản tự tắt (app vẫn chạy phần còn lại).

const connectionString = process.env.DATABASE_URL || "";
let sql = null;

function isEnabled() {
  return Boolean(connectionString) && !connectionString.includes("[YOUR-PASSWORD]");
}

function getSql() {
  if (!isEnabled()) {
    return null;
  }
  if (!sql) {
    sql = postgres(connectionString, {
      prepare: false,
      ssl: "require",
      max: 5,
      idle_timeout: 20,
      connect_timeout: 15
    });
  }
  return sql;
}

// Tạo bảng users nếu chưa có. Gọi lúc khởi động (không chặn app nếu Postgres chưa cấu hình).
async function initAccountSchema() {
  const db = getSql();
  if (!db) {
    console.warn("[Postgres] Chưa cấu hình DATABASE_URL — bỏ qua khởi tạo bảng tài khoản.");
    return;
  }

  await db`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGSERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      phone         TEXT,
      name          TEXT,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  console.log("[Postgres] Bảng users sẵn sàng.");
}

module.exports = { getSql, isEnabled, initAccountSchema };
