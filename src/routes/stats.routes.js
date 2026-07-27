const express = require("express");

const analyticsService = require("../services/analytics.service");
const pageVisibilityService = require("../services/page-visibility.service");

const router = express.Router();

function createPublicError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = null;
  return error;
}

function findSessionPage(req) {
  const { pageId } = req.params;
  return pageVisibilityService
    .getVisiblePages(req.session.facebookUser.pages)
    .find((page) => page.id === pageId);
}

// Báo cáo thống kê đầy đủ (FB + IG) cho MỘT Page theo ID.
router.get("/stats/pages/:pageId", async (req, res, next) => {
  try {
    const page = findSessionPage(req);

    if (!page) {
      throw createPublicError(404, "Page ID không thuộc tài khoản đang đăng nhập.");
    }

    // Trần an toàn tùy chọn qua query (?maxItems=), mặc định 3000, tối đa 5000.
    const requestedMax = Number(req.query.maxItems);
    const maxItems = Number.isFinite(requestedMax)
      ? Math.min(5000, Math.max(100, Math.floor(requestedMax)))
      : 3000;

    const analytics = await analyticsService.buildPageAnalytics({
      page,
      userAccessToken: req.session.facebookUser.userAccessToken,
      maxItems
    });

    res.json({ success: true, analytics });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
