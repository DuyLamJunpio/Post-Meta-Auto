const { Client } = require("@notionhq/client");

const { config } = require("../config");
const { getDb } = require("../db");

// Đẩy lead vào một bảng (data source) trong Notion. Bảng có thể do tool tự tạo
// (nút "Tạo bảng Leads") hoặc trỏ sẵn qua env NOTION_LEADS_DATA_SOURCE_ID.
// Mọi thao tác đẩy là best-effort: lỗi Notion KHÔNG làm hỏng luồng lead/Telegram.

const notion = new Client({ auth: config.notion.apiToken });

const SETTING_KEY = "leads_data_source_id";
const LEADS_DB_TITLE = "Leads (Tự động từ web)";

function getSetting(key) {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, new Date().toISOString());
}

function getParentPageId() {
  return String(process.env.NOTION_LEADS_PARENT_PAGE_ID || "").trim();
}

// Ưu tiên env (bền qua redeploy) rồi tới id đã lưu trong app_settings.
function getDataSourceId() {
  return String(process.env.NOTION_LEADS_DATA_SOURCE_ID || "").trim() || getSetting(SETTING_KEY) || null;
}

function getStatus() {
  return {
    parentConfigured: Boolean(getParentPageId()),
    dataSourceId: getDataSourceId(),
    fromEnv: Boolean(String(process.env.NOTION_LEADS_DATA_SOURCE_ID || "").trim())
  };
}

const LEAD_DB_PROPERTIES = {
  "Tên": { title: {} },
  "Số điện thoại": { phone_number: {} },
  Email: { email: {} },
  "Facebook ID": { rich_text: {} },
  "Nhu cầu": { rich_text: {} },
  "Đồng ý": { checkbox: {} },
  "Nguồn": { rich_text: {} },
  "Thời gian đồng ý": { date: {} }
};

// Tạo bảng Leads dưới trang cha (đã chia sẻ với integration). Trả về data source id.
async function createLeadsDatabase() {
  const parentPageId = getParentPageId();
  if (!parentPageId) {
    const error = new Error("Chưa đặt NOTION_LEADS_PARENT_PAGE_ID (trang cha để chứa bảng Leads).");
    error.status = 400;
    error.publicMessage = error.message;
    throw error;
  }

  const database = await notion.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: LEADS_DB_TITLE } }],
    initial_data_source: { properties: LEAD_DB_PROPERTIES }
  });

  const dataSourceId = database.data_sources && database.data_sources[0] && database.data_sources[0].id;
  if (!dataSourceId) {
    throw new Error("Notion không trả về data source id sau khi tạo bảng.");
  }

  setSetting(SETTING_KEY, dataSourceId);
  return { databaseId: database.id, dataSourceId, url: database.url || null };
}

function richText(value) {
  const text = String(value || "").trim();
  return text ? [{ type: "text", text: { content: text.slice(0, 2000) } }] : [];
}

function buildLeadProperties(lead) {
  return {
    "Tên": { title: richText(lead.name || "(không tên)") },
    "Số điện thoại": { phone_number: lead.phone || null },
    Email: lead.email ? { email: lead.email } : { email: null },
    "Facebook ID": { rich_text: richText(lead.fbId) },
    "Nhu cầu": { rich_text: richText(lead.note) },
    "Đồng ý": { checkbox: Boolean(lead.consent) },
    "Nguồn": { rich_text: richText(lead.source || "web-form") },
    "Thời gian đồng ý": lead.consentAt ? { date: { start: lead.consentAt } } : { date: null }
  };
}

// Đẩy 1 lead vào Notion. Best-effort: trả về {ok:false} thay vì throw.
async function pushLead(lead) {
  const dataSourceId = getDataSourceId();
  if (!dataSourceId) {
    return { ok: false, skipped: true };
  }

  try {
    await notion.pages.create({
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: buildLeadProperties(lead)
    });
    return { ok: true };
  } catch (error) {
    console.warn("[Notion Leads] Đẩy lead vào Notion thất bại:", error.message);
    return { ok: false, message: error.message };
  }
}

module.exports = {
  getStatus,
  createLeadsDatabase,
  pushLead
};
