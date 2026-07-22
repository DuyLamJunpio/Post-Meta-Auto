-- Lead khách hàng thu thập qua trang đăng ký công khai (đăng nhập Facebook + tự khai thông tin).
-- LUÔN kèm bằng chứng đồng ý (consent) theo Nghị định 13/2023/NĐ-CP: nội dung + thời điểm đồng ý.
CREATE TABLE IF NOT EXISTS leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  fb_id        TEXT,                       -- app-scoped id (chỉ có khi khách đăng nhập FB)
  name         TEXT,
  email        TEXT,
  phone        TEXT,
  note         TEXT,
  consent      INTEGER NOT NULL DEFAULT 0, -- 1 = khách đã tick đồng ý
  consent_text TEXT,                       -- câu đồng ý khách đã đọc (lưu để chứng minh)
  consent_at   TEXT,                       -- thời điểm đồng ý
  source       TEXT,                       -- nguồn (vd "web-form")
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at);
