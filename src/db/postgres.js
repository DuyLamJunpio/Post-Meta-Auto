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

// Nhân khẩu học lấy bằng công cụ cào Business Suite (dự án Crawl_demographics_meta).
//
// VÌ SAO Ở POSTGRES CHỨ KHÔNG PHẢI SQLite?
// data/app.db nằm trên đĩa của máy chủ, mà Render xoá sạch đĩa mỗi lần deploy —
// số liệu cào từ máy bạn sẽ biến mất sau lần deploy kế tiếp. Postgres (Supabase)
// là kho DUY NHẤT bền qua redeploy, cùng chỗ đang giữ users/user_facebook.
//
// LUỒNG:
//   [máy bạn] python -m src.cli run --all
//        -> node scripts/import-audience.js  -> Supabase  -> [web đọc]
//
// LƯU Ý VỀ ĐƠN VỊ: `percentage` LÀ PHẦN TRĂM SẴN, không phải số người.
// Meta cho tổng vượt 100% (thực đo: Việt Nam 106.2%, tổng theo quốc gia ~112%)
// vì một người có thể được tính vào nhiều quốc gia. Đó là đặc thù dữ liệu của
// Meta, KHÔNG phải lỗi. Vì vậy tầng đọc phải dùng
// normalizeBreakdown({ alreadyPercent: true }) để không chia lại theo tổng.
async function initCrawledAudienceSchema() {
  const db = getSql();
  if (!db) {
    return;
  }

  await db`
    CREATE TABLE IF NOT EXISTS crawled_audience_snapshots (
      id          BIGSERIAL PRIMARY KEY,
      -- ID Page Facebook hoặc tài khoản Instagram
      asset_id    TEXT NOT NULL,
      -- 'page' hoặc 'instagram'
      asset_type  TEXT NOT NULL DEFAULT 'page',
      business_id TEXT,
      source      TEXT NOT NULL DEFAULT 'browser',
      -- Thời điểm Meta hiển thị số liệu (do công cụ cào ghi lại)
      captured_at TIMESTAMPTZ NOT NULL,
      -- Thời điểm ghi vào đây — khác captured_at khi đẩy bù dữ liệu cũ
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS crawled_audience_rows (
      id          BIGSERIAL PRIMARY KEY,
      snapshot_id BIGINT NOT NULL
                  REFERENCES crawled_audience_snapshots(id) ON DELETE CASCADE,
      -- 'age_gender' | 'city' | 'country'
      dimension   TEXT NOT NULL,
      -- Nhãn gọn để hiển thị: "25-34 / female" hoặc "Huế, Thừa Thiên - Huế"
      segment     TEXT NOT NULL,
      -- Ba cột dưới chỉ điền cho đúng chiều tương ứng, còn lại để NULL
      age_range   TEXT,
      gender      TEXT,
      location    TEXT,
      -- ĐÃ LÀ PHẦN TRĂM (xem ghi chú đầu hàm)
      percentage  DOUBLE PRECISION NOT NULL
    )
  `;

  // Câu hỏi hay dùng nhất: "lấy ảnh chụp MỚI NHẤT của trang này".
  await db`
    CREATE INDEX IF NOT EXISTS idx_crawled_snapshots_asset
      ON crawled_audience_snapshots (asset_id, captured_at DESC)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_crawled_rows_snapshot
      ON crawled_audience_rows (snapshot_id)
  `;

  console.log("[Postgres] Bảng crawled_audience_* sẵn sàng.");
}

module.exports = { getSql, isEnabled, initAccountSchema, initCrawledAudienceSchema };
