const express = require("express");

const notionService = require("../services/notion.service");
const googleDriveService = require("../services/google-drive.service");

const router = express.Router();

router.get("/notion/tasks", async (req, res, next) => {
  try {
    const data = await notionService.listTasksForSession(req.session.facebookUser.pages, {
      pageId: req.query.pageId,
      driveAuth: googleDriveService.getSessionAuth(req.session)
    });

    res.json({
      success: true,
      ...data
    });
  } catch (error) {
    next(error);
  }
});

router.post("/notion/publish-due", async (req, res, next) => {
  try {
    const driveAuth = googleDriveService.getSessionAuth(req.session);
    const scheduleResult = await notionService.scheduleReadyTasks(req.session.facebookUser.pages, {
      driveAuth
    });
    const result = await notionService.publishDueTasks(req.session.facebookUser.pages, {
      driveAuth
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
    const scheduleResult = await notionService.scheduleReadyTasks(req.session.facebookUser.pages, {
      driveAuth,
      onlyOverdue: true
    });
    const result = await notionService.publishOverdueTasks(req.session.facebookUser.pages, {
      driveAuth
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
      driveAuth: googleDriveService.getSessionAuth(req.session)
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
      driveAuth: googleDriveService.getSessionAuth(req.session)
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
