// Cổng xác thực cho API worker (/worker/v1/*). TÁCH HẲN khỏi requireAuth (cookie):
// app cào trên máy khách không có cookie phiên, nó cầm một token bearer.

const workerTokenService = require("../services/worker-token.service");

function isLocalHost(req) {
  const host = String(req.hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

// Ép TLS: token bearer replayable BẮT BUỘC đi qua kênh mã hoá. Từ chối http://
// tới /worker/* (đọc X-Forwarded-Proto sau proxy Render), trừ localhost khi dev.
function enforceHttps(req, res, next) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "").toLowerCase();
  const secure = proto === "https" || req.secure;
  if (secure || isLocalHost(req)) {
    return next();
  }
  return res.status(400).json({
    success: false,
    error: "Yêu cầu phải qua HTTPS. Cấu hình WEB_APP_URL bằng https."
  });
}

// Đọc token, xác thực, gắn danh tính worker vào req.
async function requireWorkerToken(req, res, next) {
  try {
    const header = String(req.headers["authorization"] || "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const token = bearer || String(req.headers["x-worker-token"] || "").trim();

    const identity = await workerTokenService.verifyToken(token);
    if (!identity) {
      return res.status(401).json({
        success: false,
        error: "Token worker không hợp lệ hoặc đã bị thu hồi/hết hạn."
      });
    }

    req.workerUserId = identity.userId;
    req.workerTokenId = identity.tokenId;
    req.workerScopes = identity.scopes;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { enforceHttps, requireWorkerToken };
