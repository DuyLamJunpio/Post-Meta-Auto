// Orchestrator THỐNG KÊ: gộp dữ liệu Facebook Page + Instagram, tính toàn bộ chỉ số
// và dựng sẵn các chuỗi dữ liệu cho biểu đồ. Toàn bộ "cách thống kê" tập trung ở đây
// để dễ kiểm chứng: fetch (facebook.service) -> chuẩn hóa -> tính (stats-math) -> payload.

const facebookService = require("./facebook.service");
const stats = require("../utils/stats-math");

const REACTION_LABELS = {
  like: "Thích",
  love: "Yêu thích",
  haha: "Haha",
  wow: "Wow",
  sad: "Buồn",
  angry: "Phẫn nộ",
  care: "Thương thương"
};

// Số bài tối thiểu trong một khung (thứ/giờ) để coi "khung giờ tốt" là đáng tin.
const MIN_SAMPLE_FOR_BEST_TIME = 2;

function snippet(text, maxLength = 120) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return "(Không có nội dung văn bản)";
  }
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

function toPercent(part, total) {
  return total === 0 ? 0 : (part / total) * 100;
}

// --- Phân loại loại bài ----------------------------------------------------

function classifyFacebookPostType(post) {
  const media = String(post.mediaType || "").toLowerCase();
  const status = String(post.statusType || "").toLowerCase();

  if (media === "photo" || status === "added_photos") {
    return { key: "photo", label: "Ảnh" };
  }
  if (media === "album") {
    return { key: "album", label: "Nhiều ảnh" };
  }
  if (media === "video" || media === "video_inline" || status === "added_video") {
    return { key: "video", label: "Video" };
  }
  if (media === "link") {
    return { key: "link", label: "Liên kết" };
  }
  if (media === "share" || status === "shared_story") {
    return { key: "share", label: "Chia sẻ" };
  }
  if (status === "mobile_status_update" || (!media && !status)) {
    return { key: "text", label: "Văn bản" };
  }
  return { key: "other", label: "Khác" };
}

function classifyInstagramMediaType(item) {
  const product = String(item.mediaProductType || "").toUpperCase();
  const type = String(item.mediaType || "").toUpperCase();

  if (product === "REELS") {
    return { key: "reels", label: "Reels" };
  }
  if (product === "STORY") {
    return { key: "story", label: "Story" };
  }
  if (type === "CAROUSEL_ALBUM") {
    return { key: "carousel", label: "Carousel" };
  }
  if (type === "VIDEO") {
    return { key: "video", label: "Video" };
  }
  if (type === "IMAGE") {
    return { key: "image", label: "Ảnh" };
  }
  return { key: "other", label: "Khác" };
}

// --- Các khối tính chung ---------------------------------------------------

// Phân bố theo loại (post type / media type) kèm tổng & trung bình tương tác.
function buildTypeDistribution(items, classify) {
  const groups = new Map();
  const totalCount = items.length;

  for (const item of items) {
    const { key, label } = classify(item);
    if (!groups.has(key)) {
      groups.set(key, { key, label, count: 0, totalEngagement: 0 });
    }
    const group = groups.get(key);
    group.count += 1;
    group.totalEngagement += Number(item.engagement) || 0;
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      percent: toPercent(group.count, totalCount),
      avgEngagement: group.count === 0 ? 0 : group.totalEngagement / group.count
    }))
    .sort((a, b) => b.count - a.count);
}

// Chọn khung tốt nhất (thứ/giờ) theo tương tác trung bình, chỉ xét khung đủ mẫu.
function pickBestBucket(buckets) {
  const eligible = buckets.filter((bucket) => bucket.postCount >= MIN_SAMPLE_FOR_BEST_TIME);
  const pool = eligible.length > 0 ? eligible : buckets.filter((bucket) => bucket.postCount > 0);
  if (pool.length === 0) {
    return null;
  }
  return pool.reduce((best, bucket) => (bucket.avgValue > best.avgValue ? bucket : best));
}

function firstAndLast(items) {
  const times = items
    .map((item) => (item.createdTime ? new Date(item.createdTime).getTime() : NaN))
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) {
    return { first: null, last: null };
  }
  return {
    first: new Date(Math.min(...times)).toISOString(),
    last: new Date(Math.max(...times)).toISOString()
  };
}

// --- Facebook --------------------------------------------------------------

function buildFacebookSection({ profile, posts, truncated, hasReactionBreakdown }) {
  const engagementValues = posts.map((post) => post.engagement);
  const reactionValues = posts.map((post) => post.reactions);
  const commentValues = posts.map((post) => post.comments);
  const shareValues = posts.map((post) => post.shares);

  const totalReactions = stats.sum(reactionValues);
  const totalComments = stats.sum(commentValues);
  const totalShares = stats.sum(shareValues);
  const totalEngagement = stats.sum(engagementValues);
  const range = firstAndLast(posts);

  // Reaction theo loại (chỉ khi lấy được breakdown).
  const reactionTotals = {};
  if (hasReactionBreakdown) {
    for (const key of Object.keys(REACTION_LABELS)) {
      reactionTotals[key] = stats.sum(posts.map((post) => (post.reactionsByType || {})[key] || 0));
    }
  }
  const reactionsByType = Object.entries(reactionTotals)
    .map(([key, total]) => ({
      key,
      label: REACTION_LABELS[key],
      total,
      percent: toPercent(total, totalReactions)
    }))
    .sort((a, b) => b.total - a.total);

  const monthly = stats.bucketByMonth(
    posts,
    (post) => post.createdTime,
    (post) => ({
      reactions: post.reactions,
      comments: post.comments,
      shares: post.shares,
      engagement: post.engagement
    })
  ).map((bucket) => ({
    ...bucket,
    avgEngagement: bucket.count === 0 ? 0 : (bucket.engagement || 0) / bucket.count
  }));

  const weekday = stats.bucketByWeekday(posts, (post) => post.createdTime, (post) => post.engagement);
  const hourly = stats.bucketByHour(posts, (post) => post.createdTime, (post) => post.engagement);

  const topPosts = [...posts]
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 10)
    .map((post) => ({
      id: post.id,
      snippet: snippet(post.message),
      createdTime: post.createdTime,
      permalinkUrl: post.permalinkUrl,
      reactions: post.reactions,
      comments: post.comments,
      shares: post.shares,
      engagement: post.engagement
    }));

  const followers = profile.followersCount || profile.fanCount || 0;
  const avgEngagement = stats.mean(engagementValues);

  const lastMonth = monthly[monthly.length - 1];
  const prevMonth = monthly[monthly.length - 2];

  return {
    profile: {
      id: profile.id,
      name: profile.name,
      username: profile.username,
      category: profile.category,
      link: profile.link,
      pictureUrl: profile.pictureUrl,
      fanCount: profile.fanCount,
      followersCount: profile.followersCount
    },
    fetch: { postCount: posts.length, truncated, hasReactionBreakdown },
    overview: {
      totalPosts: posts.length,
      totalReactions,
      totalComments,
      totalShares,
      totalEngagement,
      avgEngagementPerPost: avgEngagement,
      medianEngagementPerPost: stats.median(engagementValues),
      followers,
      engagementRatePerPostPercent: stats.safeRatio(avgEngagement, followers) * 100,
      engagementRateFormula:
        "Tỷ lệ tương tác/bài = (tương tác trung bình mỗi bài ÷ số người theo dõi) × 100. Tương tác = reaction + bình luận + chia sẻ.",
      firstPostAt: range.first,
      lastPostAt: range.last,
      activeMonths: monthly.filter((bucket) => bucket.count > 0).length
    },
    reactionsByType,
    postTypes: buildTypeDistribution(posts, classifyFacebookPostType),
    distribution: {
      engagement: stats.describe(engagementValues),
      reactions: stats.describe(reactionValues),
      comments: stats.describe(commentValues),
      shares: stats.describe(shareValues)
    },
    monthly,
    monthlyGrowth: {
      engagementPercent: lastMonth && prevMonth ? stats.growthRatePercent(lastMonth.engagement || 0, prevMonth.engagement || 0) : null,
      postCountPercent: lastMonth && prevMonth ? stats.growthRatePercent(lastMonth.count, prevMonth.count) : null
    },
    weekday,
    hourly,
    bestTime: {
      weekday: pickBestBucket(weekday),
      hour: pickBestBucket(hourly)
    },
    topPosts
  };
}

// --- Instagram -------------------------------------------------------------

function buildInstagramSection({ profile, media, truncated }) {
  const engagementValues = media.map((item) => item.engagement);
  const likeValues = media.map((item) => item.likeCount);
  const commentValues = media.map((item) => item.commentsCount);

  const totalLikes = stats.sum(likeValues);
  const totalComments = stats.sum(commentValues);
  const totalEngagement = stats.sum(engagementValues);
  const range = firstAndLast(media);
  const followers = profile.followersCount || 0;
  const avgEngagement = stats.mean(engagementValues);

  const monthly = stats.bucketByMonth(
    media,
    (item) => item.createdTime,
    (item) => ({
      likes: item.likeCount,
      comments: item.commentsCount,
      engagement: item.engagement
    })
  ).map((bucket) => ({
    ...bucket,
    avgEngagement: bucket.count === 0 ? 0 : (bucket.engagement || 0) / bucket.count
  }));

  const weekday = stats.bucketByWeekday(media, (item) => item.createdTime, (item) => item.engagement);
  const hourly = stats.bucketByHour(media, (item) => item.createdTime, (item) => item.engagement);

  const topMedia = [...media]
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      snippet: snippet(item.caption),
      mediaType: item.mediaType,
      mediaProductType: item.mediaProductType,
      createdTime: item.createdTime,
      permalinkUrl: item.permalinkUrl,
      likeCount: item.likeCount,
      commentsCount: item.commentsCount,
      engagement: item.engagement
    }));

  const lastMonth = monthly[monthly.length - 1];
  const prevMonth = monthly[monthly.length - 2];

  return {
    profile: {
      id: profile.id,
      username: profile.username,
      name: profile.name,
      followersCount: profile.followersCount,
      followsCount: profile.followsCount,
      mediaCount: profile.mediaCount,
      profilePictureUrl: profile.profilePictureUrl
    },
    fetch: { mediaCount: media.length, truncated },
    overview: {
      totalMedia: media.length,
      totalLikes,
      totalComments,
      totalEngagement,
      avgEngagementPerMedia: avgEngagement,
      medianEngagementPerMedia: stats.median(engagementValues),
      followers,
      engagementRatePerMediaPercent: stats.safeRatio(avgEngagement, followers) * 100,
      engagementRateFormula:
        "Tỷ lệ tương tác/bài = (tương tác trung bình mỗi bài ÷ số người theo dõi) × 100. Tương tác = lượt thích + bình luận (không gồm lưu/chia sẻ vì cần quyền Insight).",
      firstMediaAt: range.first,
      lastMediaAt: range.last,
      activeMonths: monthly.filter((bucket) => bucket.count > 0).length
    },
    mediaTypes: buildTypeDistribution(media, classifyInstagramMediaType),
    distribution: {
      engagement: stats.describe(engagementValues),
      likes: stats.describe(likeValues),
      comments: stats.describe(commentValues)
    },
    monthly,
    monthlyGrowth: {
      engagementPercent: lastMonth && prevMonth ? stats.growthRatePercent(lastMonth.engagement || 0, prevMonth.engagement || 0) : null,
      postCountPercent: lastMonth && prevMonth ? stats.growthRatePercent(lastMonth.count, prevMonth.count) : null
    },
    weekday,
    hourly,
    bestTime: {
      weekday: pickBestBucket(weekday),
      hour: pickBestBucket(hourly)
    },
    topMedia
  };
}

// --- Điểm vào chính --------------------------------------------------------

// page: object từ session (id, name, pageAccessToken, instagramBusinessAccount).
// Trả payload đầy đủ; các nhánh phụ (IG, insight) lỗi thì thêm cảnh báo, KHÔNG làm hỏng cả báo cáo.
async function buildPageAnalytics({ page, userAccessToken, maxItems = 3000 }) {
  const warnings = [];

  const [profile, postsResult] = await Promise.all([
    facebookService.getPageProfile(page.id, page.pageAccessToken),
    facebookService.getAllPagePosts({
      pageId: page.id,
      pageAccessToken: page.pageAccessToken,
      userAccessToken,
      maxPosts: maxItems
    })
  ]);

  if (postsResult.posts.length === 0) {
    warnings.push(
      "Không đọc được bài nào của Page. Kiểm tra quyền pages_read_engagement hoặc Page chưa có bài đăng công khai."
    );
  }
  if (postsResult.truncated) {
    warnings.push(
      `Số bài vượt trần an toàn (${maxItems}). Báo cáo chỉ tính trên ${maxItems} bài mới nhất.`
    );
  }
  if (!postsResult.hasReactionBreakdown && postsResult.posts.length > 0) {
    warnings.push("Không lấy được chi tiết reaction theo loại; chỉ có tổng reaction.");
  }

  const facebook = buildFacebookSection({
    profile,
    posts: postsResult.posts,
    truncated: postsResult.truncated,
    hasReactionBreakdown: postsResult.hasReactionBreakdown
  });

  // Insight cấp Page (best-effort): dùng khoảng thời gian từ bài đầu -> nay, tối đa gần đây.
  let insights = { available: false, reason: "Chưa truy vấn." };
  try {
    const until = Math.floor(Date.now() / 1000);
    // Graph giới hạn cửa sổ insight; lấy ~24 tháng gần nhất là hợp lý cho biểu đồ xu hướng.
    const since = until - 60 * 60 * 24 * 365 * 2;
    insights = await facebookService.getPageInsights({
      pageId: page.id,
      pageAccessToken: page.pageAccessToken,
      since,
      until
    });
  } catch (insightError) {
    insights = { available: false, reason: insightError.publicMessage || insightError.message };
  }
  facebook.insights = insights;
  if (!insights.available && insights.reason) {
    warnings.push(insights.reason);
  }

  // Instagram (nếu Page có liên kết IG Business).
  let instagram = null;
  const igAccount = page.instagramBusinessAccount;
  if (igAccount && igAccount.id) {
    try {
      const [igProfile, igMediaResult] = await Promise.all([
        facebookService.getInstagramProfile(igAccount.id, page.pageAccessToken),
        facebookService.getAllInstagramMedia({
          instagramUserId: igAccount.id,
          pageAccessToken: page.pageAccessToken,
          maxItems
        })
      ]);
      instagram = buildInstagramSection({
        profile: igProfile,
        media: igMediaResult.media,
        truncated: igMediaResult.truncated
      });
      if (igMediaResult.truncated) {
        warnings.push(`Instagram vượt trần an toàn (${maxItems}); chỉ tính ${maxItems} media mới nhất.`);
      }
    } catch (igError) {
      warnings.push(`Không lấy được dữ liệu Instagram: ${igError.publicMessage || igError.message}`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    page: { id: page.id, name: page.name, hasInstagram: Boolean(igAccount && igAccount.id) },
    facebook,
    instagram,
    warnings
  };
}

module.exports = {
  buildPageAnalytics,
  // Xuất phụ để test độc lập cách phân loại/tính.
  classifyFacebookPostType,
  classifyInstagramMediaType,
  buildFacebookSection,
  buildInstagramSection
};
