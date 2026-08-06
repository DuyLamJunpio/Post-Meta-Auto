// Token cho "app cào" tải về chạy trên máy khách.
//
// VÌ SAO CÓ FILE NÀY
// App .exe trên máy khách KHÔNG được cầm DATABASE_URL (ai tải cũng moi được ->
// đọc/ghi dữ liệu mọi khách). Thay vào đó nó gọi API web kèm MỘT token riêng.
// File này phát/kiểm/thu hồi token đó.
//
// BẢO MẬT
// - Chỉ lưu BĂM SHA-256 của token, không lưu token gốc. Token entropy 256-bit
//   (randomBytes(32)) nên SHA-256 thuần là đủ — không cần scrypt như mật khẩu
//   người-chọn, và KHÔNG pepper (mất pepper = vô hiệu mọi token).
// - Token gốc chỉ hiện ĐÚNG MỘT LẦN lúc phát (kiểu GitHub PAT).
// - Kiểm token: tra thẳng theo token_hash (O(1) qua UNIQUE index). Không cần
//   timingSafeEqual vì attacker không điều khiển được preimage của hash.

const crypto = require("crypto");

const { getSql, isEnabled } = require("../db/postgres");

const TOKEN_PREFIX = "wk_";
// wk_ + base64url(32 byte) ~ 46 ký tự. Chặn token dị dạng trước khi tra DB.
const MIN_TOKEN_LENGTH = 20;
const EXPIRY_DAYS = 90;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function requireSql() {
  const sql = getSql();
  if (!sql) {
    const error = new Error("Chưa cấu hình DATABASE_URL nên không dùng được token worker.");
    error.status = 503;
    error.publicMessage = error.message;
    throw error;
  }
  return sql;
}

// Phát token mới cho một user. Trả token GỐC đúng một lần.
async function issueToken(userId, name) {
  const sql = requireSql();
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const tokenPrefix = token.slice(0, 13);

  const [row] = await sql`
    INSERT INTO worker_tokens (user_id, name, token_prefix, token_hash, scopes, expires_at)
    VALUES (${Number(userId)}, ${name ? String(name).slice(0, 120) : null},
            ${tokenPrefix}, ${tokenHash}, 'crawl',
            now() + make_interval(days => ${EXPIRY_DAYS}))
    RETURNING id, name, token_prefix, scopes, created_at, expires_at
  `;

  return {
    token, // GỐC — chỉ trả lần này
    id: Number(row.id),
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

// Kiểm token thô -> { userId, tokenId, scopes } hoặc null nếu sai/hết hạn/thu hồi.
// KHÔNG ném lỗi cho token dị dạng — trả null để middleware trả 401 gọn.
async function verifyToken(token) {
  if (!isEnabled()) {
    return null;
  }
  const value = String(token || "");
  if (!value.startsWith(TOKEN_PREFIX) || value.length < MIN_TOKEN_LENGTH) {
    return null;
  }

  const sql = getSql();
  const rows = await sql`
    UPDATE worker_tokens
    SET last_used_at = now()
    WHERE token_hash = ${hashToken(value)}
      AND revoked_at IS NULL
      AND expires_at > now()
    RETURNING id, user_id, scopes
  `;
  if (rows.length === 0) {
    return null;
  }
  return { userId: Number(rows[0].user_id), tokenId: Number(rows[0].id), scopes: rows[0].scopes };
}

async function revokeToken(id, userId) {
  const sql = requireSql();
  const rows = await sql`
    UPDATE worker_tokens
    SET revoked_at = now()
    WHERE id = ${Number(id)} AND user_id = ${Number(userId)} AND revoked_at IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

// Danh sách token của một user — KHÔNG trả hash/token gốc.
async function listTokens(userId) {
  if (!isEnabled()) {
    return [];
  }
  const sql = getSql();
  const rows = await sql`
    SELECT id, name, token_prefix, scopes, last_used_at, created_at, expires_at, revoked_at
    FROM worker_tokens
    WHERE user_id = ${Number(userId)}
    ORDER BY created_at DESC
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  }));
}

// Ghi nhịp tim của worker (heartbeat/claim). Upsert theo token_id (1 token = 1
// máy) để nhiều máy trùng hostname mặc định không đè nhau. KHÔNG trả PII.
async function recordHeartbeat({ userId, tokenId, hostname, appVersion, lastError }) {
  const sql = requireSql();
  const err = lastError ? String(lastError).slice(0, 500) : null;
  await sql`
    INSERT INTO crawl_workers (user_id, token_id, hostname, app_version, last_seen_at, last_error, last_error_at)
    VALUES (${Number(userId)}, ${Number(tokenId)}, ${hostname ? String(hostname).slice(0, 200) : null},
            ${appVersion ? String(appVersion).slice(0, 60) : null}, now(),
            ${err}, ${err ? sql`now()` : null})
    ON CONFLICT (token_id) DO UPDATE SET
      last_seen_at = now(),
      hostname = EXCLUDED.hostname,
      app_version = EXCLUDED.app_version,
      last_error = EXCLUDED.last_error,
      last_error_at = COALESCE(EXCLUDED.last_error_at, crawl_workers.last_error_at)
  `;
  // Nhãn không định danh (không email/PII).
  return { connectedLabel: hostname ? String(hostname).slice(0, 60) : "Đã kết nối" };
}

// "Online" = có nhịp tim trong vòng 90 giây. App hỏi hàng đợi mỗi ~10s (kể cả
// khi rỗng) nên vẫn đập nhịp đều; 90s dung thứ vài nhịp lỡ mà không báo tắt oan.
const ONLINE_WINDOW_MS = 90 * 1000;

// Trạng thái các máy cào của MỘT user (cho huy hiệu "máy đang bật" + khoá nút).
async function getWorkerStatus(userId) {
  if (!isEnabled() || !userId) {
    return { online: false, workers: [] };
  }
  const sql = getSql();
  const rows = await sql`
    SELECT hostname, app_version, last_seen_at, last_error, last_error_at
    FROM crawl_workers
    WHERE user_id = ${Number(userId)}
    ORDER BY last_seen_at DESC NULLS LAST
  `;
  const now = Date.now();
  const workers = rows.map((row) => {
    const seen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    return {
      hostname: row.hostname,
      appVersion: row.app_version,
      lastSeenAt: row.last_seen_at,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
      online: now - seen < ONLINE_WINDOW_MS
    };
  });
  return { online: workers.some((w) => w.online), workers };
}

module.exports = {
  issueToken,
  verifyToken,
  revokeToken,
  listTokens,
  recordHeartbeat,
  getWorkerStatus
};
