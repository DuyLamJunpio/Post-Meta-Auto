function requireAuth(req, res, next) {
  // Đã kết nối Facebook -> qua bình thường.
  if (req.session && req.session.facebookUser) {
    return next();
  }

  // Đã đăng nhập TÀI KHOẢN (userId) nhưng CHƯA kết nối Facebook (nút "Bỏ qua" lúc đăng nhập):
  // vẫn cho vào app. Gắn placeholder rỗng để các route đọc facebookUser.pages không lỗi;
  // dữ liệu sẽ rỗng cho tới khi người dùng kết nối Facebook ở trang Kết nối kênh.
  if (req.session && req.session.userId) {
    req.session.facebookUser = { id: null, name: "", userAccessToken: null, pages: [] };
    return next();
  }

  return res.status(401).json({
    success: false,
    message: "Bạn chưa đăng nhập.",
    details: null
  });
}

module.exports = requireAuth;
