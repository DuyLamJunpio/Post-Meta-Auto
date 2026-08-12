// Routes báo cáo quảng cáo (Ads Insights). Gắn dưới /api (đã qua requireAuth).
// User access token lấy TỪ PHIÊN (req.session.facebookUser.userAccessToken) — Ads
// Insights bắt buộc USER token có scope ads_read, KHÔNG dùng page token.

const express = require("express");

const facebookService = require("../services/facebook.service");
const adsInsightsService = require("../services/ads-insights.service");
const adsPagesService = require("../services/ads-pages.service");
const googleSheetsService = require("../services/google-sheets.service");
const adsSheetStore = require("../services/ads-sheet-store.service");
const pageVisibilityService = require("../services/page-visibility.service");

const router = express.Router();

function createPublicError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details || null;
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
  "this_year",
  "last_year",
  "maximum"
]);

const PRESET_LABELS = {
  today: "Hôm nay",
  yesterday: "Hôm qua",
  last_7d: "7 ngày qua",
  last_14d: "14 ngày qua",
  last_28d: "28 ngày qua",
  last_30d: "30 ngày qua",
  last_90d: "90 ngày qua",
  this_month: "Tháng này",
  last_month: "Tháng trước",
  this_year: "Năm nay",
  last_year: "Năm trước",
  maximum: "Tối đa"
};

// Khoảng thời gian cho 1 lần xuất: ưu tiên khoảng ngày tùy chọn {since,until} (YYYY-MM-DD),
// nếu không thì date_preset. Trả { key (dùng cho idempotency), timeRange, label, dateStart, dateStop }.
function resolvePeriod(body) {
  const since = String(body.since || "").trim();
  const until = String(body.until || "").trim();
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (isDate(since) && isDate(until)) {
    const lo = since <= until ? since : until;
    const hi = since <= until ? until : since;
    return { key: `custom_${lo}_${hi}`, timeRange: { since: lo, until: hi }, label: `Khoảng ${lo} → ${hi}`, dateStart: lo, dateStop: hi };
  }
  const requested = String(body.datePreset || "last_30d").trim();
  const preset = VALID_DATE_PRESETS.has(requested) ? requested : "last_30d";
  return { key: preset, timeRange: null, label: PRESET_LABELS[preset] || preset, dateStart: null, dateStop: null };
}

// "YYYY-MM-DD HH:mm" theo giờ Việt Nam cho cột "Ngày xuất".
function formatCapturedAt() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
}

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

// POST /api/ads/pages/:pageId/export-sheet — tạo 1 file Google Sheet cho Page: mỗi chiến
// dịch 1 tab, trong tab là Tổng quan + KẾT QUẢ THEO NGÀY. Body: { pageName, datePreset,
// campaigns:[{id,name,adAccountId}] }. Cần đã kết nối Google Sheets (409 nếu chưa).
router.post("/ads/pages/:pageId/export-sheet", async (req, res, next) => {
  try {
    const userAccessToken = getUserAccessToken(req);
    if (!userAccessToken) {
      throw createPublicError(400, "Chưa đăng nhập Facebook hoặc thiếu quyền quảng cáo.");
    }

    const sheetsAuth = (req.session && req.session.googleSheets) || null;
    if (!googleSheetsService.isConnected(sheetsAuth)) {
      throw createPublicError(409, "Chưa kết nối Google Sheets. Hãy bấm “Kết nối Google Sheets” rồi thử lại.", {
        reason: "google_sheets_not_connected"
      });
    }

    const fbUserId = (req.session.facebookUser && req.session.facebookUser.id) || null;
    if (!fbUserId) {
      throw createPublicError(400, "Không xác định được tài khoản Facebook đang đăng nhập.");
    }

    const pageId = String(req.params.pageId || "").trim() || "khac";
    const pageName = String(req.body.pageName || "Page").slice(0, 120);
    const period = resolvePeriod(req.body);
    const capturedAt = formatCapturedAt();

    // Giới hạn 50 chiến dịch/lần xuất để không nã Graph quá nhiều.
    const requestedCampaigns = Array.isArray(req.body.campaigns) ? req.body.campaigns.slice(0, 50) : [];
    if (requestedCampaigns.length === 0) {
      throw createPublicError(400, "Không có chiến dịch nào để xuất.");
    }

    // Lấy insights (+ nhân khẩu học) TUẦN TỰ từng chiến dịch, dựng entry để ghi vào Sheet.
    const entries = [];
    for (const item of requestedCampaigns) {
      const adAccountId = String(item.adAccountId || "").trim();
      const campaignId = String(item.id || "").trim();
      if (!adAccountId || !campaignId) {
        continue;
      }
      const insights = await adsInsightsService.buildCampaignInsights({
        campaignId,
        adAccountId,
        userAccessToken,
        userId: Number(req.session.userId) || null,
        datePreset: period.key,
        timeRange: period.timeRange
      });

      // Nhân khẩu học: chỉ khi insights khả dụng, best-effort (lỗi không chặn xuất kết quả).
      let demographics = null;
      if (insights.available) {
        try {
          demographics = await adsInsightsService.buildCampaignDemographics({
            campaignId,
            adAccountId,
            userAccessToken,
            userId: Number(req.session.userId) || null,
            datePreset: period.key,
            timeRange: period.timeRange
          });
        } catch (demoError) {
          console.warn("[Ads Export Sheet] Không lấy được nhân khẩu học:", demoError.message);
        }
      }

      entries.push(
        googleSheetsService.buildExportEntry(
          {
            name: item.name || campaignId,
            campaignId,
            available: insights.available,
            overview: insights.overview,
            daily: insights.daily,
            demographics
          },
          {
            periodLabel: period.label,
            dateStart: period.dateStart,
            dateStop: period.dateStop,
            capturedAt
          }
        )
      );
    }

    if (entries.length === 0) {
      throw createPublicError(400, "Không có chiến dịch hợp lệ để xuất.");
    }

    // Dồn vào file cũ nếu đã có (theo tài khoản FB × Page); nếu chưa thì tạo mới rồi nhớ lại.
    const existing = await adsSheetStore.getSheetMapping(fbUserId, pageId);
    const spreadsheet = await googleSheetsService.appendPageExport(sheetsAuth, {
      spreadsheetId: existing ? existing.spreadsheetId : null,
      pageName,
      entries
    });

    await adsSheetStore.saveSheetMapping(fbUserId, pageId, {
      userId: Number(req.session.userId) || null,
      spreadsheetId: spreadsheet.spreadsheetId,
      spreadsheetUrl: spreadsheet.spreadsheetUrl
    });

    res.json({ success: true, spreadsheet });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
