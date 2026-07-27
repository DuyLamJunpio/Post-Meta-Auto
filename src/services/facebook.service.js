const axios = require("axios");
const FormData = require("form-data");

const { config } = require("../config");

function createPublicError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details || null;
  return error;
}

function handleGraphError(context, error, publicMessage) {
  const graphError = error.response && error.response.data && error.response.data.error;

  console.error("[Meta Graph API]", {
    context,
    status: error.response && error.response.status,
    type: graphError && graphError.type,
    code: graphError && graphError.code,
    message: graphError && graphError.message,
    transportCode: error.code,
    transportMessage: !error.response ? error.message : undefined
  });

  if (!error.response) {
    throw createPublicError(
      502,
      "Backend không kết nối được Meta Graph API. Kiểm tra internet, proxy/firewall hoặc cách bạn đang chạy server."
    );
  }

  const responseStatus = error.response && error.response.status;
  const readableMessage = context === "create_page_video_post" && responseStatus === 413
    ? "Facebook từ chối request upload video trực tiếp với mã 413. Không thể kết luận video quá dài hoặc quá lớn chỉ từ mã này; hãy thử đăng lại bằng file Drive để hệ thống dùng luồng upload nhiều bước, hoặc kiểm tra định dạng video và quyền Page."
    : publicMessage;

  throw createPublicError(502, readableMessage, {
    service: "facebook",
    context,
    status: responseStatus,
    type: graphError && graphError.type,
    code: graphError && graphError.code,
    providerMessage: graphError && graphError.message
  });
}

async function exchangeCodeForUserAccessToken(code) {
  try {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/oauth/access_token`, {
      params: {
        client_id: config.facebook.appId,
        redirect_uri: config.facebook.redirectUri,
        client_secret: config.facebook.appSecret,
        code
      }
    });

    if (!response.data || !response.data.access_token) {
      throw createPublicError(502, "Không đổi được code lấy token Facebook.");
    }

    return response.data.access_token;
  } catch (error) {
    if (error.publicMessage) {
      throw error;
    }

    handleGraphError("exchange_code", error, "Không đổi được code lấy token Facebook.");
  }
}

async function getFacebookUser(userAccessToken) {
  try {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/me`, {
      params: {
        fields: "id,name",
        access_token: userAccessToken
      }
    });

    return response.data;
  } catch (error) {
    handleGraphError("get_user", error, "Không lấy được thông tin tài khoản Facebook.");
  }
}

// instagram_business_account: IG Business liên kết Page -> đăng IG bằng Page token (Cách Facebook Login).
const PAGE_FIELDS =
  "id,name,access_token,tasks,picture{url},instagram_business_account{id,username,profile_picture_url}";

function mapPage(page) {
  return {
    id: page.id,
    name: page.name,
    pageAccessToken: page.access_token,
    tasks: Array.isArray(page.tasks) ? page.tasks : [],
    pictureUrl: page.picture && page.picture.data ? page.picture.data.url : null,
    instagramBusinessAccount: page.instagram_business_account
      ? {
          id: page.instagram_business_account.id,
          username: page.instagram_business_account.username || "",
          profilePictureUrl: page.instagram_business_account.profile_picture_url || null
        }
      : null
  };
}

// Duyệt hết các trang phân trang của một edge Graph, trả về mảng phần tử data đã gộp.
async function fetchAllPaged(startUrl, initialParams) {
  const items = [];
  let nextUrl = startUrl;
  let params = initialParams;

  while (nextUrl) {
    const response = await axios.get(nextUrl, { params });
    const data = response.data && response.data.data ? response.data.data : [];
    items.push(...data);
    nextUrl = response.data && response.data.paging ? response.data.paging.next : null;
    params = undefined;
  }

  return items;
}

// Lấy Page nằm trong các Business Portfolio (owned_pages + client_pages) mà /me/accounts
// bỏ sót vì tài khoản không được gán vai trò trực tiếp trên Page. Cần scope business_management.
// Lỗi ở đây (thiếu quyền, chưa duyệt App...) không được làm hỏng luồng chính -> chỉ log và bỏ qua.
async function getBusinessOwnedPages(userAccessToken) {
  try {
    const businesses = await fetchAllPaged(`${config.facebook.graphApiBaseUrl}/me/businesses`, {
      fields: "id,name",
      access_token: userAccessToken,
      limit: 100
    });

    const pages = [];
    for (const business of businesses) {
      for (const edge of ["owned_pages", "client_pages"]) {
        try {
          const data = await fetchAllPaged(`${config.facebook.graphApiBaseUrl}/${business.id}/${edge}`, {
            fields: PAGE_FIELDS,
            access_token: userAccessToken,
            limit: 100
          });
          pages.push(...data);
        } catch (edgeError) {
          const detail = edgeError.response && edgeError.response.data ? edgeError.response.data : edgeError.message;
          console.warn(`[Meta Graph API] Không lấy được ${edge} của business ${business.id}:`, detail);
        }
      }
    }

    return pages;
  } catch (error) {
    const detail = error.response && error.response.data ? error.response.data : error.message;
    console.warn("[Meta Graph API] Không liệt kê được Business (business_management?):", detail);
    return [];
  }
}

async function getManagedPages(userAccessToken) {
  try {
    // 1) Page có vai trò trực tiếp (classic role).
    const directPages = await fetchAllPaged(`${config.facebook.graphApiBaseUrl}/me/accounts`, {
      fields: PAGE_FIELDS,
      access_token: userAccessToken,
      limit: 100
    });

    // 2) Page nằm trong Business Portfolio (không có vai trò trực tiếp).
    const businessPages = await getBusinessOwnedPages(userAccessToken);

    // Gộp và khử trùng lặp theo id; ưu tiên bản có sẵn access_token (thường từ /me/accounts).
    const byId = new Map();
    for (const raw of [...directPages, ...businessPages]) {
      if (!raw || !raw.id) continue;
      const existing = byId.get(raw.id);
      if (!existing) {
        byId.set(raw.id, raw);
      } else if (!existing.access_token && raw.access_token) {
        byId.set(raw.id, raw);
      }
    }

    return Array.from(byId.values()).map(mapPage);
  } catch (error) {
    handleGraphError("get_pages", error, "Không lấy được danh sách Page.");
  }
}

function canCreateContent(page) {
  return Array.isArray(page.tasks) && page.tasks.includes("CREATE_CONTENT");
}

// Thu hồi (xóa) một bài đã đăng trên Page qua Graph API. Cần Page Access Token.
async function deletePagePost(postId, pageAccessToken) {
  if (!postId || !pageAccessToken) {
    throw createPublicError(400, "Thiếu Post ID hoặc Page Access Token để thu hồi bài.", {
      service: "facebook",
      context: "delete_post_missing_args"
    });
  }

  try {
    const response = await axios.delete(`${config.facebook.graphApiBaseUrl}/${postId}`, {
      params: { access_token: pageAccessToken }
    });

    return { success: Boolean(response.data && response.data.success !== false), postId };
  } catch (error) {
    handleGraphError("delete_post", error, "Không thu hồi được bài đăng.");
  }
}

function toMediaItem(media) {
  if (!media || typeof media === "string") {
    return {
      kind: "url",
      url: media
    };
  }

  return media;
}

function isUploadMedia(media) {
  const mediaItem = toMediaItem(media);
  return mediaItem.kind === "buffer" && Buffer.isBuffer(mediaItem.buffer);
}

function getMediaUrl(media) {
  const mediaItem = toMediaItem(media);
  return mediaItem.url || mediaItem.originalUrl;
}

function getMediaContentType(media) {
  const mediaItem = toMediaItem(media);
  const contentType = String(mediaItem.contentType || "").split(";")[0].trim().toLowerCase();

  if (contentType) {
    return contentType;
  }

  const url = getMediaUrl(media) || "";

  if (/\.(avif|gif|jpe?g|png|webp)(\?.*)?$/i.test(url)) {
    return "image/*";
  }

  if (/\.(m4v|mov|mp4|webm)(\?.*)?$/i.test(url)) {
    return "video/*";
  }

  return "";
}

function isImageMedia(media) {
  return getMediaContentType(media).startsWith("image/");
}

function isVideoMedia(media) {
  return getMediaContentType(media).startsWith("video/");
}

function splitMediaItems(mediaItems) {
  const images = [];
  const videos = [];
  const unknown = [];

  for (const item of mediaItems) {
    if (isImageMedia(item)) {
      images.push(item);
    } else if (isVideoMedia(item)) {
      videos.push(item);
    } else {
      unknown.push(item);
    }
  }

  return { images, videos, unknown };
}

function appendOptionalPostFields(form, options = {}) {
  if (options.placeId) {
    form.append("place", options.placeId);
  }

  if (Array.isArray(options.tagIds) && options.tagIds.length > 0) {
    form.append("tags", options.tagIds.join(","));
  }
}

function normalizeFacebookPermalink(permalinkUrl) {
  const value = String(permalinkUrl || "").trim();

  if (!value) {
    return null;
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

function appendUploadFile(form, fieldName, media) {
  const mediaItem = toMediaItem(media);

  form.append(fieldName, mediaItem.buffer, {
    filename: mediaItem.filename || "drive-media",
    contentType: mediaItem.contentType || "application/octet-stream",
    knownLength: mediaItem.buffer.length
  });
}

async function getPagePosts(pageId, pageAccessToken) {
  try {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/${pageId}/feed`, {
      params: {
        fields: "id,message,created_time,permalink_url",
        access_token: pageAccessToken,
        limit: 25
      }
    });

    const posts = response.data && response.data.data ? response.data.data : [];

    return posts.map((post) => ({
      id: post.id,
      message: post.message || "",
      createdTime: post.created_time,
      permalinkUrl: normalizeFacebookPermalink(post.permalink_url)
    }));
  } catch (error) {
    handleGraphError("get_page_posts", error, "Không tải được danh sách bài viết.");
  }
}

// Danh sách quyền đã được CẤP cho user token — để chẩn đoán vì sao không đọc được bài.
async function getGrantedPermissions(userAccessToken) {
  try {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/me/permissions`, {
      params: { access_token: userAccessToken }
    });
    const rows = (response.data && response.data.data) || [];
    return rows.filter((row) => row.status === "granted").map((row) => row.permission);
  } catch (error) {
    console.warn("[Meta Graph API] Không đọc được /me/permissions:", error.message);
    return [];
  }
}

// Lấy Page Access Token "chuẩn" trực tiếp từ Page bằng user token. Khắc phục trường hợp token
// lấy qua Business Portfolio (owned_pages/client_pages) đọc được IG nhưng KHÔNG đọc được /feed.
async function getPageAccessToken(pageId, userAccessToken) {
  try {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/${pageId}`, {
      params: { fields: "access_token", access_token: userAccessToken }
    });
    return (response.data && response.data.access_token) || null;
  } catch (error) {
    console.warn("[Meta Graph API] Không lấy được Page Access Token chuẩn:", error.message);
    return null;
  }
}

const READ_POSTS_PERMISSION = "pages_read_engagement";

// Lấy bài Facebook của Page KÈM chẩn đoán. Nếu rỗng/lỗi: kiểm tra quyền, rồi thử Page token chuẩn.
// Trả { posts, warning } để UI hiển thị lý do rõ ràng thay vì im lặng "không có bài".
async function getPagePostsWithDiagnosis({ pageId, pageAccessToken, userAccessToken }) {
  let posts = [];
  let feedError = null;

  try {
    posts = await getPagePosts(pageId, pageAccessToken);
  } catch (error) {
    feedError = error;
  }

  if (posts && posts.length > 0) {
    return { posts, warning: null };
  }

  // Không có bài (rỗng hoặc lỗi) -> chẩn đoán quyền trước.
  const granted = await getGrantedPermissions(userAccessToken);

  if (granted.length > 0 && !granted.includes(READ_POSTS_PERMISSION)) {
    return {
      posts: [],
      warning:
        `Tài khoản Facebook này chưa cấp quyền đọc bài Page (${READ_POSTS_PERMISSION}) nên không hiển thị bài Facebook. ` +
        "Hãy đăng xuất rồi đăng nhập lại bằng Facebook và cấp ĐỦ quyền khi được hỏi."
    };
  }

  // Quyền đủ nhưng vẫn rỗng/lỗi -> thử Page Access Token chuẩn (token qua Business Portfolio hay lỗi).
  if (userAccessToken) {
    const canonicalToken = await getPageAccessToken(pageId, userAccessToken);

    if (canonicalToken && canonicalToken !== pageAccessToken) {
      try {
        const retryPosts = await getPagePosts(pageId, canonicalToken);
        if (retryPosts && retryPosts.length > 0) {
          return { posts: retryPosts, warning: null };
        }
      } catch (retryError) {
        feedError = feedError || retryError;
      }
    }
  }

  if (feedError) {
    const providerMessage = feedError.details && feedError.details.providerMessage;
    return {
      posts: [],
      warning: `Không đọc được bài Facebook của Page: ${providerMessage || feedError.publicMessage || feedError.message}`
    };
  }

  return { posts: [], warning: null };
}

// Lấy chi tiết 1 bài đăng (nội dung + ảnh + permalink) để cảnh báo hiển thị rõ là bài nào.
// Không throw: nếu không lấy được thì trả null để không chặn thao tác chính (vd thu hồi).
async function getPagePostDetail(postId, pageAccessToken) {
  try {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/${postId}`, {
      params: {
        fields: "message,story,permalink_url,full_picture,created_time",
        access_token: pageAccessToken
      }
    });

    const data = response.data || {};
    return {
      message: data.message || data.story || "",
      permalinkUrl: normalizeFacebookPermalink(data.permalink_url),
      fullPicture: data.full_picture || null,
      createdTime: data.created_time || null
    };
  } catch (error) {
    const graphError = error.response && error.response.data && error.response.data.error;
    console.warn("[Meta Graph API] Không lấy được chi tiết bài để cảnh báo:", graphError ? graphError.message : error.message);
    return null;
  }
}

// Lấy bài đăng gần đây của tài khoản Instagram Business đã liên kết với Page.
// Dùng chính Page Access Token (luồng IG-linked-to-Page), không cần token IG riêng.
async function getInstagramMedia(instagramUserId, pageAccessToken) {
  try {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/${instagramUserId}/media`, {
      params: {
        fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp",
        access_token: pageAccessToken,
        limit: 25
      }
    });

    const media = response.data && response.data.data ? response.data.data : [];

    return media.map((item) => ({
      id: item.id,
      caption: item.caption || "",
      mediaType: item.media_type || "",
      mediaUrl: item.media_url || null,
      thumbnailUrl: item.thumbnail_url || null,
      permalinkUrl: item.permalink || null,
      createdTime: item.timestamp
    }));
  } catch (error) {
    handleGraphError("get_instagram_media", error, "Không tải được danh sách bài đăng Instagram.");
  }
}

// ===========================================================================
//  THỐNG KÊ (Analytics) — kéo TOÀN BỘ dữ liệu Page FB + IG để dựng báo cáo.
// ===========================================================================

// Duyệt hết phân trang KÈM trần an toàn (maxItems) để full history không "treo"
// với Page hàng nghìn bài. Trả { items, truncated } để báo cáo biết đã cắt bớt.
async function fetchPagedCapped(startUrl, initialParams, maxItems) {
  const items = [];
  let nextUrl = startUrl;
  let params = initialParams;
  let truncated = false;

  while (nextUrl) {
    const response = await axios.get(nextUrl, { params });
    const data = response.data && response.data.data ? response.data.data : [];
    items.push(...data);

    if (maxItems && items.length >= maxItems) {
      truncated = Boolean(response.data && response.data.paging && response.data.paging.next);
      return { items: items.slice(0, maxItems), truncated };
    }

    nextUrl = response.data && response.data.paging ? response.data.paging.next : null;
    params = undefined;
  }

  return { items, truncated };
}

// Thông tin hồ sơ Page (số fan/follower, danh mục...) để tính tỷ lệ tương tác.
async function getPageProfile(pageId, pageAccessToken) {
  try {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/${pageId}`, {
      params: {
        fields: "id,name,username,category,about,link,fan_count,followers_count,picture{url}",
        access_token: pageAccessToken
      }
    });

    const data = response.data || {};
    return {
      id: data.id,
      name: data.name || "",
      username: data.username || "",
      category: data.category || "",
      about: data.about || "",
      link: data.link || null,
      fanCount: Number(data.fan_count) || 0,
      followersCount: Number(data.followers_count) || 0,
      pictureUrl: data.picture && data.picture.data ? data.picture.data.url : null
    };
  } catch (error) {
    handleGraphError("get_page_profile", error, "Không tải được hồ sơ Page.");
  }
}

const REACTION_TYPES = ["LIKE", "LOVE", "HAHA", "WOW", "SAD", "ANGRY", "CARE"];

// Trường đầy đủ: tổng reaction + reaction theo từng loại + comment + share + loại media.
const POST_FIELDS_FULL = [
  "id",
  "created_time",
  "message",
  "story",
  "permalink_url",
  "status_type",
  "attachments{media_type,type}",
  "shares",
  "comments.summary(true).limit(0)",
  "reactions.summary(true).limit(0)",
  ...REACTION_TYPES.map(
    (type) => `reactions.type(${type}).limit(0).summary(true).as(reactions_${type.toLowerCase()})`
  )
].join(",");

// Trường tối thiểu (fallback) nếu Graph từ chối bộ trường phức tạp ở trên.
const POST_FIELDS_BASIC = [
  "id",
  "created_time",
  "message",
  "story",
  "permalink_url",
  "status_type",
  "attachments{media_type,type}",
  "shares",
  "comments.summary(true).limit(0)",
  "reactions.summary(true).limit(0)"
].join(",");

function readSummaryTotal(edge) {
  return edge && edge.summary ? Number(edge.summary.total_count) || 0 : 0;
}

function normalizePagePost(post, hasReactionBreakdown) {
  const reactionsTotal = readSummaryTotal(post.reactions);
  const comments = readSummaryTotal(post.comments);
  const shares = post.shares && Number.isFinite(Number(post.shares.count)) ? Number(post.shares.count) : 0;

  const reactionsByType = {};
  if (hasReactionBreakdown) {
    for (const type of REACTION_TYPES) {
      reactionsByType[type.toLowerCase()] = readSummaryTotal(post[`reactions_${type.toLowerCase()}`]);
    }
  }

  const attachment = post.attachments && post.attachments.data && post.attachments.data[0];

  return {
    id: post.id,
    message: post.message || post.story || "",
    createdTime: post.created_time,
    permalinkUrl: normalizeFacebookPermalink(post.permalink_url),
    statusType: post.status_type || "",
    mediaType: attachment ? attachment.media_type || attachment.type || "" : "",
    reactions: reactionsTotal,
    reactionsByType,
    comments,
    shares,
    engagement: reactionsTotal + comments + shares
  };
}

// Lấy TOÀN BỘ bài Page đã đăng kèm chỉ số tương tác (reaction/comment/share).
// Tự thử Page token chuẩn nếu token hiện tại đọc rỗng (giống getPagePostsWithDiagnosis).
// Nếu Graph từ chối bộ trường reaction-theo-loại -> tự lùi về trường cơ bản.
async function getAllPagePosts({ pageId, pageAccessToken, userAccessToken, maxPosts = 3000 }) {
  const baseUrl = `${config.facebook.graphApiBaseUrl}/${pageId}/published_posts`;

  async function fetchWith(token, fields) {
    return fetchPagedCapped(baseUrl, { fields, access_token: token, limit: 100 }, maxPosts);
  }

  let hasReactionBreakdown = true;
  let result;
  let usedToken = pageAccessToken;

  try {
    result = await fetchWith(pageAccessToken, POST_FIELDS_FULL);
  } catch (fullFieldError) {
    // Bộ trường phức tạp bị từ chối -> lùi về trường cơ bản (mất breakdown, giữ tổng).
    hasReactionBreakdown = false;
    try {
      result = await fetchWith(pageAccessToken, POST_FIELDS_BASIC);
    } catch (basicError) {
      // Vẫn lỗi -> có thể do token qua Business Portfolio. Thử Page token chuẩn.
      const canonicalToken = userAccessToken ? await getPageAccessToken(pageId, userAccessToken) : null;
      if (canonicalToken && canonicalToken !== pageAccessToken) {
        usedToken = canonicalToken;
        hasReactionBreakdown = true;
        try {
          result = await fetchWith(canonicalToken, POST_FIELDS_FULL);
        } catch (retryFull) {
          hasReactionBreakdown = false;
          result = await fetchWith(canonicalToken, POST_FIELDS_BASIC);
        }
      } else {
        handleGraphError("get_all_page_posts", basicError, "Không tải được toàn bộ bài viết của Page.");
      }
    }
  }

  // Token hiện tại đọc rỗng nhưng có thể token chuẩn đọc được -> thử lại 1 lần.
  if (result && result.items.length === 0 && userAccessToken) {
    const canonicalToken = await getPageAccessToken(pageId, userAccessToken);
    if (canonicalToken && canonicalToken !== usedToken) {
      try {
        const retry = await fetchWith(canonicalToken, POST_FIELDS_FULL);
        if (retry.items.length > 0) {
          result = retry;
          hasReactionBreakdown = true;
        }
      } catch (retryError) {
        // Giữ kết quả rỗng ban đầu — analytics.service sẽ báo "chưa có bài".
      }
    }
  }

  return {
    posts: result.items.map((post) => normalizePagePost(post, hasReactionBreakdown)),
    truncated: result.truncated,
    hasReactionBreakdown
  };
}

// Hồ sơ tài khoản Instagram Business liên kết Page.
async function getInstagramProfile(instagramUserId, pageAccessToken) {
  try {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/${instagramUserId}`, {
      params: {
        fields: "id,username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url",
        access_token: pageAccessToken
      }
    });

    const data = response.data || {};
    return {
      id: data.id,
      username: data.username || "",
      name: data.name || "",
      biography: data.biography || "",
      website: data.website || null,
      followersCount: Number(data.followers_count) || 0,
      followsCount: Number(data.follows_count) || 0,
      mediaCount: Number(data.media_count) || 0,
      profilePictureUrl: data.profile_picture_url || null
    };
  } catch (error) {
    handleGraphError("get_instagram_profile", error, "Không tải được hồ sơ Instagram.");
  }
}

// Lấy TOÀN BỘ media Instagram Business kèm like/comment.
async function getAllInstagramMedia({ instagramUserId, pageAccessToken, maxItems = 3000 }) {
  const baseUrl = `${config.facebook.graphApiBaseUrl}/${instagramUserId}/media`;
  const fields = "id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count";

  try {
    const result = await fetchPagedCapped(baseUrl, { fields, access_token: pageAccessToken, limit: 100 }, maxItems);

    const media = result.items.map((item) => {
      const likeCount = Number(item.like_count) || 0;
      const commentsCount = Number(item.comments_count) || 0;
      return {
        id: item.id,
        caption: item.caption || "",
        mediaType: item.media_type || "",
        mediaProductType: item.media_product_type || "",
        permalinkUrl: item.permalink || null,
        createdTime: item.timestamp,
        likeCount,
        commentsCount,
        engagement: likeCount + commentsCount
      };
    });

    return { media, truncated: result.truncated };
  } catch (error) {
    handleGraphError("get_all_instagram_media", error, "Không tải được toàn bộ media Instagram.");
  }
}

// Insight cấp Page (reach/impressions...) — BEST-EFFORT: nhiều metric bị Meta khóa
// dần theo version, nên không được để lỗi ở đây làm hỏng cả báo cáo.
// Trả { available, metrics?, reason? }. metrics: [{ name, title, total, series:[{date,value}] }].
async function getPageInsights({ pageId, pageAccessToken, since, until }) {
  const metricList = [
    "page_impressions",
    "page_impressions_unique",
    "page_post_engagements",
    "page_fans",
    "page_views_total"
  ];

  async function requestMetrics(metrics) {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/${pageId}/insights`, {
      params: {
        metric: metrics.join(","),
        period: "day",
        since,
        until,
        access_token: pageAccessToken
      }
    });
    return (response.data && response.data.data) || [];
  }

  function normalizeInsight(entry) {
    const values = Array.isArray(entry.values) ? entry.values : [];
    const series = values.map((point) => ({
      date: point.end_time || null,
      value: Number(point.value) || 0
    }));
    return {
      name: entry.name,
      title: entry.title || entry.name,
      description: entry.description || "",
      total: series.reduce((totalSum, point) => totalSum + point.value, 0),
      series
    };
  }

  try {
    const rows = await requestMetrics(metricList);
    return { available: true, metrics: rows.map(normalizeInsight) };
  } catch (fullError) {
    // Thử tập tối thiểu thường còn sống.
    try {
      const rows = await requestMetrics(["page_impressions_unique", "page_post_engagements"]);
      return { available: true, metrics: rows.map(normalizeInsight), partial: true };
    } catch (minimalError) {
      const graphError =
        minimalError.response && minimalError.response.data && minimalError.response.data.error;
      const reason = graphError && graphError.message ? graphError.message : minimalError.message;
      console.warn("[Meta Graph API] Không lấy được Page Insights:", reason);
      return {
        available: false,
        reason:
          "Không lấy được Insight cấp Page (reach/impressions). Thường do thiếu quyền read_insights hoặc metric đã bị Meta ngừng ở phiên bản API này."
      };
    }
  }
}

async function createPagePost(pageId, pageAccessToken, message, options = {}) {
  try {
    const form = new URLSearchParams();
    form.append("message", message);
    appendOptionalPostFields(form, options);
    form.append("access_token", pageAccessToken);

    const response = await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/feed`, form, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    return response.data && response.data.id;
  } catch (error) {
    handleGraphError("create_page_post", error, "Facebook không chấp nhận đăng bài.");
  }
}

async function createUnpublishedPagePhoto(pageId, pageAccessToken, imageMedia) {
  try {
    let body;
    let headers;

    if (isUploadMedia(imageMedia)) {
      body = new FormData();
      appendUploadFile(body, "source", imageMedia);
      body.append("published", "false");
      body.append("access_token", pageAccessToken);
      headers = body.getHeaders();
    } else {
      body = new URLSearchParams();
      body.append("url", getMediaUrl(imageMedia));
      body.append("published", "false");
      body.append("access_token", pageAccessToken);
      headers = {
        "Content-Type": "application/x-www-form-urlencoded"
      };
    }

    const response = await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/photos`, body, {
      headers,
      maxBodyLength: Infinity
    });

    return response.data && response.data.id;
  } catch (error) {
    handleGraphError("create_unpublished_page_photo", error, "Facebook không chấp nhận URL ảnh.");
  }
}

async function createPagePhotoPost(pageId, pageAccessToken, message, imageMedia, options = {}) {
  try {
    let body;
    let headers;

    if (isUploadMedia(imageMedia)) {
      body = new FormData();
      appendUploadFile(body, "source", imageMedia);
      body.append("caption", message);
      appendOptionalPostFields(body, options);
      body.append("access_token", pageAccessToken);
      headers = body.getHeaders();
    } else {
      body = new URLSearchParams();
      body.append("url", getMediaUrl(imageMedia));
      body.append("caption", message);
      appendOptionalPostFields(body, options);
      body.append("access_token", pageAccessToken);
      headers = {
        "Content-Type": "application/x-www-form-urlencoded"
      };
    }

    const response = await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/photos`, body, {
      headers,
      maxBodyLength: Infinity
    });

    return (response.data && (response.data.post_id || response.data.id)) || null;
  } catch (error) {
    handleGraphError("create_page_photo_post", error, "Facebook không chấp nhận bài viết ảnh.");
  }
}

async function createUnpublishedPageVideo(pageId, pageAccessToken, message, videoMedia) {
  try {
    let body;
    let headers;

    if (isUploadMedia(videoMedia)) {
      body = new FormData();
      appendUploadFile(body, "source", videoMedia);
      body.append("description", message);
      body.append("published", "false");
      body.append("access_token", pageAccessToken);
      headers = body.getHeaders();
    } else {
      body = new URLSearchParams();
      body.append("file_url", getMediaUrl(videoMedia));
      body.append("description", message);
      body.append("published", "false");
      body.append("access_token", pageAccessToken);
      headers = {
        "Content-Type": "application/x-www-form-urlencoded"
      };
    }

    const response = await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/videos`, body, {
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    return response.data && response.data.id;
  } catch (error) {
    handleGraphError("create_unpublished_page_video", error, "Facebook không chấp nhận video để gắn vào bài viết.");
  }
}

async function createPagePostWithAttachedMedia(pageId, pageAccessToken, message, mediaIds, options = {}) {
  try {
    const form = new URLSearchParams();
    form.append("message", message);
    appendOptionalPostFields(form, options);
    form.append("access_token", pageAccessToken);

    mediaIds.forEach((mediaId, index) => {
      form.append(`attached_media[${index}]`, JSON.stringify({ media_fbid: mediaId }));
    });

    const response = await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/feed`, form, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    return response.data && response.data.id;
  } catch (error) {
    handleGraphError("create_page_media_post", error, "Facebook không chấp nhận bài viết nhiều media.");
  }
}

async function createResumablePageVideoPost(pageId, pageAccessToken, message, videoMedia, options = {}) {
  const mediaItem = toMediaItem(videoMedia);
  const fileSize = mediaItem.buffer.length;

  try {
    const startForm = new URLSearchParams();
    startForm.append("upload_phase", "start");
    startForm.append("file_size", String(fileSize));
    startForm.append("access_token", pageAccessToken);

    const startResponse = await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/videos`, startForm, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
    const uploadSessionId = startResponse.data && startResponse.data.upload_session_id;
    const videoId = startResponse.data && startResponse.data.video_id;

    if (!uploadSessionId || !videoId) {
      throw createPublicError(502, "Facebook không tạo được phiên upload video dung lượng lớn.", {
        service: "facebook",
        context: "create_page_video_post_start",
        providerMessage: JSON.stringify(startResponse.data || {})
      });
    }

    let startOffset = Number(startResponse.data.start_offset || 0);
    let endOffset = Number(startResponse.data.end_offset || Math.min(fileSize, 4 * 1024 * 1024));
    let guard = 0;

    while (startOffset < fileSize) {
      if (!Number.isFinite(endOffset) || endOffset <= startOffset) {
        endOffset = Math.min(fileSize, startOffset + 4 * 1024 * 1024);
      }

      const chunk = mediaItem.buffer.subarray(startOffset, Math.min(endOffset, fileSize));
      const transferForm = new FormData();
      transferForm.append("access_token", pageAccessToken);
      transferForm.append("upload_phase", "transfer");
      transferForm.append("upload_session_id", uploadSessionId);
      transferForm.append("start_offset", String(startOffset));
      transferForm.append("video_file_chunk", chunk, {
        filename: mediaItem.filename || "video.mp4",
        contentType: mediaItem.contentType || "video/mp4",
        knownLength: chunk.length
      });

      const transferResponse = await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/videos`, transferForm, {
        headers: transferForm.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });

      startOffset = Number(transferResponse.data && transferResponse.data.start_offset);
      endOffset = Number(transferResponse.data && transferResponse.data.end_offset);
      guard += 1;

      if (!Number.isFinite(startOffset) || guard > 500) {
        throw createPublicError(502, "Facebook không trả về tiến độ upload video hợp lệ.", {
          service: "facebook",
          context: "create_page_video_post_transfer",
          providerMessage: JSON.stringify(transferResponse.data || {})
        });
      }
    }

    const finishForm = new URLSearchParams();
    finishForm.append("upload_phase", "finish");
    finishForm.append("upload_session_id", uploadSessionId);
    finishForm.append("description", message);
    appendOptionalPostFields(finishForm, options);
    finishForm.append("access_token", pageAccessToken);

    await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/videos`, finishForm, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    return videoId;
  } catch (error) {
    if (error.publicMessage) {
      throw error;
    }

    handleGraphError("create_page_video_post_resumable", error, "Facebook không chấp nhận upload video nhiều bước.");
  }
}

async function createPageVideoPost(pageId, pageAccessToken, message, videoMedia, options = {}) {
  try {
    let body;
    let headers;

    if (isUploadMedia(videoMedia)) {
      return createResumablePageVideoPost(pageId, pageAccessToken, message, videoMedia, options);
    } else {
      body = new URLSearchParams();
      body.append("file_url", getMediaUrl(videoMedia));
      body.append("description", message);
      appendOptionalPostFields(body, options);
      body.append("access_token", pageAccessToken);
      headers = {
        "Content-Type": "application/x-www-form-urlencoded"
      };
    }

    const response = await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/videos`, body, {
      headers,
      maxBodyLength: Infinity
    });

    return response.data && response.data.id;
  } catch (error) {
    handleGraphError("create_page_video_post", error, "Facebook không chấp nhận bài viết video.");
  }
}

async function createPageReelPost(pageId, pageAccessToken, message, videoMedia, options = {}) {
  try {
    const startForm = new URLSearchParams();
    startForm.append("upload_phase", "start");
    startForm.append("access_token", pageAccessToken);

    const startResponse = await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/video_reels`, startForm, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
    const videoId = startResponse.data && startResponse.data.video_id;
    const uploadUrl = startResponse.data && startResponse.data.upload_url;

    if (!videoId || !uploadUrl) {
      throw createPublicError(502, "Facebook không tạo được phiên upload Reel.", {
        service: "facebook",
        context: "create_page_reel_post_start",
        providerMessage: JSON.stringify(startResponse.data || {})
      });
    }

    if (isUploadMedia(videoMedia)) {
      const mediaItem = toMediaItem(videoMedia);
      await axios.post(uploadUrl, mediaItem.buffer, {
        headers: {
          Authorization: `OAuth ${pageAccessToken}`,
          "Content-Type": mediaItem.contentType || "application/octet-stream",
          offset: "0",
          file_size: String(mediaItem.buffer.length)
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
    } else {
      await axios.post(uploadUrl, null, {
        headers: {
          Authorization: `OAuth ${pageAccessToken}`,
          file_url: getMediaUrl(videoMedia)
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
    }

    const finishForm = new URLSearchParams();
    finishForm.append("upload_phase", "finish");
    finishForm.append("video_id", videoId);
    finishForm.append("video_state", "PUBLISHED");
    finishForm.append("description", message);
    if (options.title) {
      finishForm.append("title", options.title);
    }
    finishForm.append("access_token", pageAccessToken);

    await axios.post(`${config.facebook.graphApiBaseUrl}/${pageId}/video_reels`, finishForm, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    return videoId;
  } catch (error) {
    if (error.publicMessage) {
      throw error;
    }

    handleGraphError("create_page_reel_post", error, "Facebook không chấp nhận đăng Reel.");
  }
}

async function getObjectPermalink(objectId, pageAccessToken) {
  try {
    const response = await axios.get(`${config.facebook.graphApiBaseUrl}/${objectId}`, {
      params: {
        fields: "permalink_url",
        access_token: pageAccessToken
      }
    });

    return normalizeFacebookPermalink(response.data && response.data.permalink_url);
  } catch (error) {
    const graphError = error.response && error.response.data && error.response.data.error;

    console.warn("[Meta Graph API]", {
      context: "get_permalink",
      status: error.response && error.response.status,
      type: graphError && graphError.type,
      code: graphError && graphError.code,
      message: graphError && graphError.message
    });

    return null;
  }
}

async function createPageContent(pageId, pageAccessToken, content) {
  const message = content.message;
  const mediaUrls = Array.isArray(content.mediaUrls) ? content.mediaUrls : [];
  const mediaItems = Array.isArray(content.mediaItems) && content.mediaItems.length > 0
    ? content.mediaItems
    : mediaUrls.map(toMediaItem);
  let contentType = content.contentType || "text";
  const postOptions = content.postOptions || {};
  const { images, videos, unknown } = splitMediaItems(mediaItems);
  let postId;

  if (unknown.length > 0) {
    throw createPublicError(400, "Media phải là ảnh hoặc video có định dạng rõ ràng.", {
      service: "facebook",
      context: "classify_media"
    });
  }

  if (contentType === "auto") {
    if (mediaItems.length === 0) {
      contentType = "text";
    } else if (videos.length === 0) {
      contentType = "photo";
    } else if (images.length === 0 && videos.length === 1) {
      contentType = "video";
    } else {
      contentType = "mixed";
    }
  }

  if (contentType === "photo" && videos.length > 0) {
    contentType = images.length === 0 && videos.length === 1 ? "video" : "mixed";
  }

  if (contentType === "reel") {
    if (videos.length !== 1 || images.length > 0) {
      throw createPublicError(400, "Reel cần đúng 1 video và không được kèm ảnh.", {
        service: "facebook",
        context: "validate_reel_media"
      });
    }

    postId = await createPageReelPost(pageId, pageAccessToken, message, videos[0], postOptions);
  } else if (contentType === "mixed") {
    const mediaIds = [];

    for (const imageMedia of images) {
      mediaIds.push(await createUnpublishedPagePhoto(pageId, pageAccessToken, imageMedia));
    }

    for (const videoMedia of videos) {
      mediaIds.push(await createUnpublishedPageVideo(pageId, pageAccessToken, message, videoMedia));
    }

    postId = await createPagePostWithAttachedMedia(pageId, pageAccessToken, message, mediaIds, postOptions);
  } else if (contentType === "photo") {
    if (mediaItems.length === 1) {
      postId = await createPagePhotoPost(pageId, pageAccessToken, message, mediaItems[0], postOptions);
    } else {
      const mediaIds = [];

      for (const imageMedia of mediaItems) {
        const mediaId = await createUnpublishedPagePhoto(pageId, pageAccessToken, imageMedia);
        mediaIds.push(mediaId);
      }

      postId = await createPagePostWithAttachedMedia(pageId, pageAccessToken, message, mediaIds, postOptions);
    }
  } else if (contentType === "video") {
    if (videos.length !== 1 || images.length > 0) {
      throw createPublicError(400, "Bài video cần đúng 1 video và không được kèm ảnh.", {
        service: "facebook",
        context: "validate_video_media"
      });
    }

    postId = await createPageVideoPost(pageId, pageAccessToken, message, mediaItems[0], postOptions);
  } else {
    postId = await createPagePost(pageId, pageAccessToken, message, postOptions);
  }

  const permalinkUrl = postId ? await getObjectPermalink(postId, pageAccessToken) : null;

  return {
    postId,
    permalinkUrl
  };
}

async function updatePagePost(postId, pageAccessToken, message) {
  try {
    const form = new URLSearchParams();
    form.append("message", message);
    form.append("access_token", pageAccessToken);

    await axios.post(`${config.facebook.graphApiBaseUrl}/${postId}`, form, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
  } catch (error) {
    handleGraphError("update_page_post", error, "Không sửa được bài viết trên Facebook.");
  }
}

async function deletePagePost(postId, pageAccessToken) {
  try {
    await axios.delete(`${config.facebook.graphApiBaseUrl}/${postId}`, {
      params: {
        access_token: pageAccessToken
      }
    });
  } catch (error) {
    handleGraphError("delete_page_post", error, "Không xóa được bài viết trên Facebook.");
  }
}

module.exports = {
  exchangeCodeForUserAccessToken,
  getFacebookUser,
  getManagedPages,
  canCreateContent,
  getPagePosts,
  getPagePostsWithDiagnosis,
  getGrantedPermissions,
  getPageAccessToken,
  getPagePostDetail,
  getInstagramMedia,
  getPageProfile,
  getAllPagePosts,
  getInstagramProfile,
  getAllInstagramMedia,
  getPageInsights,
  createPagePost,
  createPageContent,
  updatePagePost,
  deletePagePost
};
