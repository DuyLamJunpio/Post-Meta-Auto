const express = require("express");

const authService = require("../services/auth.service");
const userFacebookService = require("../services/user-facebook.service");
const notionOauthService = require("../services/notion-oauth.service");

function requireAccount(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ success: false, message: "Vui lòng đăng nhập tài khoản." });
  }
  next();
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
  } catch (error) {
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const user = await authService.authenticate(req.body && req.body.email, req.body && req.body.password);
    req.session.userId = user.id;
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

module.exports = router;
