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
  storeTokens,
  clearTokens,
  getSessionAuth,
  isConnected,
  getStatus
};
