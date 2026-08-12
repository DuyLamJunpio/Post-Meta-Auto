// Routes báo cáo quảng cáo (Ads Insights). Gắn dưới /api (đã qua requireAuth).
// User access token lấy TỪ PHIÊN (req.session.facebookUser.userAccessToken) — Ads
// Insights bắt buộc USER token có scope ads_read, KHÔNG dùng page token.

const express = require("express");

const facebookService = require("../services/facebook.service");
const adsInsightsService = require("../services/ads-insights.service");
const adsPagesService = require("../services/ads-pages.service");
const pageVisibilityService = require("../services/page-visibility.service");

const router = express.Router();

function createPublicError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = null;
  return error;
}

// Token quảng cáo = USER token của phiên Facebook. Thiếu -> null (route trả 400).
function getUserAccessToken(req) {
  return (
    (req.session && req.session.facebookUser && req.session.facebookUser.userAccessToken) || null
  );
}

// Whitelist date_preset — chặn giá trị lạ, mặc định last_30d. Đây là NƠI DUY NHẤT
// khai danh sách hợp lệ để backend không nhận một preset mà Graph từ chối.
const VALID_DATE_PRESETS = new Set([
  "today",
  "yesterday",
  "last_7d",
  "last_14d",
  "last_28d",
  "last_30d",
  "last_90d",
  "this_month",
  "last_month",
  "maximum"
]);

// GET /api/ads/pages-tree — cây "trục Page": mỗi Page user quản lý -> các chiến dịch
// (kèm trạng thái) quảng bá Page đó, quét MỌI tài khoản QC. Kết quả/nhân khẩu học của
// từng chiến dịch tải riêng qua /insights & /demographics khi mở.
router.get("/ads/pages-tree", async (req, res, next) => {
  try {
    const userAccessToken = getUserAccessToken(req);
    if (!userAccessToken) {
      throw createPublicError(400, "Chưa đăng nhập Facebook hoặc thiếu quyền quảng cáo.");
    }

    const sessionPages = (req.session.facebookUser && req.session.facebookUser.pages) || [];
    const pages = pageVisibilityService
      .getVisiblePages(sessionPages)
      .map((page) => ({ id: page.id, name: page.name }));

    const tree = await adsPagesService.buildPagesCampaignTree({ userAccessToken, pages });
    res.json({ success: true, tree });
  } catch (error) {
    next(error);
  }
});

// GET /api/ads/accounts — tài khoản quảng cáo user truy cập được.
router.get("/ads/accounts", async (req, res, next) => {
  try {
    const userAccessToken = getUserAccessToken(req);
    if (!userAccessToken) {
      throw createPublicError(400, "Chưa đăng nhập Facebook hoặc thiếu quyền quảng cáo.");
    }

    const accounts = await facebookService.getAdAccounts(userAccessToken);
    res.json({ success: true, accounts });
  } catch (error) {
    next(error);
  }
});

// GET /api/ads/accounts/:adAccountId/campaigns — chiến dịch của một tài khoản QC.
router.get("/ads/accounts/:adAccountId/campaigns", async (req, res, next) => {
  try {
    const userAccessToken = getUserAccessToken(req);
    if (!userAccessToken) {
      throw createPublicError(400, "Chưa đăng nhập Facebook hoặc thiếu quyền quảng cáo.");
    }

    const campaigns = await facebookService.getCampaigns(req.params.adAccountId, userAccessToken);
    res.json({ success: true, campaigns });
  } catch (error) {
    next(error);
  }
});

// GET /api/ads/campaigns/:campaignId/insights?adAccountId=act_...&datePreset=last_30d
router.get("/ads/campaigns/:campaignId/insights", async (req, res, next) => {
  try {
    const userAccessToken = getUserAccessToken(req);
    if (!userAccessToken) {
      throw createPublicError(400, "Chưa đăng nhập Facebook hoặc thiếu quyền quảng cáo.");
    }

    const adAccountId = String(req.query.adAccountId || "").trim();
    if (!adAccountId) {
      throw createPublicError(400, "Thiếu tham số adAccountId (mã tài khoản quảng cáo).");
    }

    const requestedPreset = String(req.query.datePreset || "last_30d").trim();
    const datePreset = VALID_DATE_PRESETS.has(requestedPreset) ? requestedPreset : "last_30d";

    const adsInsights = await adsInsightsService.buildCampaignInsights({
      campaignId: req.params.campaignId,
      adAccountId,
      userAccessToken,
      userId: Number(req.session.userId) || null,
      datePreset
    });

    res.json({ success: true, adsInsights });
  } catch (error) {
    next(error);
  }
});

// GET /api/ads/campaigns/:campaignId/demographics?adAccountId=act_...&datePreset=last_30d
// Nhân khẩu học người XEM quảng cáo (tuổi×giới / quốc gia / vùng). Từng chiều best-effort:
// một chiều thiếu quyền/không hỗ trợ vẫn trả available:false + reason, không đánh sập báo cáo.
router.get("/ads/campaigns/:campaignId/demographics", async (req, res, next) => {
  try {
    const userAccessToken = getUserAccessToken(req);
    if (!userAccessToken) {
      throw createPublicError(400, "Chưa đăng nhập Facebook hoặc thiếu quyền quảng cáo.");
    }

    const adAccountId = String(req.query.adAccountId || "").trim();
    if (!adAccountId) {
      throw createPublicError(400, "Thiếu tham số adAccountId (mã tài khoản quảng cáo).");
    }

    const requestedPreset = String(req.query.datePreset || "last_30d").trim();
    const datePreset = VALID_DATE_PRESETS.has(requestedPreset) ? requestedPreset : "last_30d";

    const demographics = await adsInsightsService.buildCampaignDemographics({
      campaignId: req.params.campaignId,
      adAccountId,
      userAccessToken,
      userId: Number(req.session.userId) || null,
      datePreset
    });

    res.json({ success: true, demographics });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
