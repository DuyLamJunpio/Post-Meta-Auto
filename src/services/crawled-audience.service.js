// Đọc nhân khẩu học do công cụ cào Business Suite ghi vào Postgres (Supabase).
//
// VÌ SAO CẦN NGUỒN NÀY
// Meta đã ngừng gần hết metric nhân khẩu học cấp Page trên Graph API — xem ghi
// chú trong facebook.service.js ("Tất cả metric thử đều không hợp lệ ở phiên bản
// API này"). Công cụ cào chạy trên máy có Edge đã đăng nhập, lấy số liệu từ
// chính giao diện Business Suite rồi đẩy lên Supabase. File này chỉ ĐỌC.
//
// VÌ SAO POSTGRES CHỨ KHÔNG PHẢI data/app.db
// Render xoá sạch đĩa máy chủ mỗi lần deploy. Để ở SQLite thì web chạy trên
// Render sẽ luôn thấy bảng rỗng, dù máy bạn cào đủ. Postgres là kho duy nhất
// bền qua redeploy — xem initCrawledAudienceSchema() trong src/db/postgres.js.
//
// NGUYÊN TẮC: file này KHÔNG TÍNH TOÁN GÌ.
// Nó chỉ đọc DB rồi đổi sang đúng hình dạng `raw` mà buildFacebookAudience()
// vốn đã nhận. Nhờ vậy toàn bộ phần chuẩn hóa, top-N, dịch nhãn, sinh segment
// trong audience.service.js dùng lại được nguyên vẹn, không sửa một dòng nào.
//
// ⚠️ ĐƠN VỊ: giá trị trả về ĐÃ LÀ PHẦN TRĂM, không phải số tuyệt đối.
// Vì vậy payload mang cờ `alreadyPercent: true`. Thiếu cờ đó thì
// normalizeBreakdown sẽ chia lại theo tổng, và vì tổng theo quốc gia của Meta
// vượt 100% (Việt Nam 106.2%, tổng ~112%) nên số hiện lên sẽ LỆCH so với
// giao diện Meta (106.2% thành 94.8%).

const { getSql, isEnabled } = require("../db/postgres");

// Nhãn giới tính của crawler -> mã mà audience.service đang dùng.
// Crawler chuẩn hóa về chữ thường; audience.service dùng F/M/U.
const GENDER_CODE = { female: "F", male: "M", unknown: "U" };

function genderCode(value) {
  return GENDER_CODE[String(value || "").toLowerCase()] || "U";
}

// Lấy ảnh chụp MỚI NHẤT của một asset (Page hoặc IG). Trả null nếu chưa có.
//
// SCOPE THEO TENANT: chỉ lấy snapshot của chính `userId` HOẶC snapshot legacy
// (user_id IS NULL — dữ liệu cũ/của người vận hành). Không kèm điều kiện này thì
// hai tài khoản cùng quản một Page sẽ đọc số liệu của nhau. Khi `userId` là null
// (phiên cũ / một người vận hành) thì chỉ khớp snapshot legacy — đúng hành vi cũ.
async function findLatestSnapshot(sql, assetId, userId) {
  const rows = await sql`
    SELECT id, asset_id, asset_type, business_id, source, captured_at
    FROM crawled_audience_snapshots
    WHERE asset_id = ${String(assetId)}
      AND (user_id = ${userId} OR user_id IS NULL)
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

async function findRows(sql, snapshotId) {
  return sql`
    SELECT dimension, segment, age_range, gender, location, percentage
    FROM crawled_audience_rows
    WHERE snapshot_id = ${snapshotId}
    ORDER BY id
  `;
}

// Đổi các dòng phẳng trong DB thành 3 breakdown mà buildFacebookAudience cần.
//
// age_gender -> genderAge với nhãn "F.25-34" (đúng định dạng cũ của Meta,
//               để hàm tách nhãn hiện có không phải sửa)
// city       -> [{ label: "Huế, Thừa Thiên - Huế", value: 69.5 }]
// country    -> [{ label: "Việt Nam", value: 106.2 }]
//
// Lưu ý về quốc gia: crawler trả TÊN đầy đủ ("Việt Nam"), không phải mã ("VN").
// countryName() trong audience.service trả nguyên giá trị khi không tra được
// trong bảng mã, nên tên đầy đủ đi qua an toàn, không bị đổi thành "Không rõ".
//
// Hàm THUẦN: chỉ nhận mảng, trả object. Test được mà không cần DB.
function toBreakdowns(rows) {
  const genderAge = [];
  const city = [];
  const country = [];

  for (const row of rows) {
    const value = Number(row.percentage) || 0;

    if (row.dimension === "age_gender") {
      if (!row.age_range) continue;
      genderAge.push({ label: `${genderCode(row.gender)}.${row.age_range}`, value });
    } else if (row.dimension === "city") {
      if (row.location) city.push({ label: row.location, value });
    } else if (row.dimension === "country") {
      if (row.location) country.push({ label: row.location, value });
    }
  }

  return { genderAge, city, country };
}

function khongCoDuLieu(reason) {
  return { available: false, reason };
}

// Điểm vào: lấy dữ liệu cào mới nhất của một asset.
//
// Trả về cùng dạng với facebook.service.getPageAudience() để hai nguồn thay
// thế được cho nhau: { available, reason? , breakdowns?, ... }.
//
// KHÔNG NÉM LỖI — kể cả khi Postgres hỏng.
// Đây là nguồn DỰ PHÒNG: nếu nó ném lỗi thì cả phần đối tượng khách hàng sập,
// trong khi Instagram và phần phân tích tương tác vẫn hoàn toàn dùng được.
// Nhưng cũng KHÔNG nuốt lỗi: câu lỗi đi vào `reason`, mà audience.service đẩy
// `reason` lên mảng warnings, nên người dùng vẫn đọc được nguyên nhân thật.
async function getCrawledAudience(assetId, userId = null) {
  if (!assetId) {
    return khongCoDuLieu("Thiếu ID trang để tra dữ liệu đã cào.");
  }

  if (!isEnabled()) {
    return khongCoDuLieu("Chưa cấu hình DATABASE_URL nên không đọc được kho số liệu cào.");
  }

  const sql = getSql();

  try {
    const snapshot = await findLatestSnapshot(sql, assetId, userId);

    if (!snapshot) {
      return khongCoDuLieu(
        "Chưa có dữ liệu cào cho trang này. Chạy `python -m src.cli run --all` " +
          "trên máy có Edge đã đăng nhập Facebook."
      );
    }

    const rows = await findRows(sql, snapshot.id);
    if (rows.length === 0) {
      return khongCoDuLieu("Bản ghi cào gần nhất không có dòng số liệu nào.");
    }

    return {
      available: true,
      // Cờ này BẮT BUỘC — xem cảnh báo về đơn vị ở đầu file.
      alreadyPercent: true,
      source: "crawler",
      // Postgres trả về đối tượng Date; đổi sang chuỗi ISO để JSON hoá ổn định.
      capturedAt: new Date(snapshot.captured_at).toISOString(),
      assetType: snapshot.asset_type,
      snapshotId: Number(snapshot.id),
      breakdowns: toBreakdowns(rows)
    };
  } catch (error) {
    return khongCoDuLieu(`Không đọc được kho số liệu cào: ${error.message}`);
  }
}

// Toàn bộ dòng thô của lần cào mới nhất — dùng cho chức năng xuất file.
//
// Vì sao có hàm riêng thay vì dùng lại getCrawledAudience()? Vì hàm kia trả về
// dữ liệu ĐÃ GOM về 3 breakdown để vẽ biểu đồ. Người dùng xuất "dữ liệu thô"
// thì cần đúng những dòng nằm trong DB, không qua bước gom nào.
async function getRawRows(assetId, userId = null) {
  if (!assetId || !isEnabled()) {
    return { available: false, rows: [] };
  }

  const sql = getSql();

  try {
    const snapshot = await findLatestSnapshot(sql, assetId, userId);
    if (!snapshot) {
      return { available: false, rows: [] };
    }

    const rows = await findRows(sql, snapshot.id);
    return {
      available: rows.length > 0,
      snapshotId: Number(snapshot.id),
      assetType: snapshot.asset_type,
      capturedAt: new Date(snapshot.captured_at).toISOString(),
      source: snapshot.source,
      rows: rows.map((row) => ({
        dimension: row.dimension,
        segment: row.segment,
        ageRange: row.age_range,
        gender: row.gender,
        location: row.location,
        percentage: Number(row.percentage)
      }))
    };
  } catch {
    // Xuất file là chức năng phụ — hỏng thì trả rỗng để route báo 404 tử tế,
    // thay vì đổ lỗi 500. Nguyên nhân thật đã hiện ở getCrawledAudience().
    return { available: false, rows: [] };
  }
}

module.exports = {
  getCrawledAudience,
  getRawRows,
  // Xuất phụ để test độc lập phần đổi hình dạng, không cần DB.
  toBreakdowns,
  genderCode
};
