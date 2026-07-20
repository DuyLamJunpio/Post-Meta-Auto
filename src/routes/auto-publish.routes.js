const express = require("express");

const publishGuardService = require("../services/publish-guard.service");
const publishAuditService = require("../services/publish-audit.service");
const facebookService = require("../services/facebook.service");
const notifier = require("../services/notifier");

// Điều khiển "phanh" vòng lặp tự đăng cho quản trị viên.
// Nằm dưới /api nên đã qua requireAuth (bắt buộc đăng nhập Facebook).
const router = express.Router();

router.get("/auto-publish/status", (req, res) => {
  res.json({
    success: true,
    status: publishGuardService.getStatus()
  });
});

// Dừng khẩn cấp vòng lặp tự đăng (pause runtime, không cần restart).
router.post("/auto-publish/pause", (req, res) => {
  const reason = req.body && typeof req.body.reason === "string" && req.body.reason.trim()
    ? req.body.reason.trim()
    : "Tạm dừng thủ công bởi quản trị viên.";

  const status = publishGuardService.pause(reason);

  res.json({
    success: true,
    message: "Đã tạm dừng tự đăng.",
    status
  });
});

// Bật lại vòng lặp tự đăng sau khi đã xử lý xong.
router.post("/auto-publish/resume", (req, res) => {
  const status = publishGuardService.resume();

  res.json({
    success: true,
    message: "Đã bật lại tự đăng.",
    status
  });
});

// Nhật ký đăng gần đây (truy vết nhanh khi có sự cố).
router.get("/auto-publish/audit", (req, res) => {
  const limit = Number(req.query.limit) || 50;

  res.json({
    success: true,
    audit: publishAuditService.listRecent(limit)
  });
});

// Thu hồi (xóa) nhanh một bài Facebook đã đăng. Body: { pageId, postId }.
router.post("/posts/facebook/retract", async (req, res, next) => {
  try {
    const pageId = req.body && req.body.pageId ? String(req.body.pageId) : "";
    const postId = req.body && req.body.postId ? String(req.body.postId) : "";

    if (!pageId || !postId) {
      return res.status(400).json({ success: false, message: "Cần cung cấp pageId và postId." });
    }

    const page = (req.session.facebookUser.pages || []).find((item) => item.id === pageId);

    if (!page) {
      return res.status(404).json({ success: false, message: "Tài khoản đang đăng nhập không quản lý Page này." });
    }

    const result = await facebookService.deletePagePost(postId, page.pageAccessToken);

    publishAuditService.record({
      event: "retracted",
      channel: "facebook",
      accountId: pageId,
      accountName: page.name,
      postId,
      message: "Thu hồi bài thủ công."
    });

    await notifier.notify({
      level: "important",
      title: "🗑️ Đã thu hồi bài",
      lines: [`Page: ${page.name}`, `Post ID: ${postId}`]
    });

    res.json({ success: true, message: "Đã thu hồi bài đăng.", result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
