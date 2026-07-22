-- Bật/tắt tự đăng theo từng Brand × kênh.
-- Mặc định (không có dòng) = BẬT. Chỉ ghi dòng khi người dùng chủ động tắt/bật.
-- Áp dụng cho luồng TỰ ĐỘNG đăng; đăng thủ công từng task không bị chặn.
CREATE TABLE IF NOT EXISTS channel_toggles (
  brand_id   TEXT NOT NULL,
  channel    TEXT NOT NULL,             -- facebook | instagram | gbp | tiktok
  enabled    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (brand_id, channel)
);
