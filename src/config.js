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
const instagramAppId = process.env.INSTAGRAM_APP_ID || "";
const instagramAppSecret = process.env.INSTAGRAM_APP_SECRET || "";
const instagramRedirectUri =
  process.env.INSTAGRAM_REDIRECT_URI ||
  `http://localhost:${Number(process.env.PORT) || 3000}/auth/instagram/callback/`;
const hiddenFacebookPageNames = (process.env.HIDDEN_FACEBOOK_PAGE_NAMES || "xay dung thanh phat")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

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
    scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
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
  }
};

module.exports = { config };
