function requireAuth(req, res, next) {
  if (!req.session || !req.session.facebookUser) {
    return res.status(401).json({
      success: false,
      message: "Bạn chưa đăng nhập.",
      details: null
    });
  }

  next();
}

module.exports = requireAuth;
