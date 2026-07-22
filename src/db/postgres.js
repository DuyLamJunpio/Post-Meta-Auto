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

  // Kết nối Facebook theo từng tài khoản (token mã hóa). 1 user = 1 kết nối FB.
  await db`
    CREATE TABLE IF NOT EXISTS user_facebook (
      user_id      BIGINT PRIMARY KEY,
      fb_user_id   TEXT,
      fb_user_name TEXT,
      data_enc     TEXT NOT NULL,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Kết nối Notion theo từng tài khoản (OAuth) + 2 data source đã chọn.
  await db`
    CREATE TABLE IF NOT EXISTS user_notion (
      user_id                BIGINT PRIMARY KEY,
      workspace_id           TEXT,
      workspace_name         TEXT,
      bot_id                 TEXT,
      token_enc              TEXT NOT NULL,
      content_data_source_id TEXT,
      brands_data_source_id  TEXT,
      connected_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  console.log("[Postgres] Bảng users + user_facebook + user_notion sẵn sàng.");
}

module.exports = { getSql, isEnabled, initAccountSchema };
