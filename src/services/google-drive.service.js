const crypto = require("crypto");
const path = require("path");

const axios = require("axios");

const { config } = require("../config");

const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

function createPublicError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details || null;
  return error;
}

function isConfigured() {
  return config.googleDrive.enabled;
}

function ensureConfigured() {
  if (!isConfigured()) {
    throw createPublicError(
      500,
      "Chưa cấu hình Google Drive OAuth. Hãy thêm GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET và GOOGLE_DRIVE_REDIRECT_URI vào file .env."
    );
  }
}

function logDriveError(context, error) {
  const apiError = error.response && error.response.data && error.response.data.error;

  console.error("[Google Drive API]", {
    context,
    status: error.response && error.response.status,
    code: apiError && apiError.code,
    message: apiError && (apiError.message || apiError),
    transportCode: error.code,
    transportMessage: !error.response ? error.message : undefined
  });
}

function handleDriveError(context, error, publicMessage, status = 502) {
  if (error.publicMessage) {
    throw error;
  }

  logDriveError(context, error);
  const apiError = error.response && error.response.data && error.response.data.error;
  const providerMessage = apiError && (apiError.message || apiError);
  const responseStatus = error.response && error.response.status;
  let readableMessage = publicMessage;

  if (
    responseStatus === 403 &&
    providerMessage &&
    String(providerMessage).toLowerCase().includes("drive api") &&
    String(providerMessage).toLowerCase().includes("disabled")
  ) {
    readableMessage = "Google Drive API chưa được bật trong Google Cloud project, nên hệ thống chưa đọc được file trong Drive.";
  } else if (responseStatus === 401) {
    readableMessage = "Phiên kết nối Google Drive đã hết hạn hoặc chưa hợp lệ. Hãy kết nối Google Drive lại.";
  } else if (responseStatus === 403) {
    readableMessage = "Tài khoản Google Drive đã kết nối chưa có quyền đọc file này, hoặc Google Cloud đang chặn quyền Drive.";
  } else if (responseStatus === 404) {
    readableMessage = "Không tìm thấy file trong Google Drive. File có thể đã bị xóa, đổi quyền hoặc link không đúng.";
  }

  throw createPublicError(status, readableMessage, {
    service: "google_drive",
    context,
    status: responseStatus,
    code: apiError && apiError.code,
    providerMessage: providerMessage || (!error.response ? error.message : null)
  });
}

function buildAuthorizationUrl(session) {
  ensureConfigured();

  const state = crypto.randomBytes(24).toString("hex");
  session.googleDriveOAuthState = state;

  const params = new URLSearchParams({
    client_id: config.googleDrive.clientId,
    redirect_uri: config.googleDrive.redirectUri,
    response_type: "code",
    scope: config.googleDrive.scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state
  });

  return `${config.googleDrive.oauthDialogUrl}?${params.toString()}`;
}

function getSessionAuth(session) {
  return session && session.googleDrive ? session.googleDrive : null;
}

function isConnected(sessionOrAuth) {
  const auth = sessionOrAuth && sessionOrAuth.googleDrive ? sessionOrAuth.googleDrive : sessionOrAuth;
  return Boolean(auth && (auth.accessToken || auth.refreshToken));
}

function getStatus(session) {
  const auth = getSessionAuth(session);

  return {
    configured: isConfigured(),
    connected: isConnected(auth),
    scopes: auth && auth.scope ? auth.scope.split(" ").filter(Boolean) : [],
    connectedAt: auth ? auth.connectedAt : null,
    expiresAt: auth ? auth.expiresAt : null,
    canRefresh: Boolean(auth && auth.refreshToken)
  };
}

async function exchangeCodeForTokens(code) {
  ensureConfigured();

  try {
    const body = new URLSearchParams({
      code,
      client_id: config.googleDrive.clientId,
      client_secret: config.googleDrive.clientSecret,
      redirect_uri: config.googleDrive.redirectUri,
      grant_type: "authorization_code"
    });

    const response = await axios.post(config.googleDrive.tokenUrl, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    if (!response.data || !response.data.access_token) {
      throw createPublicError(502, "Google không trả về access token Drive.");
    }

    return response.data;
  } catch (error) {
    handleDriveError("exchange_code", error, "Không kết nối được Google Drive.");
  }
}

function storeTokens(session, tokens) {
  const existing = getSessionAuth(session) || {};
  const expiresInMs = Number(tokens.expires_in || 3600) * 1000;

  session.googleDrive = {
    accessToken: tokens.access_token || existing.accessToken,
    refreshToken: tokens.refresh_token || existing.refreshToken,
    scope: tokens.scope || existing.scope || config.googleDrive.scopes.join(" "),
    tokenType: tokens.token_type || existing.tokenType || "Bearer",
    connectedAt: existing.connectedAt || new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString()
  };

  return session.googleDrive;
}

function needsRefresh(auth) {
  if (!auth || !auth.accessToken) {
    return true;
  }

  if (!auth.expiresAt) {
    return false;
  }

  return new Date(auth.expiresAt).getTime() - Date.now() <= TOKEN_EXPIRY_SKEW_MS;
}

async function refreshAccessToken(auth) {
  ensureConfigured();

  if (!auth || !auth.refreshToken) {
    throw createPublicError(401, "Google Drive chưa được kết nối hoặc thiếu refresh token.");
  }

  try {
    const body = new URLSearchParams({
      client_id: config.googleDrive.clientId,
      client_secret: config.googleDrive.clientSecret,
      refresh_token: auth.refreshToken,
      grant_type: "refresh_token"
    });

    const response = await axios.post(config.googleDrive.tokenUrl, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
    const tokens = response.data || {};
    const expiresInMs = Number(tokens.expires_in || 3600) * 1000;

    auth.accessToken = tokens.access_token;
    auth.scope = tokens.scope || auth.scope;
    auth.tokenType = tokens.token_type || auth.tokenType || "Bearer";
    auth.expiresAt = new Date(Date.now() + expiresInMs).toISOString();

    return auth.accessToken;
  } catch (error) {
    handleDriveError("refresh_token", error, "Không làm mới được quyền truy cập Google Drive.", 401);
  }
}

async function getAccessToken(auth) {
  if (!auth || (!auth.accessToken && !auth.refreshToken)) {
    throw createPublicError(401, "Chưa kết nối Google Drive để đọc ảnh riêng tư.");
  }

  if (needsRefresh(auth)) {
    return refreshAccessToken(auth);
  }

  return auth.accessToken;
}

function getGoogleDriveFileId(url) {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();

    if (!/(\.|^)googleusercontent\.com$/.test(hostname) && !/(\.|^)google\.com$/.test(hostname)) {
      return null;
    }

    const id = parsedUrl.searchParams.get("id");

    if (id) {
      return id;
    }

    const fileMatch = parsedUrl.pathname.match(/\/file\/d\/([^/]+)/);
    return fileMatch ? fileMatch[1] : null;
  } catch (error) {
    return null;
  }
}

function isGoogleDriveFileUrl(url) {
  return Boolean(getGoogleDriveFileId(url));
}

function extensionFromContentType(contentType) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  const extensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov"
  };

  return extensions[normalized] || "";
}

function normalizeFileName(name, contentType, fallbackId) {
  const baseName = String(name || fallbackId || "drive-media").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-");
  const hasExtension = path.extname(baseName).length > 0;

  return hasExtension ? baseName : `${baseName}${extensionFromContentType(contentType)}`;
}

async function getFileMetadata(fileId, auth) {
  const accessToken = await getAccessToken(auth);

  try {
    const response = await axios.get(`${config.googleDrive.driveApiBaseUrl}/files/${encodeURIComponent(fileId)}`, {
      params: {
        fields: "id,name,mimeType,size",
        supportsAllDrives: true
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    return response.data || {};
  } catch (error) {
    handleDriveError(
      "get_file_metadata",
      error,
      "Không đọc được thông tin file trong Google Drive. Hãy kiểm tra quyền truy cập file.",
      error.response && error.response.status === 404 ? 404 : 502
    );
  }
}

async function downloadFileFromUrl(url, auth) {
  const fileId = getGoogleDriveFileId(url);

  if (!fileId) {
    return null;
  }

  const metadata = await getFileMetadata(fileId, auth);
  const accessToken = await getAccessToken(auth);

  try {
    const response = await axios.get(`${config.googleDrive.driveApiBaseUrl}/files/${encodeURIComponent(fileId)}`, {
      params: {
        alt: "media",
        supportsAllDrives: true
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      responseType: "arraybuffer",
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    const contentType = response.headers["content-type"] || metadata.mimeType || "application/octet-stream";
    const buffer = Buffer.from(response.data);

    if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
      throw createPublicError(400, "File Google Drive không phải ảnh hoặc video có thể đăng lên Facebook.");
    }

    return {
      kind: "buffer",
      buffer,
      contentType,
      filename: normalizeFileName(metadata.name, contentType, fileId),
      originalUrl: url,
      driveFileId: fileId,
      size: metadata.size ? Number(metadata.size) : buffer.length
    };
  } catch (error) {
    handleDriveError(
      "download_file",
      error,
      "Không tải được file Google Drive. Hãy kiểm tra file có nằm trong Drive đã kết nối và tài khoản có quyền xem.",
      error.status || 502
    );
  }
}

async function resolveMediaItems(urls, auth) {
  const mediaUrls = Array.isArray(urls) ? urls : [];
  const items = [];

  for (const url of mediaUrls) {
    if (isGoogleDriveFileUrl(url)) {
      items.push(await downloadFileFromUrl(url, auth));
    } else {
      items.push({
        kind: "url",
        url,
        originalUrl: url
      });
    }
  }

  return items;
}

async function downloadMediaFromUrl(url, auth) {
  return downloadFileFromUrl(url, auth);
}

async function disconnect(session) {
  const auth = getSessionAuth(session);
  const token = auth && (auth.refreshToken || auth.accessToken);

  delete session.googleDrive;

  if (!token || !isConfigured()) {
    return;
  }

  try {
    await axios.post(
      config.googleDrive.revokeUrl,
      new URLSearchParams({ token }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );
  } catch (error) {
    logDriveError("revoke_token", error);
  }
}

module.exports = {
  buildAuthorizationUrl,
  disconnect,
  exchangeCodeForTokens,
  getGoogleDriveFileId,
  getSessionAuth,
  getStatus,
  isConfigured,
  isConnected,
  isGoogleDriveFileUrl,
  downloadMediaFromUrl,
  resolveMediaItems,
  storeTokens
};
