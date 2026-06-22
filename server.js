const express = require("express");
const session = require("express-session");
const path = require("path");

const { config } = require("./src/config");
const requireAuth = require("./src/middleware/requireAuth");
const authRoutes = require("./src/routes/auth.routes");
const userRoutes = require("./src/routes/user.routes");
const pageRoutes = require("./src/routes/page.routes");
const postRoutes = require("./src/routes/post.routes");
const notionRoutes = require("./src/routes/notion.routes");
const driveRoutes = require("./src/routes/drive.routes");
const instagramRoutes = require("./src/routes/instagram.routes");
const googleDriveService = require("./src/services/google-drive.service");
const notionService = require("./src/services/notion.service");
const pageVisibilityService = require("./src/services/page-visibility.service");

const app = express();
const sessionStore = new session.MemoryStore();

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
      secure: false,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

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
      const visiblePages = pageVisibilityService.getVisiblePages(storedSession.facebookUser.pages);

      if (visiblePages.length === 0) {
        continue;
      }

      const scheduleResult = await notionService.scheduleReadyTasks(storedSession.facebookUser.pages, {
        driveAuth
      });
      const result = await notionService.publishDueTasks(storedSession.facebookUser.pages, {
        driveAuth
      });

      if (
        scheduleResult.attemptedCount > 0 ||
        scheduleResult.failureCount > 0 ||
        result.attemptedCount > 0 ||
        result.failureCount > 0
      ) {
        console.log("[Notion Auto Publish]", {
          scheduledCount: scheduleResult.successCount,
          attemptedCount: result.attemptedCount,
          successCount: result.successCount,
          failureCount: result.failureCount
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
