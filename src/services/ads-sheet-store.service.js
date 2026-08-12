// Nhớ file Google Sheet đã tạo cho mỗi (tài khoản FB × Page) trong Postgres, để lần xuất
// sau GHI TIẾP vào file cũ thay vì tạo file mới. Best-effort: Postgres tắt -> trả null /
// bỏ qua lưu (khi đó luồng xuất tự tạo file mới mỗi lần, có cảnh báo ở tầng route).

const { getSql, isEnabled } = require("../db/postgres");

// Lấy file đã lưu cho (fbUserId, pageId). Trả { spreadsheetId, spreadsheetUrl } hoặc null.
async function getSheetMapping(fbUserId, pageId) {
  if (!isEnabled()) {
    return null;
  }
  const sql = getSql();
  if (!sql || !fbUserId || !pageId) {
    return null;
  }
  try {
    const rows = await sql`
      SELECT spreadsheet_id, spreadsheet_url
      FROM ads_export_sheets
      WHERE fb_user_id = ${String(fbUserId)} AND page_id = ${String(pageId)}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }
    return { spreadsheetId: rows[0].spreadsheet_id, spreadsheetUrl: rows[0].spreadsheet_url };
  } catch (error) {
    console.warn("[Ads Export Sheet] Không đọc được mapping Sheet:", error.message);
    return null;
  }
}

// Lưu/cập nhật file cho (fbUserId, pageId). Idempotent theo UNIQUE(fb_user_id, page_id).
async function saveSheetMapping(fbUserId, pageId, { userId = null, spreadsheetId, spreadsheetUrl }) {
  if (!isEnabled()) {
    return;
  }
  const sql = getSql();
  if (!sql || !fbUserId || !pageId || !spreadsheetId) {
    return;
  }
  try {
    await sql`
      INSERT INTO ads_export_sheets (user_id, fb_user_id, page_id, spreadsheet_id, spreadsheet_url)
      VALUES (${userId}, ${String(fbUserId)}, ${String(pageId)}, ${spreadsheetId}, ${spreadsheetUrl || null})
      ON CONFLICT (fb_user_id, page_id)
      DO UPDATE SET
        spreadsheet_id = EXCLUDED.spreadsheet_id,
        spreadsheet_url = EXCLUDED.spreadsheet_url,
        user_id = EXCLUDED.user_id,
        updated_at = now()
    `;
  } catch (error) {
    console.warn("[Ads Export Sheet] Không lưu được mapping Sheet:", error.message);
  }
}

module.exports = { getSheetMapping, saveSheetMapping };
