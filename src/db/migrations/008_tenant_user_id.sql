-- Pha 4c: gắn user_id (tenant sở hữu) để cô lập & dọn dữ liệu đa người dùng.
-- Nullable: dòng của luồng admin/.env cũ = NULL. Notion page id (task/brand) là UUID toàn cục nên
-- các bảng key theo task/brand vốn KHÔNG đụng chéo tenant -> user_id là lớp phòng thủ + hygiene
-- (dọn khi user ngắt kết nối, truy vết ai sở hữu job), KHÔNG phải điều kiện đúng-sai của publish loop.

ALTER TABLE publish_jobs    ADD COLUMN user_id TEXT;
ALTER TABLE channel_toggles ADD COLUMN user_id TEXT;
ALTER TABLE publish_audit   ADD COLUMN user_id TEXT;
ALTER TABLE leads           ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_publish_jobs_user  ON publish_jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_publish_audit_user ON publish_audit (user_id);
