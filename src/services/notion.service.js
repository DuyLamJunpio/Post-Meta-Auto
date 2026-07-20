const { Client } = require("@notionhq/client");

const { config } = require("../config");
const facebookService = require("./facebook.service");
const googleDriveService = require("./google-drive.service");
const pageVisibilityService = require("./page-visibility.service");
const publisherService = require("./publisher.service");
const publishJobsService = require("./publish-jobs.service");
const publishGuardService = require("./publish-guard.service");
const mediaProxyService = require("./media-proxy.service");
const {
  CHANNELS,
  CHANNEL_LABELS,
  channelKeyFromLabel,
  getAdapter,
  hasAdapter,
  resolveChannelAccount
} = require("../channels");

const notion = new Client({
  auth: config.notion.apiToken
});

// Tên cột theo kênh dùng prefix [FB]/[IG]/[GBP]/[TikTok]; cột chung không prefix.
// ĐỔI Ở ĐÂY PHẢI ĐỔI ĐỒNG BỘ TÊN CỘT TRONG NOTION (scripts/migrate-notion-channel-columns.js).
const CONTENT_PROPS = {
  title: "Post Title",
  caption: "CAPTION",
  tags: "Tags",
  postType: "Post Type",
  postFormat: "Post Format",
  mediaUrls: "Media URLs",
  legacyMediaUrls: "Final Media URLs",
  imageUrls: "Final Image URLs",
  videoUrls: "Final Video URLs",
  tagPeopleUrls: "[FB] Tag People URLs",
  locationName: "[FB] Location Name",
  locationFacebookUrl: "[FB] Location URL",
  feelingActivity: "[FB] Feeling/Activity",
  messengerCta: "[FB] Messenger CTA",
  callPhoneNumber: "[FB] Call Phone Number",
  shareToStory: "[FB] Share To Story",
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
  facebookPostId: "[FB] Post ID",
  facebookPostUrl: "[FB] Post URL",
  instagramPostId: "[IG] Post ID",
  instagramPostUrl: "[IG] Post URL",
  gbpPostUrl: "[GBP] Post URL",
  tiktokPostId: "[TikTok] Post ID",
  tiktokPostUrl: "[TikTok] Post URL",
  publishedAt: "Published At",
  lastSyncedAt: "Last Synced At",
  retryCount: "Retry Count",
  manualActionRequired: "Manual Action Required",
  automationKey: "Automation Key",
  collaboratorBrand: "[FB] Collaborator Brand",
  notes: "Notes",
  errorMessage: "Error Message"
};

const BRAND_PROPS = {
  name: "Brand Name",
  code: "Brand Code",
  facebookPageId: "Facebook Page ID",
  facebookPageName: "Facebook Page Name",
  instagramAccountId: "Instagram Account ID",
  gbpLocationId: "Google Business Profile ID",
  tiktokAccountId: "TikTok Account ID",
  active: "Active",
  connected: "Connected",
  timezone: "Timezone"
};

// Field trên brand chứa account id của từng kênh (khớp các key trong CHANNELS).
// Dùng để build brand.channelAccounts và để adapter đọc đúng id khi resolve.
const CHANNEL_BRAND_ACCOUNT_FIELD = Object.freeze({
  [CHANNELS.FACEBOOK]: "facebookPageId",
  [CHANNELS.INSTAGRAM]: "instagramAccountId",
  [CHANNELS.GBP]: "gbpLocationId",
  [CHANNELS.TIKTOK]: "tiktokAccountId"
});

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

// Đọc property "Channel" (multi_select) -> mảng channel key duy nhất, giữ thứ tự chọn.
// Vẫn nhận select đơn (back-compat nếu có page chưa migrate). Nhãn lạ bị bỏ qua.
function parseChannels(page) {
  const property = getProperty(page, CONTENT_PROPS.channel);

  let names = [];

  if (property && property.type === "multi_select") {
    names = property.multi_select.map((option) => option.name);
  } else if (property && property.type === "select" && property.select) {
    names = [property.select.name];
  }

  const keys = [];

  for (const name of names) {
    const key = channelKeyFromLabel(name);

    if (key && !keys.includes(key)) {
      keys.push(key);
    }
  }

  return keys;
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
  const channels = parseChannels(page);

  return {
    id: page.id,
    notionUrl: page.url,
    title: getText(page, CONTENT_PROPS.title),
    // Caption lấy từ cột "CAPTION" (rich_text). Xuống dòng trong ô được giữ nguyên.
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
    channels,
    channel: channels.map((key) => CHANNEL_LABELS[key] || key).join(", "),
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
  const brand = {
    id: page.id,
    name: getText(page, BRAND_PROPS.name),
    code: getText(page, BRAND_PROPS.code),
    facebookPageId: getText(page, BRAND_PROPS.facebookPageId),
    facebookPageName: getText(page, BRAND_PROPS.facebookPageName),
    instagramAccountId: getText(page, BRAND_PROPS.instagramAccountId),
    gbpLocationId: getText(page, BRAND_PROPS.gbpLocationId),
    tiktokAccountId: getText(page, BRAND_PROPS.tiktokAccountId),
    active: getCheckbox(page, BRAND_PROPS.active),
    connected: getCheckbox(page, BRAND_PROPS.connected),
    timezone: getText(page, BRAND_PROPS.timezone)
  };

  // Map channelKey -> account id (chuỗi rỗng nếu brand chưa điền), cho resolve per-channel.
  brand.channelAccounts = Object.entries(CHANNEL_BRAND_ACCOUNT_FIELD).reduce(
    (accumulator, [channelKey, field]) => {
      accumulator[channelKey] = brand[field] || "";
      return accumulator;
    },
    {}
  );

  return brand;
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

// Đồng bộ Instagram Account ID từ các Page đang đăng nhập FB (đã có instagram_business_account)
// vào brand khớp theo Facebook Page ID. Ghi thẳng cột "Instagram Account ID" trên Brands DB.
async function syncInstagramAccountIds(sessionPages) {
  const pages = Array.isArray(sessionPages) ? sessionPages : [];
  const brands = [...(await getBrandsById()).values()];
  const results = [];

  for (const page of pages) {
    const igAccount = page.instagramBusinessAccount;
    const igId = igAccount && igAccount.id;

    if (!igId) {
      continue;
    }

    const matchedBrands = brands.filter(
      (brand) => brand.facebookPageId && String(brand.facebookPageId) === String(page.id)
    );

    for (const brand of matchedBrands) {
      if (String(brand.instagramAccountId) === String(igId)) {
        results.push({ brand: brand.name, instagramAccountId: igId, updated: false });
        continue;
      }

      try {
        await notion.pages.update({
          page_id: brand.id,
          properties: {
            [BRAND_PROPS.instagramAccountId]: { rich_text: [{ text: { content: String(igId) } }] }
          }
        });
        results.push({
          brand: brand.name,
          instagramAccountId: igId,
          username: igAccount.username || "",
          updated: true
        });
      } catch (error) {
        logNotionError("sync_instagram_account_id", error);
        results.push({ brand: brand.name, instagramAccountId: igId, updated: false, error: error.message });
      }
    }
  }

  const linkedPages = pages
    .filter((page) => page.instagramBusinessAccount && page.instagramBusinessAccount.id)
    .map((page) => ({
      pageId: page.id,
      pageName: page.name,
      instagramAccountId: page.instagramBusinessAccount.id,
      instagramUsername: page.instagramBusinessAccount.username || ""
    }));

  return {
    updatedCount: results.filter((item) => item.updated).length,
    results,
    linkedPages
  };
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

// Lý do readiness riêng của Facebook (feature Graph API + Page/Drive buffer).
// Chỉ được cộng vào khi task nhắm tới Facebook.
function getFacebookChannelReasons(task, brand, page, inferredContent, options = {}) {
  const reasons = [];

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

  if (brand && !brand.facebookPageId) {
    reasons.push("Brand chưa có Facebook Page ID.");
  }

  if (brand && brand.facebookPageId && !page) {
    reasons.push("Tài khoản Facebook đang đăng nhập chưa quản lý Page của Brand này.");
  }

  if (page && !facebookService.canCreateContent(page)) {
    reasons.push("Page không có quyền tạo bài viết.");
  }

  return reasons;
}

// Lý do readiness riêng của Instagram — ủy quyền hoàn toàn cho adapter.
function getInstagramChannelReasons(task, brand, options = {}) {
  const adapter = getAdapter(CHANNELS.INSTAGRAM);

  if (!adapter) {
    return [];
  }

  const resolvedChannel = options.channelAccounts ? options.channelAccounts[CHANNELS.INSTAGRAM] : null;
  const account = resolvedChannel ? resolvedChannel.account : null;

  return adapter.getReadinessReasons({
    task,
    brand,
    account,
    instagramAuth: options.instagramAuth || null,
    proxyEnabled: options.proxyEnabled || false,
    driveConnected: options.driveConnected || false
  });
}

// Lý do readiness riêng của Google Business Profile — ủy quyền cho adapter.
function getGbpChannelReasons(task, brand, options = {}) {
  const adapter = getAdapter(CHANNELS.GBP);

  if (!adapter) {
    return [];
  }

  const resolvedChannel = options.channelAccounts ? options.channelAccounts[CHANNELS.GBP] : null;
  const account = resolvedChannel ? resolvedChannel.account : null;

  return adapter.getReadinessReasons({
    task,
    brand,
    account,
    gbpAuth: options.gbpAuth || null,
    proxyEnabled: options.proxyEnabled || false,
    driveConnected: options.driveConnected || false
  });
}

// Lý do readiness riêng của TikTok — ủy quyền cho adapter.
function getTiktokChannelReasons(task, brand, options = {}) {
  const adapter = getAdapter(CHANNELS.TIKTOK);

  if (!adapter) {
    return [];
  }

  const resolvedChannel = options.channelAccounts ? options.channelAccounts[CHANNELS.TIKTOK] : null;
  const account = resolvedChannel ? resolvedChannel.account : null;

  return adapter.getReadinessReasons({
    task,
    brand,
    account,
    tiktokAuth: options.tiktokAuth || null,
    proxyEnabled: options.proxyEnabled || false,
    driveConnected: options.driveConnected || false
  });
}

function getBaseReadinessReasons(task, brand, page, inferredContent, options = {}) {
  const reasons = [];

  if (!task.autoPublish) {
    reasons.push("Auto Publish đang tắt.");
  }

  if (task.channels.length === 0) {
    reasons.push("Tác vụ chưa chọn Channel nào.");
  } else {
    // Kênh chưa có adapter (GBP/TikTok) không thể đăng tự động -> chặn để Notion không bao giờ báo Đã đăng hụt.
    const unsupportedChannels = task.channels.filter((channelKey) => !hasAdapter(channelKey));

    if (unsupportedChannels.length > 0) {
      const labels = unsupportedChannels.map((channelKey) => CHANNEL_LABELS[channelKey] || channelKey).join(", ");
      reasons.push(`Kênh chưa hỗ trợ đăng tự động: ${labels}.`);
    }
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

  if (!brand) {
    reasons.push("Tác vụ chưa map được Primary Brand.");
  } else {
    if (!brand.active) {
      reasons.push("Brand đang tắt Active.");
    }

    if (!brand.connected) {
      reasons.push("Brand chưa Connected.");
    }

    if (!brand.code) {
      reasons.push("Brand chưa có Brand Code.");
    }
  }

  // Lý do riêng theo từng kênh: chỉ tính khi task thực sự nhắm tới kênh đó.
  if (task.channels.includes(CHANNELS.FACEBOOK)) {
    reasons.push(...getFacebookChannelReasons(task, brand, page, inferredContent, options));
  }

  if (task.channels.includes(CHANNELS.INSTAGRAM)) {
    reasons.push(...getInstagramChannelReasons(task, brand, options));
  }

  if (task.channels.includes(CHANNELS.GBP)) {
    reasons.push(...getGbpChannelReasons(task, brand, options));
  }

  if (task.channels.includes(CHANNELS.TIKTOK)) {
    reasons.push(...getTiktokChannelReasons(task, brand, options));
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
  const instagramAuth = options.instagramAuth || null;
  const gbpAuth = options.gbpAuth || null;
  const tiktokAuth = options.tiktokAuth || null;
  const readinessOptions = {
    driveConnected: googleDriveService.isConnected(options.driveAuth),
    proxyEnabled: mediaProxyService.isEnabled(),
    instagramAuth,
    gbpAuth,
    tiktokAuth
  };

  return tasks.flatMap((task) => {
    const brandId = task.primaryBrandIds[0];
    const brand = brandId ? brandsById.get(brandId) : null;
    if (pageVisibilityService.isHiddenBrandPage(brand, hiddenPageIds)) {
      return [];
    }

    const page = brand && brand.facebookPageId ? pagesById.get(brand.facebookPageId) : null;

    // Resolve tài khoản đăng cho từng kênh mà task nhắm tới (per-channel account).
    // channelAccounts[key] = { supported, configured, account } (account null nếu chưa nối).
    const channelAccounts = {};
    for (const channelKey of task.channels) {
      channelAccounts[channelKey] = resolveChannelAccount(channelKey, { brand, sessionPages, instagramAuth, gbpAuth, tiktokAuth });
    }

    // Readiness cần biết account đã resolve của từng kênh (adapter tự chấm điểm theo account).
    const taskReadinessOptions = { ...readinessOptions, channelAccounts };

    return [{
      task,
      brand,
      page,
      channelAccounts,
      scheduleReadiness: getScheduleReadiness(task, brand, page, now, taskReadinessOptions),
      readiness: getPublishReadiness(task, brand, page, now, taskReadinessOptions)
    }];
  });
}

function serializeResolvedTask(resolved) {
  const { task, brand, page, scheduleReadiness, readiness } = resolved;
  // Đã đăng = Publish Status tổng hợp là Đã đăng (kênh không phải Facebook không có cột Post ID riêng).
  const isPublished = task.publishStatus === PUBLISHED_STATUS;
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
    channels: task.channels,
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
    driveAuth: filters.driveAuth,
    instagramAuth: filters.instagramAuth,
    gbpAuth: filters.gbpAuth,
    tiktokAuth: filters.tiktokAuth
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
  const retryOptions = { ...readinessOptions, channelAccounts: resolved.channelAccounts };
  const retryReadiness = getScheduleReadiness(retryTask, brand, page, now, retryOptions);
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
    driveAuth: options.driveAuth,
    instagramAuth: options.instagramAuth,
    gbpAuth: options.gbpAuth,
    tiktokAuth: options.tiktokAuth
  });
  const filtered = options.pageId
    ? resolvedTasks.filter((resolved) => resolved.page && resolved.page.id === options.pageId)
    : resolvedTasks;
  const failedTasks = filtered.filter((resolved) => resolved.task.publishStatus === FAILED_STATUS);
  const readinessOptions = {
    driveConnected: googleDriveService.isConnected(options.driveAuth),
    proxyEnabled: mediaProxyService.isEnabled(),
    instagramAuth: options.instagramAuth || null,
    gbpAuth: options.gbpAuth || null,
    tiktokAuth: options.tiktokAuth || null
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

// Ghi trạng thái Đã đăng khi MỌI kênh đã xong. Cột Facebook Post ID/URL chỉ lấy từ
// kết quả Facebook (giữ nguyên hành vi cũ); kênh khác chỉ phản ánh qua Publish Status.
// Trả về permalink để caller log: ưu tiên Facebook, nếu không có thì lấy kênh đầu tiên có link.
async function updateTaskPublishSuccess(task, facebookResult, channelResults, syncedAt) {
  const properties = {
    [CONTENT_PROPS.publishStatus]: selectContent(PUBLISHED_STATUS),
    [CONTENT_PROPS.publishedAt]: richTextContent(syncedAt.toISOString()),
    [CONTENT_PROPS.lastSyncedAt]: richTextContent(syncedAt.toISOString()),
    [CONTENT_PROPS.errorMessage]: richTextContent("")
  };

  let permalinkUrl = "";

  if (facebookResult) {
    permalinkUrl = normalizeFacebookPostUrl(facebookResult.permalinkUrl) || `https://www.facebook.com/${facebookResult.postId}`;
    properties[CONTENT_PROPS.facebookPostId] = richTextContent(facebookResult.postId);
    properties[CONTENT_PROPS.facebookPostUrl] = richTextContent(permalinkUrl);
  } else {
    const firstWithLink = channelResults.find((result) => result.permalinkUrl);
    permalinkUrl = firstWithLink ? firstWithLink.permalinkUrl : "";
  }

  // Ghi ngược kết quả Instagram (id + link) để xem trực tiếp trên Notion; per-kênh vẫn nằm ở publish_jobs.
  const instagramResult = channelResults.find((result) => result.channel === CHANNELS.INSTAGRAM) || null;

  if (instagramResult) {
    properties[CONTENT_PROPS.instagramPostId] = richTextContent(instagramResult.postId || "");
    properties[CONTENT_PROPS.instagramPostUrl] = richTextContent(instagramResult.permalinkUrl || "");
  }

  const gbpResult = channelResults.find((result) => result.channel === CHANNELS.GBP) || null;

  if (gbpResult) {
    properties[CONTENT_PROPS.gbpPostUrl] = richTextContent(gbpResult.permalinkUrl || "");
  }

  const tiktokResult = channelResults.find((result) => result.channel === CHANNELS.TIKTOK) || null;

  if (tiktokResult) {
    properties[CONTENT_PROPS.tiktokPostId] = richTextContent(tiktokResult.postId || "");
    properties[CONTENT_PROPS.tiktokPostUrl] = richTextContent(tiktokResult.permalinkUrl || "");
  }

  await notion.pages.update({
    page_id: task.id,
    properties
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
    // Lớp 2: chốt mục tiêu đăng dự kiến để phát hiện đổi mapping trước giờ đăng.
    snapshotExpectedTargets(resolved);

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
    driveAuth: options.driveAuth,
    instagramAuth: options.instagramAuth,
    gbpAuth: options.gbpAuth,
    tiktokAuth: options.tiktokAuth
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

// So khớp mềm tên Brand vs tên Page thật: coi là khớp nếu một bên chứa bên kia
// hoặc chia sẻ ít nhất 1 "từ" đủ dài (>=3 ký tự) sau khi chuẩn hóa bỏ dấu.
function namesLikelyMatch(brandName, accountName) {
  const a = pageVisibilityService.normalizePageName(brandName);
  const b = pageVisibilityService.normalizePageName(accountName);

  if (!a || !b) {
    return true; // thiếu dữ liệu -> không kết luận là lệch
  }

  if (a === b || a.includes(b) || b.includes(a)) {
    return true;
  }

  const tokensA = new Set(a.split(" ").filter((token) => token.length >= 3));
  return b.split(" ").filter((token) => token.length >= 3).some((token) => tokensA.has(token));
}

// Xác minh mục tiêu đăng NGAY TRƯỚC KHI đăng, để tránh đăng nhầm page (bộ mặt doanh nghiệp).
// Chặn (throw) nếu: account lệch cấu hình Brand, hoặc mục tiêu đổi so với lúc lên lịch.
// Tên lệch chỉ cảnh báo, trừ khi bật AUTO_PUBLISH_STRICT_NAME_MATCH.
function verifyPublishTarget(resolved, channelKey, account) {
  const { task, brand } = resolved;
  const currentId = String((account && account.id) || "");
  const brandConfiguredId =
    brand && brand.channelAccounts ? String(brand.channelAccounts[channelKey] || "") : "";

  if (brandConfiguredId && currentId !== brandConfiguredId) {
    throw createPublicError(
      409,
      `Chặn đăng để tránh nhầm page: tài khoản đăng (${currentId}) khác Page ID cấu hình của Brand (${brandConfiguredId}).`,
      { service: "publish-guard", context: "account_mismatch_brand", status: 409 }
    );
  }

  const job = publishJobsService.getJob(task.id, channelKey);

  if (job && job.expectedAccountId && String(job.expectedAccountId) !== currentId) {
    throw createPublicError(
      409,
      `Chặn đăng: mục tiêu đăng đã thay đổi kể từ lúc lên lịch (dự kiến ${job.expectedAccountId}, hiện tại ${currentId}). Hãy kiểm tra lại Brand rồi lên lịch lại.`,
      { service: "publish-guard", context: "account_drift_since_schedule", status: 409 }
    );
  }

  const brandName = brand ? brand.facebookPageName || brand.name || "" : "";
  const nameMismatch = Boolean(
    channelKey === CHANNELS.FACEBOOK && brandName && account.name && !namesLikelyMatch(brandName, account.name)
  );

  if (nameMismatch) {
    console.warn(`[Publish Guard] Tên lệch: Brand "${brandName}" vs Page "${account.name}" (task ${task.id}).`);

    if (config.autoPublish.strictNameMatch) {
      throw createPublicError(
        409,
        `Chặn đăng: tên page thật "${account.name}" không khớp tên Brand "${brandName}".`,
        { service: "publish-guard", context: "name_mismatch_strict", status: 409 }
      );
    }
  }

  return { nameMismatch, brandName, accountName: (account && account.name) || "" };
}

// Chốt "mục tiêu đăng dự kiến" cho từng kênh ngay khi lên lịch (nguồn để phát hiện đổi mapping).
function snapshotExpectedTargets(resolved) {
  try {
    for (const channelKey of resolved.task.channels) {
      const resolvedChannel = resolved.channelAccounts[channelKey];

      if (resolvedChannel && resolvedChannel.supported && resolvedChannel.account && resolvedChannel.account.id) {
        publishJobsService.recordExpectedAccount(resolved.task.id, channelKey, String(resolvedChannel.account.id));
      }
    }
  } catch (error) {
    logNotionError("snapshot_expected_targets", error);
  }
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

  // Kênh sẽ đăng = kênh task nhắm tới, có adapter và đã resolve được account.
  // Account từng kênh đã được resolve per-channel ở getResolvedTasks (qua adapter).
  const targetChannels = task.channels.filter((channelKey) => {
    const resolvedChannel = resolved.channelAccounts[channelKey];
    return Boolean(resolvedChannel && resolvedChannel.supported && resolvedChannel.account);
  });

  let mediaItems = [];
  let publicMediaUrls = null;
  const proxyFilenames = [];
  const channelResults = [];

  try {
    if (targetChannels.length === 0) {
      throw createPublicError(400, "Không resolve được kênh nào để đăng cho tác vụ này.", {
        service: "publisher",
        context: "resolve_channels"
      });
    }

    await updateTaskPublishing(task, startedAt);
    // Resolve media 1 lần (buffer từ Drive cho Facebook); kênh dùng public URL sẽ bỏ qua mediaItems.
    mediaItems = await googleDriveService.resolveMediaItems(task.mediaUrls, options.driveAuth);

    // Kênh PULL (IG/GBP/TikTok) không nhận buffer — cần URL công khai. Nếu bật proxy, phát lại
    // buffer Drive thành URL công khai tạm (đuôi file đúng) để nền tảng fetch; xóa sau khi đăng.
    const needsPublicUrls = targetChannels.some((channelKey) => channelKey !== CHANNELS.FACEBOOK);

    if (needsPublicUrls && mediaProxyService.isEnabled()) {
      publicMediaUrls = mediaItems.map((item) => {
        if (item && item.kind === "buffer") {
          const stored = mediaProxyService.publishBuffer(item.buffer, {
            contentType: item.contentType,
            filename: item.filename
          });
          proxyFilenames.push(stored.filename);
          return { url: stored.url, contentType: item.contentType };
        }

        return { url: item && item.url, contentType: null };
      });
    }

    for (const channelKey of targetChannels) {
      const account = resolved.channelAccounts[channelKey].account;

      // publish_jobs là nguồn sự thật: kênh đã đăng thành công thì bỏ qua (chống trùng khi retry đa kênh).
      const existingJob = publishJobsService.getJob(task.id, channelKey);

      if (existingJob && existingJob.status === publishJobsService.STATUS.PUBLISHED && existingJob.postId) {
        channelResults.push({
          channel: channelKey,
          postId: existingJob.postId,
          permalinkUrl: existingJob.permalinkUrl,
          alreadyPublished: true
        });
        continue;
      }

      // Lớp 2: xác minh đúng page trước khi đăng (chặn nếu lệch cấu hình/đổi mục tiêu).
      verifyPublishTarget(resolved, channelKey, account);

      const publishResult = await publisherService.publishTaskToChannel({
        channelKey,
        task,
        brand: resolved.brand,
        account,
        contentType: readiness.contentType,
        mediaItems,
        publicMediaUrls,
        driveAuth: options.driveAuth
      });

      channelResults.push({
        channel: channelKey,
        postId: publishResult.postId,
        permalinkUrl: publishResult.permalinkUrl
      });
    }
  } catch (error) {
    // Có kênh lỗi -> Notion tổng hợp là Lỗi đăng (dù kênh trước đã đăng; publish_jobs vẫn giữ đúng trạng thái từng kênh).
    const message = error.publicMessage || error.message || "Đăng bài thất bại.";

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
      message,
      channelResults
    };
  } finally {
    // Xóa file proxy tạm ngay sau khi đăng (nền tảng đã fetch xong vì publish chờ đồng bộ).
    for (const filename of proxyFilenames) {
      mediaProxyService.remove(filename);
    }
  }

  // Mọi kênh đã đăng xong -> tổng hợp trạng thái Đã đăng về Notion.
  const facebookResult = channelResults.find((result) => result.channel === CHANNELS.FACEBOOK) || null;
  const primaryResult = facebookResult || channelResults[0] || null;

  try {
    const permalinkUrl = await updateTaskPublishSuccess(task, facebookResult, channelResults, startedAt);

    return {
      success: true,
      taskId: task.id,
      title: task.title,
      pageId: page ? page.id : null,
      pageName: page ? page.name : null,
      postId: primaryResult ? primaryResult.postId : null,
      permalinkUrl,
      channelResults
    };
  } catch (error) {
    logNotionError("update_task_success", error);

    return {
      success: false,
      posted: true,
      skipped: false,
      taskId: task.id,
      title: task.title,
      postId: primaryResult ? primaryResult.postId : null,
      permalinkUrl: primaryResult
        ? (primaryResult.permalinkUrl || (facebookResult ? `https://www.facebook.com/${facebookResult.postId}` : ""))
        : "",
      message: "Đã đăng lên các kênh nhưng không cập nhật được Notion.",
      channelResults
    };
  }
}

// Danh sách account id (page id...) mà task sẽ đăng lên — để áp cooldown theo page.
function getTargetAccountIds(resolved) {
  return resolved.task.channels
    .map((channelKey) => resolved.channelAccounts[channelKey])
    .filter((resolvedChannel) => resolvedChannel && resolvedChannel.supported && resolvedChannel.account && resolvedChannel.account.id)
    .map((resolvedChannel) => String(resolvedChannel.account.id));
}

// Đăng danh sách task đã sẵn sàng, ÁP CÁC LỚP PHANH AN TOÀN:
// - Kill switch / pause runtime: không đăng gì.
// - Ngưỡng bất thường: quá nhiều task đến hạn cùng lúc => tự pause + KHÔNG đăng.
// - Trần số bài/tick: phần vượt trần hoãn sang lượt sau.
// - Cooldown theo page: page vừa đăng thì hoãn để không dồn bài.
async function publishTasksWithGuard(readyTasks, totalResolved, options) {
  const guardStatus = publishGuardService.getStatus();

  if (!publishGuardService.isActive()) {
    return {
      attemptedCount: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: totalResolved,
      paused: true,
      guardStatus,
      results: []
    };
  }

  const threshold = config.autoPublish.anomalyThreshold;

  if (readyTasks.length > threshold) {
    const reason = `Bất thường: ${readyTasks.length} tác vụ đến hạn cùng lúc (ngưỡng ${threshold}). Đã tạm dừng tự đăng để bảo vệ page.`;
    publishGuardService.pause(reason);

    return {
      attemptedCount: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: totalResolved,
      paused: true,
      anomaly: true,
      anomalyReason: reason,
      dueCount: readyTasks.length,
      guardStatus: publishGuardService.getStatus(),
      results: []
    };
  }

  const maxPerRun = config.autoPublish.maxPublishPerRun;
  const results = [];
  let publishedCount = 0;

  for (const resolvedTask of readyTasks) {
    if (publishedCount >= maxPerRun) {
      results.push({
        success: false,
        skipped: true,
        deferred: true,
        taskId: resolvedTask.task.id,
        title: resolvedTask.task.title,
        reasons: [`Đã đạt trần ${maxPerRun} bài mỗi lượt, hoãn sang lượt sau.`]
      });
      continue;
    }

    const now = Date.now();
    const accountIds = getTargetAccountIds(resolvedTask);
    const coolingAccountId = accountIds.find((id) => !publishGuardService.canPublishToAccount(id, now));

    if (coolingAccountId) {
      const remainMinutes = Math.ceil(publishGuardService.cooldownRemainingMs(coolingAccountId, now) / 60000);
      results.push({
        success: false,
        skipped: true,
        cooldown: true,
        taskId: resolvedTask.task.id,
        title: resolvedTask.task.title,
        reasons: [`Page vừa đăng, đang nghỉ giữa 2 bài (còn ~${remainMinutes} phút).`]
      });
      continue;
    }

    const result = await publishResolvedTask(resolvedTask, options);
    results.push(result);

    if (result.success || result.posted) {
      const publishedAt = Date.now();
      accountIds.forEach((id) => publishGuardService.recordPublish(id, publishedAt));
      publishedCount += 1;
    }
  }

  return {
    attemptedCount: readyTasks.length,
    successCount: results.filter((result) => result.success).length,
    failureCount: results.filter((result) => !result.success && !result.skipped).length,
    skippedCount: totalResolved - readyTasks.length,
    publishedCount,
    results
  };
}

async function publishDueTasks(sessionPages, options = {}) {
  const resolvedTasks = await getResolvedTasks(sessionPages, {
    driveAuth: options.driveAuth,
    instagramAuth: options.instagramAuth,
    gbpAuth: options.gbpAuth,
    tiktokAuth: options.tiktokAuth
  });
  const readyTasks = resolvedTasks.filter((resolved) => resolved.readiness.readyToPublish);

  return publishTasksWithGuard(readyTasks, resolvedTasks.length, options);
}

async function publishOverdueTasks(sessionPages, options = {}) {
  const resolvedTasks = await getResolvedTasks(sessionPages, {
    driveAuth: options.driveAuth,
    instagramAuth: options.instagramAuth,
    gbpAuth: options.gbpAuth,
    tiktokAuth: options.tiktokAuth
  });
  const overdueTasks = resolvedTasks.filter(
    (resolved) =>
      resolved.readiness.readyToPublish &&
      resolved.readiness.overdue &&
      !resolved.readiness.tooOldOverdue
  );

  return publishTasksWithGuard(overdueTasks, resolvedTasks.length, options);
}

async function publishSingleTask(taskId, sessionPages, options = {}) {
  const resolvedTasks = await getResolvedTasks(sessionPages, {
    driveAuth: options.driveAuth,
    instagramAuth: options.instagramAuth,
    gbpAuth: options.gbpAuth,
    tiktokAuth: options.tiktokAuth
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
  syncInstagramAccountIds,
  listTasksForSession,
  markTaskManualPostSuccess,
  prepareFailedTasksForRetry,
  scheduleReadyTasks,
  publishDueTasks,
  publishOverdueTasks,
  publishSingleTask
};
