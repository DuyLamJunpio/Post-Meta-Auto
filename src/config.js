require("dotenv").config();

const requiredEnv = [
  "PORT",
  "META_GRAPH_API_VERSION",
  "FACEBOOK_APP_ID",
  "FACEBOOK_APP_SECRET",
  "FACEBOOK_REDIRECT_URI",
  "NOTION_API_TOKEN",
  "NOTION_BRANDS_DATA_SOURCE_ID",
  "NOTION_CONTENT_DATA_SOURCE_ID",
  "SESSION_SECRET"
];

const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(
    `Thiếu biến môi trường bắt buộc: ${missingEnv.join(", ")}. Vui lòng kiểm tra file .env.`
  );
  process.exit(1);
}

const graphApiVersion = process.env.META_GRAPH_API_VERSION;
const googleDriveRedirectUri =
  process.env.GOOGLE_DRIVE_REDIRECT_URI ||
  process.env.GOOGLE_REDIRECT_URI ||
  `http://localhost:${Number(process.env.PORT) || 3000}/auth/google/drive/callback`;
const googleDriveClientId = process.env.GOOGLE_CLIENT_ID || "";
const googleDriveClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
const googleBusinessRedirectUri =
  process.env.GOOGLE_BUSINESS_REDIRECT_URI ||
  `http://localhost:${Number(process.env.PORT) || 3000}/auth/google/business/callback`;
const instagramAppId = process.env.INSTAGRAM_APP_ID || "";
const instagramAppSecret = process.env.INSTAGRAM_APP_SECRET || "";
const instagramRedirectUri =
  process.env.INSTAGRAM_REDIRECT_URI ||
  `http://localhost:${Number(process.env.PORT) || 3000}/auth/instagram/callback/`;
const tiktokClientKey = process.env.TIKTOK_CLIENT_KEY || "";
const tiktokClientSecret = process.env.TIKTOK_CLIENT_SECRET || "";
const tiktokRedirectUri =
  process.env.TIKTOK_REDIRECT_URI ||
  `http://localhost:${Number(process.env.PORT) || 3000}/auth/tiktok/callback`;
const hiddenFacebookPageNames = (process.env.HIDDEN_FACEBOOK_PAGE_NAMES || "xay dung thanh phat")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const config = {
  port: Number(process.env.PORT) || 3000,
  sessionSecret: process.env.SESSION_SECRET,
  facebook: {
    appId: process.env.FACEBOOK_APP_ID,
    appSecret: process.env.FACEBOOK_APP_SECRET,
    redirectUri: process.env.FACEBOOK_REDIRECT_URI,
    graphApiVersion,
    graphApiBaseUrl: `https://graph.facebook.com/${graphApiVersion}`,
    oauthDialogUrl: `https://www.facebook.com/${graphApiVersion}/dialog/oauth`,
    // instagram_basic + instagram_content_publish: đăng lên IG Business liên kết với Page,
    // dùng chung Page Access Token (không cần đăng nhập Instagram riêng).
    scopes: [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      // business_management: liệt kê Page nằm trong Business Portfolio (owned_pages/client_pages)
      // mà /me/accounts không trả về vì tài khoản không được gán vai trò trực tiếp trên Page.
      "business_management",
      "instagram_basic",
      "instagram_content_publish"
    ],
    hiddenPageNames: hiddenFacebookPageNames
  },
  instagram: {
    appId: instagramAppId,
    appSecret: instagramAppSecret,
    redirectUri: instagramRedirectUri,
    enabled: Boolean(instagramAppId && instagramAppSecret && instagramRedirectUri),
    oauthDialogUrl: "https://api.instagram.com/oauth/authorize",
    tokenUrl: "https://api.instagram.com/oauth/access_token",
    graphApiBaseUrl: "https://graph.instagram.com",
    scopes: (process.env.INSTAGRAM_SCOPES || "instagram_business_basic,instagram_business_content_publish")
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  },
  notion: {
    apiToken: process.env.NOTION_API_TOKEN,
    brandsDataSourceId: process.env.NOTION_BRANDS_DATA_SOURCE_ID,
    contentDataSourceId: process.env.NOTION_CONTENT_DATA_SOURCE_ID,
    autoPublishIntervalMs: Number(process.env.NOTION_AUTO_PUBLISH_INTERVAL_MS || 60000)
  },
  // Lớp phanh an toàn cho vòng lặp tự đăng (chống đăng nhầm/trùng/xả hàng loạt lên page thật).
  autoPublish: {
    // Kill switch cứng qua env: false => vòng lặp không đăng gì (cần đổi env + restart để bật lại).
    enabled: String(process.env.AUTO_PUBLISH_ENABLED || "true").toLowerCase() !== "false",
    // Trần số bài đăng mỗi tick vòng lặp (mỗi session). Chặn "xả bài đồng loạt".
    maxPublishPerRun: Math.max(1, Number(process.env.MAX_PUBLISH_PER_RUN || 5)),
    // Khoảng nghỉ tối thiểu giữa 2 bài lên CÙNG một page (ms). 0 = tắt cooldown.
    perPageCooldownMs: Math.max(0, Number(process.env.PER_PAGE_COOLDOWN_MS || 10 * 60 * 1000)),
    // Nếu số task đến hạn trong 1 tick vượt ngưỡng này => tự pause + cảnh báo, KHÔNG đăng.
    anomalyThreshold: Math.max(1, Number(process.env.AUTO_PUBLISH_ANOMALY_THRESHOLD || 10)),
    // true => chặn đăng khi tên page thật lệch hẳn tên Brand (mặc định chỉ cảnh báo, tránh báo nhầm).
    strictNameMatch: String(process.env.AUTO_PUBLISH_STRICT_NAME_MATCH || "false").toLowerCase() === "true",
    // Task kẹt ở "Đang đăng" quá thời gian này (ms) => hòa giải: có bằng chứng đã đăng thì
    // chuyển "Đã đăng", không có thì chuyển "Lỗi đăng" cho người kiểm tra (KHÔNG tự đăng lại).
    stuckPublishingMs: Math.max(60 * 1000, Number(process.env.AUTO_PUBLISH_STUCK_MS || 15 * 60 * 1000))
  },
  // Cảnh báo quản trị viên (lưới an toàn khi DB có thể mất trên Render Free).
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
    enabled: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    // Cấp độ nhận cảnh báo: "all" = cả thành công & lỗi; "important" = chỉ lỗi/pause/thu hồi.
    notifyLevel: (process.env.TELEGRAM_NOTIFY_LEVEL || "important").toLowerCase()
  },
  googleDrive: {
    clientId: googleDriveClientId,
    clientSecret: googleDriveClientSecret,
    redirectUri: googleDriveRedirectUri,
    enabled: Boolean(googleDriveClientId && googleDriveClientSecret && googleDriveRedirectUri),
    oauthDialogUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    driveApiBaseUrl: "https://www.googleapis.com/drive/v3",
    scopes: (process.env.GOOGLE_DRIVE_SCOPES || "https://www.googleapis.com/auth/drive.readonly")
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  },
  googleBusiness: {
    clientId: googleDriveClientId,
    clientSecret: googleDriveClientSecret,
    redirectUri: googleBusinessRedirectUri,
    enabled: Boolean(googleDriveClientId && googleDriveClientSecret && googleBusinessRedirectUri),
    oauthDialogUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    apiBaseUrl: "https://mybusiness.googleapis.com/v4",
    // API liệt kê account/location (định danh brand.gbpLocationId) — khác endpoint đăng bài v4.
    accountApiBaseUrl: "https://mybusinessaccountmanagement.googleapis.com/v1",
    infoApiBaseUrl: "https://mybusinessbusinessinformation.googleapis.com/v1",
    scopes: (process.env.GOOGLE_BUSINESS_SCOPES || "https://www.googleapis.com/auth/business.manage")
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  },
  tiktok: {
    clientKey: tiktokClientKey,
    clientSecret: tiktokClientSecret,
    redirectUri: tiktokRedirectUri,
    enabled: Boolean(tiktokClientKey && tiktokClientSecret && tiktokRedirectUri),
    oauthDialogUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    revokeUrl: "https://open.tiktokapis.com/v2/oauth/revoke/",
    apiBaseUrl: "https://open.tiktokapis.com/v2",
    // Ứng dụng TikTok chưa qua audit chỉ đăng được ở mức SELF_ONLY (video riêng tư).
    privacyLevel: process.env.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY",
    scopes: (process.env.TIKTOK_SCOPES || "user.info.basic,video.publish")
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  },
  mediaProxy: {
    // Host công khai để phát lại media Drive cho IG/GBP/TikTok fetch. Trống = tắt (localhost).
    publicBaseUrl,
    enabled: Boolean(publicBaseUrl),
    storageDir: process.env.MEDIA_PROXY_DIR || "data/media-cache",
    ttlMs: Number(process.env.MEDIA_PROXY_TTL_MS || 2 * 60 * 60 * 1000)
  }
};

module.exports = { config };
