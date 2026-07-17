const express = require("express");

const notionService = require("../services/notion.service");
const googleDriveService = require("../services/google-drive.service");
const instagramService = require("../services/instagram.service");
const gbpService = require("../services/gbp.service");
const tiktokService = require("../services/tiktok.service");

const router = express.Router();

router.get("/notion/tasks", async (req, res, next) => {
  try {
    const data = await notionService.listTasksForSession(req.session.facebookUser.pages, {
      pageId: req.query.pageId,
      driveAuth: googleDriveService.getSessionAuth(req.session),
      instagramAuth: instagramService.getSessionAuth(req.session),
      gbpAuth: gbpService.getSessionAuth(req.session),
      tiktokAuth: tiktokService.getSessionAuth(req.session)
    });

    res.json({
      success: true,
      ...data
    });
  } catch (error) {
    next(error);
  }
});

router.post("/notion/sync-instagram-ids", async (req, res, next) => {
  try {
    const result = await notionService.syncInstagramAccountIds(req.session.facebookUser.pages);

    res.json({
      success: true,
      message: `Đã cập nhật Instagram Account ID cho ${result.updatedCount} brand.`,
      ...result
    });
  } catch (error) {
    next(error);
  }
});

router.post("/notion/publish-due", async (req, res, next) => {
  try {
    const driveAuth = googleDriveService.getSessionAuth(req.session);
    const instagramAuth = instagramService.getSessionAuth(req.session);
    const gbpAuth = gbpService.getSessionAuth(req.session);
    const tiktokAuth = tiktokService.getSessionAuth(req.session);
    const scheduleResult = await notionService.scheduleReadyTasks(req.session.facebookUser.pages, {
      driveAuth,
      instagramAuth,
      gbpAuth,
      tiktokAuth
    });
    const result = await notionService.publishDueTasks(req.session.facebookUser.pages, {
      driveAuth,
      instagramAuth,
      gbpAuth,
      tiktokAuth
    });

    res.json({
      success: true,
      message: `Đã đưa ${scheduleResult.successCount} tác vụ vào lịch và xử lý ${result.attemptedCount} tác vụ đến hạn.`,
      schedule: scheduleResult,
      ...result
    });
  } catch (error) {
    next(error);
  }
});

router.post("/notion/publish-overdue", async (req, res, next) => {
  try {
    const driveAuth = googleDriveService.getSessionAuth(req.session);
    const instagramAuth = instagramService.getSessionAuth(req.session);
    const gbpAuth = gbpService.getSessionAuth(req.session);
    const tiktokAuth = tiktokService.getSessionAuth(req.session);
    const scheduleResult = await notionService.scheduleReadyTasks(req.session.facebookUser.pages, {
      driveAuth,
      instagramAuth,
      gbpAuth,
      tiktokAuth,
      onlyOverdue: true
    });
    const result = await notionService.publishOverdueTasks(req.session.facebookUser.pages, {
      driveAuth,
      instagramAuth,
      gbpAuth,
      tiktokAuth
    });

    res.json({
      success: true,
      message: `Đã đưa ${scheduleResult.successCount} tác vụ quá hạn vào lịch và xử lý ${result.attemptedCount} tác vụ quá hạn dưới 24 giờ.`,
      schedule: scheduleResult,
      ...result
    });
  } catch (error) {
    next(error);
  }
});

router.post("/notion/retry-failed", async (req, res, next) => {
  try {
    const result = await notionService.prepareFailedTasksForRetry(req.session.facebookUser.pages, {
      pageId: req.query.pageId,
      driveAuth: googleDriveService.getSessionAuth(req.session),
      instagramAuth: instagramService.getSessionAuth(req.session),
      gbpAuth: gbpService.getSessionAuth(req.session),
      tiktokAuth: tiktokService.getSessionAuth(req.session)
    });

    res.json({
      success: true,
      message: `Đã chuẩn bị ${result.successCount} task lỗi để đăng lại, bỏ qua ${result.skippedCount} task chưa đủ điều kiện.`,
      ...result
    });
  } catch (error) {
    next(error);
  }
});

router.post("/notion/tasks/:taskId/publish", async (req, res, next) => {
  try {
    const result = await notionService.publishSingleTask(req.params.taskId, req.session.facebookUser.pages, {
      driveAuth: googleDriveService.getSessionAuth(req.session),
      instagramAuth: instagramService.getSessionAuth(req.session),
      gbpAuth: gbpService.getSessionAuth(req.session),
      tiktokAuth: tiktokService.getSessionAuth(req.session)
    });

    res.json({
      success: result.success,
      message: result.scheduled ? "Tác vụ Notion đã được đưa vào lịch." : result.success ? "Đăng tác vụ Notion thành công." : result.message,
      result
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
