const express = require("express");

const { config } = require("../config");

// Tải "Công cụ cào" (.exe) cho khách ngoài. CÔNG KHAI — đặt trước requireAuth
// (trang hướng dẫn /cong-cu-cao.html không yêu cầu đăng nhập).
//
// File .exe KHÔNG nằm ở đây: nó host ở ngoài (GitHub Release, storage...) và
// web chỉ chuyển hướng tới đó. Lý do: binary vài chục MB không nên commit vào
// repo, và đĩa Render bị xoá mỗi lần deploy nên không giữ file được.
const router = express.Router();

// Giao diện hỏi trước để hiện NÚT TẢI thật hay trạng thái "sắp có" — tránh đặt
// một nút bấm vào là 503.
router.get("/download/status", (_req, res) => {
  res.json({
    success: true,
    available: Boolean(config.crawler.downloadUrl),
    version: config.crawler.version || null
  });
});

// Link tải ỔN ĐỊNH (không đổi khi ta đổi nơi host). Chưa cấu hình
// CRAWLER_DOWNLOAD_URL => 503 kèm thông báo tiếng Việt, KHÔNG 404 khó hiểu.
router.get("/download", (_req, res) => {
  const url = config.crawler.downloadUrl;
  if (!url) {
    return res.status(503).json({
      success: false,
      message: "Bản tải công cụ cào chưa sẵn sàng. Vui lòng quay lại sau."
    });
  }
  res.redirect(url);
});

module.exports = router;
