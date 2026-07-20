const { Store } = require("express-session");
const { getDb } = require("./index");

// Session store lưu bền bằng node:sqlite (dùng chung DB app.db).
// Mục tiêu: đăng nhập Facebook + vòng lặp tự đăng sống sót qua restart/ngủ của server,
// thay cho MemoryStore (mất hết khi process tắt).
//
// Lưu ý: server.js dùng sessionStore.all() để duyệt mọi session Facebook đang đăng nhập,
// nên store này BẮT BUỘC phải hỗ trợ all().

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // dọn session hết hạn mỗi giờ

function getExpiresAt(session) {
  const cookie = session && session.cookie;
  if (cookie && cookie.expires) {
    return new Date(cookie.expires).getTime();
  }
  const maxAge = cookie && typeof cookie.maxAge === "number" ? cookie.maxAge : DAY_MS;
  return Date.now() + maxAge;
}

class SqliteSessionStore extends Store {
  constructor() {
    super();
    this.db = getDb();
    this._cleanup();
    // Định kỳ dọn session hết hạn; unref để không giữ process sống.
    this._timer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
    if (this._timer.unref) {
      this._timer.unref();
    }
  }

  _cleanup() {
    try {
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    } catch (error) {
      console.warn("[Session Store] Không dọn được session hết hạn:", error.message);
    }
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare("SELECT data, expires_at FROM sessions WHERE sid = ?").get(sid);
      if (!row) {
        return callback(null, null);
      }
      if (row.expires_at <= Date.now()) {
        this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, session, callback) {
    try {
      const data = JSON.stringify(session);
      const expiresAt = getExpiresAt(session);
      this.db
        .prepare(
          `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
        )
        .run(sid, data, expiresAt);
      return callback ? callback(null) : undefined;
    } catch (error) {
      return callback ? callback(error) : undefined;
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      return callback ? callback(null) : undefined;
    } catch (error) {
      return callback ? callback(error) : undefined;
    }
  }

  touch(sid, session, callback) {
    try {
      const expiresAt = getExpiresAt(session);
      this.db.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?").run(expiresAt, sid);
      return callback ? callback(null) : undefined;
    } catch (error) {
      return callback ? callback(error) : undefined;
    }
  }

  all(callback) {
    try {
      const rows = this.db.prepare("SELECT data FROM sessions WHERE expires_at > ?").all(Date.now());
      const sessions = rows.map((row) => JSON.parse(row.data));
      return callback(null, sessions);
    } catch (error) {
      return callback(error);
    }
  }

  length(callback) {
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ?").get(Date.now());
      return callback(null, row ? row.count : 0);
    } catch (error) {
      return callback(error);
    }
  }

  clear(callback) {
    try {
      this.db.prepare("DELETE FROM sessions").run();
      return callback ? callback(null) : undefined;
    } catch (error) {
      return callback ? callback(error) : undefined;
    }
  }
}

module.exports = { SqliteSessionStore };
