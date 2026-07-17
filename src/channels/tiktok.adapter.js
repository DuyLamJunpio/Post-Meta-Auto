const tiktokService = require("../services/tiktok.service");
const { CHANNELS, defineAdapter } = require("./adapter");

// Adapter TikTok (Content Posting API — direct post).
// Hỗ trợ 2 loại bài:
//   - VIDEO (1 video/bài): ưu tiên đẩy binary FILE_UPLOAD từ buffer Drive (khỏi verify domain),
//     fallback PULL_FROM_URL nếu chỉ có link công khai.
//   - ẢNH (1..35 ảnh): chỉ hỗ trợ PULL_FROM_URL nên BẮT BUỘC URL công khai (qua proxy).
// Đăng theo tài khoản TikTok đang đăng nhập trong session, khớp brand.tiktokAccountId (open_id).

const VIDEO_EXTENSION = /\.(m4v|mov|mp4|webm)(\?.*)?$/i;
const IMAGE_EXTENSION = /\.(avif|gif|jpe?g|png|webp)(\?.*)?$/i;
const MAX_PHOTO_COUNT = 35;

function normalizePostTag(tag) {
  const value = String(tag || "").trim();

  if (!value) {
    return "";
  }

  return value.startsWith("#") || value.startsWith("@") ? value : `#${value}`;
}

function buildTitleWithTags(caption, tags) {
  const text = String(caption || "").trim();
  const tagText = Array.isArray(tags)
    ? tags.map(normalizePostTag).filter(Boolean).join(" ")
    : "";

  return [text, tagText].filter(Boolean).join(" ").trim();
}

function isPublicHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || "").trim());
}

function isSupportedVideoUrl(url) {
  return isPublicHttpUrl(url) && VIDEO_EXTENSION.test(url);
}

function isSupportedImageUrl(url) {
  return isPublicHttpUrl(url) && IMAGE_EXTENSION.test(url);
}

// Link file Drive (riêng tư) — sẽ được proxy phát lại thành URL công khai lúc đăng.
function isDriveMediaUrl(url) {
  return /drive\.google\.com|googleusercontent\.com/i.test(String(url || ""));
}

// mediaItem là video? (buffer có contentType video/* hoặc tên/URL có đuôi video).
function isVideoItem(item) {
  if (!item) {
    return false;
  }

  if (typeof item.contentType === "string" && item.contentType.startsWith("video/")) {
    return true;
  }

  return VIDEO_EXTENSION.test(item.filename || item.originalUrl || item.url || "");
}

function isConfigured() {
  return tiktokService.isConfigured();
}

// context: { brand, tiktokAuth } -> tài khoản TikTok để đăng.
// Chỉ hợp lệ khi tài khoản đang đăng nhập khớp brand.tiktokAccountId (open_id).
function resolveAccount(context) {
  const brand = context.brand;
  const auth = context.tiktokAuth;

  if (!brand || !brand.tiktokAccountId) {
    return null;
  }

  if (!auth || !(auth.accessToken || auth.refreshToken) || !auth.openId) {
    return null;
  }

  if (String(brand.tiktokAccountId) !== String(auth.openId)) {
    return null;
  }

  return {
    id: auth.openId,
    name: auth.displayName || "",
    auth
  };
}

// context: { task, brand, account, tiktokAuth, proxyEnabled, driveConnected }
function getReadinessReasons(context) {
  const brand = context.brand;
  const auth = context.tiktokAuth;
  const task = context.task || {};
  const reasons = [];

  if (!isConfigured()) {
    reasons.push("Server chưa cấu hình TikTok (thiếu TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI).");
  }

  if (!brand || !brand.tiktokAccountId) {
    reasons.push("Brand chưa có TikTok Account ID.");
  }

  if (!auth || !(auth.accessToken || auth.refreshToken) || !auth.openId) {
    reasons.push("Chưa kết nối tài khoản TikTok để đăng.");
  } else if (brand && brand.tiktokAccountId && String(brand.tiktokAccountId) !== String(auth.openId)) {
    reasons.push("Tài khoản TikTok đang kết nối không khớp TikTok Account ID của brand.");
  }

  const mediaUrls = Array.isArray(task.mediaUrls) ? task.mediaUrls : [];
  const driveUrls = mediaUrls.filter(isDriveMediaUrl);
  const publicUrls = mediaUrls.filter((url) => !isDriveMediaUrl(url));
  const publicVideos = publicUrls.filter(isSupportedVideoUrl);
  const publicPhotos = publicUrls.filter(isSupportedImageUrl);

  if (mediaUrls.length === 0) {
    reasons.push("TikTok cần ít nhất 1 video hoặc 1 ảnh để đăng (không đăng bài chỉ có chữ).");
  } else {
    // Media Drive riêng tư: video dùng buffer, ảnh dùng proxy — chưa biết loại tới lúc tải về,
    // nên yêu cầu đủ cả proxy + Drive để an toàn cho cả hai nhánh.
    if (driveUrls.length > 0) {
      if (!context.proxyEnabled) {
        reasons.push("Cần cấu hình PUBLIC_BASE_URL (proxy media) để đăng ảnh/video Drive lên TikTok.");
      } else if (!context.driveConnected) {
        reasons.push("Chưa kết nối Google Drive để đọc media Drive cho TikTok.");
      }
    }

    const badPublic = publicUrls.filter((url) => !isSupportedVideoUrl(url) && !isSupportedImageUrl(url));

    if (badPublic.length > 0) {
      reasons.push("TikTok cần link video/ảnh công khai có đuôi file rõ ràng (không dùng Google Drive riêng tư).");
    }

    if (publicVideos.length > 0 && publicPhotos.length > 0) {
      reasons.push("TikTok chỉ đăng video HOẶC ảnh trong một bài, không trộn lẫn.");
    }

    if (publicVideos.length > 1) {
      reasons.push("TikTok chỉ đăng được 1 video mỗi bài.");
    }

    if (publicPhotos.length > MAX_PHOTO_COUNT) {
      reasons.push(`TikTok chỉ đăng tối đa ${MAX_PHOTO_COUNT} ảnh mỗi bài.`);
    }
  }

  return reasons;
}

// context: { task, publicMediaUrls } -> title + URL công khai đã phân loại (video/ảnh).
// Quyết định cuối video-vs-ảnh nằm ở publish (dựa vào mediaItems buffer).
function normalizeContent(context) {
  const task = context.task;
  const publicItems = Array.isArray(context.publicMediaUrls) ? context.publicMediaUrls : [];

  let videoUrls = [];
  let photoUrls = [];

  if (publicItems.length > 0) {
    // publicMediaUrls: [{ url, contentType }] — phân loại theo contentType hoặc đuôi URL.
    for (const item of publicItems) {
      const url = item && item.url;
      if (!url) {
        continue;
      }
      const isVideo =
        (typeof item.contentType === "string" && item.contentType.startsWith("video/")) ||
        VIDEO_EXTENSION.test(url);
      if (isVideo) {
        videoUrls.push(url);
      } else {
        photoUrls.push(url);
      }
    }
  } else {
    const mediaUrls = Array.isArray(task.mediaUrls) ? task.mediaUrls : [];
    videoUrls = mediaUrls.filter(isSupportedVideoUrl);
    photoUrls = mediaUrls.filter(isSupportedImageUrl);
  }

  return {
    content: {
      title: buildTitleWithTags(task.caption, task.tags),
      videoUrl: videoUrls[0] || "",
      photoUrls,
      contentType: context.contentType || task.contentType || "auto"
    },
    reasons: []
  };
}

// context: { account, content, mediaItems }
// Ưu tiên video (buffer FILE_UPLOAD > URL PULL); nếu không có video thì đăng ảnh (PULL public URL).
async function publish(context) {
  const account = context.account;
  const content = context.content;
  const mediaItems = Array.isArray(context.mediaItems) ? context.mediaItems : [];

  const videoBufferItem = mediaItems.find((item) => item && item.kind === "buffer" && isVideoItem(item));
  const hasVideo = Boolean(videoBufferItem) || Boolean(content.videoUrl) || mediaItems.some(isVideoItem);

  let payload;

  if (hasVideo) {
    payload = {
      mediaType: "video",
      title: content.title,
      videoBuffer: videoBufferItem ? videoBufferItem.buffer : null,
      videoContentType: videoBufferItem ? videoBufferItem.contentType : null,
      videoUrl: content.videoUrl
    };
  } else {
    payload = {
      mediaType: "photo",
      title: content.title,
      photoUrls: Array.isArray(content.photoUrls) ? content.photoUrls : []
    };
  }

  const result = await tiktokService.publishContent(account.id, account.auth, payload);

  return {
    postId: result.postId,
    permalinkUrl: result.permalinkUrl
  };
}

module.exports = defineAdapter({
  key: CHANNELS.TIKTOK,
  label: "TikTok",
  isConfigured,
  resolveAccount,
  getReadinessReasons,
  normalizeContent,
  publish
});
