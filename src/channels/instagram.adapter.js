const { config } = require("../config");
const instagramService = require("../services/instagram.service");
const { CHANNELS, defineAdapter } = require("./adapter");

// Adapter Instagram (Cách Facebook Login / Instagram Graph API qua graph.facebook.com).
// Đặc thù: đăng lên IG Business ĐÃ LIÊN KẾT với Facebook Page mà tài khoản FB đang đăng nhập quản lý,
// dùng chung Page Access Token — KHÔNG cần đăng nhập Instagram riêng.
// Media BẮT BUỘC là public URL (IG tự tải về); Google Drive riêng tư phải qua media proxy.

const IMAGE_EXTENSION = /\.(avif|gif|jpe?g|png|webp)(\?.*)?$/i;
const VIDEO_EXTENSION = /\.(m4v|mov|mp4|webm)(\?.*)?$/i;

function isPublicHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || "").trim());
}

function isSupportedMediaUrl(url) {
  return isPublicHttpUrl(url) && (IMAGE_EXTENSION.test(url) || VIDEO_EXTENSION.test(url));
}

// Link file Drive (riêng tư) — sẽ được proxy phát lại thành URL công khai lúc đăng.
function isDriveMediaUrl(url) {
  return /drive\.google\.com|googleusercontent\.com/i.test(String(url || ""));
}

// URL media để đăng: ưu tiên proxy URL công khai (đã có đuôi file); nếu chưa có thì dùng task.mediaUrls.
function resolveMediaUrls(context) {
  const task = context.task || {};

  if (Array.isArray(context.publicMediaUrls) && context.publicMediaUrls.length > 0) {
    return context.publicMediaUrls.map((item) => item.url).filter(Boolean);
  }

  return Array.isArray(task.mediaUrls) ? task.mediaUrls : [];
}

// IG đăng bằng Page token nên "đã cấu hình" = app Facebook đã có app id/secret.
function isConfigured() {
  return Boolean(config.facebook.appId && config.facebook.appSecret);
}

// Tìm Page (trong các Page tài khoản FB quản lý) có IG Business khớp brand.instagramAccountId.
function findLinkedPage(sessionPages, instagramAccountId) {
  if (!instagramAccountId) {
    return null;
  }

  return (
    sessionPages.find(
      (page) =>
        page.instagramBusinessAccount &&
        String(page.instagramBusinessAccount.id) === String(instagramAccountId)
    ) || null
  );
}

// context: { brand, sessionPages } -> tài khoản IG để đăng (id IG + Page Access Token).
function resolveAccount(context) {
  const brand = context.brand;
  const sessionPages = Array.isArray(context.sessionPages) ? context.sessionPages : [];

  if (!brand || !brand.instagramAccountId) {
    return null;
  }

  const page = findLinkedPage(sessionPages, brand.instagramAccountId);

  if (!page || !page.pageAccessToken) {
    return null;
  }

  return {
    id: String(brand.instagramAccountId),
    name: page.instagramBusinessAccount.username || page.name || "",
    accessToken: page.pageAccessToken,
    pageId: page.id
  };
}

// context: { task, brand, account, proxyEnabled, driveConnected }
function getReadinessReasons(context) {
  const brand = context.brand;
  const account = context.account;
  const task = context.task || {};
  const reasons = [];

  if (!isConfigured()) {
    reasons.push("Server chưa cấu hình Facebook App (thiếu FACEBOOK_APP_ID/SECRET).");
  }

  if (!brand || !brand.instagramAccountId) {
    reasons.push("Brand chưa có Instagram Account ID.");
  } else if (!account) {
    // account null = chưa đăng nhập FB, hoặc không quản lý Page nào liên kết IG này, hoặc Page chưa liên kết IG.
    reasons.push(
      "Tài khoản Facebook đang đăng nhập chưa quản lý Page nào liên kết với Instagram Account ID này (kiểm tra Page ↔ IG đã liên kết và quyền instagram_content_publish)."
    );
  }

  const mediaUrls = Array.isArray(task.mediaUrls) ? task.mediaUrls : [];
  const driveUrls = mediaUrls.filter(isDriveMediaUrl);
  const otherUrls = mediaUrls.filter((url) => !isDriveMediaUrl(url));

  if (mediaUrls.length === 0) {
    reasons.push("Instagram không đăng được bài chỉ có chữ; cần ít nhất 1 ảnh/video.");
  } else {
    // Media Drive riêng tư sẽ được proxy phát lại thành URL công khai — cần bật proxy + đã kết nối Drive.
    if (driveUrls.length > 0) {
      if (!context.proxyEnabled) {
        reasons.push("Cần cấu hình PUBLIC_BASE_URL (proxy media) để đăng ảnh/video từ Google Drive lên Instagram.");
      } else if (!context.driveConnected) {
        reasons.push("Chưa kết nối Google Drive để đọc media Drive cho Instagram.");
      }
    }

    if (otherUrls.some((url) => !isSupportedMediaUrl(url))) {
      reasons.push("Instagram cần link ảnh/video công khai có đuôi file rõ ràng (không dùng Google Drive riêng tư).");
    }
  }

  return reasons;
}

// context: { task, publicMediaUrls } -> caption + media cho Instagram (ưu tiên proxy URL).
function normalizeContent(context) {
  const task = context.task;

  return {
    content: {
      message: task.caption || "",
      mediaUrls: resolveMediaUrls(context),
      contentType: context.contentType || task.contentType || "auto"
    },
    reasons: []
  };
}

// context: { account, content } -> đăng bằng IG user id + Page Access Token.
async function publish(context) {
  const account = context.account;
  const content = context.content;

  const result = await instagramService.publishContent(account.id, account.accessToken, {
    message: content.message,
    mediaUrls: content.mediaUrls
  });

  return {
    postId: result.postId,
    permalinkUrl: result.permalinkUrl
  };
}

module.exports = defineAdapter({
  key: CHANNELS.INSTAGRAM,
  label: "Instagram",
  isConfigured,
  resolveAccount,
  getReadinessReasons,
  normalizeContent,
  publish
});
