const express = require("express");

const leadService = require("../services/lead.service");
const notifier = require("../services/notifier");

// Luồng thu lead CÔNG KHAI (không qua requireAuth): khách đăng nhập Facebook tối thiểu,
// rồi tự khai thông tin KÈM đồng ý. Admin xem lại danh sách qua adminRouter (/api/leads).

const publicRouter = express.Router();
const adminRouter = express.Router();

function normalizePhone(value) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

// Bắt đầu đăng nhập Facebook (chỉ public_profile,email).
publicRouter.get("/auth/facebook", (req, res, next) => {
  try {
    if (!leadService.isConfigured()) {
      return res.status(503).send("Chưa cấu hình Facebook App để thu thập lead.");
    }

    const state = leadService.createState();
    req.session.leadOauthState = state;
    res.redirect(leadService.buildAuthUrl(state));
  } catch (error) {
    next(error);
  }
});

// Facebook gọi lại: đổi code lấy hồ sơ, lưu tạm vào session của khách rồi về trang đăng ký.
publicRouter.get("/auth/facebook/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query;

    if (!code || !state || state !== req.session.leadOauthState) {
      return res.redirect("/lead.html?error=auth");
    }

    delete req.session.leadOauthState;
    req.session.leadProfile = await leadService.exchangeCodeForProfile(String(code));
    res.redirect("/lead.html");
  } catch (error) {
    console.error("[Lead Auth]", error.message);
    res.redirect("/lead.html?error=auth");
  }
});

// Trạng thái đăng nhập của khách (để trang quyết định hiện nút login hay form).
publicRouter.get("/me", (req, res) => {
  res.json({
    success: true,
    profile: req.session.leadProfile || null,
    consentText: leadService.CONSENT_TEXT
  });
});

// Khách gửi thông tin đăng ký (bắt buộc đã đăng nhập FB + đã đồng ý).
publicRouter.post("/submit", async (req, res, next) => {
  try {
    const profile = req.session.leadProfile;
    if (!profile) {
      return res.status(401).json({ success: false, message: "Vui lòng đăng nhập Facebook trước." });
    }

    const consent = req.body && req.body.consent === true;
    if (!consent) {
      return res.status(400).json({ success: false, message: "Cần tick đồng ý để đăng ký." });
    }

    const phone = normalizePhone(req.body && req.body.phone);
    if (phone.length < 8) {
      return res.status(400).json({ success: false, message: "Số điện thoại không hợp lệ." });
    }

    const email = String((req.body && req.body.email) || "").trim();
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Email không hợp lệ." });
    }

    const name = String((req.body && req.body.name) || profile.name || "").trim();
    const note = String((req.body && req.body.note) || "").trim();

    const saved = leadService.createLead({
      fbId: profile.id,
      name,
      email: email || profile.email || "",
      phone,
      note,
      consent: true,
      source: "web-form"
    });

    await notifier.notify({
      level: "important",
      title: "🎯 Lead mới từ web",
      lines: [
        `Tên: ${name || "(không tên)"}`,
        `SĐT: ${phone}`,
        email || profile.email ? `Email: ${email || profile.email}` : null,
        note ? `Nhu cầu: ${note}` : null,
        `Facebook ID: ${profile.id || "?"}`,
        "✅ Khách đã đồng ý cho liên hệ."
      ]
    });

    // Xóa hồ sơ tạm để lần đăng ký sau là phiên mới.
    delete req.session.leadProfile;

    res.json({ success: true, message: "Đăng ký thành công. Cảm ơn bạn!", id: saved.id });
  } catch (error) {
    next(error);
  }
});

// Admin: xem danh sách lead (đặt dưới /api nên đã qua requireAuth).
adminRouter.get("/leads", (req, res, next) => {
  try {
    res.json({ success: true, leads: leadService.listLeads(Number(req.query.limit) || 100) });
  } catch (error) {
    next(error);
  }
});

module.exports = { publicRouter, adminRouter };
