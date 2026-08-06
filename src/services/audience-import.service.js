// Nhận + kiểm + lưu một ảnh chụp nhân khẩu học vào Postgres.
//
// NGUỒN DÙNG CHUNG: cả worker.routes.js (đường HTTP mới) lẫn scripts/import-
// audience.js (đường di trú cũ, chạy trên máy vận hành) đều require file này ->
// MỘT nguồn validate. Trước đây logic nằm trong script; tách ra để hai đường
// không lệch cách kiểm.
//
// LƯU Ý ĐƠN VỊ: percentage ĐÃ LÀ PHẦN TRĂM và có thể > 100 (Meta trả 106.2% vì
// một người tính vào nhiều quốc gia). KHÔNG đặt trần 100 — sẽ loại dữ liệu đúng.

const crypto = require("crypto");

// Ba chiều dữ liệu hợp lệ. Chặn ở đây để một chiều lạ (Meta đổi tên) không lặng
// lẽ chui vào DB rồi làm hỏng phần đọc.
const DIMENSIONS = new Set(["age_gender", "city", "country"]);

class InputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.publicMessage = message;
  }
}

function normalizeRow(row, index) {
  const dimension = String(row.dimension || "");
  if (!DIMENSIONS.has(dimension)) {
    throw new InputError(
      `Dòng ${index}: chiều dữ liệu '${dimension}' không hợp lệ (chỉ ${[...DIMENSIONS].join(" | ")}).`
    );
  }

  const percentage = Number(row.percentage);
  if (!Number.isFinite(percentage) || percentage < 0) {
    throw new InputError(`Dòng ${index}: percentage không hợp lệ (${row.percentage}).`);
  }

  return {
    dimension,
    segment: String(row.segment || ""),
    age_range: row.ageRange || null,
    gender: row.gender || null,
    location: row.location || null,
    percentage
  };
}

// Kiểm + chuẩn hoá một payload (object) thành snapshot sẵn sàng lưu. Dùng cho cả
// HTTP body lẫn JSON file (import-audience.js parse file rồi gọi hàm này).
function buildSnapshot(payload) {
  const assetId = String((payload && payload.assetId) || "").trim();
  if (!assetId) {
    throw new InputError("Thiếu assetId.");
  }

  const capturedAt = new Date(payload.capturedAt);
  if (Number.isNaN(capturedAt.getTime())) {
    throw new InputError(`capturedAt không đọc được: ${payload.capturedAt}`);
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.length === 0) {
    throw new InputError("Không có dòng số liệu nào (rows rỗng).");
  }

  const timeRange = String(payload.timeRange || "lifetime");

  // Idempotency: cùng (asset, thời điểm, khoảng) -> cùng key -> chống tạo trùng
  // khi worker retry sau lỗi mạng. Cho phép client tự khai key nếu muốn.
  const idempotencyKey = payload.idempotencyKey
    ? String(payload.idempotencyKey)
    : crypto.createHash("sha256").update(`${assetId}|${capturedAt.toISOString()}|${timeRange}`).digest("hex");

  return {
    assetId,
    assetType: payload.assetType === "instagram" ? "instagram" : "page",
    businessId: payload.businessId ? String(payload.businessId) : null,
    source: String(payload.source || "browser"),
    capturedAt,
    timeRange,
    idempotencyKey,
    rows: rows.map(normalizeRow)
  };
}

// Lưu snapshot + các dòng trong MỘT giao dịch. Idempotent theo idempotency_key.
// userId = chủ sở hữu tenant (null cho luồng vận hành cũ = legacy dùng chung).
async function saveSnapshot(sql, snapshot, { userId = null } = {}) {
  if (snapshot.idempotencyKey) {
    const existing = await sql`
      SELECT id FROM crawled_audience_snapshots
      WHERE idempotency_key = ${snapshot.idempotencyKey} LIMIT 1
    `;
    if (existing.length > 0) {
      return { snapshotId: Number(existing[0].id), rowCount: snapshot.rows.length, deduped: true };
    }
  }

  try {
    const snapshotId = await sql.begin(async (tx) => {
      const [created] = await tx`
        INSERT INTO crawled_audience_snapshots
          (asset_id, asset_type, business_id, source, captured_at, time_range, user_id, idempotency_key)
        VALUES (${snapshot.assetId}, ${snapshot.assetType}, ${snapshot.businessId}, ${snapshot.source},
                ${snapshot.capturedAt}, ${snapshot.timeRange}, ${userId}, ${snapshot.idempotencyKey})
        RETURNING id
      `;
      const id = created.id;
      const rows = snapshot.rows.map((row) => ({ ...row, snapshot_id: id }));
      await tx`
        INSERT INTO crawled_audience_rows ${tx(
          rows,
          "snapshot_id",
          "dimension",
          "segment",
          "age_range",
          "gender",
          "location",
          "percentage"
        )}
      `;
      return id;
    });
    return { snapshotId: Number(snapshotId), rowCount: snapshot.rows.length, deduped: false };
  } catch (error) {
    // Đua chèn cùng key -> unique violation (23505). Đọc lại bản đã có.
    if (error && error.code === "23505" && snapshot.idempotencyKey) {
      const existing = await sql`
        SELECT id FROM crawled_audience_snapshots
        WHERE idempotency_key = ${snapshot.idempotencyKey} LIMIT 1
      `;
      if (existing.length > 0) {
        return { snapshotId: Number(existing[0].id), rowCount: snapshot.rows.length, deduped: true };
      }
    }
    throw error;
  }
}

module.exports = { DIMENSIONS, InputError, normalizeRow, buildSnapshot, saveSnapshot };
