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
const mediaRoutes = require("./src/routes/media.routes");
const googleDriveService = require("./src/services/google-drive.service");
const instagramService = require("./src/services/instagram.service");
const gbpService = require("./src/services/gbp.service");
const tiktokService = require("./src/services/tiktok.service");
const mediaProxyService = require("./src/services/media-proxy.service");
const notionService = require("./src/services/notion.service");
const pageVisibilityService = require("./src/services/page-visibility.service");
const notifier = require("./src/services/notifier");
const publishAuditService = require("./src/services/publish-audit.service");

const app = express();

initDatabase();

// Session lưu bền trong SQLite (khởi tạo sau initDatabase để bảng sessions đã có).
const sessionStore = new SqliteSessionStore();

// Deploy HTTPS sau proxy (Render...) khi PUBLIC_BASE_URL là https:
// - trust proxy để express nhận đúng giao thức từ X-Forwarded-Proto.
// - cookie secure để trình duyệt chỉ gửi cookie qua HTTPS.
const isSecureDeployment = /^https:/i.test(process.env.PUBLIC_BASE_URL || "");

if (isSecureDeployment) {
  app.set("trust proxy", 1);
}

app.use(express.json());
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
app.use("/api", requireAuth);
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

// Ghi audit + gửi cảnh báo cho kết quả một tick tự đăng (không để lỗi cảnh báo làm hỏng vòng lặp).
async function handlePublishAlerts(result, reconcileResult) {
  try {
    if (result.anomaly) {
      publishAuditService.record({ event: "paused", message: result.anomalyReason });
      await notifier.notify({
        level: "important",
        title: "🛑 Tự đăng ĐÃ TẠM DỪNG (bất thường)",
        lines: [result.anomalyReason, "Hãy kiểm tra Notion rồi bật lại qua /api/auto-publish/resume."]
      });
    }

    for (const item of result.results || []) {
      if (item.success) {
        publishAuditService.record({
          event: "published",
          notionTaskId: item.taskId,
          postId: item.postId,
          permalinkUrl: item.permalinkUrl,
          title: item.title
        });
        await notifier.notify({
          level: "info",
          title: "✅ Đã đăng bài",
          lines: [`Bài: ${item.title || "(không tên)"}`, item.permalinkUrl || `Post ID: ${item.postId || "?"}`]
        });
      } else if (item.posted) {
        publishAuditService.record({
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
          lines: [`Bài: ${item.title || "(không tên)"}`, item.permalinkUrl || `Post ID: ${item.postId || "?"}`, "Kiểm tra để tránh xử lý trùng."]
        });
      } else if (!item.skipped) {
        publishAuditService.record({
          event: "failed",
          notionTaskId: item.taskId,
          title: item.title,
          message: item.message
        });
        await notifier.notify({
          level: "important",
          title: "❌ Đăng bài THẤT BẠI",
          lines: [`Bài: ${item.title || "(không tên)"}`, `Lý do: ${item.message || "Không rõ"}`]
        });
      }
    }

    for (const item of (reconcileResult && reconcileResult.results) || []) {
      if (item.outcome === "failed") {
        publishAuditService.record({
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

async function runNotionAutoPublish() {
  if (notionAutoPublishRunning) {
    return;
  }

  notionAutoPublishRunning = true;

  try {
    const sessions = await getStoredSessions();
    const facebookSessions = sessions.filter(
      (storedSession) =>
        storedSession.facebookUser &&
        Array.isArray(storedSession.facebookUser.pages) &&
        storedSession.facebookUser.pages.length > 0
    );

    for (const storedSession of facebookSessions) {
      const driveAuth = googleDriveService.getSessionAuth(storedSession);
      const instagramAuth = instagramService.getSessionAuth(storedSession);
      const gbpAuth = gbpService.getSessionAuth(storedSession);
      const tiktokAuth = tiktokService.getSessionAuth(storedSession);
      const visiblePages = pageVisibilityService.getVisiblePages(storedSession.facebookUser.pages);

      if (visiblePages.length === 0) {
        continue;
      }

      // Lớp 3: hòa giải task kẹt ở "Đang đăng" trước khi lên lịch/đăng (chống kẹt & đăng trùng).
      const reconcileResult = await notionService.reconcileStuckPublishingTasks(storedSession.facebookUser.pages, {
        driveAuth,
        instagramAuth,
        gbpAuth,
        tiktokAuth
      });

      if (reconcileResult.stuckCount > 0) {
        console.warn("[Notion Auto Publish] Hòa giải task kẹt:", {
          stuckCount: reconcileResult.stuckCount,
          reconciledPublished: reconcileResult.reconciledPublished,
          reconciledFailed: reconcileResult.reconciledFailed
        });
      }

      const scheduleResult = await notionService.scheduleReadyTasks(storedSession.facebookUser.pages, {
        driveAuth,
        instagramAuth,
        gbpAuth,
        tiktokAuth
      });
      const result = await notionService.publishDueTasks(storedSession.facebookUser.pages, {
        driveAuth,
        instagramAuth,
        gbpAuth,
        tiktokAuth
      });

      if (result.anomaly) {
        console.error("[Notion Auto Publish] ĐÃ TỰ PAUSE vì bất thường:", result.anomalyReason);
      } else if (result.paused) {
        console.warn("[Notion Auto Publish] Đang tạm dừng (kill switch/pause) — bỏ qua đăng.");
      }

      await handlePublishAlerts(result, reconcileResult);

      if (
        scheduleResult.attemptedCount > 0 ||
        scheduleResult.failureCount > 0 ||
        result.attemptedCount > 0 ||
        result.failureCount > 0 ||
        result.paused
      ) {
        console.log("[Notion Auto Publish]", {
          scheduledCount: scheduleResult.successCount,
          attemptedCount: result.attemptedCount,
          successCount: result.successCount,
          failureCount: result.failureCount,
          publishedCount: result.publishedCount || 0,
          paused: Boolean(result.paused)
        });
      }
    }
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
