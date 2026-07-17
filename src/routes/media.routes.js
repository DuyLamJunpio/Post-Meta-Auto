const express = require("express");

const mediaProxyService = require("../services/media-proxy.service");

const router = express.Router();

// Phục vụ file media tạm cho các nền tảng PULL (IG/GBP/TikTok) fetch về đăng.
// KHÔNG nằm sau requireAuth vì máy chủ của Instagram/Google/TikTok gọi ẩn danh.
router.get("/:filename", (req, res) => {
  const filePath = mediaProxyService.getFilePath(req.params.filename);

  if (!filePath) {
    return res.status(404).json({
      success: false,
      message: "Không tìm thấy media.",
      details: null
    });
  }

  res.setHeader("Content-Type", mediaProxyService.contentTypeFor(req.params.filename));
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(filePath);
});

module.exports = router;
