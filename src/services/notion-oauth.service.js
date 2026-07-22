const crypto = require("crypto");
const axios = require("axios");
const { Client } = require("@notionhq/client");

const { config } = require("../config");
const { getSql, isEnabled } = require("../db/postgres");
const { encrypt, decrypt } = require("../utils/crypto-box");

// Pha 3: kết nối Notion theo từng tài khoản qua OAuth (public integration).
// Token workspace mã hóa lưu Postgres; sau đó user chọn Content DB + Brands DB của họ.

const CLIENT_ID = process.env.NOTION_OAUTH_CLIENT_ID || "";
const CLIENT_SECRET = process.env.NOTION_OAUTH_CLIENT_SECRET || "";
const AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.notion.com/v1/oauth/token";

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function getRedirectUri() {
  const base = config.publicBaseUrl || `http://localhost:${config.port}`;
  return `${base}/account/notion/callback`;
}

function createState() {
  return crypto.randomBytes(24).toString("hex");
}

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    owner: "user",
    redirect_uri: getRedirectUri(),
    state
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCode(code) {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const response = await axios.post(
    TOKEN_URL,
    { grant_type: "authorization_code", code, redirect_uri: getRedirectUri() },
    {
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      timeout: 15000
    }
  );

  const data = response.data || {};
  return {
    accessToken: data.access_token,
    workspaceId: data.workspace_id || null,
    workspaceName: data.workspace_name || null,
    botId: data.bot_id || null
  };
}

async function saveConnection(userId, tokenData) {
  const sql = getSql();
  await sql`
    INSERT INTO user_notion (user_id, workspace_id, workspace_name, bot_id, token_enc, connected_at)
    VALUES (${Number(userId)}, ${tokenData.workspaceId}, ${tokenData.workspaceName}, ${tokenData.botId}, ${encrypt(tokenData.accessToken)}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      workspace_name = excluded.workspace_name,
      bot_id = excluded.bot_id,
      token_enc = excluded.token_enc,
      connected_at = now()
  `;
}

async function getConnection(userId) {
  if (!isEnabled() || !userId) {
    return null;
  }
  const rows = await getSql()`SELECT * FROM user_notion WHERE user_id = ${Number(userId)} LIMIT 1`;
  if (!rows[0]) {
    return null;
  }
  let accessToken = null;
  try {
    accessToken = decrypt(rows[0].token_enc);
  } catch {
    accessToken = null;
  }
  return {
    workspaceId: rows[0].workspace_id,
    workspaceName: rows[0].workspace_name,
    accessToken,
    contentDataSourceId: rows[0].content_data_source_id,
    brandsDataSourceId: rows[0].brands_data_source_id,
    connectedAt: rows[0].connected_at
  };
}

async function getStatus(userId) {
  const connection = await getConnection(userId);
  if (!connection) {
    return { connected: false };
  }
  return {
    connected: true,
    workspaceName: connection.workspaceName,
    contentDataSourceId: connection.contentDataSourceId,
    brandsDataSourceId: connection.brandsDataSourceId,
    dbSelected: Boolean(connection.contentDataSourceId && connection.brandsDataSourceId)
  };
}

function extractTitle(item) {
  if (Array.isArray(item.title) && item.title.length) {
    return item.title.map((t) => t.plain_text || "").join("").trim() || "(không tên)";
  }
  if (typeof item.name === "string" && item.name.trim()) {
    return item.name.trim();
  }
  return "(không tên)";
}

// Liệt kê data source (database) mà integration của user truy cập được, để họ chọn Content/Brands.
async function listDataSources(userId) {
  const connection = await getConnection(userId);
  if (!connection || !connection.accessToken) {
    return [];
  }
  const client = new Client({ auth: connection.accessToken });
  const response = await client.search({ page_size: 100 });
  return (response.results || [])
    .filter((item) => item.object === "data_source" || item.object === "database")
    .map((item) => ({ id: item.id, title: extractTitle(item) }));
}

async function setDataSources(userId, contentDataSourceId, brandsDataSourceId) {
  await getSql()`
    UPDATE user_notion
    SET content_data_source_id = ${contentDataSourceId || null},
        brands_data_source_id = ${brandsDataSourceId || null}
    WHERE user_id = ${Number(userId)}
  `;
}

async function disconnect(userId) {
  if (!isEnabled() || !userId) {
    return;
  }
  await getSql()`DELETE FROM user_notion WHERE user_id = ${Number(userId)}`;
}

module.exports = {
  isConfigured,
  createState,
  buildAuthUrl,
  exchangeCode,
  saveConnection,
  getConnection,
  getStatus,
  listDataSources,
  setDataSources,
  disconnect
};
