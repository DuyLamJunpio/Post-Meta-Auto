const crypto = require("crypto");
const axios = require("axios");

const { config } = require("../config");
const { getDb } = require("../db");

// Thu thập lead khách hàng: đăng nhập Facebook TỐI THIỂU (public_profile,email) để biết khách là ai,
// rồi khách tự khai SĐT/Email/nhu cầu KÈM đồng ý. Tách hẳn khỏi đăng nhập admin (quyền quản trị page).

const LEAD_SCOPES = "public_profile,email";

// Câu đồng ý được lưu cùng lead để chứng minh (versioned).
const CONSENT_TEXT =
  "Tôi đồng ý cho doanh nghiệp lưu trữ và sử dụng thông tin liên hệ (họ tên, số điện thoại, email) " +
  "để tư vấn và giới thiệu sản phẩm/dịch vụ. Tôi có thể yêu cầu ngừng liên hệ và xóa dữ liệu bất cứ lúc nào.";

function isConfigured() {
  return Boolean(config.facebook.appId && config.facebook.appSecret);
}

function getRedirectUri() {
  const base = config.publicBaseUrl || `http://localhost:${config.port}`;
  return `${base}/lead/auth/facebook/callback`;
}

function getDialogBaseUrl() {
  // graph.facebook.com/vXX -> www.facebook.com/vXX/dialog/oauth
  return `${config.facebook.graphApiBaseUrl.replace("graph.facebook.com", "www.facebook.com")}/dialog/oauth`;
}

function createState() {
  return crypto.randomBytes(24).toString("hex");
}

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.facebook.appId,
    redirect_uri: getRedirectUri(),
    scope: LEAD_SCOPES,
    state,
    response_type: "code"
  });
  return `${getDialogBaseUrl()}?${params.toString()}`;
}

async function exchangeCodeForProfile(code) {
  const tokenResponse = await axios.get(`${config.facebook.graphApiBaseUrl}/oauth/access_token`, {
    params: {
      client_id: config.facebook.appId,
      client_secret: config.facebook.appSecret,
      redirect_uri: getRedirectUri(),
      code
    },
    timeout: 10000
  });

  const accessToken = tokenResponse.data && tokenResponse.data.access_token;
  if (!accessToken) {
    throw new Error("Không đổi được mã đăng nhập Facebook.");
  }

  const profileResponse = await axios.get(`${config.facebook.graphApiBaseUrl}/me`, {
    params: { fields: "id,name,email", access_token: accessToken },
    timeout: 10000
  });

  const data = profileResponse.data || {};
  return {
    id: data.id || "",
    name: data.name || "",
    email: data.email || ""
  };
}

function createLead(lead) {
  const db = getDb();
  const now = new Date().toISOString();

  const info = db
    .prepare(
      `INSERT INTO leads (fb_id, name, email, phone, note, consent, consent_text, consent_at, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lead.fbId || null,
      lead.name || null,
      lead.email || null,
      lead.phone || null,
      lead.note || null,
      lead.consent ? 1 : 0,
      lead.consent ? CONSENT_TEXT : null,
      lead.consent ? now : null,
      lead.source || "web-form",
      now
    );

  return { id: Number(info.lastInsertRowid), createdAt: now };
}

function listLeads(limit = 100) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT ?")
    .all(Number(limit) || 100)
    .map((row) => ({
      id: row.id,
      fbId: row.fb_id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      note: row.note,
      consent: row.consent === 1,
      consentAt: row.consent_at,
      source: row.source,
      createdAt: row.created_at
    }));
}

module.exports = {
  CONSENT_TEXT,
  isConfigured,
  createState,
  buildAuthUrl,
  exchangeCodeForProfile,
  createLead,
  listLeads
};
