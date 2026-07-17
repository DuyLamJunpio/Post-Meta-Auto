const crypto = require("crypto");
const axios = require("axios");

const { config } = require("../config");

function createPublicError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details || null;
  return error;
}

function handleInstagramError(context, error, publicMessage) {
  const responseData = error.response && error.response.data;
  const providerError = responseData && (responseData.error || responseData);

  console.error("[Instagram API]", {
    context,
    status: error.response && error.response.status,
    type: providerError && (providerError.type || providerError.error_type),
    code: providerError && (providerError.code || providerError.error_code),
    message: providerError && (providerError.message || providerError.error_message),
    transportCode: error.code,
    transportMessage: !error.response ? error.message : undefined
  });

  if (!error.response) {
    throw createPublicError(
      502,
      "Backend không kết nối được Instagram API. Kiểm tra internet, proxy/firewall hoặc cách bạn đang chạy server."
    );
  }

  throw createPublicError(502, publicMessage, {
    service: "instagram",
    context,
    status: error.response.status,
    providerMessage: providerError && (providerError.message || providerError.error_message)
  });
}

function isConfigured() {
  return config.instagram.enabled;
}

function ensureConfigured() {
  if (!isConfigured()) {
    throw createPublicError(
      400,
      "Chưa cấu hình Instagram API. Cần INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET và INSTAGRAM_REDIRECT_URI trong .env."
    );
  }
}

function buildAuthorizationUrl(session) {
  ensureConfigured();

  const state = crypto.randomBytes(24).toString("hex");
  session.instagramOAuthState = state;

  const params = new URLSearchParams({
    client_id: config.instagram.appId,
    redirect_uri: config.instagram.redirectUri,
    scope: config.instagram.scopes.join(","),
    response_type: "code",
    state
  });

  return `${config.instagram.oauthDialogUrl}?${params.toString()}`;
}

async function exchangeCodeForShortLivedToken(code) {
  ensureConfigured();

  try {
    const body = new URLSearchParams({
      client_id: config.instagram.appId,
      client_secret: config.instagram.appSecret,
      grant_type: "authorization_code",
      redirect_uri: config.instagram.redirectUri,
      code
    });

    const response = await axios.post(config.instagram.tokenUrl, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    if (!response.data || !response.data.access_token) {
      throw createPublicError(502, "Instagram không trả về access token.");
    }

    return response.data;
  } catch (error) {
    if (error.publicMessage) {
      throw error;
    }

    handleInstagramError("exchange_short_lived_token", error, "Không đổi được code lấy token Instagram.");
  }
}

async function exchangeForLongLivedToken(shortLivedAccessToken) {
  ensureConfigured();

  try {
    const response = await axios.get(`${config.instagram.graphApiBaseUrl}/access_token`, {
      params: {
        grant_type: "ig_exchange_token",
        client_secret: config.instagram.appSecret,
        access_token: shortLivedAccessToken
      }
    });

    return response.data || {};
  } catch (error) {
    if (error.publicMessage) {
      throw error;
    }

    handleInstagramError("exchange_long_lived_token", error, "Không đổi được token Instagram dài hạn.");
  }
}

async function refreshLongLivedToken(accessToken) {
  ensureConfigured();

  try {
    const response = await axios.get(`${config.instagram.graphApiBaseUrl}/refresh_access_token`, {
      params: {
        grant_type: "ig_refresh_token",
        access_token: accessToken
      }
    });

    return response.data || {};
  } catch (error) {
    if (error.publicMessage) {
      throw error;
    }

    handleInstagramError("refresh_long_lived_token", error, "Không refresh được token Instagram.");
  }
}

async function getProfile(accessToken) {
  ensureConfigured();

  try {
    const response = await axios.get(`${config.instagram.graphApiBaseUrl}/me`, {
      params: {
        fields: "id,username,account_type,media_count",
        access_token: accessToken
      }
    });

    return response.data || {};
  } catch (error) {
    handleInstagramError("get_profile", error, "Không lấy được thông tin tài khoản Instagram.");
  }
}

const IMAGE_EXTENSION = /\.(avif|gif|jpe?g|png|webp)(\?.*)?$/i;
const VIDEO_EXTENSION = /\.(m4v|mov|mp4|webm)(\?.*)?$/i;
const MAX_STATUS_POLLS = 30;
const STATUS_POLL_INTERVAL_MS = 5000;

// Content Publishing dùng Facebook Graph API (graph.facebook.com) với IG Business liên kết Page
// + Page Access Token — KHÔNG dùng graph.instagram.com/login IG riêng. Các endpoint media/
// media_publish giống hệt nhau trên graph.facebook.com.
const PUBLISH_API_BASE = config.facebook.graphApiBaseUrl;

function isPublicHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || "").trim());
}

function classifyMediaUrl(url) {
  if (IMAGE_EXTENSION.test(url)) {
    return "image";
  }

  if (VIDEO_EXTENSION.test(url)) {
    return "video";
  }

  return "unknown";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Instagram Content Publishing API: tạo media container -> (video: chờ FINISHED) -> media_publish.
// Media BẮT BUỘC là public URL (IG tự tải về); không upload binary như Facebook.
async function createMediaContainer(igUserId, accessToken, params) {
  try {
    const response = await axios.post(
      `${PUBLISH_API_BASE}/${igUserId}/media`,
      new URLSearchParams({ ...params, access_token: accessToken }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    if (!response.data || !response.data.id) {
      throw createPublicError(502, "Instagram không trả về media container id.", {
        service: "instagram",
        context: "create_media_container"
      });
    }

    return response.data.id;
  } catch (error) {
    if (error.publicMessage) {
      throw error;
    }

    handleInstagramError("create_media_container", error, "Không tạo được media container Instagram.");
  }
}

async function waitForContainerReady(containerId, accessToken) {
  for (let attempt = 0; attempt < MAX_STATUS_POLLS; attempt += 1) {
    let statusCode;

    try {
      const response = await axios.get(`${PUBLISH_API_BASE}/${containerId}`, {
        params: { fields: "status_code", access_token: accessToken }
      });
      statusCode = response.data && response.data.status_code;
    } catch (error) {
      handleInstagramError("check_container_status", error, "Không kiểm tra được trạng thái media Instagram.");
    }

    if (statusCode === "FINISHED") {
      return;
    }

    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      throw createPublicError(502, `Instagram xử lý media thất bại (trạng thái ${statusCode}).`, {
        service: "instagram",
        context: "container_status",
        providerMessage: statusCode
      });
    }

    await delay(STATUS_POLL_INTERVAL_MS);
  }

  throw createPublicError(504, "Instagram xử lý media quá lâu (timeout chờ FINISHED).", {
    service: "instagram",
    context: "container_status_timeout"
  });
}

async function publishContainer(igUserId, accessToken, creationId) {
  try {
    const response = await axios.post(
      `${PUBLISH_API_BASE}/${igUserId}/media_publish`,
      new URLSearchParams({ creation_id: creationId, access_token: accessToken }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    if (!response.data || !response.data.id) {
      throw createPublicError(502, "Instagram không trả về media id sau khi publish.", {
        service: "instagram",
        context: "media_publish"
      });
    }

    return response.data.id;
  } catch (error) {
    if (error.publicMessage) {
      throw error;
    }

    handleInstagramError("media_publish", error, "Không publish được bài Instagram.");
  }
}

async function getPermalink(mediaId, accessToken) {
  try {
    const response = await axios.get(`${PUBLISH_API_BASE}/${mediaId}`, {
      params: { fields: "permalink", access_token: accessToken }
    });

    return (response.data && response.data.permalink) || null;
  } catch (error) {
    // Không chặn publish nếu chỉ thiếu permalink.
    console.error("[Instagram API] Không lấy được permalink:", error.message);
    return null;
  }
}

// content: { message (caption), mediaUrls: [public urls] }
// Trả về { postId, permalinkUrl } đồng bộ contract với facebook.service.createPageContent.
async function publishContent(igUserId, accessToken, content) {
  const caption = content.message || "";
  const mediaUrls = (Array.isArray(content.mediaUrls) ? content.mediaUrls : []).filter(isPublicHttpUrl);

  if (mediaUrls.length === 0) {
    throw createPublicError(400, "Instagram cần ít nhất 1 link ảnh/video công khai để đăng.", {
      service: "instagram",
      context: "validate_media"
    });
  }

  const kinds = mediaUrls.map(classifyMediaUrl);

  if (kinds.includes("unknown")) {
    throw createPublicError(400, "Instagram cần link ảnh/video có đuôi file rõ ràng (jpg/png/mp4...).", {
      service: "instagram",
      context: "classify_media"
    });
  }

  const hasVideo = kinds.includes("video");
  const hasImage = kinds.includes("image");
  let creationId;

  if (mediaUrls.length === 1) {
    // Ảnh đơn hoặc video (REELS) đơn.
    creationId = hasVideo
      ? await createMediaContainer(igUserId, accessToken, {
          media_type: "REELS",
          video_url: mediaUrls[0],
          caption
        })
      : await createMediaContainer(igUserId, accessToken, {
          image_url: mediaUrls[0],
          caption
        });

    if (hasVideo) {
      await waitForContainerReady(creationId, accessToken);
    }
  } else {
    // Carousel: hỗ trợ ảnh; trộn video cần poll từng child. Giai đoạn này chỉ nhận toàn ảnh.
    if (hasVideo) {
      throw createPublicError(400, "Carousel Instagram nhiều media hiện chỉ hỗ trợ toàn ảnh.", {
        service: "instagram",
        context: "validate_carousel"
      });
    }

    if (!hasImage) {
      throw createPublicError(400, "Carousel Instagram cần các link ảnh công khai.", {
        service: "instagram",
        context: "validate_carousel"
      });
    }

    const childIds = [];

    for (const url of mediaUrls) {
      childIds.push(
        await createMediaContainer(igUserId, accessToken, {
          image_url: url,
          is_carousel_item: "true"
        })
      );
    }

    creationId = await createMediaContainer(igUserId, accessToken, {
      media_type: "CAROUSEL",
      children: childIds.join(","),
      caption
    });
  }

  const mediaId = await publishContainer(igUserId, accessToken, creationId);
  const permalinkUrl = await getPermalink(mediaId, accessToken);

  return { postId: mediaId, permalinkUrl };
}

async function exchangeCodeForTokens(code) {
  const shortLived = await exchangeCodeForShortLivedToken(code);
  const longLived = await exchangeForLongLivedToken(shortLived.access_token);
  const accessToken = longLived.access_token || shortLived.access_token;
  const expiresIn = Number(longLived.expires_in || shortLived.expires_in || 0);

  return {
    accessToken,
    userId: String(shortLived.user_id || ""),
    expiresIn,
    expiresAt: expiresIn > 0 ? Date.now() + expiresIn * 1000 : null
  };
}

function storeTokens(session, tokens, profile) {
  session.instagramUser = {
    id: String(profile.id || tokens.userId || ""),
    username: profile.username || "",
    accountType: profile.account_type || "",
    mediaCount: typeof profile.media_count === "number" ? profile.media_count : null,
    accessToken: tokens.accessToken,
    expiresAt: tokens.expiresAt || null
  };
}

function clearTokens(session) {
  delete session.instagramUser;
  delete session.instagramOAuthState;
}

function getSessionAuth(session) {
  return session && session.instagramUser ? session.instagramUser : null;
}

function isConnected(session) {
  const auth = getSessionAuth(session);
  return Boolean(auth && auth.accessToken && auth.id);
}

function getStatus(session) {
  const auth = getSessionAuth(session);

  return {
    configured: isConfigured(),
    connected: isConnected(session),
    redirectUri: config.instagram.redirectUri,
    user: auth
      ? {
          id: auth.id,
          username: auth.username,
          accountType: auth.accountType,
          mediaCount: auth.mediaCount,
          expiresAt: auth.expiresAt
        }
      : null
  };
}

module.exports = {
  isConfigured,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshLongLivedToken,
  getProfile,
  publishContent,
  storeTokens,
  clearTokens,
  getSessionAuth,
  isConnected,
  getStatus
};
