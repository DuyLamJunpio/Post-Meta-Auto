-- Lớp 4 (phát hiện & truy vết): nhật ký các sự kiện đăng để tra cứu "ai/đăng gì/lên page nào".
-- Lưu ý: trên Render Free, bảng này có thể mất khi deploy lại; cảnh báo Telegram là lưới an toàn bền hơn.
CREATE TABLE IF NOT EXISTS publish_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event          TEXT NOT NULL,            -- published | failed | paused | retracted
  notion_task_id TEXT,
  channel        TEXT,
  account_id     TEXT,                     -- page id / account đăng lên
  account_name   TEXT,
  post_id        TEXT,
  permalink_url  TEXT,
  title          TEXT,
  message        TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_publish_audit_created ON publish_audit (created_at);
CREATE INDEX IF NOT EXISTS idx_publish_audit_event   ON publish_audit (event);
