const { config } = require("../config");
const facebookService = require("../services/facebook.service");
const googleDriveService = require("../services/google-drive.service");
const { CHANNELS, defineAdapter } = require("./adapter");

// Adapter Facebook: gom phần logic riêng của Facebook (resolve Page, readiness,
// publish) sau contract chung. Ủy quyền phần gọi Graph API cho facebook.service.

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

function isConfigured() {
  return Boolean(config.facebook.appId && config.facebook.appSecret);
}

// context: { brand, sessionPages }
function resolveAccount(context) {
  const brand = context.brand;
  const sessionPages = Array.isArray(context.sessionPages) ? context.sessionPages : [];

  if (!brand || !brand.facebookPageId) {
    return null;
  }

  const page = sessionPages.find((item) => item.id === brand.facebookPageId);

  if (!page) {
    return null;
  }

  return {
    id: page.id,
    name: page.name,
    pageAccessToken: page.pageAccessToken,
    canCreateContent: facebookService.canCreateContent(page)
  };
}

// context: { brand, account }
function getReadinessReasons(context) {
  const brand = context.brand;
  const account = context.account;
  const reasons = [];

  if (!brand) {
    reasons.push("Tác vụ chưa map được Primary Brand.");
    return reasons;
  }

  if (!brand.facebookPageId) {
    reasons.push("Brand chưa có Facebook Page ID.");
  }

  if (!account) {
    reasons.push("Tài khoản Facebook đang đăng nhập chưa quản lý Page của Brand này.");
    return reasons;
  }

  if (!account.canCreateContent) {
    reasons.push("Page không có quyền tạo bài viết.");
  }

  return reasons;
}

// context: { task } -> chuẩn hóa nội dung cho Facebook.
// contentType đã được suy ra ở lớp Notion (Phase 3 sẽ chuyển hẳn vào đây).
function normalizeContent(context) {
  const task = context.task;
  const message = buildMessageWithTags(task.caption, task.tags);

  return {
    content: {
      message,
      mediaUrls: task.mediaUrls,
      contentType: (context.contentType || task.contentType || "text"),
      postOptions: {
        placeId: task.placeId,
        tagIds: task.tagPeopleIds,
        title: task.title
      }
    },
    reasons: []
  };
}

// context: { account, content, driveAuth, mediaItems }
async function publish(context) {
  const account = context.account;
  const content = context.content;
  // Ưu tiên media đã resolve sẵn (để lớp Notion giữ được thông tin cho ghi chú lỗi).
  const mediaItems = Array.isArray(context.mediaItems)
    ? context.mediaItems
    : await googleDriveService.resolveMediaItems(content.mediaUrls, context.driveAuth);

  const result = await facebookService.createPageContent(account.id, account.pageAccessToken, {
    message: content.message,
    mediaUrls: content.mediaUrls,
    mediaItems,
    contentType: content.contentType,
    postOptions: content.postOptions
  });

  return {
    postId: result.postId,
    permalinkUrl: result.permalinkUrl,
    mediaItems
  };
}

module.exports = defineAdapter({
  key: CHANNELS.FACEBOOK,
  label: "Facebook",
  isConfigured,
  resolveAccount,
  getReadinessReasons,
  normalizeContent,
  publish
});
