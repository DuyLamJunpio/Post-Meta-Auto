const { getSql, isEnabled } = require("../db/postgres");
const notionOauthService = require("./notion-oauth.service");
const userFacebookService = require("./user-facebook.service");
const notionService = require("./notion.service");
const pageVisibilityService = require("./page-visibility.service");

// Pha 4 (tenant-hóa): dựng danh sách tenant (tài khoản Postgres) đủ điều kiện tự đăng — mỗi tenant
// đăng bằng Notion riêng + Facebook riêng của họ. MVP chỉ FB + Notion (Drive/IG/GBP/TikTok per-user
// để pha sau vì token của chúng hiện chỉ nằm trong session, chưa lưu Postgres).

// user_id của mọi tài khoản đã kết nối Notion riêng — dùng để loop admin cũ BỎ QUA session tương ứng
// (chống đăng trùng: các user này đã được loop per-user xử lý).
async function listNotionConnectedUserIds() {
  if (!isEnabled()) {
    return [];
  }
  const rows = await getSql()`SELECT user_id FROM user_notion`;
  return rows.map((row) => String(row.user_id));
}

// userId đủ điều kiện: đã kết nối Notion (chọn đủ 2 data source) VÀ đã kết nối Facebook.
async function listPublishableUserIds() {
  if (!isEnabled()) {
    return [];
  }
  const rows = await getSql()`
    SELECT n.user_id
    FROM user_notion n
    JOIN user_facebook f ON f.user_id = n.user_id
    WHERE n.content_data_source_id IS NOT NULL
      AND n.brands_data_source_id IS NOT NULL
  `;
  return rows.map((row) => String(row.user_id));
}

// Dựng context đăng cho 1 tenant: { userId, pages (đã lọc ẩn), notionContext }.
// Trả null nếu thiếu dữ liệu (chưa chọn data source / chưa có page hiển thị / token hỏng).
async function buildTenantContext(userId) {
  const [notionConn, fbConn] = await Promise.all([
    notionOauthService.getConnection(userId),
    userFacebookService.getConnection(userId)
  ]);

  if (
    !notionConn ||
    !notionConn.accessToken ||
    !notionConn.contentDataSourceId ||
    !notionConn.brandsDataSourceId
  ) {
    return null;
  }

  if (!fbConn || !Array.isArray(fbConn.pages) || fbConn.pages.length === 0) {
    return null;
  }

  const pages = pageVisibilityService.getVisiblePages(fbConn.pages);
  if (pages.length === 0) {
    return null;
  }

  const notionContext = notionService.buildNotionContext({
    token: notionConn.accessToken,
    contentDataSourceId: notionConn.contentDataSourceId,
    brandsDataSourceId: notionConn.brandsDataSourceId,
    userId
  });

  return { userId: String(userId), pages, notionContext };
}

// Danh sách tenant sẵn sàng đăng (đã dựng đầy đủ context). Rỗng nếu Postgres chưa cấu hình.
async function listPublishableTenants() {
  const userIds = await listPublishableUserIds();
  const tenants = [];

  for (const userId of userIds) {
    try {
      const tenant = await buildTenantContext(userId);
      if (tenant) {
        tenants.push(tenant);
      }
    } catch (error) {
      console.warn(`[Tenant Runner] Bỏ qua tenant ${userId}:`, error.message);
    }
  }

  return tenants;
}

module.exports = {
  listNotionConnectedUserIds,
  listPublishableUserIds,
  buildTenantContext,
  listPublishableTenants
};
