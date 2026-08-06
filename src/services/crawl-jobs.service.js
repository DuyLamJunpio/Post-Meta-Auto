// Hàng đợi yêu cầu cào: web ghi việc, máy có Edge ở nhà nhận và làm.
//
// VÌ SAO PHẢI LÀ HÀNG ĐỢI
// Web chạy trên Render, nhưng việc cào chỉ làm được trên máy có Edge đã đăng
// nhập Facebook. Render KHÔNG gọi thẳng tới máy bạn được: máy nằm sau router,
// không có địa chỉ công khai.
//
// Hàng đợi lật ngược chiều gọi — web chỉ ghi "có việc", máy ở nhà tự đọc.
// Không phải mở cổng, không cần địa chỉ tĩnh, và máy tắt cũng không mất yêu
// cầu: nó nằm chờ tới khi máy bật lên.
//
// VÒNG ĐỜI MỘT YÊU CẦU
//   pending  vừa bấm nút, chưa máy nào nhận
//   running  máy ở nhà đã nhận, đang mở Edge cào
//   done     xong, có snapshot_id để tra số liệu
//   failed   hỏng, có error để đọc nguyên nhân

const { getSql, isEnabled } = require("../db/postgres");

// Các khoảng thời gian cho phép chọn.
//
// ĐÂY LÀ NƠI DUY NHẤT khai danh sách này ở phía web. Giao diện dựng ô chọn từ
// đây, route kiểm tra hợp lệ cũng từ đây — nên không có đường nào để hai bên
// lệch nhau.
//
// ⚠️ Ngoài 'lifetime', các giá trị còn lại CHƯA được xác nhận là Meta thật sự
// hỗ trợ (`verified: false`). Công cụ cào sẽ tự đối chiếu kết quả với
// 'lifetime'; nếu giống hệt nghĩa là Meta đã bỏ qua tham số, và job bị đánh
// dấu failed kèm lời giải thích — thay vì lặng lẽ lưu số liệu trọn đời dưới
// nhãn "7 ngày", loại sai mà nhìn báo cáo không tài nào phát hiện được.
const TIME_RANGES = [
  { value: "lifetime", label: "Trọn đời", verified: true },
  { value: "last_7d", label: "7 ngày qua", verified: false },
  { value: "last_28d", label: "28 ngày qua", verified: false },
  { value: "last_90d", label: "90 ngày qua", verified: false },
  { value: "last_365d", label: "365 ngày qua", verified: false }
];

const TIME_RANGE_VALUES = new Set(TIME_RANGES.map((r) => r.value));

const STATUS_LABELS = {
  pending: "Đang chờ máy cào",
  running: "Đang cào",
  done: "Xong",
  failed: "Hỏng"
};

class CrawlJobError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.publicMessage = message;
  }
}

function requireSql() {
  if (!isEnabled()) {
    throw new CrawlJobError(
      "Chưa cấu hình DATABASE_URL nên không dùng được hàng đợi cào.",
      503
    );
  }
  return getSql();
}

// Đổi dòng DB sang hình dạng cho giao diện. Gom vào một chỗ để mọi endpoint
// trả về cùng một cấu trúc — giao diện chỉ phải hiểu một dạng dữ liệu.
function toPublic(row) {
  return {
    id: Number(row.id),
    assetId: row.asset_id,
    assetType: row.asset_type,
    assetName: row.asset_name || "",
    timeRange: row.time_range,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    requestedAt: row.requested_at ? new Date(row.requested_at).toISOString() : null,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    snapshotId: row.snapshot_id === null ? null : Number(row.snapshot_id),
    rowCount: row.row_count === null ? null : Number(row.row_count),
    error: row.error || null,
    worker: row.worker || null
  };
}

// Tạo một yêu cầu cào mới.
//
// CHỐNG BẤM NHIỀU LẦN: nếu trang này đã có yêu cầu cùng khoảng thời gian đang
// chờ hoặc đang chạy thì TRẢ LẠI chính yêu cầu đó, không tạo thêm. Không có
// đoạn này thì bấm nút ba lần sẽ xếp ba việc, và máy ở nhà mở Edge cào cùng
// một trang ba lượt liên tiếp.
async function createJob({ userId, assetId, assetType, assetName, timeRange }) {
  const sql = requireSql();

  const id = String(assetId || "").trim();
  if (!id) {
    throw new CrawlJobError("Thiếu ID trang cần cào.");
  }

  const range = String(timeRange || "lifetime");
  if (!TIME_RANGE_VALUES.has(range)) {
    throw new CrawlJobError(
      `Khoảng thời gian "${range}" không hợp lệ. ` +
        `Chọn một trong: ${[...TIME_RANGE_VALUES].join(", ")}.`
    );
  }

  // Chống bấm trùng THEO TỪNG TENANT: có AND user_id thì hai user cùng Page ID
  // không nhận lại job của nhau (tránh rò asset_name chéo). IS NOT DISTINCT FROM
  // xử lý cả trường hợp NULL = NULL (luồng vận hành cũ).
  const dangCho = await sql`
    SELECT * FROM crawl_jobs
    WHERE asset_id = ${id} AND time_range = ${range}
      AND status IN ('pending', 'running')
      AND user_id IS NOT DISTINCT FROM ${userId || null}
    ORDER BY requested_at DESC
    LIMIT 1
  `;

  if (dangCho.length > 0) {
    return { job: toPublic(dangCho[0]), daCoSan: true };
  }

  const [created] = await sql`
    INSERT INTO crawl_jobs (user_id, asset_id, asset_type, asset_name, time_range)
    VALUES (${userId || null}, ${id},
            ${assetType === "instagram" ? "instagram" : "page"},
            ${assetName || null}, ${range})
    RETURNING *
  `;

  return { job: toPublic(created), daCoSan: false };
}

// Lịch sử yêu cầu của một trang — giao diện hỏi liên tục cái này để cập nhật
// tiến trình sau khi bấm nút.
// Scope theo tenant: chỉ trả job của chính user (hoặc job legacy user_id IS NULL
// do người vận hành đặt). Không có `userId` (phiên cũ / một người vận hành) thì
// chỉ thấy job legacy — đúng hành vi đơn-người-dùng cũ, không lộ job người khác.
async function listJobs(assetId, limit = 10, userId = null) {
  if (!isEnabled()) return [];

  const sql = getSql();
  const rows = await sql`
    SELECT * FROM crawl_jobs
    WHERE asset_id = ${String(assetId)}
      AND (user_id = ${userId} OR user_id IS NULL)
    ORDER BY requested_at DESC
    LIMIT ${Math.max(1, Math.min(50, Number(limit) || 10))}
  `;
  return rows.map(toPublic);
}

async function getJob(jobId) {
  if (!isEnabled()) return null;

  const sql = getSql();
  const rows = await sql`SELECT * FROM crawl_jobs WHERE id = ${Number(jobId)}`;
  return rows.length > 0 ? toPublic(rows[0]) : null;
}

// --- Phía máy ở nhà --------------------------------------------------------

// Nhận việc kế tiếp. Trả null nếu hàng đợi rỗng.
//
// FOR UPDATE SKIP LOCKED là phần quan trọng nhất của câu lệnh này.
// Không có nó, hai tiến trình cùng đọc "việc số 5 đang chờ" rồi cùng nhận, và
// Edge bị mở hai lần cho cùng một trang. SKIP LOCKED khiến tiến trình thứ hai
// bỏ qua dòng đang bị khoá và lấy dòng kế tiếp, thay vì ngồi đợi.
//
// Toàn bộ nằm trong MỘT câu UPDATE: đọc rồi mới ghi ở hai câu riêng sẽ có khe
// hở giữa hai câu, và khe hở đó chính là chỗ hai máy chen vào nhau.
// Bộ lọc quyền sở hữu job theo token — dùng chung cho claim/finish/fail.
// - scopes='crawl' (token khách): CHỈ job của mình, KHÔNG chạm job admin (NULL).
// - có userId, không phải 'crawl' (admin/CLI có userId): job của mình HOẶC admin.
// - không userId (CLI cũ, máy-nhà): không lọc -> giữ nguyên hành vi cũ, không gãy.
function ownerFilter(sql, userId, scopes) {
  if (scopes === "crawl") {
    return sql`AND user_id = ${userId} AND user_id IS NOT NULL`;
  }
  if (userId !== null && userId !== undefined) {
    return sql`AND (user_id = ${userId} OR user_id IS NULL)`;
  }
  return sql``;
}

async function claimNextJob(workerName, { userId = null, scopes = null } = {}) {
  const sql = requireSql();

  const rows = await sql`
    UPDATE crawl_jobs
    SET status = 'running', started_at = now(), worker = ${String(workerName || "")}
    WHERE id = (
      SELECT id FROM crawl_jobs
      WHERE status = 'pending' ${ownerFilter(sql, userId, scopes)}
      ORDER BY requested_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;

  return rows.length > 0 ? toPublic(rows[0]) : null;
}

async function finishJob(jobId, { snapshotId, rowCount }, { userId = null, scopes = null } = {}) {
  const sql = requireSql();
  // Chống khách A đóng job của khách B (và chống token khách chạm job admin NULL).
  const [row] = await sql`
    UPDATE crawl_jobs
    SET status = 'done', finished_at = now(),
        snapshot_id = ${snapshotId || null}, row_count = ${rowCount || 0},
        error = NULL
    WHERE id = ${Number(jobId)} ${ownerFilter(sql, userId, scopes)}
    RETURNING *
  `;

  // Gán chủ sở hữu cho snapshot vừa tạo, suy từ user_id CỦA CHÍNH JOB NÀY — KHÔNG
  // tin worker (worker không cầm user_id). Nhờ vậy đường đọc scope được theo
  // tenant. Best-effort: hỏng thì backfillSnapshotOwners() lúc khởi động vá sau,
  // KHÔNG làm fail lệnh finish (snapshot đã lưu an toàn, worker cần biết là xong).
  if (row && snapshotId && row.user_id !== null && row.user_id !== undefined) {
    try {
      await sql`
        UPDATE crawled_audience_snapshots
        SET user_id = ${row.user_id}
        WHERE id = ${Number(snapshotId)} AND user_id IS NULL
      `;
    } catch (error) {
      console.warn("[Crawl] Không gán được chủ sở hữu snapshot:", error.message);
    }
  }

  return row ? toPublic(row) : null;
}

async function failJob(jobId, message, { userId = null, scopes = null } = {}) {
  const sql = requireSql();
  const [row] = await sql`
    UPDATE crawl_jobs
    SET status = 'failed', finished_at = now(), error = ${String(message || "")}
    WHERE id = ${Number(jobId)} ${ownerFilter(sql, userId, scopes)}
    RETURNING *
  `;
  return row ? toPublic(row) : null;
}

// Trả thông tin thô của job để router worker kiểm ràng buộc khi nhận snapshot
// (job thuộc đúng user + assetId khớp). KHÔNG đi qua toPublic vì cần user_id.
async function getJobForWorker(jobId) {
  if (!isEnabled()) return null;
  const sql = getSql();
  const rows = await sql`
    SELECT id, user_id, asset_id, asset_type, status
    FROM crawl_jobs WHERE id = ${Number(jobId)}
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    userId: r.user_id === null ? null : Number(r.user_id),
    assetId: r.asset_id,
    assetType: r.asset_type,
    status: r.status
  };
}

// Việc bị bỏ dở: máy tắt giữa chừng thì job kẹt ở 'running' mãi mãi, và cơ
// chế chống bấm nhiều lần sẽ chặn luôn mọi yêu cầu mới cho trang đó — bấm nút
// không thấy gì xảy ra, mà cũng không có thông báo lỗi nào.
// Gọi lúc máy ở nhà khởi động để dọn.
async function releaseStaleJobs(maxMinutes = 60) {
  if (!isEnabled()) return 0;

  const sql = getSql();
  const rows = await sql`
    UPDATE crawl_jobs
    SET status = 'failed', finished_at = now(),
        error = 'May cao tat giua chung hoac qua thoi gian cho phep.'
    WHERE status = 'running'
      AND started_at < now() - make_interval(mins => ${Number(maxMinutes)})
    RETURNING id
  `;
  return rows.length;
}

module.exports = {
  TIME_RANGES,
  CrawlJobError,
  createJob,
  listJobs,
  getJob,
  getJobForWorker,
  claimNextJob,
  finishJob,
  failJob,
  releaseStaleJobs
};
