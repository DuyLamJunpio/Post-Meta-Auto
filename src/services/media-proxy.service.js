const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { config } = require("../config");

// Proxy media tạm thời: server tải file Drive (riêng tư) về buffer, rồi PHÁT LẠI tại một URL
// công khai có đuôi file để IG/GBP/TikTok (mô hình PULL — tự đi fetch URL) lấy về đăng.
// File chỉ tồn tại trong lúc đăng; xóa ngay sau khi đăng + có "chổi quét" TTL phòng crash.
// Bật/tắt qua PUBLIC_BASE_URL (host công khai). localhost không dùng được vì nền tảng ở ngoài
// internet phải với tới được URL này.

const EXT_BY_CONTENT_TYPE = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm"
};

const CONTENT_TYPE_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm"
};

function isEnabled() {
  return config.mediaProxy.enabled;
}

function storageDir() {
  return path.resolve(config.mediaProxy.storageDir);
}

function ensureStorageDir() {
  const dir = storageDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extensionFor(contentType, filename) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();

  if (EXT_BY_CONTENT_TYPE[normalized]) {
    return EXT_BY_CONTENT_TYPE[normalized];
  }

  const fromName = path.extname(String(filename || "")).toLowerCase();
  return CONTENT_TYPE_BY_EXT[fromName] ? fromName : ".bin";
}

// buffer -> file tạm với tên token ngẫu nhiên (khó đoán) + đuôi file đúng.
// Trả về { filename, url } — url là địa chỉ công khai cho nền tảng fetch.
function publishBuffer(buffer, meta = {}) {
  ensureStorageDir();

  const ext = extensionFor(meta.contentType, meta.filename);
  const token = crypto.randomBytes(16).toString("hex");
  const storedName = `${token}${ext}`;

  fs.writeFileSync(path.join(storageDir(), storedName), buffer);

  return {
    filename: storedName,
    url: `${config.mediaProxy.publicBaseUrl}/media/${storedName}`
  };
}

// Chỉ nhận tên file an toàn (chống path traversal) và phải nằm trong thư mục lưu.
function safeName(filename) {
  const base = path.basename(String(filename || ""));
  return /^[a-zA-Z0-9._-]+$/.test(base) ? base : null;
}

function getFilePath(filename) {
  const name = safeName(filename);

  if (!name) {
    return null;
  }

  const full = path.join(storageDir(), name);
  return fs.existsSync(full) ? full : null;
}

function contentTypeFor(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] || "application/octet-stream";
}

function remove(filename) {
  const name = safeName(filename);

  if (!name) {
    return;
  }

  const full = path.join(storageDir(), name);

  try {
    if (fs.existsSync(full)) {
      fs.unlinkSync(full);
    }
  } catch (error) {
    console.error("[Media Proxy] Không xóa được file tạm:", error.message);
  }
}

// Xóa mọi file quá hạn TTL (phòng khi server crash giữa chừng, không kịp xóa sau publish).
function sweep() {
  if (!isEnabled()) {
    return;
  }

  const dir = storageDir();
  let names;

  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    return;
  }

  const now = Date.now();

  for (const name of names) {
    const full = path.join(dir, name);

    try {
      const stats = fs.statSync(full);

      if (now - stats.mtimeMs > config.mediaProxy.ttlMs) {
        fs.unlinkSync(full);
      }
    } catch (error) {
      // Bỏ qua file lỗi stat/unlink; lần quét sau xử lý tiếp.
    }
  }
}

module.exports = {
  isEnabled,
  publishBuffer,
  getFilePath,
  contentTypeFor,
  remove,
  sweep
};
