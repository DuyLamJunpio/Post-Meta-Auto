const express = require("express");

const instagramService = require("../services/instagram.service");

const router = express.Router();

router.get("/instagram/status", (req, res) => {
  res.json({
    success: true,
    instagram: instagramService.getStatus(req.session)
  });
});

router.post("/instagram/disconnect", (req, res) => {
  instagramService.clearTokens(req.session);

  req.session.save((error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "Ngắt kết nối Instagram không thành công.",
        details: null
      });
    }

    res.json({
      success: true,
      message: "Đã ngắt kết nối Instagram."
    });
  });
});

module.exports = router;
