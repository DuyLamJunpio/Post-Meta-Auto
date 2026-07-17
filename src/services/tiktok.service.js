const crypto = require("crypto");

const axios = require("axios");

const { config } = require("../config");

// TikTok — OAuth Login Kit v2 (open.tiktokapis.com) + Content Posting API (direct post).
// Đặc thù: CHỈ đăng video; nguồn video BẮT BUỘC là public URL qua PULL_FROM_URL
// (domain phải được verify/allowlist trong TikTok Developer Portal). Ứng dụng chưa audit
// chỉ đăng ở mức privacy SELF_ONLY. Tài khoản đăng theo session (open_id) như Instagram.

const CHANNEL_KEY = "tiktok";
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const MAX_STATUS_POLLS = 30;
const STATUS_POLL_INTERVAL_MS = 5000;
const VIDEO_EXTENSION = /\.(m4v|mov|mp4|webm)(\?.*)?$/i;
const MAX_PHOTO_COUNT = 35;
const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024; // 10MB mỗi chunk khi video lớn
const MAX_SINGLE_CHUNK_SIZE = 64 * 1024 * 1024; // <=64MB thì upload 1 chunk

function createPublicError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details || null;
  return error;
}

function isConfigured() {
  return config.tiktok.enabled;
}

function ensureConfigured() {
  if (!isConfigured()) {
    throw createPublicError(
      500,
      "Chưa cấu hình TikTok OAuth. Cần TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET và TIKTOK_REDIRECT_URI trong .env."
    );
  }
}

function isPublicHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || "").trim());
}

function logTiktokError(context, error) {
  const apiError = error.response && error.response.data && error.response.data.error;

  console.error("[TikTok API]", {
    context,
    status: error.response && error.response.status,
    code: apiError && apiError.code,
    message: apiError && (apiError.message || apiError),
    logId: apiError && apiError.log_id,
    transportCode: error.code,
    transportMessage: !error.response ? error.message : undefined
  });
}

function handleTiktokError(context, error, publicMessage, status = 502) {
  if (error.publicMessage) {
    throw error;
  }

  logTiktokError(context, error);

  if (!error.response) {
    throw createPublicError(
      502,
      "Backend không kết nối được TikTok API. Kiểm tra internet, proxy/firewall hoặc cách bạn đang chạy server."
    );
  }

  const apiError = error.response.data && error.response.data.error;
  const responseStatus = error.response.status;
  let readableMessage = publicMessage;

  if (responseStatus === 401 || (apiError && apiError.code === "access_token_invalid")) {
    readableMessage = "Phiên kết nối TikTok đã hết hạn hoặc chưa hợp lệ. Hãy kết nối lại.";
  } else if (responseStatus === 403 || (apiError && apiError.code === "scope_not_authorized")) {
    readableMessage = "Tài khoản TikTok chưa cấp đủ quyền đăng video (scope video.publish).";
  }

  throw createPublicError(status, readableMessage, {
    service: CHANNEL_KEY,
    context,
    status: responseStatus,
    code: apiError && apiError.code,
    providerMessage: apiError && (apiError.message || apiError.log_id)
  });
}

function buildAuthorizationUrl(session) {
  ensureConfigured();

  const state = crypto.randomBytes(24).toString("hex");
  session.tiktokOAuthState = state;

  const params = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    redirect_uri: config.tiktok.redirectUri,
    response_type: "code",
    scope: config.tiktok.scopes.join(","),
    state
  });

  return `${config.tiktok.oauthDialogUrl}?${params.toString()}`;
}

function getSessionAuth(session) {
  return session && session.tiktokUser ? session.tiktokUser : null;
}

function isConnected(session) {
  const auth = getSessionAuth(session);
  return Boolean(auth && (auth.accessToken || auth.refreshToken) && auth.openId);
}

function getStatus(session) {
  const auth = getSessionAuth(session);

  return {
    configured: isConfigured(),
    connected: isConnected(session),
    redirectUri: config.tiktok.redirectUri,
    user: auth
      ? {
          openId: auth.openId,
          displayName: auth.displayName,
          avatarUrl: auth.avatarUrl,
          expiresAt: auth.expiresAt
        }
      : null
  };
}

async function requestTokens(params) {
  ensureConfigured();

  try {
    const body = new URLSearchParams({
      client_key: config.tiktok.clientKey,
      client_secret: config.tiktok.clientSecret,
      ...params
    });

    const response = await axios.post(config.tiktok.tokenUrl, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache"
      }
    });

    if (!response.data || !response.data.access_token) {
      throw createPublicError(502, "TikTok không trả về access token.");
    }

    return response.data;
  } catch (error) {
    handleTiktokError("request_tokens", error, "Không lấy được token TikTok.");
  }
}

async function exchangeCodeForTokens(code) {
  return requestTokens({
    code,
    grant_type: "authorization_code",
    redirect_uri: config.tiktok.redirectUri
  });
}

async function getProfile(accessToken) {
  ensureConfigured();

  try {
    const response = await axios.get(`${config.tiktok.apiBaseUrl}/user/info/`, {
      params: { fields: "open_id,display_name,avatar_url" },
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    return (response.data && response.data.data && response.data.data.user) || {};
  } catch (error) {
    handleTiktokError("get_profile", error, "Không lấy được thông tin tài khoản TikTok.");
  }
}

function storeTokens(session, tokens, profile) {
  const expiresInMs = Number(tokens.expires_in || 86400) * 1000;
  const refreshExpiresInMs = Number(tokens.refresh_expires_in || 0) * 1000;
  const existing = getSessionAuth(session) || {};

  session.tiktokUser = {
    openId: String((profile && profile.open_id) || tokens.open_id || existing.openId || ""),
    displayName: (profile && profile.display_name) || existing.displayName || "",
    avatarUrl: (profile && profile.avatar_url) || existing.avatarUrl || "",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || existing.refreshToken,
    scope: tokens.scope || existing.scope || config.tiktok.scopes.join(","),
    tokenType: tokens.token_type || existing.tokenType || "Bearer",
    connectedAt: existing.connectedAt || new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    refreshExpiresAt: refreshExpiresInMs > 0 ? new Date(Date.now() + refreshExpiresInMs).toISOString() : existing.refreshExpiresAt || null
  };

  return session.tiktokUser;
}

function clearTokens(session) {
  delete session.tiktokUser;
  delete session.tiktokOAuthState;
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
    throw createPublicError(401, "TikTok chưa được kết nối hoặc thiếu refresh token.");
  }

  const tokens = await requestTokens({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken
  });
  const expiresInMs = Number(tokens.expires_in || 86400) * 1000;

  auth.accessToken = tokens.access_token;
  auth.refreshToken = tokens.refresh_token || auth.refreshToken;
  auth.scope = tokens.scope || auth.scope;
  auth.tokenType = tokens.token_type || auth.tokenType || "Bearer";
  auth.expiresAt = new Date(Date.now() + expiresInMs).toISOString();

  return auth.accessToken;
}

async function getAccessToken(auth) {
  if (!auth || (!auth.accessToken && !auth.refreshToken)) {
    throw createPublicError(401, "Chưa kết nối TikTok để đăng bài.");
  }

  if (needsRefresh(auth)) {
    return refreshAccessToken(auth);
  }

  return auth.accessToken;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Khởi tạo direct post video từ public URL (PULL_FROM_URL). Trả về publish_id.
async function initVideoPost(accessToken, title, videoUrl) {
  const body = {
    post_info: {
      title,
      privacy_level: config.tiktok.privacyLevel,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false
    },
    source_info: {
      source: "PULL_FROM_URL",
      video_url: videoUrl
    }
  };

  try {
    const response = await axios.post(`${config.tiktok.apiBaseUrl}/post/publish/video/init/`, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8"
      }
    });
    const data = response.data || {};

    if (data.error && data.error.code && data.error.code !== "ok") {
      throw createPublicError(502, data.error.message || "TikTok từ chối yêu cầu đăng video.", {
        service: CHANNEL_KEY,
        context: "init_video_post",
        code: data.error.code,
        providerMessage: data.error.log_id
      });
    }

    const publishId = data.data && data.data.publish_id;

    if (!publishId) {
      throw createPublicError(502, "TikTok không trả về publish_id.", {
        service: CHANNEL_KEY,
        context: "init_video_post"
      });
    }

    return publishId;
  } catch (error) {
    handleTiktokError("init_video_post", error, "Không khởi tạo được bài đăng TikTok.");
  }
}

// Poll trạng thái xử lý video tới khi hoàn tất hoặc lỗi.
async function waitForPublishComplete(accessToken, publishId) {
  for (let attempt = 0; attempt < MAX_STATUS_POLLS; attempt += 1) {
    let data;

    try {
      const response = await axios.post(
        `${config.tiktok.apiBaseUrl}/post/publish/status/fetch/`,
        { publish_id: publishId },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json; charset=UTF-8"
          }
        }
      );
      data = response.data || {};
    } catch (error) {
      handleTiktokError("fetch_publish_status", error, "Không kiểm tra được trạng thái đăng TikTok.");
    }

    const status = data.data && data.data.status;

    if (status === "PUBLISH_COMPLETE" || status === "SEND_TO_USER_INBOX") {
      const publiclyAvailableIds = (data.data && data.data.publicaly_available_post_id) || [];
      return {
        postId: publiclyAvailableIds.length > 0 ? String(publiclyAvailableIds[0]) : publishId,
        status
      };
    }

    if (status === "FAILED") {
      const failReason = data.data && data.data.fail_reason;
      throw createPublicError(502, `TikTok xử lý video thất bại${failReason ? ` (${failReason})` : ""}.`, {
        service: CHANNEL_KEY,
        context: "publish_status",
        providerMessage: failReason
      });
    }

    await delay(STATUS_POLL_INTERVAL_MS);
  }

  throw createPublicError(504, "TikTok xử lý video quá lâu (timeout chờ hoàn tất).", {
    service: CHANNEL_KEY,
    context: "publish_status_timeout"
  });
}

// Khởi tạo direct post video bằng FILE_UPLOAD (đẩy binary trực tiếp, KHÔNG cần verify domain
// như PULL_FROM_URL). Trả về { publishId, uploadUrl, chunkSize, totalChunkCount }.
async function initVideoFileUpload(accessToken, title, videoSize) {
  const singleChunk = videoSize <= MAX_SINGLE_CHUNK_SIZE;
  const chunkSize = singleChunk ? videoSize : UPLOAD_CHUNK_SIZE;
  // TikTok: chunk cuối gộp phần dư, nên total = floor(size / chunkSize).
  const totalChunkCount = singleChunk ? 1 : Math.floor(videoSize / chunkSize);

  const body = {
    post_info: {
      title,
      privacy_level: config.tiktok.privacyLevel,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false
    },
    source_info: {
      source: "FILE_UPLOAD",
      video_size: videoSize,
      chunk_size: chunkSize,
      total_chunk_count: totalChunkCount
    }
  };

  try {
    const response = await axios.post(`${config.tiktok.apiBaseUrl}/post/publish/video/init/`, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8"
      }
    });
    const data = response.data || {};

    if (data.error && data.error.code && data.error.code !== "ok") {
      throw createPublicError(502, data.error.message || "TikTok từ chối yêu cầu đăng video.", {
        service: CHANNEL_KEY,
        context: "init_video_upload",
        code: data.error.code,
        providerMessage: data.error.log_id
      });
    }

    const publishId = data.data && data.data.publish_id;
    const uploadUrl = data.data && data.data.upload_url;

    if (!publishId || !uploadUrl) {
      throw createPublicError(502, "TikTok không trả về publish_id/upload_url.", {
        service: CHANNEL_KEY,
        context: "init_video_upload"
      });
    }

    return { publishId, uploadUrl, chunkSize, totalChunkCount };
  } catch (error) {
    handleTiktokError("init_video_upload", error, "Không khởi tạo được phiên upload video TikTok.");
  }
}

// Đẩy buffer video lên upload_url theo từng chunk (chunk cuối gộp phần dư).
async function uploadVideoBuffer(uploadUrl, buffer, chunkSize, totalChunkCount, contentType) {
  const total = buffer.length;

  for (let i = 0; i < totalChunkCount; i += 1) {
    const start = i * chunkSize;
    const end = i === totalChunkCount - 1 ? total - 1 : start + chunkSize - 1;
    const chunk = buffer.subarray(start, end + 1);

    try {
      await axios.put(uploadUrl, chunk, {
        headers: {
          "Content-Type": contentType || "video/mp4",
          "Content-Length": chunk.length,
          "Content-Range": `bytes ${start}-${end}/${total}`
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
    } catch (error) {
      handleTiktokError("upload_video_chunk", error, "Tải video lên TikTok thất bại.");
    }
  }
}

// Khởi tạo direct post ẢNH (1..MAX_PHOTO_COUNT ảnh). Ảnh chỉ hỗ trợ PULL_FROM_URL nên
// cần URL công khai (đã qua proxy). Trả về publish_id.
async function initPhotoPost(accessToken, title, photoUrls) {
  const body = {
    post_info: {
      title: title.slice(0, 90),
      description: title,
      privacy_level: config.tiktok.privacyLevel,
      disable_comment: false
    },
    source_info: {
      source: "PULL_FROM_URL",
      photo_cover_index: 0,
      photo_images: photoUrls
    },
    post_mode: "DIRECT_POST",
    media_type: "PHOTO"
  };

  try {
    const response = await axios.post(`${config.tiktok.apiBaseUrl}/post/publish/content/init/`, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8"
      }
    });
    const data = response.data || {};

    if (data.error && data.error.code && data.error.code !== "ok") {
      throw createPublicError(502, data.error.message || "TikTok từ chối yêu cầu đăng ảnh.", {
        service: CHANNEL_KEY,
        context: "init_photo_post",
        code: data.error.code,
        providerMessage: data.error.log_id
      });
    }

    const publishId = data.data && data.data.publish_id;

    if (!publishId) {
      throw createPublicError(502, "TikTok không trả về publish_id.", {
        service: CHANNEL_KEY,
        context: "init_photo_post"
      });
    }

    return publishId;
  } catch (error) {
    handleTiktokError("init_photo_post", error, "Không khởi tạo được bài đăng ảnh TikTok.");
  }
}

// content: {
//   mediaType: "video" | "photo",
//   title (caption),
//   videoBuffer?, videoContentType?  -> ưu tiên FILE_UPLOAD
//   videoUrl?                        -> fallback PULL_FROM_URL nếu không có buffer
//   photoUrls?                       -> danh sách URL ảnh công khai
// }
// Trả về { postId, permalinkUrl } đồng bộ contract với các service kênh khác.
async function publishContent(openId, auth, content) {
  ensureConfigured();

  const accessToken = await getAccessToken(auth);
  const title = String(content.title || "").trim();

  if (content.mediaType === "photo") {
    const photoUrls = (Array.isArray(content.photoUrls) ? content.photoUrls : []).filter(isPublicHttpUrl);

    if (photoUrls.length === 0) {
      throw createPublicError(400, "TikTok cần ít nhất 1 ảnh công khai để đăng (ảnh Drive cần bật proxy PUBLIC_BASE_URL).", {
        service: CHANNEL_KEY,
        context: "validate_media"
      });
    }

    if (photoUrls.length > MAX_PHOTO_COUNT) {
      throw createPublicError(400, `TikTok chỉ đăng tối đa ${MAX_PHOTO_COUNT} ảnh mỗi bài.`, {
        service: CHANNEL_KEY,
        context: "validate_media"
      });
    }

    const publishId = await initPhotoPost(accessToken, title, photoUrls);
    const result = await waitForPublishComplete(accessToken, publishId);

    return { postId: result.postId, permalinkUrl: "" };
  }

  // Video: ưu tiên đẩy binary (FILE_UPLOAD) nếu có buffer; nếu không, fallback PULL_FROM_URL.
  if (content.videoBuffer && content.videoBuffer.length > 0) {
    const { publishId, uploadUrl, chunkSize, totalChunkCount } = await initVideoFileUpload(
      accessToken,
      title,
      content.videoBuffer.length
    );
    await uploadVideoBuffer(uploadUrl, content.videoBuffer, chunkSize, totalChunkCount, content.videoContentType);
    const result = await waitForPublishComplete(accessToken, publishId);

    return { postId: result.postId, permalinkUrl: "" };
  }

  const videoUrl = String(content.videoUrl || "").trim();

  if (!isPublicHttpUrl(videoUrl) || !VIDEO_EXTENSION.test(videoUrl)) {
    throw createPublicError(400, "TikTok cần file video từ Drive (đã kết nối) hoặc 1 link video công khai có đuôi file rõ ràng (mp4/mov/webm...).", {
      service: CHANNEL_KEY,
      context: "validate_media"
    });
  }

  const publishId = await initVideoPost(accessToken, title, videoUrl);
  const result = await waitForPublishComplete(accessToken, publishId);

  return {
    postId: result.postId,
    permalinkUrl: ""
  };
}

async function disconnect(session) {
  const auth = getSessionAuth(session);
  const token = auth && auth.accessToken;

  clearTokens(session);

  if (!token || !isConfigured()) {
    return;
  }

  try {
    await axios.post(
      config.tiktok.revokeUrl,
      new URLSearchParams({
        client_key: config.tiktok.clientKey,
        client_secret: config.tiktok.clientSecret,
        token
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }
    );
  } catch (error) {
    logTiktokError("revoke_token", error);
  }
}

module.exports = {
  buildAuthorizationUrl,
  clearTokens,
  disconnect,
  exchangeCodeForTokens,
  getAccessToken,
  getProfile,
  getSessionAuth,
  getStatus,
  isConfigured,
  isConnected,
  publishContent,
  storeTokens
};
