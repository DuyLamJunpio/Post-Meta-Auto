-- Cấu hình runtime dạng key-value (vd id data source "Leads" đã tạo trong Notion).
-- Lưu ý Render Free: bảng này mất khi redeploy -> nên set env NOTION_LEADS_DATA_SOURCE_ID
-- để giữ ổn định lâu dài (tránh tạo lại bảng Leads mới).
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL
);
