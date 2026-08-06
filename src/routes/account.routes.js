const express = require("express");

const authService = require("../services/auth.service");
const userFacebookService = require("../services/user-facebook.service");
const notionOauthService = require("../services/notion-oauth.service");
const workerTokenService = require("../services/worker-token.service");
const notifier = require("../services/notifier");

function requireAccount(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, message: "Vui lòng đăng nhập tài khoản." });
  }
  next();
}

// Chống CSRF cho POST đổi trạng thái (phát/thu hồi token): sameSite:lax không
// diệt hết CSRF cùng-site, nên kiểm Origin/Referer khớp Host. Thiếu cả hai ->
// từ chối (fetch cùng-site của trình duyệt luôn gửi Origin).
function checkSameOrigin(req, res, next) {
  const source = req.headers.origin || req.headers.referer || "";
  if (source) {
    try {
      if (new URL(source).host === req.headers.host) {
        return next();
      }
    } catch {
      // rơi xuống 403
    }
  }
  return res.status(403).json({ success: false, message: "Nguồn yêu cầu không hợp lệ (CSRF)." });
}

// Hệ tài khoản người dùng (đăng ký/đăng nhập bằng email + mật khẩu).
// CÔNG KHAI — đặt trước requireAuth. Session lưu userId cho các pha sau (kết nối FB/Notion per-user).
const router = express.Router();

router.post("/register", async (req, res, next) => {
  try {
    const user = await authService.registerUser({
      email: req.body && req.body.email,
      password: req.body && req.body.password,
      name: req.body && req.body.name,
      phone: req.body && req.body.phone
    });
    req.session.userId = user.id;
    res.json({ success: true, message: "Đăng ký thành công.", user });

    // Báo Telegram khi có tài khoản mới — fire-and-forget, không chặn/không làm hỏng luồng đăng ký.
    notifier
      .notify({
        level: "important",
        title: "🆕 Tài khoản mới đăng ký",
        lines: [
          `Tên: ${user.name || "(không tên)"}`,
          `Email: ${user.email}`,
          user.phone ? `SĐT: ${user.phone}` : null,
          `Thời gian: ${new Date(user.createdAt || Date.now()).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`
        ]
      })
      .catch((notifyError) => console.warn("[Account] Không gửi được cảnh báo đăng ký:", notifyError.message));
  } catch (error) {
    next(error);
  }
});

const REMEMBER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 ngày

router.post("/login", async (req, res, next) => {
  try {
    const user = await authService.authenticate(req.body && req.body.email, req.body && req.body.password);
    req.session.userId = user.id;
    // "Ghi nhớ đăng nhập": kéo dài tuổi cookie phiên lên 30 ngày (mặc định 24 giờ).
    if (req.body && req.body.remember) {
      req.session.cookie.maxAge = REMEMBER_MAX_AGE_MS;
    }
    res.json({ success: true, message: "Đăng nhập thành công.", user });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", (req, res) => {
  delete req.session.userId;
  res.json({ success: true, message: "Đã đăng xuất." });
});

router.get("/me", async (req, res, next) => {
  try {
    if (!req.session.userId) {
      return res.json({ success: true, user: null });
    }
    const user = await authService.getUserById(req.session.userId);
    res.json({ success: true, user });
  } catch (error) {
    next(error);
  }
});

// Pha 2: trạng thái kết nối Facebook của tài khoản đang đăng nhập.
router.get("/facebook/status", async (req, res, next) => {
  try {
    if (!req.session.userId) {
      return res.json({ success: true, status: { connected: false, needLogin: true } });
    }
    const status = await userFacebookService.getStatus(req.session.userId);
    res.json({ success: true, status });
  } catch (error) {
    next(error);
  }
});

router.post("/facebook/disconnect", async (req, res, next) => {
  try {
    if (req.session.userId) {
      await userFacebookService.disconnect(req.session.userId);
    }
    delete req.session.facebookUser;
    res.json({ success: true, message: "Đã ngắt kết nối Facebook." });
  } catch (error) {
    next(error);
  }
});

// Pha 3: kết nối Notion qua OAuth (per-user).
router.get("/notion/connect", (req, res) => {
  if (!req.session.userId) {
    return res.redirect("/account.html");
  }
  if (!notionOauthService.isConfigured()) {
    return res.status(503).send("Chưa cấu hình Notion OAuth (NOTION_OAUTH_CLIENT_ID/SECRET).");
  }
  const state = notionOauthService.createState();
  req.session.notionOAuthState = state;
  res.redirect(notionOauthService.buildAuthUrl(state));
});

router.get("/notion/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!req.session.userId) {
      return res.redirect("/account.html");
    }
    if (!code || !state || state !== req.session.notionOAuthState) {
      return res.redirect("/account.html?notion=error");
    }
    delete req.session.notionOAuthState;

    const tokenData = await notionOauthService.exchangeCode(String(code));
    await notionOauthService.saveConnection(req.session.userId, tokenData);
    res.redirect("/account.html?notion=connected");
  } catch (error) {
    console.error("[Notion OAuth]", error.message);
    res.redirect("/account.html?notion=error");
  }
});

router.get("/notion/status", requireAccount, async (req, res, next) => {
  try {
    res.json({ success: true, status: await notionOauthService.getStatus(req.session.userId) });
  } catch (error) {
    next(error);
  }
});

router.get("/notion/databases", requireAccount, async (req, res, next) => {
  try {
    res.json({ success: true, databases: await notionOauthService.listDataSources(req.session.userId) });
  } catch (error) {
    next(error);
  }
});

router.post("/notion/databases", requireAccount, async (req, res, next) => {
  try {
    const contentId = req.body && req.body.contentDataSourceId ? String(req.body.contentDataSourceId) : "";
    const brandsId = req.body && req.body.brandsDataSourceId ? String(req.body.brandsDataSourceId) : "";
    if (!contentId || !brandsId) {
      return res.status(400).json({ success: false, message: "Cần chọn cả Content DB và Brands DB." });
    }
    await notionOauthService.setDataSources(req.session.userId, contentId, brandsId);
    res.json({ success: true, message: "Đã lưu lựa chọn database Notion." });
  } catch (error) {
    next(error);
  }
});

router.post("/notion/disconnect", requireAccount, async (req, res, next) => {
  try {
    await notionOauthService.disconnect(req.session.userId);
    res.json({ success: true, message: "Đã ngắt kết nối Notion." });
  } catch (error) {
    next(error);
  }
});

// --- Token cho app cào (Công cụ cào) ---------------------------------------

// Phát token mới. Token GỐC chỉ trả về ĐÚNG MỘT LẦN — khách phải copy ngay.
router.post("/worker-tokens", requireAccount, checkSameOrigin, async (req, res, next) => {
  try {
    const result = await workerTokenService.issueToken(req.session.userId, req.body && req.body.name);
    res.json({
      success: true,
      token: result.token,
      tokenMeta: {
        id: result.id,
        name: result.name,
        tokenPrefix: result.tokenPrefix,
        scopes: result.scopes,
        createdAt: result.createdAt,
        expiresAt: result.expiresAt
      }
    });
  } catch (error) {
    next(error);
  }
});

// Danh sách token (KHÔNG chứa token gốc/hash).
router.get("/worker-tokens", requireAccount, async (req, res, next) => {
  try {
    res.json({ success: true, tokens: await workerTokenService.listTokens(req.session.userId) });
  } catch (error) {
    next(error);
  }
});

// Thu hồi token.
router.post("/worker-tokens/:id/revoke", requireAccount, checkSameOrigin, async (req, res, next) => {
  try {
    const ok = await workerTokenService.revokeToken(req.params.id, req.session.userId);
    res.json({ success: true, ok });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
