const { Client } = require("@notionhq/client");

const { config } = require("../config");
const facebookService = require("./facebook.service");
const googleDriveService = require("./google-drive.service");
const pageVisibilityService = require("./page-visibility.service");

const notion = new Client({
  auth: config.notion.apiToken
});

const CONTENT_PROPS = {
  title: "Post Title",
  caption: "Caption",
  tags: "Tags",
  postType: "Post Type",
  postFormat: "Post Format",
  mediaUrls: "Media URLs",
  legacyMediaUrls: "Final Media URLs",
  imageUrls: "Final Image URLs",
  videoUrls: "Final Video URLs",
  tagPeopleUrls: "Tag People URLs",
  locationName: "Location Name",
  locationFacebookUrl: "Location Facebook URL",
  feelingActivity: "Feeling/Activity",
  messengerCta: "Messenger CTA",
  callPhoneNumber: "Call Phone Number",
  shareToStory: "Share To Story",
  sourceFolderUrl: "Source Folder URL",
  autoPublish: "Auto Publish",
  publishStatus: "Publish Status",
  contentWorkflow: "Content Workflow",
  approvalStatus: "Approval Status",
  publishMode: "Publish Mode",
  channel: "Channel",
  publishAt: "Publish At",
  timezone: "Timezone",
  primaryBrand: "Primary Brand",
  facebookPostId: "Facebook Post ID",
  facebookPostUrl: "Facebook Post URL",
  publishedAt: "Published At",
  lastSyncedAt: "Last Synced At",
  retryCount: "Retry Count",
  manualActionRequired: "Manual Action Required",
  automationKey: "Automation Key",
  collaboratorBrand: "Collaborator Brand",
  notes: "Notes",
  errorMessage: "Error Message"
};

const BRAND_PROPS = {
  name: "Brand Name",
  code: "Brand Code",
  facebookPageId: "Facebook Page ID",
  facebookPageName: "Facebook Page Name",
  active: "Active",
  connected: "Connected",
  timezone: "Timezone"
};

const APPROVED_STATUS = "Đã duyệt";
const COMPLETED_WORKFLOW_STATUS = "Hoàn thành nội dung";
const UNSCHEDULED_STATUS = "Chưa lên lịch";
const SCHEDULED_STATUS = "Đã lên lịch";
const PUBLISHING_STATUS = "Đang đăng";
const PUBLISHED_STATUS = "Đã đăng";
const FAILED_STATUS = "Lỗi đăng";
const OVERDUE_PUBLISH_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_COUNT = 3;

function createPublicError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details || null;
  return error;
}

function logNotionError(context, error) {
  console.error("[Notion API]", {
    context,
    status: error.status,
    code: error.code,
    message: error.message,
    body: error.body
  });
}

function handleNotionError(context, error, publicMessage) {
  logNotionError(context, error);
  throw createPublicError(502, publicMessage);
}

function richTextContent(value) {
  if (value === null || value === undefined || String(value).length === 0) {
    return { rich_text: [] };
  }

  return {
    rich_text: [
      {
        text: {
          content: String(value).slice(0, 1900)
        }
      }
    ]
  };
}

function selectContent(value) {
  return {
    select: {
      name: value
    }
  };
}

function getPlainText(property) {
  if (!property) {
    return "";
  }

  if (property.type === "title") {
    return property.title.map((part) => part.plain_text || "").join("");
  }

  if (property.type === "rich_text") {
    return property.rich_text.map((part) => part.plain_text || "").join("");
  }

  if (property.type === "select") {
    return property.select ? property.select.name : "";
  }

  if (property.type === "status") {
    return property.status ? property.status.name : "";
  }

  if (property.type === "url") {
    return property.url || "";
  }

  if (property.type === "phone_number") {
    return property.phone_number || "";
  }

  if (property.type === "number") {
    return property.number === null || property.number === undefined ? "" : String(property.number);
  }

  if (property.type === "checkbox") {
    return property.checkbox ? "true" : "false";
  }

  if (property.type === "multi_select") {
    return property.multi_select.map((option) => option.name || "").filter(Boolean).join(", ");
  }

  if (property.type === "files") {
    return property.files
      .map((file) => {
        if (file.type === "external") {
          return file.external.url;
        }

        if (file.type === "file") {
          return file.file.url;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function getProperty(page, propertyName) {
  return page.properties ? page.properties[propertyName] : null;
}

function getText(page, propertyName) {
  return getPlainText(getProperty(page, propertyName)).trim();
}

function getFirstText(page, propertyNames) {
  for (const propertyName of propertyNames) {
    const value = getText(page, propertyName);

    if (value) {
      return value;
    }
  }

  return "";
}

function getCheckbox(page, propertyName) {
  const property = getProperty(page, propertyName);
  return property && property.type === "checkbox" ? property.checkbox : false;
}

function getNumber(page, propertyName) {
  const property = getProperty(page, propertyName);
  return property && property.type === "number" && typeof property.number === "number"
    ? property.number
    : 0;
}

function getDateStart(page, propertyName) {
  const property = getProperty(page, propertyName);
  return property && property.type === "date" && property.date ? property.date.start : null;
}

function getRelationIds(page, propertyName) {
  const property = getProperty(page, propertyName);
  return property && property.type === "relation" ? property.relation.map((item) => item.id) : [];
}

function parseMediaUrls(value) {
  const text = String(value || "");
  const matches = text.match(/https?:\/\/[^\s,]+/g);
  return matches
    ? matches.map((url) => url.trim().replace(/[)\].,;]+$/g, "")).filter(Boolean)
    : [];
}

function parseFacebookRefs(value) {
  const text = String(value || "");
  const matches = text.match(/https?:\/\/[^\s,;]+|\b\d{5,}\b/g) || [];

  return matches
    .map((raw) => raw.trim().replace(/[)\].,;]+$/g, ""))
    .filter(Boolean)
    .map((raw) => ({
      raw,
      id: getFacebookNumericId(raw)
    }));
}

function normalizePostTag(tag) {
  const value = String(tag || "").trim();

  if (!value) {
    return "";
  }

  return value.startsWith("#") || value.startsWith("@") ? value : `#${value}`;
}

function parseTags(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(/[,\n;]+/)
        .map(normalizePostTag)
        .filter(Boolean)
    )
  );
}

function buildMessageWithTags(caption, tags) {
  const text = String(caption || "").trim();
  const tagText = Array.isArray(tags) ? tags.map(normalizePostTag).filter(Boolean).join(" ") : "";

  return [text, tagText].filter(Boolean).join("\n\n");
}

function normalizePropertyName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function getNumberedMediaIndex(propertyName) {
  const normalizedName = normalizePropertyName(propertyName);
  const match = normalizedName.match(
    /^(?:final\s+media\s+url(?:s)?|final\s+image\s+url(?:s)?|media\s+url|image\s+url|photo\s+url|drive\s+url|link\s+anh|anh|image|photo)\s*(?:#|\+|-|_|:)?\s*(\d+)$/
  );

  return match ? Number(match[1]) : null;
}

function getNumberedVideoIndex(propertyName) {
  const normalizedName = normalizePropertyName(propertyName);
  const match = normalizedName.match(
    /^(?:final\s+video\s+url(?:s)?|video\s+url|reel\s+url|drive\s+video\s+url|link\s+video|video|reel)\s*(?:#|\+|-|_|:)?\s*(\d+)$/
  );

  return match ? Number(match[1]) : null;
}

function getGoogleDriveFileId(url) {
  try {
    const parsedUrl = new URL(url);

    if (!/(\.|^)googleusercontent\.com$/.test(parsedUrl.hostname) && !/(\.|^)google\.com$/.test(parsedUrl.hostname)) {
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

function getFacebookNumericId(value) {
  const text = String(value || "").trim();

  if (/^\d{5,}$/.test(text)) {
    return text;
  }

  try {
    const parsedUrl = new URL(text);
    const id = parsedUrl.searchParams.get("id");

    if (id && /^\d{5,}$/.test(id)) {
      return id;
    }

    const numericPathPart = parsedUrl.pathname
      .split("/")
      .map((part) => part.trim())
      .find((part) => /^\d{5,}$/.test(part));

    return numericPathPart || null;
  } catch (error) {
    return null;
  }
}

function isGoogleDriveFolderUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname.includes("drive.google.com") && parsedUrl.pathname.includes("/drive/folders/");
  } catch (error) {
    return false;
  }
}

function hasGoogleDriveMedia(task) {
  return task.mediaUrls.some((url) => Boolean(getGoogleDriveFileId(url)));
}

function normalizeMediaUrl(url) {
  const fileId = getGoogleDriveFileId(url);

  if (!fileId) {
    return url;
  }

  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

function uniqueUrls(urls) {
  const seen = new Set();
  const result = [];

  for (const url of urls) {
    if (!seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }

  return result;
}

function isVideoFormat(postFormat) {
  const format = normalize(postFormat);
  return format.includes("video") || format.includes("reel");
}

function hasImageExtension(url) {
  return /\.(avif|gif|jpe?g|png|webp)(\?.*)?$/i.test(url);
}

function hasVideoExtension(url) {
  return /\.(m4v|mov|mp4|webm)(\?.*)?$/i.test(url);
}

function getMediaUrlKind(url) {
  if (hasImageExtension(url)) {
    return "image";
  }

  if (hasVideoExtension(url)) {
    return "video";
  }

  if (getGoogleDriveFileId(url)) {
    return "drive";
  }

  return "unknown";
}

function getNumberedUrls(page, indexGetter) {
  return Object.entries(page.properties || {})
    .map(([propertyName, property]) => ({
      index: indexGetter(propertyName),
      urls: parseMediaUrls(getPlainText(property))
    }))
    .filter((item) => item.index !== null && item.urls.length > 0)
    .sort((a, b) => a.index - b.index)
    .flatMap((item) => item.urls);
}

function getMediaUrls(page, postType) {
  const mediaUrls = parseMediaUrls(getText(page, CONTENT_PROPS.mediaUrls));

  if (mediaUrls.length > 0) {
    return uniqueUrls(mediaUrls.map(normalizeMediaUrl));
  }

  if (isVideoFormat(postType)) {
    const numberedVideoUrls = getNumberedUrls(page, getNumberedVideoIndex);
    const fallbackVideoUrls = parseMediaUrls(getText(page, CONTENT_PROPS.videoUrls));
    const urls = numberedVideoUrls.length > 0 ? numberedVideoUrls : fallbackVideoUrls;

    return uniqueUrls(urls.map(normalizeMediaUrl));
  }

  const numberedUrls = getNumberedUrls(page, getNumberedMediaIndex);
  const imageUrls = parseMediaUrls(getText(page, CONTENT_PROPS.imageUrls));
  const legacyMediaUrls = parseMediaUrls(getText(page, CONTENT_PROPS.legacyMediaUrls));
  const fallbackUrls = imageUrls.length > 0 ? imageUrls : legacyMediaUrls;
  const urls = numberedUrls.length > 0 ? numberedUrls : fallbackUrls;

  return uniqueUrls(urls.map(normalizeMediaUrl));
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function isImageUrl(url) {
  const kind = getMediaUrlKind(url);
  return kind === "image" || kind === "drive";
}

function isPlaceholderUrl(url) {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname === "example.com" || parsedUrl.hostname.endsWith(".example.com");
  } catch (error) {
    return true;
  }
}

function getPublishTiming(task, now) {
  if (!task.publishAt) {
    return {
      due: false,
      overdue: false,
      overdueMs: 0,
      tooOldOverdue: false,
      missing: true
    };
  }

  const publishTime = new Date(task.publishAt);

  if (Number.isNaN(publishTime.getTime())) {
    return {
      due: false,
      overdue: false,
      overdueMs: 0,
      tooOldOverdue: false,
      invalid: true
    };
  }

  const overdueMs = now.getTime() - publishTime.getTime();

  return {
    due: overdueMs >= 0,
    overdue: overdueMs > 0,
    overdueMs: overdueMs > 0 ? overdueMs : 0,
    tooOldOverdue: overdueMs > OVERDUE_PUBLISH_WINDOW_MS
  };
}

function normalizeFacebookPostUrl(url) {
  const value = String(url || "").trim();

  if (!value) {
    return "";
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  if (value.startsWith("/")) {
    return `https://www.facebook.com${value}`;
  }

  return `https://www.facebook.com/${value.replace(/^\/+/, "")}`;
}

function mapContentPage(page) {
  const postType = getFirstText(page, [CONTENT_PROPS.postType, CONTENT_PROPS.postFormat]) || "Post";
  const tagPeopleRefs = parseFacebookRefs(getText(page, CONTENT_PROPS.tagPeopleUrls));
  const locationFacebookUrl = getText(page, CONTENT_PROPS.locationFacebookUrl);

  return {
    id: page.id,
    notionUrl: page.url,
    title: getText(page, CONTENT_PROPS.title),
    caption: getText(page, CONTENT_PROPS.caption),
    tags: parseTags(getText(page, CONTENT_PROPS.tags)),
    postType,
    postFormat: postType,
    mediaUrls: getMediaUrls(page, postType),
    tagPeopleUrls: getText(page, CONTENT_PROPS.tagPeopleUrls),
    tagPeopleRefs,
    tagPeopleIds: tagPeopleRefs.map((ref) => ref.id).filter(Boolean),
    locationName: getText(page, CONTENT_PROPS.locationName),
    locationFacebookUrl,
    placeId: getFacebookNumericId(locationFacebookUrl),
    feelingActivity: getText(page, CONTENT_PROPS.feelingActivity),
    messengerCta: getCheckbox(page, CONTENT_PROPS.messengerCta),
    callPhoneNumber: getText(page, CONTENT_PROPS.callPhoneNumber),
    shareToStory: getCheckbox(page, CONTENT_PROPS.shareToStory),
    sourceFolderUrl: getText(page, CONTENT_PROPS.sourceFolderUrl),
    autoPublish: getCheckbox(page, CONTENT_PROPS.autoPublish),
    publishStatus: getText(page, CONTENT_PROPS.publishStatus),
    contentWorkflow: getText(page, CONTENT_PROPS.contentWorkflow),
    approvalStatus: getText(page, CONTENT_PROPS.approvalStatus),
    publishMode: getText(page, CONTENT_PROPS.publishMode),
    channel: getText(page, CONTENT_PROPS.channel),
    publishAt: getDateStart(page, CONTENT_PROPS.publishAt),
    timezone: getText(page, CONTENT_PROPS.timezone),
    primaryBrandIds: getRelationIds(page, CONTENT_PROPS.primaryBrand),
    facebookPostId: getText(page, CONTENT_PROPS.facebookPostId),
    facebookPostUrl: normalizeFacebookPostUrl(getText(page, CONTENT_PROPS.facebookPostUrl)),
    retryCount: getNumber(page, CONTENT_PROPS.retryCount),
    manualActionRequired: getCheckbox(page, CONTENT_PROPS.manualActionRequired),
    automationKey: getText(page, CONTENT_PROPS.automationKey),
    collaboratorBrandIds: getRelationIds(page, CONTENT_PROPS.collaboratorBrand),
    notes: getText(page, CONTENT_PROPS.notes),
    errorMessage: getText(page, CONTENT_PROPS.errorMessage)
  };
}

function mapBrandPage(page) {
  return {
    id: page.id,
    name: getText(page, BRAND_PROPS.name),
    code: getText(page, BRAND_PROPS.code),
    facebookPageId: getText(page, BRAND_PROPS.facebookPageId),
    facebookPageName: getText(page, BRAND_PROPS.facebookPageName),
    active: getCheckbox(page, BRAND_PROPS.active),
    connected: getCheckbox(page, BRAND_PROPS.connected),
    timezone: getText(page, BRAND_PROPS.timezone)
  };
}

async function queryAllDataSource(dataSourceId, mapper, context) {
  const results = [];
  let startCursor;

  try {
    do {
      const response = await notion.dataSources.query({
        data_source_id: dataSourceId,
        page_size: 100,
        start_cursor: startCursor
      });

      results.push(...response.results.map(mapper));
      startCursor = response.has_more ? response.next_cursor : null;
    } while (startCursor);

    return results;
  } catch (error) {
    handleNotionError(context, error, "Không đọc được dữ liệu từ Notion.");
  }
}

async function getContentTasks() {
  return queryAllDataSource(config.notion.contentDataSourceId, mapContentPage, "query_content_tasks");
}

async function getBrandsById() {
  const brands = await queryAllDataSource(config.notion.brandsDataSourceId, mapBrandPage, "query_brands");
  return new Map(brands.map((brand) => [brand.id, brand]));
}

function inferContentType(task) {
  const format = normalize(task.postType || task.postFormat);
  const mediaUrls = task.mediaUrls;
  const mediaKinds = mediaUrls.map(getMediaUrlKind);
  const hasImages = mediaKinds.includes("image");
  const hasVideos = mediaKinds.includes("video");
  const hasDriveMedia = mediaKinds.includes("drive");
  const hasUnknownMedia = mediaKinds.includes("unknown");

  if (format.includes("reel")) {
    if (mediaUrls.length === 0) {
      return {
        type: "reel",
        error: "Reel cần đúng 1 video trong Media URLs."
      };
    }

    if (mediaUrls.length !== 1) {
      return {
        type: "reel",
        error: "Reel chỉ nhận 1 video duy nhất trong Media URLs."
      };
    }

    if (hasImages) {
      return {
        type: "reel",
        error: "Reel chỉ nhận video, không nhận ảnh."
      };
    }

    return hasVideos || hasDriveMedia
      ? { type: "reel", error: null }
      : { type: "reel", error: "Media URLs của Reel cần là link video có định dạng rõ ràng hoặc link Google Drive file video." };
  }

  if (mediaUrls.length === 0) {
    return {
      type: "text",
      error: null
    };
  }

  if (hasUnknownMedia) {
    return {
      type: null,
      error: "Media URLs cần là link ảnh/video có đuôi file rõ ràng hoặc link Google Drive từng file."
    };
  }

  if (hasDriveMedia) {
    return {
      type: "auto",
      error: null
    };
  }

  if (hasImages && !hasVideos) {
    return {
      type: "photo",
      error: null
    };
  }

  if (hasVideos && !hasImages && mediaUrls.length === 1) {
    return {
      type: "video",
      error: null
    };
  }

  if (hasVideos) {
    return {
      type: "mixed",
      error: null
    };
  }

  return {
    type: null,
    error: "Media URLs chưa xác định được là ảnh hay video."
  };
}

function getBaseReadinessReasons(task, brand, page, inferredContent, options = {}) {
  const reasons = [];

  if (!task.autoPublish) {
    reasons.push("Auto Publish đang tắt.");
  }

  if (task.channel !== "Facebook") {
    reasons.push("Channel không phải Facebook.");
  }

  if (task.approvalStatus !== APPROVED_STATUS) {
    reasons.push("Tác vụ chưa được duyệt.");
  }

  if (task.contentWorkflow !== COMPLETED_WORKFLOW_STATUS) {
    reasons.push("Content Workflow chưa hoàn thành nội dung.");
  }

  if (task.publishStatus === PUBLISHED_STATUS || task.facebookPostId) {
    reasons.push("Tác vụ đã có Facebook Post ID.");
  }

  if (task.publishStatus === PUBLISHING_STATUS) {
    reasons.push("Tác vụ đang ở trạng thái Đang đăng.");
  }

  if (task.retryCount >= MAX_RETRY_COUNT) {
    reasons.push("Tác vụ đã vượt giới hạn retry.");
  }

  if (inferredContent.type === "text" && !buildMessageWithTags(task.caption, task.tags)) {
    reasons.push("Caption đang trống.");
  }

  if (task.primaryBrandIds.length !== 1) {
    reasons.push("Tác vụ cần đúng 1 Primary Brand.");
  }

  if (task.mediaUrls.some(isPlaceholderUrl)) {
    reasons.push("Media URLs đang là URL placeholder.");
  }

  if (task.mediaUrls.some(isGoogleDriveFolderUrl)) {
    reasons.push("Media URLs đang là link thư mục Drive; cần link từng file ảnh/video.");
  }

  const unresolvedTagPeople = (task.tagPeopleRefs || []).filter((ref) => !ref.id);

  if (unresolvedTagPeople.length > 0) {
    reasons.push("Tag People URLs hiện chỉ tự động gửi được khi link chứa Facebook numeric ID hoặc profile.php?id=...");
  }

  if ((task.locationName || task.locationFacebookUrl) && !task.placeId) {
    reasons.push("Location cần Location Facebook URL có numeric place ID để tự động gắn vị trí.");
  }

  if (inferredContent.type === "reel" && (task.tagPeopleIds.length > 0 || task.placeId)) {
    reasons.push("Reel hiện chưa tự động gắn thẻ người hoặc vị trí qua luồng Graph API này.");
  }

  if (task.feelingActivity) {
    reasons.push("Feeling/Activity chưa có luồng Graph API an toàn trong hệ thống; cần xử lý thủ công hoặc bổ sung API.");
  }

  if (task.messengerCta) {
    reasons.push("Messenger CTA cần bổ sung cấu hình call_to_action/API trước khi tự động đăng.");
  }

  if (task.callPhoneNumber) {
    reasons.push("Nhận cuộc gọi cần bổ sung API/call_to_action phù hợp trước khi tự động đăng.");
  }

  if (task.shareToStory) {
    reasons.push("Share To Story cần triển khai Page Stories API riêng trước khi tự động đăng.");
  }

  if (task.collaboratorBrandIds.length > 0) {
    reasons.push("Collaborator Brand/Collab cần API hoặc quyền Facebook riêng trước khi tự động đăng.");
  }

  if (hasGoogleDriveMedia(task)) {
    if (!googleDriveService.isConfigured()) {
      reasons.push("Server chưa cấu hình Google Drive OAuth để đọc ảnh Drive riêng tư.");
    } else if (!options.driveConnected) {
      reasons.push("Chưa kết nối Google Drive để đọc ảnh Drive riêng tư.");
    }
  }

  if (!brand) {
    reasons.push("Tác vụ chưa map được Primary Brand.");
  } else {
    if (!brand.active) {
      reasons.push("Brand đang tắt Active.");
    }

    if (!brand.connected) {
      reasons.push("Brand chưa Connected.");
    }

    if (!brand.facebookPageId) {
      reasons.push("Brand chưa có Facebook Page ID.");
    }

    if (!brand.code) {
      reasons.push("Brand chưa có Brand Code.");
    }
  }

  if (brand && !page) {
    reasons.push("Tài khoản Facebook đang đăng nhập chưa quản lý Page của Brand này.");
  }

  if (page && !facebookService.canCreateContent(page)) {
    reasons.push("Page không có quyền tạo bài viết.");
  }

  if (inferredContent.error) {
    reasons.push(inferredContent.error);
  }

  return reasons;
}

function getScheduleReadiness(task, brand, page, now, options = {}) {
  const timing = getPublishTiming(task, now);
  const inferredContent = inferContentType(task);
  const reasons = getBaseReadinessReasons(task, brand, page, inferredContent, options);

  if (task.publishStatus !== UNSCHEDULED_STATUS) {
    reasons.push("Publish Status chưa phải Chưa lên lịch.");
  }

  if (timing.missing) {
    reasons.push("Publish At đang trống.");
  }

  if (timing.invalid) {
    reasons.push("Publish At không hợp lệ.");
  }

  if (timing.tooOldOverdue) {
    reasons.push("Tác vụ quá hạn hơn 24 giờ.");
  }

  return {
    due: timing.due,
    overdue: timing.overdue,
    overdueMs: timing.overdueMs,
    tooOldOverdue: timing.tooOldOverdue,
    readyToSchedule: reasons.length === 0,
    reasons,
    contentType: inferredContent.type || "unknown"
  };
}

function getPublishReadiness(task, brand, page, now, options = {}) {
  const timing = getPublishTiming(task, now);
  const inferredContent = inferContentType(task);
  const reasons = getBaseReadinessReasons(task, brand, page, inferredContent, options);

  if (task.publishStatus !== SCHEDULED_STATUS) {
    reasons.push("Publish Status chưa phải Đã lên lịch.");
  }

  if (timing.missing) {
    reasons.push("Publish At đang trống.");
  }

  if (timing.invalid) {
    reasons.push("Publish At không hợp lệ.");
  }

  if (!timing.due) {
    reasons.push("Tác vụ chưa đến Publish At.");
  }

  if (timing.tooOldOverdue) {
    reasons.push("Tác vụ quá hạn hơn 24 giờ.");
  }

  return {
    due: timing.due,
    overdue: timing.overdue,
    overdueMs: timing.overdueMs,
    tooOldOverdue: timing.tooOldOverdue,
    readyToPublish: reasons.length === 0,
    reasons,
    contentType: inferredContent.type || "unknown"
  };
}

async function getResolvedTasks(sessionPages, options = {}) {
  const [tasks, brandsById] = await Promise.all([getContentTasks(), getBrandsById()]);
  const hiddenPageIds = pageVisibilityService.getHiddenPageIds(sessionPages);
  const pagesById = new Map(sessionPages.map((page) => [page.id, page]));
  const now = new Date();
  const readinessOptions = {
    driveConnected: googleDriveService.isConnected(options.driveAuth)
  };

  return tasks.flatMap((task) => {
    const brandId = task.primaryBrandIds[0];
    const brand = brandId ? brandsById.get(brandId) : null;
    if (pageVisibilityService.isHiddenBrandPage(brand, hiddenPageIds)) {
      return [];
    }

    const page = brand && brand.facebookPageId ? pagesById.get(brand.facebookPageId) : null;

    return [{
      task,
      brand,
      page,
      scheduleReadiness: getScheduleReadiness(task, brand, page, now, readinessOptions),
      readiness: getPublishReadiness(task, brand, page, now, readinessOptions)
    }];
  });
}

function serializeResolvedTask(resolved) {
  const { task, brand, page, scheduleReadiness, readiness } = resolved;
  const isPublished = Boolean(
    task.facebookPostUrl &&
    task.facebookPostId &&
    task.publishStatus === PUBLISHED_STATUS
  );
  const taskStage = isPublished
    ? "published"
    : readiness.readyToPublish
      ? "ready_to_publish"
      : scheduleReadiness.readyToSchedule
        ? "ready_to_schedule"
        : task.publishStatus === PUBLISHING_STATUS
          ? "publishing"
          : task.publishStatus === FAILED_STATUS
            ? "failed"
            : task.manualActionRequired
              ? "manual"
              : "blocked";

  return {
    id: task.id,
    notionUrl: task.notionUrl,
    title: task.title,
    caption: task.caption,
    tags: task.tags,
    postType: task.postType,
    postFormat: task.postFormat,
    contentType: readiness.contentType,
    mediaUrls: task.mediaUrls,
    mediaCount: task.mediaUrls.length,
    tagPeopleUrls: task.tagPeopleUrls,
    locationName: task.locationName,
    locationFacebookUrl: task.locationFacebookUrl,
    feelingActivity: task.feelingActivity,
    messengerCta: task.messengerCta,
    callPhoneNumber: task.callPhoneNumber,
    shareToStory: task.shareToStory,
    sourceFolderUrl: task.sourceFolderUrl,
    autoPublish: task.autoPublish,
    publishStatus: task.publishStatus,
    contentWorkflow: task.contentWorkflow,
    approvalStatus: task.approvalStatus,
    publishMode: task.publishMode,
    channel: task.channel,
    publishAt: task.publishAt,
    timezone: task.timezone,
    facebookPostId: task.facebookPostId,
    facebookPostUrl: task.facebookPostUrl,
    retryCount: task.retryCount,
    manualActionRequired: task.manualActionRequired,
    automationKey: task.automationKey,
    notes: task.notes,
    errorMessage: task.errorMessage,
    due: readiness.due,
    overdue: readiness.overdue,
    overdueMs: readiness.overdueMs,
    tooOldOverdue: readiness.tooOldOverdue,
    isPublished,
    taskStage,
    readyToSchedule: scheduleReadiness.readyToSchedule,
    scheduleReasons: scheduleReadiness.reasons,
    readyToPublish: readiness.readyToPublish,
    reasons: readiness.reasons,
    brand: brand
      ? {
          id: brand.id,
          name: brand.name,
          code: brand.code,
          facebookPageId: brand.facebookPageId,
          facebookPageName: brand.facebookPageName,
          active: brand.active,
          connected: brand.connected
        }
      : null,
    page: page
      ? {
          id: page.id,
          name: page.name,
          canCreateContent: facebookService.canCreateContent(page)
        }
      : null
  };
}

async function listTasksForSession(sessionPages, filters = {}) {
  const resolvedTasks = await getResolvedTasks(sessionPages, {
    driveAuth: filters.driveAuth
  });
  const filtered = filters.pageId
    ? resolvedTasks.filter((resolved) => resolved.page && resolved.page.id === filters.pageId)
    : resolvedTasks;
  const tasks = filtered
    .map(serializeResolvedTask)
    .sort((a, b) => {
      if (!a.publishAt && !b.publishAt) {
        return a.title.localeCompare(b.title);
      }

      if (!a.publishAt) {
        return -1;
      }

      if (!b.publishAt) {
        return 1;
      }

      return new Date(a.publishAt).getTime() - new Date(b.publishAt).getTime();
    });

  return {
    tasks,
    totalCount: tasks.length,
    scheduleReadyCount: tasks.filter((task) => task.readyToSchedule).length,
    readyCount: tasks.filter((task) => task.readyToPublish).length,
    dueCount: tasks.filter((task) => task.due).length,
    overdueCount: tasks.filter(
      (task) =>
        (task.readyToSchedule || task.readyToPublish) &&
        task.overdue &&
        !task.tooOldOverdue
    ).length
  };
}

function getRetryPreparationReadiness(resolved, readinessOptions, now) {
  const { task, brand, page } = resolved;
  const retryTask = {
    ...task,
    publishStatus: UNSCHEDULED_STATUS,
    retryCount: 0,
    errorMessage: ""
  };
  const retryReadiness = getScheduleReadiness(retryTask, brand, page, now, readinessOptions);
  const reasons = [];

  if (task.publishStatus !== FAILED_STATUS) {
    reasons.push("Task không ở trạng thái Lỗi đăng.");
  }

  if (task.facebookPostId || task.facebookPostUrl || task.publishStatus === PUBLISHED_STATUS) {
    reasons.push("Task đã có Facebook Post ID hoặc Facebook Post URL nên không được mở khóa đăng lại.");
  }

  return {
    readyToPrepare: reasons.length === 0 && retryReadiness.readyToSchedule,
    reasons: [...reasons, ...retryReadiness.reasons],
    due: retryReadiness.due,
    overdue: retryReadiness.overdue,
    tooOldOverdue: retryReadiness.tooOldOverdue
  };
}

async function updateTaskRetryReady(task, syncedAt) {
  await notion.pages.update({
    page_id: task.id,
    properties: {
      [CONTENT_PROPS.publishStatus]: selectContent(UNSCHEDULED_STATUS),
      [CONTENT_PROPS.errorMessage]: richTextContent(""),
      [CONTENT_PROPS.retryCount]: {
        number: 0
      },
      [CONTENT_PROPS.lastSyncedAt]: richTextContent(syncedAt.toISOString())
    }
  });
}

async function prepareFailedTasksForRetry(sessionPages, options = {}) {
  const resolvedTasks = await getResolvedTasks(sessionPages, {
    driveAuth: options.driveAuth
  });
  const filtered = options.pageId
    ? resolvedTasks.filter((resolved) => resolved.page && resolved.page.id === options.pageId)
    : resolvedTasks;
  const failedTasks = filtered.filter((resolved) => resolved.task.publishStatus === FAILED_STATUS);
  const readinessOptions = {
    driveConnected: googleDriveService.isConnected(options.driveAuth)
  };
  const now = new Date();
  const results = [];

  for (const resolved of failedTasks) {
    const retryReadiness = getRetryPreparationReadiness(resolved, readinessOptions, now);

    if (!retryReadiness.readyToPrepare) {
      results.push({
        success: false,
        skipped: true,
        taskId: resolved.task.id,
        title: resolved.task.title,
        reasons: retryReadiness.reasons
      });
      continue;
    }

    try {
      await updateTaskRetryReady(resolved.task, now);
      results.push({
        success: true,
        taskId: resolved.task.id,
        title: resolved.task.title,
        due: retryReadiness.due,
        overdue: retryReadiness.overdue
      });
    } catch (error) {
      logNotionError("prepare_task_retry", error);
      results.push({
        success: false,
        skipped: false,
        taskId: resolved.task.id,
        title: resolved.task.title,
        message: error.publicMessage || error.message || "Không cập nhật được task để đăng lại."
      });
    }
  }

  return {
    attemptedCount: failedTasks.length,
    successCount: results.filter((result) => result.success).length,
    failureCount: results.filter((result) => !result.success && !result.skipped).length,
    skippedCount: results.filter((result) => result.skipped).length,
    results
  };
}

async function updateTaskSuccess(task, facebookResult, syncedAt) {
  const permalinkUrl = normalizeFacebookPostUrl(facebookResult.permalinkUrl) || `https://www.facebook.com/${facebookResult.postId}`;

  await notion.pages.update({
    page_id: task.id,
    properties: {
      [CONTENT_PROPS.publishStatus]: selectContent(PUBLISHED_STATUS),
      [CONTENT_PROPS.facebookPostId]: richTextContent(facebookResult.postId),
      [CONTENT_PROPS.facebookPostUrl]: richTextContent(permalinkUrl),
      [CONTENT_PROPS.publishedAt]: richTextContent(syncedAt.toISOString()),
      [CONTENT_PROPS.lastSyncedAt]: richTextContent(syncedAt.toISOString()),
      [CONTENT_PROPS.errorMessage]: richTextContent("")
    }
  });

  return permalinkUrl;
}

async function updateTaskManualSuccess(task, facebookResult, syncedAt) {
  const permalinkUrl = normalizeFacebookPostUrl(facebookResult.permalinkUrl) || `https://www.facebook.com/${facebookResult.postId}`;

  await notion.pages.update({
    page_id: task.id,
    properties: {
      [CONTENT_PROPS.publishStatus]: selectContent(PUBLISHED_STATUS),
      [CONTENT_PROPS.facebookPostId]: richTextContent(facebookResult.postId),
      [CONTENT_PROPS.facebookPostUrl]: richTextContent(permalinkUrl),
      [CONTENT_PROPS.publishedAt]: richTextContent(syncedAt.toISOString()),
      [CONTENT_PROPS.lastSyncedAt]: richTextContent(syncedAt.toISOString()),
      [CONTENT_PROPS.errorMessage]: richTextContent("")
    }
  });

  return permalinkUrl;
}

async function markTaskManualPostSuccess(taskId, sessionPages, pageId, facebookResult) {
  const resolvedTasks = await getResolvedTasks(sessionPages);
  const resolvedTask = resolvedTasks.find((resolved) => resolved.task.id === taskId);

  if (!resolvedTask) {
    throw createPublicError(404, "Không tìm thấy task Notion để cập nhật đăng thủ công.");
  }

  if (!resolvedTask.page || resolvedTask.page.id !== pageId) {
    throw createPublicError(400, "Task Notion không thuộc Page đang đăng thủ công.");
  }

  return updateTaskManualSuccess(resolvedTask.task, facebookResult, new Date());
}

async function updateTaskScheduled(task, syncedAt) {
  await notion.pages.update({
    page_id: task.id,
    properties: {
      [CONTENT_PROPS.publishStatus]: selectContent(SCHEDULED_STATUS),
      [CONTENT_PROPS.lastSyncedAt]: richTextContent(syncedAt.toISOString()),
      [CONTENT_PROPS.errorMessage]: richTextContent("")
    }
  });
}

async function updateTaskPublishing(task, syncedAt) {
  await notion.pages.update({
    page_id: task.id,
    properties: {
      [CONTENT_PROPS.publishStatus]: selectContent(PUBLISHING_STATUS),
      [CONTENT_PROPS.lastSyncedAt]: richTextContent(syncedAt.toISOString()),
      [CONTENT_PROPS.errorMessage]: richTextContent("")
    }
  });
}

function formatNoteTime(date) {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh"
  }).format(date);
}

function getFailureExplanation(task, message, error) {
  const details = (error && error.details) || {};
  const providerMessage = details.providerMessage || "";
  const raw = `${message || ""} ${providerMessage}`.toLowerCase();
  const taskType = task.postType || task.postFormat;
  const isVideoTask = isVideoFormat(taskType);

  if (isVideoTask && task.mediaUrls.length === 0) {
    return {
      cause: "Bài này là video/Reel nhưng chưa có link video nào trong Media URLs.",
      action: "Thêm đúng link video vào Media URLs, sau đó đưa task về Chưa lên lịch và đăng lại."
    };
  }

  if (isVideoTask && task.mediaUrls.length > 1) {
    return {
      cause: "Bài video chỉ đăng được 1 file video mỗi lần, nhưng task đang có nhiều hơn 1 link video.",
      action: "Giữ lại 1 link video trong Media URLs. Nếu cần bài Post gồm ảnh và video, đặt Post Type là Post để hệ thống dùng luồng mixed media."
    };
  }

  if (details.service === "google_drive") {
    if (raw.includes("not been used") || raw.includes("disabled") || raw.includes("chưa được bật")) {
      return {
        cause: "Google Drive API trong Google Cloud project chưa được bật, nên hệ thống không thể đọc file video/ảnh từ Drive.",
        action: "Vào Google Cloud, bật Google Drive API cho project đang dùng, đợi vài phút, kết nối Drive lại rồi đăng lại task."
      };
    }

    if (details.status === 401 || raw.includes("hết hạn") || raw.includes("chưa kết nối")) {
      return {
        cause: "Phiên kết nối Google Drive chưa có hoặc đã hết hạn, nên hệ thống không có quyền tải file từ Drive.",
        action: "Bấm Kết nối Drive lại trên dashboard, chọn đúng tài khoản Google có quyền xem file, rồi đăng lại task."
      };
    }

    if (details.status === 403) {
      return {
        cause: "Tài khoản Google đã kết nối chưa có quyền xem file trong Drive, hoặc Google Cloud đang chặn quyền đọc file.",
        action: "Kiểm tra file Drive đã share cho đúng tài khoản Google, hoặc chuyển file vào Drive của tài khoản đã kết nối."
      };
    }

    if (details.status === 404) {
      return {
        cause: "Không tìm thấy file trong Google Drive. Link có thể sai, file đã bị xóa, hoặc file nằm ở nơi tài khoản đã kết nối không nhìn thấy.",
        action: "Mở link Drive bằng đúng tài khoản Google đã kết nối. Nếu không mở được, hãy thay link video/ảnh trong Notion."
      };
    }

    return {
      cause: "Hệ thống không tải được file từ Google Drive trước khi gửi sang Facebook.",
      action: "Kiểm tra link Drive, quyền truy cập file và trạng thái kết nối Drive trên dashboard."
    };
  }

  if (details.service === "facebook" && isVideoTask && details.context === "create_page_video_post") {
    if (details.status === 413) {
      return {
        cause: "Facebook trả mã 413 khi nhận request upload video trực tiếp. Mã này nói rằng request bị từ chối ở bước gửi lên Facebook, nhưng chưa đủ căn cứ để kết luận video quá dài hoặc quá lớn.",
        action: "Hệ thống đã chuyển video lấy từ Google Drive sang luồng upload nhiều bước của Facebook. Hãy bấm đăng lại; nếu vẫn lỗi, xem thông báo gốc bên dưới và kiểm tra định dạng video, codec, quyền Page."
      };
    }

    return {
      cause: "Facebook từ chối nhận video ở bước tạo bài video. Nguyên nhân có thể là định dạng/codec video, quyền Page, token Facebook, hoặc phản hồi xử lý media từ Facebook.",
      action: "Kiểm tra video là file MP4/MOV hợp lệ, Page còn quyền đăng nội dung, tài khoản Facebook vẫn được cấp quyền, rồi thử đăng lại task."
    };
  }

  if (details.service === "facebook" && isVideoTask && details.context === "create_page_video_post_resumable") {
    return {
      cause: "Facebook từ chối video trong luồng upload nhiều bước. Trường hợp này không tự động có nghĩa là video dài; thường cần xem định dạng file, codec âm thanh/hình ảnh, quyền Page hoặc thông báo gốc từ Facebook.",
      action: "Thử xuất lại video ở định dạng MP4 phổ biến, kiểm tra Page còn quyền đăng bài, rồi đăng lại. Nếu còn lỗi, dùng thông báo gốc trong phần chi tiết kỹ thuật để xử lý đúng nguyên nhân."
    };
  }

  if (details.service === "facebook") {
    if (details.context === "create_page_video_post") {
      if (details.status === 413) {
        return {
          cause: "Facebook trả mã 413 khi nhận request upload video trực tiếp. Mã này chưa đủ căn cứ để kết luận file video quá lớn.",
          action: "Thử đăng lại bằng file Drive để hệ thống dùng luồng upload nhiều bước, hoặc kiểm tra định dạng video, quyền Page và thông báo gốc từ Facebook."
        };
      }

      return {
        cause: "Facebook từ chối nhận video. Thường gặp khi Page chưa đủ quyền đăng video, file video không đúng định dạng/codec, token không còn quyền hoặc Facebook không xử lý được file.",
        action: "Kiểm tra Page còn quyền đăng bài, video là MP4/MOV hợp lệ, xem thông báo gốc nếu có, rồi thử đăng lại."
      };
    }

    return {
      cause: "Facebook không chấp nhận yêu cầu đăng bài từ hệ thống.",
      action: "Kiểm tra quyền Page, trạng thái đăng nhập Facebook và nội dung/media của task."
    };
  }

  if (raw.includes("không phải ảnh") || raw.includes("không phải video")) {
    return {
      cause: "File trong Drive không phải ảnh hoặc video hợp lệ để đăng lên Facebook.",
      action: "Thay bằng file ảnh/video đúng định dạng, sau đó đăng lại task."
    };
  }

  return {
    cause: message || "Hệ thống gặp lỗi khi đăng bài.",
    action: "Kiểm tra lại các điều kiện của task, quyền Facebook Page, kết nối Google Drive và thử đăng lại."
  };
}

function formatBytes(bytes) {
  const size = Number(bytes);

  if (!Number.isFinite(size) || size <= 0) {
    return "không rõ";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getMediaItemSize(mediaItem) {
  const size = Number(mediaItem && mediaItem.size);

  if (Number.isFinite(size) && size > 0) {
    return size;
  }

  if (mediaItem && Buffer.isBuffer(mediaItem.buffer)) {
    return mediaItem.buffer.length;
  }

  return null;
}

function describeMediaLine(mediaItem, fallbackUrl, index) {
  const item = mediaItem || {};
  const url = item.originalUrl || item.url || fallbackUrl || "(không có link)";
  const details = [];
  const size = getMediaItemSize(item);

  if (item.filename) {
    details.push(`tên file: ${item.filename}`);
  }

  if (item.contentType) {
    details.push(`loại file: ${item.contentType}`);
  }

  if (size) {
    details.push(`dung lượng: ${formatBytes(size)}`);
  }

  if (item.driveFileId) {
    details.push(`Drive ID: ${item.driveFileId}`);
  }

  return `${index + 1}. ${url}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

function buildFailureNotes(task, message, error, syncedAt, mediaItems = []) {
  const details = (error && error.details) || {};
  const explanation = getFailureExplanation(task, message, error);
  const providerMessage = details.providerMessage || "";
  const resolvedMediaItems = Array.isArray(mediaItems) ? mediaItems : [];
  const technicalParts = [
    details.service ? `Nguồn lỗi: ${details.service}` : null,
    details.context ? `Bước lỗi: ${details.context}` : null,
    details.status ? `Mã trạng thái: ${details.status}` : null,
    providerMessage ? `Thông báo gốc: ${providerMessage}` : null
  ].filter(Boolean);
  const mediaSourceCount = Math.max(task.mediaUrls.length, resolvedMediaItems.length);
  const mediaLines = mediaSourceCount > 0
    ? Array.from({ length: mediaSourceCount }, (_, index) =>
        describeMediaLine(resolvedMediaItems[index], task.mediaUrls[index], index)
      ).join("\n")
    : "Không có link media.";
  const previousNotes = task.notes
    ? `\n\n---\nGhi chú cũ trước khi lỗi:\n${task.notes}`
    : "";

  return [
    `Lỗi đăng gần nhất (${formatNoteTime(syncedAt)})`,
    `Bài: ${task.title || "(chưa có tiêu đề)"}`,
    `Định dạng: ${task.postType || task.postFormat || "Không rõ"}`,
    `Số file media hệ thống đọc được: ${task.mediaUrls.length}`,
    "",
    `Nguyên nhân dễ hiểu: ${explanation.cause}`,
    `Cần làm: ${explanation.action}`,
    "",
    "Link media hệ thống đang dùng:",
    mediaLines,
    "",
    `Thông báo lỗi ngắn: ${message}`,
    technicalParts.length > 0 ? `Chi tiết kỹ thuật: ${technicalParts.join(" | ")}` : "Chi tiết kỹ thuật: Không có thêm thông tin từ dịch vụ bên ngoài."
  ].join("\n") + previousNotes;
}

async function updateTaskFailure(task, message, syncedAt, error, mediaItems = []) {
  const notes = buildFailureNotes(task, message, error, syncedAt, mediaItems);

  await notion.pages.update({
    page_id: task.id,
    properties: {
      [CONTENT_PROPS.publishStatus]: selectContent(FAILED_STATUS),
      [CONTENT_PROPS.errorMessage]: richTextContent(message),
      [CONTENT_PROPS.notes]: richTextContent(notes),
      [CONTENT_PROPS.retryCount]: {
        number: task.retryCount + 1
      },
      [CONTENT_PROPS.lastSyncedAt]: richTextContent(syncedAt.toISOString())
    }
  });
}

async function scheduleResolvedTask(resolved) {
  const { task, scheduleReadiness } = resolved;

  if (!scheduleReadiness.readyToSchedule) {
    return {
      success: false,
      skipped: true,
      taskId: task.id,
      title: task.title,
      reasons: scheduleReadiness.reasons
    };
  }

  try {
    await updateTaskScheduled(task, new Date());

    return {
      success: true,
      taskId: task.id,
      title: task.title
    };
  } catch (error) {
    const message = error.publicMessage || error.message || "Không cập nhật được trạng thái Đã lên lịch.";

    try {
      await updateTaskFailure(task, message, new Date(), error);
    } catch (notionError) {
      logNotionError("update_task_schedule_failure", notionError);
    }

    return {
      success: false,
      skipped: false,
      taskId: task.id,
      title: task.title,
      message
    };
  }
}

async function scheduleReadyTasks(sessionPages, options = {}) {
  const resolvedTasks = await getResolvedTasks(sessionPages, {
    driveAuth: options.driveAuth
  });
  const readyTasks = resolvedTasks.filter((resolved) => {
    if (!resolved.scheduleReadiness.readyToSchedule) {
      return false;
    }

    if (options.onlyOverdue) {
      return resolved.scheduleReadiness.overdue && !resolved.scheduleReadiness.tooOldOverdue;
    }

    if (options.onlyDue) {
      return resolved.scheduleReadiness.due;
    }

    return true;
  });
  const results = [];

  for (const resolvedTask of readyTasks) {
    results.push(await scheduleResolvedTask(resolvedTask));
  }

  return {
    attemptedCount: readyTasks.length,
    successCount: results.filter((result) => result.success).length,
    failureCount: results.filter((result) => !result.success && !result.skipped).length,
    skippedCount: resolvedTasks.length - readyTasks.length,
    results
  };
}

async function publishResolvedTask(resolved, options = {}) {
  const { task, page, readiness } = resolved;
  const startedAt = new Date();

  if (!readiness.readyToPublish) {
    return {
      success: false,
      skipped: true,
      taskId: task.id,
      title: task.title,
      reasons: readiness.reasons
    };
  }

  let facebookResult;
  let mediaItems = [];

  try {
    await updateTaskPublishing(task, startedAt);
    mediaItems = await googleDriveService.resolveMediaItems(task.mediaUrls, options.driveAuth);

    facebookResult = await facebookService.createPageContent(page.id, page.pageAccessToken, {
      message: buildMessageWithTags(task.caption, task.tags),
      mediaUrls: task.mediaUrls,
      mediaItems,
      contentType: readiness.contentType,
      postOptions: {
        placeId: task.placeId,
        tagIds: task.tagPeopleIds,
        title: task.title
      }
    });

    if (!facebookResult.postId) {
      throw createPublicError(502, "Facebook đã nhận yêu cầu nhưng không trả về Post ID.");
    }
  } catch (error) {
    const message = error.publicMessage || error.message || "Đăng bài Facebook thất bại.";

    try {
      await updateTaskFailure(task, message, new Date(), error, mediaItems);
    } catch (notionError) {
      logNotionError("update_task_failure", notionError);
    }

    return {
      success: false,
      skipped: false,
      taskId: task.id,
      title: task.title,
      message
    };
  }

  try {
    const permalinkUrl = await updateTaskSuccess(task, facebookResult, startedAt);

    return {
      success: true,
      taskId: task.id,
      title: task.title,
      pageId: page.id,
      pageName: page.name,
      postId: facebookResult.postId,
      permalinkUrl
    };
  } catch (error) {
    logNotionError("update_task_success", error);

    return {
      success: false,
      posted: true,
      skipped: false,
      taskId: task.id,
      title: task.title,
      postId: facebookResult.postId,
      permalinkUrl: facebookResult.permalinkUrl || `https://www.facebook.com/${facebookResult.postId}`,
      message: "Đã đăng lên Facebook nhưng không cập nhật được Notion."
    };
  }
}

async function publishDueTasks(sessionPages, options = {}) {
  const resolvedTasks = await getResolvedTasks(sessionPages, {
    driveAuth: options.driveAuth
  });
  const readyTasks = resolvedTasks.filter((resolved) => resolved.readiness.readyToPublish);
  const results = [];

  for (const resolvedTask of readyTasks) {
    results.push(await publishResolvedTask(resolvedTask, options));
  }

  return {
    attemptedCount: readyTasks.length,
    successCount: results.filter((result) => result.success).length,
    failureCount: results.filter((result) => !result.success && !result.skipped).length,
    skippedCount: resolvedTasks.length - readyTasks.length,
    results
  };
}

async function publishOverdueTasks(sessionPages, options = {}) {
  const resolvedTasks = await getResolvedTasks(sessionPages, {
    driveAuth: options.driveAuth
  });
  const overdueTasks = resolvedTasks.filter(
    (resolved) =>
      resolved.readiness.readyToPublish &&
      resolved.readiness.overdue &&
      !resolved.readiness.tooOldOverdue
  );
  const results = [];

  for (const resolvedTask of overdueTasks) {
    results.push(await publishResolvedTask(resolvedTask, options));
  }

  return {
    attemptedCount: overdueTasks.length,
    successCount: results.filter((result) => result.success).length,
    failureCount: results.filter((result) => !result.success && !result.skipped).length,
    skippedCount: resolvedTasks.length - overdueTasks.length,
    results
  };
}

async function publishSingleTask(taskId, sessionPages, options = {}) {
  const resolvedTasks = await getResolvedTasks(sessionPages, {
    driveAuth: options.driveAuth
  });
  let resolvedTask = resolvedTasks.find((resolved) => resolved.task.id === taskId);

  if (!resolvedTask) {
    throw createPublicError(404, "Không tìm thấy tác vụ Notion.");
  }

  if (resolvedTask.scheduleReadiness.readyToSchedule) {
    const scheduleResult = await scheduleResolvedTask(resolvedTask);

    if (!scheduleResult.success) {
      return scheduleResult;
    }

    const refreshedTasks = await getResolvedTasks(sessionPages, {
      driveAuth: options.driveAuth
    });
    resolvedTask = refreshedTasks.find((resolved) => resolved.task.id === taskId);

    if (!resolvedTask.readiness.readyToPublish) {
      return {
        success: true,
        scheduled: true,
        taskId,
        title: resolvedTask.task.title,
        message: "Tác vụ đã được đưa vào lịch chờ đăng."
      };
    }
  }

  if (!resolvedTask.readiness.readyToPublish) {
    throw createPublicError(400, "Tác vụ Notion chưa đủ điều kiện đăng.", {
      reasons: [
        ...resolvedTask.scheduleReadiness.reasons,
        ...resolvedTask.readiness.reasons
      ]
    });
  }

  return publishResolvedTask(resolvedTask, options);
}

module.exports = {
  listTasksForSession,
  markTaskManualPostSuccess,
  prepareFailedTasksForRetry,
  scheduleReadyTasks,
  publishDueTasks,
  publishOverdueTasks,
  publishSingleTask
};
