const crypto = require("crypto");

const axios = require("axios");

const { config } = require("../config");

// Google Business Profile (GBP) — tái dùng Google OAuth (cùng client với Drive) nhưng
// scope riêng `business.manage` và session key riêng `googleBusiness`. Đăng bài qua
// Business Profile API v4 localPosts. Lưu ý: v4 localPosts cần Google allowlist mới đăng thật được.

const CHANNEL_KEY = "gbp";
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const LOCATION_NAME_PATTERN = /^accounts\/[^/]+\/locations\/[^/]+$/;

function createPublicError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details || null;
  return error;
}

function isConfigured() {
  return config.googleBusiness.enabled;
}

function ensureConfigured() {
  if (!isConfigured()) {
    throw createPublicError(
      500,
      "Chưa cấu hình Google Business Profile OAuth. Hãy thêm GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET và GOOGLE_BUSINESS_REDIRECT_URI vào file .env."
    );
  }
}

function isValidLocationName(name) {
  return LOCATION_NAME_PATTERN.test(String(name || "").trim());
}

function logBusinessError(context, error) {
  const apiError = error.response && error.response.data && error.response.data.error;

  console.error("[Google Business API]", {
    context,
    status: error.response && error.response.status,
    code: apiError && apiError.code,
    message: apiError && (apiError.message || apiError),
    transportCode: error.code,
    transportMessage: !error.response ? error.message : undefined
  });
}

function handleBusinessError(context, error, publicMessage, status = 502) {
  if (error.publicMessage) {
    throw error;
  }

  logBusinessError(context, error);
  const apiError = error.response && error.response.data && error.response.data.error;
  const providerMessage = apiError && (apiError.message || apiError);
  const responseStatus = error.response && error.response.status;
  let readableMessage = publicMessage;

  if (responseStatus === 401) {
    readableMessage = "Phiên kết nối Google Business Profile đã hết hạn hoặc chưa hợp lệ. Hãy kết nối lại.";
  } else if (responseStatus === 403) {
    readableMessage = "Tài khoản Google chưa có quyền đăng lên location này, hoặc Business Profile API chưa được cấp quyền (cần allowlist).";
  } else if (responseStatus === 404) {
    readableMessage = "Không tìm thấy location Google Business Profile. Kiểm tra lại Google Business Profile ID của brand.";
  }

  throw createPublicError(status, readableMessage, {
    service: CHANNEL_KEY,
    context,
    status: responseStatus,
    code: apiError && apiError.code,
    providerMessage: providerMessage || (!error.response ? error.message : null)
  });
}

function buildAuthorizationUrl(session) {
  ensureConfigured();

  const state = crypto.randomBytes(24).toString("hex");
  session.googleBusinessOAuthState = state;

  const params = new URLSearchParams({
    client_id: config.googleBusiness.clientId,
    redirect_uri: config.googleBusiness.redirectUri,
    response_type: "code",
    scope: config.googleBusiness.scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state
  });

  return `${config.googleBusiness.oauthDialogUrl}?${params.toString()}`;
}

function getSessionAuth(session) {
  return session && session.googleBusiness ? session.googleBusiness : null;
}

function isConnected(sessionOrAuth) {
  const auth = sessionOrAuth && sessionOrAuth.googleBusiness ? sessionOrAuth.googleBusiness : sessionOrAuth;
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
      client_id: config.googleBusiness.clientId,
      client_secret: config.googleBusiness.clientSecret,
      redirect_uri: config.googleBusiness.redirectUri,
      grant_type: "authorization_code"
    });

    const response = await axios.post(config.googleBusiness.tokenUrl, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    if (!response.data || !response.data.access_token) {
      throw createPublicError(502, "Google không trả về access token Business Profile.");
    }

    return response.data;
  } catch (error) {
    handleBusinessError("exchange_code", error, "Không kết nối được Google Business Profile.");
  }
}

function storeTokens(session, tokens) {
  const existing = getSessionAuth(session) || {};
  const expiresInMs = Number(tokens.expires_in || 3600) * 1000;

  session.googleBusiness = {
    accessToken: tokens.access_token || existing.accessToken,
    refreshToken: tokens.refresh_token || existing.refreshToken,
    scope: tokens.scope || existing.scope || config.googleBusiness.scopes.join(" "),
    tokenType: tokens.token_type || existing.tokenType || "Bearer",
    connectedAt: existing.connectedAt || new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString()
  };

  return session.googleBusiness;
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
    throw createPublicError(401, "Google Business Profile chưa được kết nối hoặc thiếu refresh token.");
  }

  try {
    const body = new URLSearchParams({
      client_id: config.googleBusiness.clientId,
      client_secret: config.googleBusiness.clientSecret,
      refresh_token: auth.refreshToken,
      grant_type: "refresh_token"
    });

    const response = await axios.post(config.googleBusiness.tokenUrl, body, {
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
    handleBusinessError("refresh_token", error, "Không làm mới được quyền truy cập Google Business Profile.", 401);
  }
}

async function getAccessToken(auth) {
  if (!auth || (!auth.accessToken && !auth.refreshToken)) {
    throw createPublicError(401, "Chưa kết nối Google Business Profile để đăng bài.");
  }

  if (needsRefresh(auth)) {
    return refreshAccessToken(auth);
  }

  return auth.accessToken;
}

// Liệt kê mọi location mà tài khoản Google đang kết nối quản lý, kèm ID dạng
// "accounts/{accountId}/locations/{locationId}" để copy vào cột Brands.
// Dùng Account Management API (list accounts) + Business Information API (list locations).
async function listLocations(auth) {
  ensureConfigured();

  const accessToken = await getAccessToken(auth);
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  let accounts = [];

  try {
    const response = await axios.get(`${config.googleBusiness.accountApiBaseUrl}/accounts`, {
      headers: authHeader,
      params: { pageSize: 100 }
    });
    accounts = (response.data && response.data.accounts) || [];
  } catch (error) {
    handleBusinessError("list_accounts", error, "Không lấy được danh sách tài khoản Google Business Profile.");
  }

  const results = [];

  for (const account of accounts) {
    // account.name có dạng "accounts/{accountId}".
    if (!account || !account.name) {
      continue;
    }

    try {
      const response = await axios.get(`${config.googleBusiness.infoApiBaseUrl}/${account.name}/locations`, {
        headers: authHeader,
        params: {
          pageSize: 100,
          readMask: "name,title,storefrontAddress"
        }
      });
      const locations = (response.data && response.data.locations) || [];

      for (const location of locations) {
        // location.name có dạng "locations/{locationId}" -> ghép account để ra id v4.
        if (!location || !location.name) {
          continue;
        }

        const address = location.storefrontAddress && Array.isArray(location.storefrontAddress.addressLines)
          ? location.storefrontAddress.addressLines.join(", ")
          : "";

        results.push({
          id: `${account.name}/${location.name}`,
          title: location.title || "",
          account: account.accountName || account.name,
          address
        });
      }
    } catch (error) {
      // Một account lỗi (thiếu quyền...) không nên chặn toàn bộ; log rồi bỏ qua.
      logBusinessError("list_locations", error);
    }
  }

  return results;
}

// content: { summary, mediaUrls (chỉ ảnh public), languageCode? }
// locationName: "accounts/{accountId}/locations/{locationId}"
async function publishContent(locationName, auth, content) {
  ensureConfigured();

  const summary = String(content.summary || "").trim();
  const photoUrls = Array.isArray(content.mediaUrls) ? content.mediaUrls : [];

  if (!isValidLocationName(locationName)) {
    throw createPublicError(400, "Google Business Profile ID phải có dạng accounts/{accountId}/locations/{locationId}.", {
      service: CHANNEL_KEY,
      context: "validate_location"
    });
  }

  if (!summary && photoUrls.length === 0) {
    throw createPublicError(400, "Bài Google Business Profile cần nội dung chữ hoặc ít nhất 1 ảnh.", {
      service: CHANNEL_KEY,
      context: "validate_content"
    });
  }

  const accessToken = await getAccessToken(auth);
  const body = {
    languageCode: content.languageCode || "vi",
    summary,
    topicType: "STANDARD"
  };

  if (photoUrls.length > 0) {
    body.media = photoUrls.map((url) => ({ mediaFormat: "PHOTO", sourceUrl: url }));
  }

  try {
    const response = await axios.post(
      `${config.googleBusiness.apiBaseUrl}/${locationName}/localPosts`,
      body,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );
    const data = response.data || {};

    return {
      postId: data.name || "",
      permalinkUrl: data.searchUrl || ""
    };
  } catch (error) {
    handleBusinessError("create_local_post", error, "Không đăng được bài lên Google Business Profile.");
  }
}

async function disconnect(session) {
  const auth = getSessionAuth(session);
  const token = auth && (auth.refreshToken || auth.accessToken);

  delete session.googleBusiness;

  if (!token || !isConfigured()) {
    return;
  }

  try {
    await axios.post(
      config.googleBusiness.revokeUrl,
      new URLSearchParams({ token }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );
  } catch (error) {
    logBusinessError("revoke_token", error);
  }
}

module.exports = {
  buildAuthorizationUrl,
  disconnect,
  exchangeCodeForTokens,
  getAccessToken,
  getSessionAuth,
  getStatus,
  isConfigured,
  isConnected,
  isValidLocationName,
  listLocations,
  publishContent,
  storeTokens
};
