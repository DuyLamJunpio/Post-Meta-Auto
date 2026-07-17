const express = require("express");

const gbpService = require("../services/gbp.service");

const router = express.Router();

router.get("/gbp/status", (req, res) => {
  res.json({
    success: true,
    gbp: gbpService.getStatus(req.session)
  });
});

// Liệt kê location để lấy Google Business Profile ID điền vào Brands.
router.get("/gbp/locations", async (req, res, next) => {
  try {
    const auth = gbpService.getSessionAuth(req.session);

    if (!gbpService.isConnected(auth)) {
      return res.status(400).json({
        success: false,
        message: "Chưa kết nối Google Business Profile. Hãy kết nối trước khi lấy danh sách địa điểm.",
        details: null
      });
    }

    const locations = await gbpService.listLocations(auth);

    res.json({ success: true, locations });
  } catch (error) {
    next(error);
  }
});

router.post("/gbp/disconnect", async (req, res, next) => {
  try {
    await gbpService.disconnect(req.session);

    req.session.save((error) => {
      if (error) {
        return res.status(500).json({
          success: false,
          message: "Ngắt kết nối Google Business Profile không thành công.",
          details: null
        });
      }

      res.json({
        success: true,
        message: "Đã ngắt kết nối Google Business Profile."
      });
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
