const express = require("express");

const authService = require("../services/auth.service");
const userFacebookService = require("../services/user-facebook.service");

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

module.exports = router;
