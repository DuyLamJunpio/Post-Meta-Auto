-- Phase 0: tầng lưu trữ bền vững cho token đa kênh và trạng thái đăng bài.

-- Token/tài khoản của từng kênh, gắn theo user Facebook đang đăng nhập.
-- access_token/refresh_token được mã hóa (AES-256-GCM) trước khi ghi.
CREATE TABLE IF NOT EXISTS channel_accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,            -- Facebook user id (chủ sở hữu kết nối)
  channel       TEXT NOT NULL,            -- facebook | instagram | gbp | tiktok | google_drive
  account_id    TEXT NOT NULL DEFAULT '', -- page id / ig business id / gbp location / tiktok open id
  account_name  TEXT,
  access_token  TEXT,                     -- đã mã hóa
  refresh_token TEXT,                     -- đã mã hóa
  scope         TEXT,
  token_type    TEXT,
  expires_at    TEXT,                     -- ISO 8601
  metadata      TEXT,                     -- JSON blob cho dữ liệu riêng của kênh
  connected_at  TEXT,
  updated_at    TEXT NOT NULL,
  UNIQUE (user_id, channel, account_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_accounts_user
  ON channel_accounts (user_id, channel);

-- Mỗi task Notion đăng lên mỗi kênh sinh đúng 1 job (idempotent theo task+channel).
-- Đây là nguồn sự thật cho trạng thái đăng đa kênh; Notion chỉ là bản chiếu tổng hợp.
CREATE TABLE IF NOT EXISTS publish_jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  notion_task_id TEXT NOT NULL,
  channel        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | publishing | published | failed | skipped
  account_id     TEXT,
  post_id        TEXT,
  permalink_url  TEXT,
  retry_count    INTEGER NOT NULL DEFAULT 0,
  error_message  TEXT,
  scheduled_at   TEXT,
  published_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (notion_task_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_publish_jobs_task   ON publish_jobs (notion_task_id);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_status ON publish_jobs (status);
