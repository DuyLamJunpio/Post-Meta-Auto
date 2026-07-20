-- Lưu session bền trong SQLite thay cho MemoryStore, để đăng nhập Facebook
-- (và vòng lặp tự đăng) sống sót qua restart/ngủ của server.
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL -- epoch ms; dùng để dọn session hết hạn
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
