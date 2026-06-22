const express = require("express");

const googleDriveService = require("../services/google-drive.service");

const router = express.Router();

router.get("/drive/status", (req, res) => {
  res.json({
    success: true,
    drive: googleDriveService.getStatus(req.session)
  });
});

router.get("/drive/media-preview", async (req, res, next) => {
  try {
    const url = typeof req.query.url === "string" ? req.query.url : "";

    if (!url || !googleDriveService.isGoogleDriveFileUrl(url)) {
      const error = new Error("Link preview phải là link file Google Drive hợp lệ.");
      error.status = 400;
      error.publicMessage = error.message;
      error.details = null;
      throw error;
    }

    const media = await googleDriveService.downloadMediaFromUrl(url, googleDriveService.getSessionAuth(req.session));

    res.setHeader("Content-Type", media.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(media.buffer.length));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(media.buffer);
  } catch (error) {
    next(error);
  }
});

router.post("/drive/disconnect", async (req, res, next) => {
  try {
    await googleDriveService.disconnect(req.session);

    req.session.save((error) => {
      if (error) {
        return next(error);
      }

      res.json({
        success: true,
        message: "Đã ngắt kết nối Google Drive."
      });
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
