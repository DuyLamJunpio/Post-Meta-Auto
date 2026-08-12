const crypto = require("crypto");

const axios = require("axios");

const { config } = require("../config");

// Kết nối Google Sheets (OAuth) — NHÂN BẢN khuôn google-drive.service (cùng client OAuth,
// khác redirect + scope). Lưu token trong session.googleSheets. Tạo 1 file Sheet / Page,
// mỗi tab = 1 chiến dịch, trong tab là Tổng quan + KẾT QUẢ THEO NGÀY. Gọi Sheets API bằng
// axios REST (đồng bộ với cách app gọi Google Drive — không thêm dependency googleapis).

const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

function createPublicError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details || null;
  return error;
}

function isConfigured() {
  return config.googleSheets.enabled;
}

function ensureConfigured() {
  if (!isConfigured()) {
    throw createPublicError(
      500,
      "Chưa cấu hình Google Sheets OAuth. Cần GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET và GOOGLE_SHEETS_REDIRECT_URI."
    );
  }
}

function logSheetsError(context, error) {
  const apiError = error.response && error.response.data && error.response.data.error;
  console.error("[Google Sheets API]", {
    context,
    status: error.response && error.response.status,
    code: apiError && apiError.code,
    message: apiError && (apiError.message || apiError),
    transportCode: error.code,
    transportMessage: !error.response ? error.message : undefined
  });
}

function handleSheetsError(context, error, publicMessage, status = 502) {
  if (error.publicMessage) {
    throw error;
  }
  logSheetsError(context, error);
  const apiError = error.response && error.response.data && error.response.data.error;
  const providerMessage = apiError && (apiError.message || apiError);
  const responseStatus = error.response && error.response.status;
  let readableMessage = publicMessage;

  if (
    responseStatus === 403 &&
    providerMessage &&
    String(providerMessage).toLowerCase().includes("sheets api") &&
    String(providerMessage).toLowerCase().includes("disabled")
  ) {
    readableMessage = "Google Sheets API chưa được bật trong Google Cloud project.";
  } else if (responseStatus === 401) {
    readableMessage = "Phiên kết nối Google Sheets đã hết hạn. Hãy kết nối Google Sheets lại.";
  } else if (responseStatus === 403) {
    readableMessage = "Tài khoản Google đã kết nối chưa đủ quyền tạo/ghi Google Sheet (thiếu scope spreadsheets).";
  }

  throw createPublicError(status, readableMessage, {
    service: "google_sheets",
    context,
    status: responseStatus,
    code: apiError && apiError.code,
    providerMessage: providerMessage || (!error.response ? error.message : null)
  });
}

// --- OAuth (song sinh với google-drive.service) ----------------------------

function buildAuthorizationUrl(session) {
  ensureConfigured();
  const state = crypto.randomBytes(24).toString("hex");
  session.googleSheetsOAuthState = state;

  const params = new URLSearchParams({
    client_id: config.googleSheets.clientId,
    redirect_uri: config.googleSheets.redirectUri,
    response_type: "code",
    scope: config.googleSheets.scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state
  });

  return `${config.googleSheets.oauthDialogUrl}?${params.toString()}`;
}

function getSessionAuth(session) {
  return session && session.googleSheets ? session.googleSheets : null;
}

function isConnected(sessionOrAuth) {
  const auth = sessionOrAuth && sessionOrAuth.googleSheets ? sessionOrAuth.googleSheets : sessionOrAuth;
  return Boolean(auth && (auth.accessToken || auth.refreshToken));
}

function getStatus(session) {
  const auth = getSessionAuth(session);
  return {
    configured: isConfigured(),
    connected: isConnected(auth),
    scopes: auth && auth.scope ? auth.scope.split(" ").filter(Boolean) : [],
    connectedAt: auth ? auth.connectedAt : null,
    expiresAt: auth ? auth.expiresAt : null,
    canRefresh: Boolean(auth && auth.refreshToken)
  };
}

async function exchangeCodeForTokens(code) {
  ensureConfigured();
  try {
    const body = new URLSearchParams({
      code,
      client_id: config.googleSheets.clientId,
      client_secret: config.googleSheets.clientSecret,
      redirect_uri: config.googleSheets.redirectUri,
      grant_type: "authorization_code"
    });
    const response = await axios.post(config.googleSheets.tokenUrl, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    if (!response.data || !response.data.access_token) {
      throw createPublicError(502, "Google không trả về access token Sheets.");
    }
    return response.data;
  } catch (error) {
    handleSheetsError("exchange_code", error, "Không kết nối được Google Sheets.");
  }
}

function storeTokens(session, tokens) {
  const existing = getSessionAuth(session) || {};
  const expiresInMs = Number(tokens.expires_in || 3600) * 1000;
  session.googleSheets = {
    accessToken: tokens.access_token || existing.accessToken,
    refreshToken: tokens.refresh_token || existing.refreshToken,
    scope: tokens.scope || existing.scope || config.googleSheets.scopes.join(" "),
    tokenType: tokens.token_type || existing.tokenType || "Bearer",
    connectedAt: existing.connectedAt || new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString()
  };
  return session.googleSheets;
}

function needsRefresh(auth) {
  if (!auth || !auth.accessToken) return true;
  if (!auth.expiresAt) return false;
  return new Date(auth.expiresAt).getTime() - Date.now() <= TOKEN_EXPIRY_SKEW_MS;
}

async function refreshAccessToken(auth) {
  ensureConfigured();
  if (!auth || !auth.refreshToken) {
    throw createPublicError(401, "Google Sheets chưa được kết nối hoặc thiếu refresh token.");
  }
  try {
    const body = new URLSearchParams({
      client_id: config.googleSheets.clientId,
      client_secret: config.googleSheets.clientSecret,
      refresh_token: auth.refreshToken,
      grant_type: "refresh_token"
    });
    const response = await axios.post(config.googleSheets.tokenUrl, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    const tokens = response.data || {};
    const expiresInMs = Number(tokens.expires_in || 3600) * 1000;
    auth.accessToken = tokens.access_token;
    auth.scope = tokens.scope || auth.scope;
    auth.tokenType = tokens.token_type || auth.tokenType || "Bearer";
    auth.expiresAt = new Date(Date.now() + expiresInMs).toISOString();
    return auth.accessToken;
  } catch (error) {
    handleSheetsError("refresh_token", error, "Không làm mới được quyền Google Sheets.", 401);
  }
}

async function getAccessToken(auth) {
  if (!auth || (!auth.accessToken && !auth.refreshToken)) {
    throw createPublicError(401, "Chưa kết nối Google Sheets.");
  }
  if (needsRefresh(auth)) {
    return refreshAccessToken(auth);
  }
  return auth.accessToken;
}

async function disconnect(session) {
  const auth = getSessionAuth(session);
  const token = auth && (auth.refreshToken || auth.accessToken);
  delete session.googleSheets;
  if (!token || !isConfigured()) return;
  try {
    await axios.post(config.googleSheets.revokeUrl, new URLSearchParams({ token }), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
  } catch (error) {
    logSheetsError("revoke_token", error);
  }
}

// --- Dựng nội dung tab + tạo spreadsheet -----------------------------------

const OVERVIEW_FIELDS = [
  { key: "spend", label: "Chi tiêu" },
  { key: "impressions", label: "Hiển thị" },
  { key: "reach", label: "Tiếp cận" },
  { key: "clicks", label: "Lượt nhấp" },
  { key: "ctr", label: "CTR (%)" },
  { key: "cpc", label: "CPC" },
  { key: "cpm", label: "CPM" },
  { key: "frequency", label: "Tần suất" },
  { key: "results", label: "Kết quả" },
  { key: "costPerResult", label: "Chi phí / kết quả" }
];

// Số cho ô Sheet: trả NUMBER để Sheets lưu dạng số (không phải chuỗi). Không hợp lệ -> "".
function cellNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? n : Math.round(n * 10000) / 10000;
}

// Nhãn giới tính + tên quốc gia tiếng Việt (khớp cách hiển thị trên web).
const GENDER_LABELS = { female: "Nữ", male: "Nam", unknown: "Không rõ" };

let regionDisplay = null;
try {
  regionDisplay = new Intl.DisplayNames(["vi"], { type: "region" });
} catch {
  regionDisplay = null;
}
function countryLabel(code) {
  if (!code || code === "unknown") return "Không rõ";
  if (regionDisplay) {
    try {
      const name = regionDisplay.of(code);
      if (name && name !== code) return `${name} (${code})`;
    } catch {
      /* mã lạ -> giữ nguyên code */
    }
  }
  return code;
}

// Ghi 1 chiều nhân khẩu học (country/region) vào rows: tiêu đề + cột + dữ liệu, hoặc "Không khả dụng".
function pushCategoricalDim(rows, dim, title, header, labeler) {
  rows.push([]);
  rows.push([title]);
  if (dim && dim.available) {
    rows.push([header, "Hiển thị", "Tiếp cận", "Lượt nhấp", "Chi tiêu", "Tỷ trọng (%)"]);
    for (const item of dim.items || []) {
      rows.push([
        labeler(item.value),
        cellNumber(item.impressions),
        cellNumber(item.reach),
        cellNumber(item.clicks),
        cellNumber(item.spend),
        cellNumber(item.share)
      ]);
    }
  } else {
    rows.push(["Không khả dụng", (dim && dim.reason) || ""]);
  }
}

// Tên tab hợp lệ: bỏ ký tự Sheets cấm ( : \ / ? * [ ] ' ), gọn khoảng trắng, tối đa 95 ký tự.
function sanitizeSheetTitle(name) {
  let title = String(name || "")
    .replace(/[:\\/?*[\]']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) title = "Chiến dịch";
  return title.length > 95 ? title.slice(0, 95) : title;
}

function uniqueSheetTitle(name, used) {
  const base = sanitizeSheetTitle(name);
  let title = base;
  let i = 2;
  while (used.has(title.toLowerCase())) {
    const suffix = ` (${i})`;
    title = base.slice(0, 95 - suffix.length) + suffix;
    i += 1;
  }
  used.add(title.toLowerCase());
  return title;
}

// 2D values cho 1 tab chiến dịch: Tổng quan + KẾT QUẢ THEO NGÀY.
function buildCampaignSheetValues(campaign) {
  const rows = [];
  rows.push([`Chiến dịch: ${campaign.name || ""}`]);
  rows.push([`Mã chiến dịch: ${campaign.campaignId || ""}`]);
  if (campaign.currency) {
    rows.push([`Tiền tệ: ${campaign.currency}`]);
  }
  rows.push([]);

  if (!campaign.available) {
    rows.push(["Không có số liệu", campaign.reason || ""]);
    return rows;
  }

  const overview = campaign.overview || {};
  rows.push(["[Tổng quan]"]);
  rows.push(["Chỉ số", "Giá trị"]);
  for (const field of OVERVIEW_FIELDS) {
    rows.push([field.label, cellNumber(overview[field.key])]);
  }
  rows.push([]);

  rows.push(["[Kết quả theo ngày]"]);
  rows.push(["Ngày", "Chi tiêu", "Hiển thị", "Tiếp cận", "Lượt nhấp"]);
  for (const point of campaign.daily || []) {
    rows.push([
      point.date,
      cellNumber(point.spend),
      cellNumber(point.impressions),
      cellNumber(point.reach),
      cellNumber(point.clicks)
    ]);
  }

  // --- Nhân khẩu học người xem quảng cáo (tuổi×giới / quốc gia / vùng) ---
  const demo = campaign.demographics;
  if (demo) {
    rows.push([]);
    rows.push(["[Nhân khẩu học người xem quảng cáo]"]);

    rows.push([]);
    rows.push(["[Tuổi × giới tính]"]);
    if (demo.ageGender && demo.ageGender.available) {
      rows.push(["Nhóm tuổi", "Giới tính", "Hiển thị", "Tiếp cận", "Lượt nhấp", "Chi tiêu", "Tỷ trọng (%)"]);
      for (const seg of demo.ageGender.segments || []) {
        rows.push([
          seg.age,
          GENDER_LABELS[seg.gender] || seg.gender,
          cellNumber(seg.impressions),
          cellNumber(seg.reach),
          cellNumber(seg.clicks),
          cellNumber(seg.spend),
          cellNumber(seg.share)
        ]);
      }
    } else {
      rows.push(["Không khả dụng", (demo.ageGender && demo.ageGender.reason) || ""]);
    }

    pushCategoricalDim(rows, demo.country, "[Top quốc gia]", "Quốc gia", countryLabel);
    pushCategoricalDim(rows, demo.region, "[Top vùng/tỉnh]", "Vùng/tỉnh", (value) =>
      !value || value === "unknown" ? "Không rõ" : value
    );
  }

  return rows;
}

// Tạo 1 file Sheet cho 1 Page: mỗi campaign 1 tab. Trả { spreadsheetId, spreadsheetUrl, title }.
async function createPageSpreadsheet(auth, { pageName, campaigns }) {
  const accessToken = await getAccessToken(auth);
  const title = `${pageName || "Page"} — Báo cáo QC`;

  const usedTitles = new Set();
  const prepared = (campaigns || []).map((campaign, index) => ({
    ...campaign,
    sheetTitle: uniqueSheetTitle(campaign.name || `Chiến dịch ${index + 1}`, usedTitles)
  }));

  // Google yêu cầu tối thiểu 1 sheet.
  const sheetsSpec = prepared.length
    ? prepared.map((campaign) => ({ properties: { title: campaign.sheetTitle } }))
    : [{ properties: { title: "Trống" } }];

  let spreadsheet;
  try {
    const response = await axios.post(
      config.googleSheets.sheetsApiBaseUrl,
      { properties: { title }, sheets: sheetsSpec },
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
    );
    spreadsheet = response.data || {};
  } catch (error) {
    handleSheetsError("create_spreadsheet", error, "Không tạo được file Google Sheet.");
  }

  if (prepared.length > 0) {
    const data = prepared.map((campaign) => ({
      // A1 notation: tên tab bọc nháy đơn (đã bỏ nháy đơn khi sanitize nên an toàn).
      range: `'${campaign.sheetTitle}'!A1`,
      values: buildCampaignSheetValues(campaign)
    }));
    try {
      await axios.post(
        `${config.googleSheets.sheetsApiBaseUrl}/${spreadsheet.spreadsheetId}/values:batchUpdate`,
        { valueInputOption: "RAW", data },
        { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
      );
    } catch (error) {
      handleSheetsError("write_values", error, "Đã tạo file nhưng ghi số liệu thất bại.");
    }
  }

  return {
    spreadsheetId: spreadsheet.spreadsheetId,
    spreadsheetUrl: spreadsheet.spreadsheetUrl,
    title
  };
}

// ===== Chế độ DỒN DATA: 1 file/Page, mỗi lần xuất thêm 1 DÒNG tổng hợp ========

// Chuỗi theo NGÀY: mỗi dòng = 1 ngày. Xuất khoảng nào thì điền/cập nhật đúng các ngày đó
// (upsert theo cột "Ngày") — không trùng, không chồng lấn; vẽ biểu đồ / pivot ra tuần-tháng dễ.
const DAILY_HEADER = ["Ngày", "Chi tiêu", "Hiển thị", "Tiếp cận", "Lượt nhấp", "CTR (%)", "Kết quả"];

// Tên tab ỔN ĐỊNH theo chiến dịch (kèm đuôi id) để lần xuất sau GHI TIẾP đúng tab, kể cả
// khi 2 chiến dịch trùng tên hoặc chiến dịch bị đổi tên.
function campaignTabTitle(name, campaignId) {
  const idTail = String(campaignId || "").slice(-6);
  const base = sanitizeSheetTitle(name).slice(0, 80);
  const suffix = idTail ? ` [${idTail}]` : "";
  return (base + suffix).slice(0, 95);
}
function demoTabTitle(name, campaignId) {
  return `${campaignTabTitle(name, campaignId).slice(0, 89)} · NKH`;
}

// Các dòng theo NGÀY cho 1 chiến dịch (từ chuỗi daily của insights). CTR suy theo ngày.
function buildDailyRows(campaign) {
  const daily = Array.isArray(campaign.daily) ? campaign.daily : [];
  return daily.map((point) => {
    const impressions = Number(point.impressions) || 0;
    const clicks = Number(point.clicks) || 0;
    const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
    return [
      point.date,
      cellNumber(point.spend),
      cellNumber(point.impressions),
      cellNumber(point.reach),
      cellNumber(point.clicks),
      cellNumber(ctr),
      cellNumber(point.results)
    ];
  });
}

// 2D values cho tab nhân khẩu học (bản MỚI NHẤT, ghi đè mỗi lần xuất).
function buildDemoValues(entry) {
  const rows = [];
  rows.push([`Nhân khẩu học — ${entry.name || ""}`]);
  rows.push([`Cập nhật: ${entry.capturedAt || ""} · Khoảng: ${entry.periodLabel || ""}`]);
  rows.push([]);

  const demo = entry.demographics;
  if (!demo) {
    rows.push(["Không có dữ liệu nhân khẩu học."]);
    return rows;
  }

  rows.push(["[Tuổi × giới tính]"]);
  if (demo.ageGender && demo.ageGender.available) {
    rows.push(["Nhóm tuổi", "Giới tính", "Hiển thị", "Tiếp cận", "Lượt nhấp", "Chi tiêu", "Tỷ trọng (%)"]);
    for (const seg of demo.ageGender.segments || []) {
      rows.push([
        seg.age,
        GENDER_LABELS[seg.gender] || seg.gender,
        cellNumber(seg.impressions),
        cellNumber(seg.reach),
        cellNumber(seg.clicks),
        cellNumber(seg.spend),
        cellNumber(seg.share)
      ]);
    }
  } else {
    rows.push(["Không khả dụng", (demo.ageGender && demo.ageGender.reason) || ""]);
  }
  pushCategoricalDim(rows, demo.country, "[Top quốc gia]", "Quốc gia", countryLabel);
  pushCategoricalDim(rows, demo.region, "[Top vùng/tỉnh]", "Vùng/tỉnh", (v) =>
    !v || v === "unknown" ? "Không rõ" : v
  );
  return rows;
}

// Gộp dòng theo NGÀY: incoming ghi đè existing cùng ngày (cột 0), rồi sắp tăng theo ngày.
// THUẦN (không I/O) -> kiểm thử được. rows là mảng mảng ["YYYY-MM-DD", ...số...].
function mergeDailyByDate(existing, incoming) {
  const map = new Map();
  for (const row of Array.isArray(existing) ? existing : []) {
    const date = row && row[0];
    if (date) map.set(String(date), row);
  }
  for (const row of Array.isArray(incoming) ? incoming : []) {
    const date = row && row[0];
    if (date) map.set(String(date), row); // dữ liệu mới đè dữ liệu cũ cùng ngày
  }
  return [...map.values()].sort((a, b) =>
    String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0
  );
}

// Dựng "entry" cho 1 chiến dịch: tên tab + các dòng theo ngày + (tuỳ) values nhân khẩu học.
// periodMeta chỉ còn dùng cho phần đầu tab nhân khẩu học (thời điểm cập nhật + khoảng).
function buildExportEntry(campaign, periodMeta) {
  const meta = periodMeta || {};
  const entry = {
    name: campaign.name,
    demographics: campaign.demographics || null,
    capturedAt: meta.capturedAt || "",
    periodLabel: meta.periodLabel || ""
  };
  const hasDemo = Boolean(campaign.available && campaign.demographics);
  return {
    campaignTab: campaignTabTitle(campaign.name, campaign.campaignId),
    demoTab: hasDemo ? demoTabTitle(campaign.name, campaign.campaignId) : null,
    header: DAILY_HEADER,
    dailyRows: buildDailyRows(campaign),
    demoValues: hasDemo ? buildDemoValues(entry) : null
  };
}

// --- Sheets REST helpers (axios) ---

// A1 range đã encode cho path URL: 'Tab Name'!A1 (nháy đơn nhân đôi, encode cả ! và ').
function rangeUrl(tabTitle, cellPart) {
  const raw = `'${String(tabTitle).replace(/'/g, "''")}'` + (cellPart ? `!${cellPart}` : "");
  return encodeURIComponent(raw);
}

async function apiGetSpreadsheet(accessToken, spreadsheetId) {
  const res = await axios.get(`${config.googleSheets.sheetsApiBaseUrl}/${spreadsheetId}`, {
    params: { fields: "spreadsheetId,spreadsheetUrl,sheets.properties(sheetId,title)" },
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = res.data || {};
  return {
    spreadsheetId: data.spreadsheetId,
    spreadsheetUrl: data.spreadsheetUrl,
    titles: new Set((data.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean))
  };
}

async function apiCreateSpreadsheet(accessToken, title, tabTitles) {
  const titles = tabTitles.length ? tabTitles : ["Tổng"];
  const res = await axios.post(
    config.googleSheets.sheetsApiBaseUrl,
    { properties: { title }, sheets: titles.map((t) => ({ properties: { title: t } })) },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
  return { spreadsheetId: res.data.spreadsheetId, spreadsheetUrl: res.data.spreadsheetUrl };
}

async function apiAddSheets(accessToken, spreadsheetId, titles) {
  if (titles.length === 0) return;
  await axios.post(
    `${config.googleSheets.sheetsApiBaseUrl}/${spreadsheetId}:batchUpdate`,
    { requests: titles.map((t) => ({ addSheet: { properties: { title: t } } })) },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
}

async function apiUpdate(accessToken, spreadsheetId, tabTitle, values) {
  await axios.put(
    `${config.googleSheets.sheetsApiBaseUrl}/${spreadsheetId}/values/${rangeUrl(tabTitle, "A1")}`,
    { values },
    {
      params: { valueInputOption: "RAW" },
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }
    }
  );
}

async function apiAppend(accessToken, spreadsheetId, tabTitle, values) {
  await axios.post(
    `${config.googleSheets.sheetsApiBaseUrl}/${spreadsheetId}/values/${rangeUrl(tabTitle, "A1")}:append`,
    { values },
    {
      params: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }
    }
  );
}

async function apiClear(accessToken, spreadsheetId, tabTitle) {
  await axios.post(
    `${config.googleSheets.sheetsApiBaseUrl}/${spreadsheetId}/values/${rangeUrl(tabTitle, "")}:clear`,
    {},
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
}

// Đọc toàn bộ values của 1 tab (gồm cả dòng header). Không có -> [].
async function apiGetValues(accessToken, spreadsheetId, tabTitle) {
  const res = await axios.get(
    `${config.googleSheets.sheetsApiBaseUrl}/${spreadsheetId}/values/${rangeUrl(tabTitle, "")}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return (res.data && res.data.values) || [];
}

// Ghi các entry vào 1 file Page theo mô hình CHUỖI NGÀY (upsert):
//   - Tạo file nếu chưa có (hoặc file cũ đã mất), thêm tab thiếu.
//   - Tab chiến dịch: đọc chuỗi ngày hiện có -> GỘP với dữ liệu mới theo ngày (mới đè cũ) ->
//     ghi lại (header + các ngày, đã sắp). Tab format cũ (không phải chuỗi ngày) -> ghi đè sạch.
//   - Tab NKH: ghi đè bản mới nhất.
// Trả { spreadsheetId, spreadsheetUrl, created }.
async function appendPageExport(auth, { spreadsheetId, pageName, entries }) {
  const accessToken = await getAccessToken(auth);
  const title = `${pageName || "Page"} — Báo cáo QC`;
  const list = Array.isArray(entries) ? entries : [];

  try {
    let meta = null;
    if (spreadsheetId) {
      try {
        meta = await apiGetSpreadsheet(accessToken, spreadsheetId);
      } catch {
        meta = null; // file bị xoá / mất quyền -> tạo mới
      }
    }

    let sheetId;
    let sheetUrl;
    let preexistingTitles; // tab đã có TRƯỚC lần chạy này (mới có dữ liệu để gộp)

    if (!meta) {
      const tabTitles = [];
      for (const entry of list) {
        tabTitles.push(entry.campaignTab);
        if (entry.demoTab) tabTitles.push(entry.demoTab);
      }
      const created = await apiCreateSpreadsheet(accessToken, title, tabTitles);
      sheetId = created.spreadsheetId;
      sheetUrl = created.spreadsheetUrl;
      preexistingTitles = new Set(); // tất cả tab đều mới -> ghi thẳng
    } else {
      sheetId = meta.spreadsheetId;
      sheetUrl = meta.spreadsheetUrl;
      preexistingTitles = meta.titles;
      const missing = [];
      for (const entry of list) {
        if (!preexistingTitles.has(entry.campaignTab)) missing.push(entry.campaignTab);
        if (entry.demoTab && !preexistingTitles.has(entry.demoTab)) missing.push(entry.demoTab);
      }
      await apiAddSheets(accessToken, sheetId, missing);
    }

    for (const entry of list) {
      if (preexistingTitles.has(entry.campaignTab)) {
        // Tab đã có: gộp chuỗi ngày (chỉ khi đúng format chuỗi ngày; format cũ -> bỏ, ghi sạch).
        const values = await apiGetValues(accessToken, sheetId, entry.campaignTab);
        const hasDaily = values[0] && String(values[0][0]).trim() === "Ngày";
        const existingRows = hasDaily ? values.slice(1) : [];
        const merged = mergeDailyByDate(existingRows, entry.dailyRows);
        await apiClear(accessToken, sheetId, entry.campaignTab);
        await apiUpdate(accessToken, sheetId, entry.campaignTab, [entry.header, ...merged]);
      } else {
        // Tab mới: ghi header + các ngày.
        await apiUpdate(accessToken, sheetId, entry.campaignTab, [entry.header, ...entry.dailyRows]);
      }

      if (entry.demoTab) {
        await apiClear(accessToken, sheetId, entry.demoTab);
        await apiUpdate(accessToken, sheetId, entry.demoTab, entry.demoValues);
      }
    }

    return { spreadsheetId: sheetId, spreadsheetUrl: sheetUrl, created: !meta };
  } catch (error) {
    handleSheetsError("append_page_export", error, "Không ghi được dữ liệu vào Google Sheet.");
  }
}

module.exports = {
  buildAuthorizationUrl,
  disconnect,
  exchangeCodeForTokens,
  getSessionAuth,
  getStatus,
  isConfigured,
  isConnected,
  storeTokens,
  createPageSpreadsheet,
  buildExportEntry,
  appendPageExport
};
