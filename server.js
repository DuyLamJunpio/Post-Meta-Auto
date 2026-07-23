const express = require("express");
const session = require("express-session");
const path = require("path");

const { config } = require("./src/config");
const { initDatabase } = require("./src/db");
const { SqliteSessionStore } = require("./src/db/session-store");
const requireAuth = require("./src/middleware/requireAuth");
const authRoutes = require("./src/routes/auth.routes");
const userRoutes = require("./src/routes/user.routes");
const pageRoutes = require("./src/routes/page.routes");
const postRoutes = require("./src/routes/post.routes");
const notionRoutes = require("./src/routes/notion.routes");
const driveRoutes = require("./src/routes/drive.routes");
const instagramRoutes = require("./src/routes/instagram.routes");
const gbpRoutes = require("./src/routes/gbp.routes");
const tiktokRoutes = require("./src/routes/tiktok.routes");
const autoPublishRoutes = require("./src/routes/auto-publish.routes");
const leadRoutes = require("./src/routes/lead.routes");
const accountRoutes = require("./src/routes/account.routes");
const { initAccountSchema } = require("./src/db/postgres");
const mediaRoutes = require("./src/routes/media.routes");
const googleDriveService = require("./src/services/google-drive.service");
const instagramService = require("./src/services/instagram.service");
const gbpService = require("./src/services/gbp.service");
const tiktokService = require("./src/services/tiktok.service");
const mediaProxyService = require("./src/services/media-proxy.service");
const notionService = require("./src/services/notion.service");
const tenantRunner = require("./src/services/tenant-runner.service");
const pageVisibilityService = require("./src/services/page-visibility.service");
const notifier = require("./src/services/notifier");
const publishAuditService = require("./src/services/publish-audit.service");

const app = express();

initDatabase();

// Khởi tạo bảng tài khoản trên Postgres (Supabase) — không chặn app nếu chưa cấu hình DATABASE_URL.
initAccountSchema().catch((error) => {
  console.error("[Postgres] Khởi tạo bảng tài khoản thất bại:", error.message);
});

// Session lưu bền trong SQLite (khởi tạo sau initDatabase để bảng sessions đã có).
const sessionStore = new SqliteSessionStore();

// Deploy HTTPS sau proxy (Render...) khi PUBLIC_BASE_URL là https:
// - trust proxy để express nhận đúng giao thức từ X-Forwarded-Proto.
// - cookie secure để trình duyệt chỉ gửi cookie qua HTTPS.
const isSecureDeployment = /^https:/i.test(process.env.PUBLIC_BASE_URL || "");

if (isSecureDeployment) {
  app.set("trust proxy", 1);
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    store: sessionStore,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isSecureDeployment,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

// Proxy media tạm cho IG/GBP/TikTok fetch — public, KHÔNG qua requireAuth.
app.use("/media", mediaRoutes);

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "Server đang hoạt động."
  });
});

app.use("/auth", authRoutes);

// Hệ tài khoản người dùng: CÔNG KHAI -> đặt TRƯỚC requireAuth.
app.use("/account", accountRoutes);

// Thu lead khách hàng: CÔNG KHAI (khách không có tài khoản admin) -> đặt TRƯỚC requireAuth.
app.use("/lead", leadRoutes.publicRouter);

app.use("/api", requireAuth);
app.use("/api", leadRoutes.adminRouter);
app.use("/api", userRoutes);
app.use("/api", pageRoutes);
app.use("/api", postRoutes);
app.use("/api", driveRoutes);
app.use("/api", instagramRoutes);
app.use("/api", gbpRoutes);
app.use("/api", tiktokRoutes);
app.use("/api", autoPublishRoutes);
app.use("/api", notionRoutes);

let notionAutoPublishRunning = false;

function getStoredSessions() {
  return new Promise((resolve, reject) => {
    sessionStore.all((error, sessions) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(Array.isArray(sessions) ? sessions : Object.values(sessions || {}));
    });
  });
}

// Rút gọn caption để cảnh báo Telegram hiển thị rõ đó là bài nào.
function captionSnippet(caption) {
  const text = String(caption || "").trim().replace(/\s+/g, " ");
  if (!text) {
    return null;
  }
  return `Nội dung: ${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`;
}

// Ghi audit + gửi cảnh báo cho kết quả một tick tự đăng (không để lỗi cảnh báo làm hỏng vòng lặp).
// userId (Pha 4c): tenant sở hữu chu kỳ này — null cho luồng admin/.env.
async function handlePublishAlerts(result, reconcileResult, userId = null) {
  const recordAudit = (event) => publishAuditService.record({ ...event, userId });
  try {
    if (result.anomaly) {
      recordAudit({ event: "paused", message: result.anomalyReason });
      await notifier.notify({
        level: "important",
        title: "🛑 Tự đăng ĐÃ TẠM DỪNG (bất thường)",
        lines: [result.anomalyReason, "Hãy kiểm tra Notion rồi bật lại qua /api/auto-publish/resume."]
      });
    }

    for (const item of result.results || []) {
      if (item.success) {
        recordAudit({
          event: "published",
          notionTaskId: item.taskId,
          postId: item.postId,
          permalinkUrl: item.permalinkUrl,
          title: item.title
        });
        await notifier.notify({
          level: "info",
          title: "✅ Đã đăng bài",
          lines: [
            `Bài: ${item.title || "(không tên)"}`,
            captionSnippet(item.caption),
            item.permalinkUrl || (item.postId ? `Post ID: ${item.postId}` : null)
          ],
          linkPreview: Boolean(item.permalinkUrl)
        });
      } else if (item.posted) {
        recordAudit({
          event: "published",
          notionTaskId: item.taskId,
          postId: item.postId,
          permalinkUrl: item.permalinkUrl,
          title: item.title,
          message: "Đã đăng nhưng cập nhật Notion thất bại."
        });
        await notifier.notify({
          level: "important",
          title: "⚠️ Đã đăng nhưng KHÔNG cập nhật được Notion",
          lines: [
            `Bài: ${item.title || "(không tên)"}`,
            captionSnippet(item.caption),
            item.permalinkUrl || (item.postId ? `Post ID: ${item.postId}` : null),
            "Kiểm tra để tránh xử lý trùng."
          ],
          linkPreview: Boolean(item.permalinkUrl)
        });
      } else if (!item.skipped) {
        recordAudit({
          event: "failed",
          notionTaskId: item.taskId,
          title: item.title,
          message: item.message
        });
        await notifier.notify({
          level: "important",
          title: "❌ Đăng bài THẤT BẠI",
          lines: [
            `Bài: ${item.title || "(không tên)"}`,
            captionSnippet(item.caption),
            `Lý do: ${item.message || "Không rõ"}`
          ]
        });
      }
    }

    for (const item of (reconcileResult && reconcileResult.results) || []) {
      if (item.outcome === "failed") {
        recordAudit({
          event: "failed",
          notionTaskId: item.taskId,
          title: item.title,
          message: "Kẹt Đang đăng — chuyển Lỗi đăng để kiểm tra thủ công."
        });
        await notifier.notify({
          level: "important",
          title: "⚠️ Task kẹt 'Đang đăng' cần kiểm tra",
          lines: [`Bài: ${item.title || "(không tên)"}`, "Mở page kiểm tra bài đã lên chưa TRƯỚC KHI đăng lại (tránh trùng)."]
        });
      }
    }
  } catch (error) {
    console.warn("[Notion Auto Publish] Lỗi khi gửi cảnh báo:", error.message);
  }
}

// Một "chu kỳ đăng" cho MỘT context (1 session admin hoặc 1 tenant): hòa giải kẹt -> lên lịch -> đăng.
// options mang notionContext (tenant) hoặc bỏ trống (admin -> notion.service dùng .env mặc định),
// kèm driveAuth/instagramAuth/gbpAuth/tiktokAuth nếu có.
async function runPublishCycle(pages, options, label) {
  // userId (Pha 4c): tenant sở hữu chu kỳ — lấy từ notionContext; null cho luồng admin/.env.
  const userId = (options.notionContext && options.notionContext.userId) || null;

  // Lớp 3: hòa giải task kẹt ở "Đang đăng" trước khi lên lịch/đăng (chống kẹt & đăng trùng).
  const reconcileResult = await notionService.reconcileStuckPublishingTasks(pages, options);

  if (reconcileResult.stuckCount > 0) {
    console.warn("[Notion Auto Publish] Hòa giải task kẹt:", {
      context: label,
      stuckCount: reconcileResult.stuckCount,
      reconciledPublished: reconcileResult.reconciledPublished,
      reconciledFailed: reconcileResult.reconciledFailed
    });
  }

  const scheduleResult = await notionService.scheduleReadyTasks(pages, options);
  const result = await notionService.publishDueTasks(pages, options);

  if (result.anomaly) {
    console.error("[Notion Auto Publish] ĐÃ TỰ PAUSE vì bất thường:", result.anomalyReason);
  } else if (result.paused) {
    console.warn("[Notion Auto Publish] Đang tạm dừng (kill switch/pause) — bỏ qua đăng.");
  }

  await handlePublishAlerts(result, reconcileResult, userId);

  if (
    scheduleResult.attemptedCount > 0 ||
    scheduleResult.failureCount > 0 ||
    result.attemptedCount > 0 ||
    result.failureCount > 0 ||
    result.paused
  ) {
    console.log("[Notion Auto Publish]", {
      context: label,
      scheduledCount: scheduleResult.successCount,
      attemptedCount: result.attemptedCount,
      successCount: result.successCount,
      failureCount: result.failureCount,
      publishedCount: result.publishedCount || 0,
      paused: Boolean(result.paused)
    });
  }
}

// Loop CŨ (admin/single-tenant): duyệt session, dùng Notion .env chung.
// Chốt chặn: session của user ĐÃ kết nối Notion riêng thì bỏ qua (loop per-user xử lý -> chống đăng trùng).
async function runSessionAutoPublish() {
  const sessions = await getStoredSessions();
  const notionUserIds = new Set(await tenantRunner.listNotionConnectedUserIds());
  const facebookSessions = sessions.filter(
    (storedSession) =>
      storedSession.facebookUser &&
      Array.isArray(storedSession.facebookUser.pages) &&
      storedSession.facebookUser.pages.length > 0
  );

  for (const storedSession of facebookSessions) {
    if (storedSession.userId && notionUserIds.has(String(storedSession.userId))) {
      continue;
    }

    const visiblePages = pageVisibilityService.getVisiblePages(storedSession.facebookUser.pages);
    if (visiblePages.length === 0) {
      continue;
    }

    const options = {
      driveAuth: googleDriveService.getSessionAuth(storedSession),
      instagramAuth: instagramService.getSessionAuth(storedSession),
      gbpAuth: gbpService.getSessionAuth(storedSession),
      tiktokAuth: tiktokService.getSessionAuth(storedSession)
    };

    try {
      await runPublishCycle(storedSession.facebookUser.pages, options, "session");
    } catch (error) {
      console.error("[Notion Auto Publish] Lỗi chu kỳ session:", error.publicMessage || error.message);
    }
  }
}

// Loop MỚI (per-user): mỗi tenant đăng bằng Notion + Facebook riêng. MVP chỉ FB + Notion
// (KHÔNG truyền driveAuth/ig/gbp/tiktok — token per-user của các kênh này chưa lưu Postgres).
async function runTenantAutoPublish() {
  const tenants = await tenantRunner.listPublishableTenants();

  for (const tenant of tenants) {
    try {
      await runPublishCycle(tenant.pages, { notionContext: tenant.notionContext }, `tenant:${tenant.userId}`);
    } catch (error) {
      console.error(`[Notion Auto Publish] Lỗi chu kỳ tenant ${tenant.userId}:`, error.publicMessage || error.message);
    }
  }
}

async function runNotionAutoPublish() {
  if (notionAutoPublishRunning) {
    return;
  }

  notionAutoPublishRunning = true;

  try {
    await runSessionAutoPublish();
    await runTenantAutoPublish();
  } catch (error) {
    console.error("[Notion Auto Publish]", error.publicMessage || error.message);
  } finally {
    notionAutoPublishRunning = false;
  }
}

if (config.notion.autoPublishIntervalMs > 0) {
  const autoPublishTimer = setInterval(runNotionAutoPublish, config.notion.autoPublishIntervalMs);
  autoPublishTimer.unref();
}

if (mediaProxyService.isEnabled()) {
  const mediaSweepTimer = setInterval(() => mediaProxyService.sweep(), config.mediaProxy.ttlMs);
  mediaSweepTimer.unref();
}

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Không tìm thấy endpoint.",
    details: null
  });
});

app.use((error, req, res, next) => {
  const status = error.status || 500;
  const message = error.publicMessage || error.message || "Có lỗi xảy ra.";

  if (status >= 500) {
    console.error("[Server Error]", message);
  }

  res.status(status).json({
    success: false,
    message,
    details: error.details || null
  });
});

app.listen(config.port, () => {
  console.log(`Server đang chạy tại http://localhost:${config.port}`);
});
