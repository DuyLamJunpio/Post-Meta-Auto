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

  // Khoảng thời gian của số liệu: 'lifetime' | 'last_7d' | 'last_28d' | ...
  //
  // ADD COLUMN IF NOT EXISTS chứ không sửa câu CREATE TABLE ở trên: bảng đã
  // có dữ liệu thật trên Supabase rồi. Sửa CREATE chỉ tác dụng với cơ sở dữ
  // liệu trống, còn bảng đang chạy sẽ mãi thiếu cột — mà không có gì báo.
  await db`
    ALTER TABLE crawled_audience_snapshots
      ADD COLUMN IF NOT EXISTS time_range TEXT NOT NULL DEFAULT 'lifetime'
  `;

  // Chủ sở hữu (tenant) của ảnh chụp. ADD COLUMN IF NOT EXISTS vì bảng đã có dữ
  // liệu thật trên Supabase.
  //
  // VÌ SAO CẦN: trước cột này, đường đọc lấy snapshot theo asset_id TOÀN CỤC —
  // hai tài khoản cùng quản một Page sẽ thấy số liệu của nhau. Gắn chủ để đường
  // đọc scope được theo tenant.
  //
  // NULL = snapshot cũ/của người vận hành (chưa gắn chủ). Đường đọc coi NULL là
  // "dùng chung/legacy" để KHÔNG mất dữ liệu đã cào trước khi có cột này.
  await db`
    ALTER TABLE crawled_audience_snapshots
      ADD COLUMN IF NOT EXISTS user_id BIGINT
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_crawled_snapshots_asset_user
      ON crawled_audience_snapshots (asset_id, user_id, captured_at DESC)
  `;

  // Chống tạo trùng khi worker retry (cùng asset + thời điểm + khoảng -> cùng
  // key). Index UNIQUE MỘT PHẦN: chỉ ràng buộc khi có key, để dữ liệu cũ (key
  // NULL) không vi phạm.
  await db`
    ALTER TABLE crawled_audience_snapshots
      ADD COLUMN IF NOT EXISTS idempotency_key TEXT
  `;
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_crawled_snapshots_idem
      ON crawled_audience_snapshots (idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `;

  console.log("[Postgres] Bảng crawled_audience_* sẵn sàng.");
}

// Hàng đợi yêu cầu cào, để bấm nút trên web mà máy ở nhà thực hiện.
//
// VÌ SAO PHẢI CÓ HÀNG ĐỢI THAY VÌ GỌI THẲNG?
// Web chạy trên Render, nhưng việc cào chỉ làm được trên máy có Edge đã đăng
// nhập Facebook. Hai bên KHÔNG gọi thẳng nhau được: máy ở nhà nằm sau router,
// không có địa chỉ công khai để Render gọi tới.
//
// Hàng đợi lật ngược chiều gọi. Web chỉ GHI một dòng "có việc cần làm".
// Máy ở nhà tự ĐỌC và nhận việc. Không cần mở cổng, không cần địa chỉ tĩnh,
// và máy tắt cũng không mất yêu cầu — nó nằm chờ tới khi máy bật lên.
async function initCrawlJobsSchema() {
  const db = getSql();
  if (!db) {
    return;
  }

  await db`
    CREATE TABLE IF NOT EXISTS crawl_jobs (
      id           BIGSERIAL PRIMARY KEY,
      -- Ai bấm nút. Để biết yêu cầu này của tài khoản nào.
      user_id      BIGINT,
      asset_id     TEXT NOT NULL,
      asset_type   TEXT NOT NULL DEFAULT 'page',
      -- Chép lại tên trang lúc bấm, để bảng lịch sử đọc được mà không phải
      -- tra ngược sang Facebook (tên trang có thể đổi, hoặc mất quyền xem)
      asset_name   TEXT,
      -- 'lifetime' | 'last_7d' | 'last_28d' | 'last_90d' | ...
      time_range   TEXT NOT NULL DEFAULT 'lifetime',
      -- pending -> running -> done | failed
      status       TEXT NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at   TIMESTAMPTZ,
      finished_at  TIMESTAMPTZ,
      -- Kết quả khi xong
      snapshot_id  BIGINT,
      row_count    INTEGER,
      error        TEXT,
      -- Máy nào nhận việc. Có ích khi sau này chạy hai máy cùng lúc.
      worker       TEXT
    )
  `;

  // Câu hỏi máy ở nhà hỏi liên tục: "có việc nào đang chờ không?".
  // Index MỘT PHẦN (chỉ dòng pending) vì bảng sẽ đầy dần các dòng done, mà
  // những dòng đó không bao giờ nằm trong câu hỏi này.
  await db`
    CREATE INDEX IF NOT EXISTS idx_crawl_jobs_cho_xu_ly
      ON crawl_jobs (requested_at)
      WHERE status = 'pending'
  `;

  // Câu hỏi của web: "trang này có yêu cầu nào gần đây?"
  await db`
    CREATE INDEX IF NOT EXISTS idx_crawl_jobs_asset
      ON crawl_jobs (asset_id, requested_at DESC)
  `;

  console.log("[Postgres] Bảng crawl_jobs sẵn sàng.");
}

// Token + heartbeat cho "app cào" tải về (chạy trên máy khách, gọi API bằng
// token thay vì cầm DATABASE_URL). Xem worker-token.service.js.
async function initWorkerSchema() {
  const db = getSql();
  if (!db) {
    return;
  }

  // Chỉ lưu BĂM token (token_hash), không lưu token gốc. expires_at mặc định 90
  // ngày để buộc xoay vòng. token_prefix để khách nhận diện token trên web.
  await db`
    CREATE TABLE IF NOT EXISTS worker_tokens (
      id            BIGSERIAL PRIMARY KEY,
      user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT,
      token_prefix  TEXT NOT NULL,
      token_hash    TEXT NOT NULL,
      scopes        TEXT NOT NULL DEFAULT 'crawl',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at  TIMESTAMPTZ,
      expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 days'),
      revoked_at    TIMESTAMPTZ,
      UNIQUE(token_hash)
    )
  `;
  await db`
    CREATE INDEX IF NOT EXISTS idx_worker_tokens_user ON worker_tokens (user_id)
  `;

  // Nhịp tim + lỗi trước-claim của mỗi máy cào. Khoá theo token_id (1 token = 1
  // máy) để nhiều máy trùng hostname mặc định 'DESKTOP-XXXX' không đè nhau.
  await db`
    CREATE TABLE IF NOT EXISTS crawl_workers (
      id             BIGSERIAL PRIMARY KEY,
      user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_id       BIGINT REFERENCES worker_tokens(id) ON DELETE SET NULL,
      hostname       TEXT,
      app_version    TEXT,
      last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error     TEXT,
      last_error_at  TIMESTAMPTZ,
      UNIQUE(token_id)
    )
  `;

  console.log("[Postgres] Bảng worker_tokens + crawl_workers sẵn sàng.");
}

// Số liệu Ads Insights (Marketing API) chụp theo chiến dịch. Cùng lý do ở
// Postgres như crawled_audience_*: Render xoá đĩa mỗi deploy nên SQLite mất lịch
// sử. snapshots = 1 lần chụp cho (tài khoản QC × chiến dịch × khoảng × ngày chốt);
// rows = các con số của lần chụp đó (tổng hợp cả kỳ row_date NULL + chuỗi theo ngày).
async function initAdsInsightsSchema() {
  const db = getSql();
  if (!db) {
    return;
  }

  await db`
    CREATE TABLE IF NOT EXISTS ads_insights_snapshots (
      id              BIGSERIAL PRIMARY KEY,
      ad_account_id   TEXT NOT NULL,
      level           TEXT NOT NULL,            -- 'campaign'
      object_id       TEXT NOT NULL,            -- campaign id
      date_preset     TEXT,
      date_start      DATE,
      date_stop       DATE,
      currency        TEXT,
      user_id         BIGINT,                   -- tenant users.id, nullable (legacy)
      idempotency_key TEXT,
      captured_at     TIMESTAMPTZ DEFAULT now(),
      created_at      TIMESTAMPTZ DEFAULT now()
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS ads_insights_rows (
      id              BIGSERIAL PRIMARY KEY,
      snapshot_id     BIGINT NOT NULL
                      REFERENCES ads_insights_snapshots(id) ON DELETE CASCADE,
      row_date        DATE,                     -- ngày cho chuỗi thời gian; NULL = tổng hợp cả kỳ
      breakdown_key   TEXT DEFAULT 'total',     -- Pha 2: 'age_gender' | 'country' | 'region'
      breakdown_value TEXT,                     -- NULL cho total
      metric          TEXT NOT NULL,            -- spend/impressions/reach/clicks/...
      value           DOUBLE PRECISION
    )
  `;

  // Chống tạo trùng khi client gọi lại trong ngày. UNIQUE MỘT PHẦN: chỉ ràng buộc
  // khi có key, để bản legacy (key NULL) không vi phạm.
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ads_insights_snapshots_idem
      ON ads_insights_snapshots (idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `;

  // Câu hỏi hay dùng: "bản chụp gần nhất của chiến dịch này (theo tenant)".
  await db`
    CREATE INDEX IF NOT EXISTS idx_ads_insights_snapshots_lookup
      ON ads_insights_snapshots (ad_account_id, object_id, user_id, captured_at DESC)
  `;

  await db`
    CREATE INDEX IF NOT EXISTS idx_ads_insights_rows_snapshot
      ON ads_insights_rows (snapshot_id)
  `;

  console.log("[Postgres] Bảng ads_insights_* sẵn sàng.");
}

// Nhớ file Google Sheet đã tạo cho mỗi (tài khoản FB × Page) để lần xuất sau GHI TIẾP
// vào file cũ (dồn dữ liệu) thay vì tạo file mới. Khoá tự nhiên = fb_user_id + page_id
// (fb_user_id luôn có khi đăng nhập Facebook; user_id SaaS có thể NULL).
async function initAdsExportSheetsSchema() {
  const db = getSql();
  if (!db) {
    return;
  }

  await db`
    CREATE TABLE IF NOT EXISTS ads_export_sheets (
      id              BIGSERIAL PRIMARY KEY,
      user_id         BIGINT,                 -- tenant SaaS (nullable)
      fb_user_id      TEXT NOT NULL,          -- tài khoản Facebook sở hữu file
      page_id         TEXT NOT NULL,
      spreadsheet_id  TEXT NOT NULL,
      spreadsheet_url TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (fb_user_id, page_id)
    )
  `;

  console.log("[Postgres] Bảng ads_export_sheets sẵn sàng.");
}

// Gán chủ sở hữu cho các snapshot CŨ chưa có user_id, suy từ crawl_jobs đã liên
// kết (crawl_jobs.snapshot_id -> snapshots.id). Chạy MỘT LẦN lúc khởi động, SAU
// khi cả bảng snapshots (đã thêm cột user_id) lẫn crawl_jobs đều sẵn sàng.
//
// Idempotent: chỉ đụng dòng user_id IS NULL và có job gắn user_id — chạy lại bao
// nhiêu lần cũng vô hại. Snapshot cào bởi người vận hành (job.user_id = NULL) sẽ
// giữ NULL và được đường đọc coi là "dùng chung/legacy".
async function backfillSnapshotOwners() {
  const db = getSql();
  if (!db) {
    return;
  }

  const rows = await db`
    UPDATE crawled_audience_snapshots s
    SET user_id = j.user_id
    FROM crawl_jobs j
    WHERE j.snapshot_id = s.id
      AND s.user_id IS NULL
      AND j.user_id IS NOT NULL
    RETURNING s.id
  `;

  if (rows.length > 0) {
    console.log(`[Postgres] Backfill chủ sở hữu cho ${rows.length} snapshot cào.`);
  }
}

module.exports = {
  getSql,
  isEnabled,
  initAccountSchema,
  initCrawledAudienceSchema,
  initCrawlJobsSchema,
  initWorkerSchema,
  initAdsInsightsSchema,
  initAdsExportSheetsSchema,
  backfillSnapshotOwners
};
