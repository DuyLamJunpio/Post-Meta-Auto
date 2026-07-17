const express = require("express");

const tiktokService = require("../services/tiktok.service");

const router = express.Router();

router.get("/tiktok/status", (req, res) => {
  res.json({
    success: true,
    tiktok: tiktokService.getStatus(req.session)
  });
});

router.post("/tiktok/disconnect", async (req, res, next) => {
  try {
    await tiktokService.disconnect(req.session);

    req.session.save((error) => {
      if (error) {
        return res.status(500).json({
          success: false,
          message: "Ngắt kết nối TikTok không thành công.",
          details: null
        });
      }

      res.json({
        success: true,
        message: "Đã ngắt kết nối TikTok."
      });
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
