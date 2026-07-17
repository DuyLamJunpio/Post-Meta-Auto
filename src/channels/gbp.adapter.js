const gbpService = require("../services/gbp.service");
const { CHANNELS, defineAdapter } = require("./adapter");

// Adapter Google Business Profile. Đăng "local post" theo location của brand
// (brand.gbpLocationId dạng accounts/{a}/locations/{l}). Ảnh phải là public URL
// (GBP tự fetch sourceUrl); chưa hỗ trợ video trong local post.

const VIDEO_EXTENSION = /\.(m4v|mov|mp4|webm)(\?.*)?$/i;
const IMAGE_EXTENSION = /\.(avif|gif|jpe?g|png|webp)(\?.*)?$/i;

function normalizePostTag(tag) {
  const value = String(tag || "").trim();

  if (!value) {
    return "";
  }

  return value.startsWith("#") || value.startsWith("@") ? value : `#${value}`;
}

function buildMessageWithTags(caption, tags) {
  const text = String(caption || "").trim();
  const tagText = Array.isArray(tags)
    ? tags.map(normalizePostTag).filter(Boolean).join(" ")
    : "";

  return [text, tagText].filter(Boolean).join("\n\n");
}

function isPublicHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || "").trim());
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

function isConfigured() {
  return gbpService.isConfigured();
}

// context: { brand, gbpAuth }
function resolveAccount(context) {
  const brand = context.brand;
  const auth = context.gbpAuth;

  if (!brand || !brand.gbpLocationId) {
    return null;
  }

  if (!auth || !(auth.accessToken || auth.refreshToken)) {
    return null;
  }

  if (!gbpService.isValidLocationName(brand.gbpLocationId)) {
    return null;
  }

  return {
    id: brand.gbpLocationId,
    name: brand.name || "",
    auth
  };
}

// context: { task, brand, account, gbpAuth }
function getReadinessReasons(context) {
  const brand = context.brand;
  const auth = context.gbpAuth;
  const task = context.task || {};
  const reasons = [];

  if (!isConfigured()) {
    reasons.push("Server chưa cấu hình Google Business Profile (thiếu GOOGLE_CLIENT_ID/SECRET/GOOGLE_BUSINESS_REDIRECT_URI).");
  }

  if (!brand || !brand.gbpLocationId) {
    reasons.push("Brand chưa có Google Business Profile ID.");
  } else if (!gbpService.isValidLocationName(brand.gbpLocationId)) {
    reasons.push("Google Business Profile ID phải có dạng accounts/{accountId}/locations/{locationId}.");
  }

  if (!auth || !(auth.accessToken || auth.refreshToken)) {
    reasons.push("Chưa kết nối tài khoản Google Business Profile để đăng.");
  }

  const mediaUrls = Array.isArray(task.mediaUrls) ? task.mediaUrls : [];
  const driveUrls = mediaUrls.filter(isDriveMediaUrl);
  const publicUrls = mediaUrls.filter((url) => !isDriveMediaUrl(url));
  const summary = buildMessageWithTags(task.caption, task.tags);

  // Media Drive riêng tư sẽ được proxy phát lại thành URL công khai — cần bật proxy + đã kết nối Drive.
  // Lưu ý: chưa biết Drive file là ảnh hay video tới lúc tải về; publish sẽ tự lọc bỏ video khỏi GBP.
  if (driveUrls.length > 0) {
    if (!context.proxyEnabled) {
      reasons.push("Cần cấu hình PUBLIC_BASE_URL (proxy media) để đăng ảnh Drive lên Google Business Profile.");
    } else if (!context.driveConnected) {
      reasons.push("Chưa kết nối Google Drive để đọc media Drive cho Google Business Profile.");
    }
  }

  const publicVideoUrls = publicUrls.filter((url) => VIDEO_EXTENSION.test(url));
  const publicPhotoUrls = publicUrls.filter((url) => !VIDEO_EXTENSION.test(url));

  if (publicVideoUrls.length > 0) {
    reasons.push("Google Business Profile chưa hỗ trợ đăng video trong bài local post.");
  }

  if (publicPhotoUrls.some((url) => !isPublicHttpUrl(url) || !IMAGE_EXTENSION.test(url))) {
    reasons.push("Google Business Profile cần link ảnh công khai có đuôi file rõ ràng (không dùng Google Drive riêng tư).");
  }

  const hasPotentialPhoto = publicPhotoUrls.length > 0 || driveUrls.length > 0;

  if (!summary && !hasPotentialPhoto) {
    reasons.push("Bài Google Business Profile cần nội dung chữ hoặc ít nhất 1 ảnh.");
  }

  return reasons;
}

// context: { task, publicMediaUrls } -> summary + ảnh cho GBP (ưu tiên proxy URL, bỏ video khỏi media).
function normalizeContent(context) {
  const task = context.task;
  const mediaUrls = resolveMediaUrls(context);
  const photoUrls = mediaUrls.filter((url) => !VIDEO_EXTENSION.test(url));

  return {
    content: {
      summary: buildMessageWithTags(task.caption, task.tags),
      mediaUrls: photoUrls,
      contentType: context.contentType || task.contentType || "auto"
    },
    reasons: []
  };
}

// context: { account, content }
async function publish(context) {
  const account = context.account;
  const content = context.content;

  const result = await gbpService.publishContent(account.id, account.auth, {
    summary: content.summary,
    mediaUrls: content.mediaUrls
  });

  return {
    postId: result.postId,
    permalinkUrl: result.permalinkUrl
  };
}

module.exports = defineAdapter({
  key: CHANNELS.GBP,
  label: "Google Business Profile",
  isConfigured,
  resolveAccount,
  getReadinessReasons,
  normalizeContent,
  publish
});
