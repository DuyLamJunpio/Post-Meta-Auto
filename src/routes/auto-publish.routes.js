const express = require("express");

const publishGuardService = require("../services/publish-guard.service");

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

module.exports = router;
