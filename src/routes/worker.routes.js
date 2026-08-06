// API cho "app cào" tải về (chạy trên máy khách). Gác bằng TOKEN (không cookie).
//
// Máy khách KHÔNG cầm DATABASE_URL — nó gọi các endpoint dưới đây kèm
// 'Authorization: Bearer <token>'; server (giữ secret) mới chạm Supabase.
//
// Hợp đồng envelope: { success, data } khi OK, { success:false, error } khi lỗi.
// error-handler riêng ở cuối file chuẩn hoá field 'error' (ApiClient Python đọc).

const express = require("express");

const { enforceHttps, requireWorkerToken } = require("../middleware/requireWorkerToken");
const crawlJobsService = require("../services/crawl-jobs.service");
const workerTokenService = require("../services/worker-token.service");
const audienceImport = require("../services/audience-import.service");
const userFacebookService = require("../services/user-facebook.service");
const pageVisibilityService = require("../services/page-visibility.service");

const router = express.Router();

// Trần số dòng mỗi snapshot: cào thật ~32 dòng (3 chiều). Trần rộng để không
// chặn nhầm, mà vẫn nằm gọn dưới giới hạn body mặc định.
const MAX_ROWS_PER_SNAPSHOT = 1000;

// --- Rate-limit đơn giản theo tokenId (in-memory, 1 instance) -----------------
// Render Free = 1 instance nên đủ. Nếu scale ngang cần đếm dựa DB (Bước 0.2).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 240;
const rateBuckets = new Map();

function rateLimit(req, res, next) {
  const key = req.workerTokenId;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX_PER_WINDOW) {
    return res.status(429).json({ success: false, error: "Quá nhiều yêu cầu, thử lại sau ít phút." });
  }
  next();
}

// Trải Page (+ IG Business kèm theo) thành danh sách asset. Mirror export-assets.js.
// CHỈ trả trường an toàn — TUYỆT ĐỐI không userAccessToken/pageAccessToken.
function toAssets(pages) {
  const assets = [];
  for (const page of pages || []) {
    if (!page || !page.id) continue;
    assets.push({ assetId: String(page.id), name: page.name || "", type: "page" });
    const ig = page.instagramBusinessAccount;
    if (ig && ig.id) {
      assets.push({ assetId: String(ig.id), name: ig.username || "", type: "instagram", parentPageId: String(page.id) });
    }
  }
  return assets;
}

// Token khách (scopes='crawl') chỉ được chạm job CỦA MÌNH; token admin được chạm
// job của mình hoặc job vô chủ (user_id NULL).
function workerOwnsJob(job, req) {
  if (!job) return false;
  if (req.workerScopes === "crawl") {
    return job.userId !== null && job.userId === req.workerUserId;
  }
  return job.userId === null || job.userId === req.workerUserId;
}

// Mọi route worker: ép HTTPS -> xác thực token -> rate-limit.
router.use(enforceHttps);
router.use(requireWorkerToken);
router.use(rateLimit);

// Nhận việc kế tiếp (giữ nguyên UPDATE atomic FOR UPDATE SKIP LOCKED trong service).
router.post("/v1/jobs/claim", async (req, res, next) => {
  try {
    const worker = req.body && req.body.worker ? String(req.body.worker) : "unknown";
    const appVersion = req.body && req.body.appVersion ? String(req.body.appVersion) : null;

    const job = await crawlJobsService.claimNextJob(worker, {
      userId: req.workerUserId,
      scopes: req.workerScopes
    });

    // Ghi nhịp tim (không để lỗi heartbeat làm hỏng claim).
    workerTokenService
      .recordHeartbeat({ userId: req.workerUserId, tokenId: req.workerTokenId, hostname: worker, appVersion })
      .catch((error) => console.warn("[Worker API] heartbeat lỗi:", error.message));

    res.json({ success: true, data: { job } });
  } catch (error) {
    next(error);
  }
});

// Báo xong một việc.
router.post("/v1/jobs/:id/finish", async (req, res, next) => {
  try {
    const job = await crawlJobsService.finishJob(
      req.params.id,
      { snapshotId: req.body && req.body.snapshotId, rowCount: req.body && req.body.rowCount },
      { userId: req.workerUserId, scopes: req.workerScopes }
    );
    if (!job) {
      return res.status(403).json({ success: false, error: "Không có quyền với việc này hoặc việc không tồn tại." });
    }
    res.json({ success: true, data: { job } });
  } catch (error) {
    next(error);
  }
});

// Báo hỏng một việc.
router.post("/v1/jobs/:id/fail", async (req, res, next) => {
  try {
    const message = req.body && req.body.message ? String(req.body.message).slice(0, 500) : "Không rõ nguyên nhân.";
    const job = await crawlJobsService.failJob(req.params.id, message, {
      userId: req.workerUserId,
      scopes: req.workerScopes
    });
    if (!job) {
      return res.status(403).json({ success: false, error: "Không có quyền với việc này hoặc việc không tồn tại." });
    }
    res.json({ success: true, data: { job } });
  } catch (error) {
    next(error);
  }
});

// Nhịp tim: app báo còn sống + lỗi trước-claim (Edge thiếu, hết phiên FB...).
router.post("/v1/heartbeat", async (req, res, next) => {
  try {
    const { connectedLabel } = await workerTokenService.recordHeartbeat({
      userId: req.workerUserId,
      tokenId: req.workerTokenId,
      hostname: req.body && req.body.hostname,
      appVersion: req.body && req.body.appVersion,
      lastError: req.body && req.body.lastError
    });
    res.json({ success: true, data: { ok: true, connectedLabel } });
  } catch (error) {
    next(error);
  }
});

// Danh sách tài sản (Page/IG) của chính user gắn token. userId TỪ TOKEN, không
// tin client. Giải mã token FB server-side; chỉ trả id/tên/loại.
router.get("/v1/assets", async (req, res, next) => {
  try {
    const connection = await userFacebookService.getConnection(req.workerUserId);
    const pages = connection ? pageVisibilityService.getVisiblePages(connection.pages) : [];
    res.json({ success: true, data: { assets: toAssets(pages) } });
  } catch (error) {
    next(error);
  }
});

// Nhận một snapshot nhân khẩu học đã cào. BẮT BUỘC kèm jobId: verify job thuộc
// đúng user VÀ assetId khớp job (chống ghi số liệu cho asset không thuộc việc).
router.post("/v1/snapshots", async (req, res, next) => {
  try {
    const body = req.body || {};
    const jobId = Number(body.jobId);
    if (!jobId) {
      return res.status(400).json({ success: false, error: "Thiếu jobId cho snapshot." });
    }

    const job = await crawlJobsService.getJobForWorker(jobId);
    if (!workerOwnsJob(job, req)) {
      return res.status(403).json({ success: false, error: "Không có quyền ghi snapshot cho việc này." });
    }

    const assetId = String(body.assetId || "").trim();
    if (assetId !== job.assetId) {
      return res.status(400).json({ success: false, error: "assetId của snapshot không khớp việc đã nhận." });
    }

    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (rows.length > MAX_ROWS_PER_SNAPSHOT) {
      return res.status(400).json({ success: false, error: `Quá ${MAX_ROWS_PER_SNAPSHOT} dòng cho một snapshot.` });
    }

    const snapshot = audienceImport.buildSnapshot(body);
    const { getSql } = require("../db/postgres");
    // Chủ sở hữu snapshot = chủ của job (có thể NULL cho job admin = legacy dùng chung).
    const result = await audienceImport.saveSnapshot(getSql(), snapshot, { userId: job.userId });

    res.json({ success: true, data: { snapshotId: result.snapshotId, rowCount: result.rowCount } });
  } catch (error) {
    next(error);
  }
});

// Error-handler RIÊNG cho router worker: chuẩn hoá field 'error' (khác central
// handler dùng 'message'). ApiClient Python đọc data.error.
router.use((error, req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) {
    console.error("[Worker API]", error.message);
  }
  res.status(status).json({
    success: false,
    error: error.publicMessage || error.message || "Có lỗi xảy ra."
  });
});

module.exports = router;
