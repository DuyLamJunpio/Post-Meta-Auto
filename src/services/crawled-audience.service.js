// Đọc nhân khẩu học do công cụ cào Business Suite ghi vào (bảng crawled_audience_*).
//
// VÌ SAO CẦN NGUỒN NÀY
// Meta đã ngừng gần hết metric nhân khẩu học cấp Page trên Graph API — xem ghi
// chú trong facebook.service.js ("Tất cả metric thử đều không hợp lệ ở phiên bản
// API này"). Công cụ cào chạy trên máy có Edge đã đăng nhập, lấy số liệu từ
// chính giao diện Business Suite rồi ghi vào data/app.db. File này chỉ ĐỌC.
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

const { getDb } = require("../db");

// Nhãn giới tính của crawler -> mã mà audience.service đang dùng.
// Crawler chuẩn hóa về chữ thường; audience.service dùng F/M/U.
const GENDER_CODE = { female: "F", male: "M", unknown: "U" };

function genderCode(value) {
  return GENDER_CODE[String(value || "").toLowerCase()] || "U";
}

// Lấy ảnh chụp MỚI NHẤT của một asset (Page hoặc IG). Trả null nếu chưa có.
function findLatestSnapshot(database, assetId) {
  return (
    database
      .prepare(
        `SELECT id, asset_id, asset_type, business_id, source, captured_at
         FROM crawled_audience_snapshots
         WHERE asset_id = ?
         ORDER BY captured_at DESC, id DESC
         LIMIT 1`
      )
      .get(String(assetId)) || null
  );
}

function findRows(database, snapshotId) {
  return database
    .prepare(
      `SELECT dimension, age_range, gender, location, percentage
       FROM crawled_audience_rows
       WHERE snapshot_id = ?
       ORDER BY id`
    )
    .all(snapshotId);
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

// Điểm vào: lấy dữ liệu cào mới nhất của một asset.
//
// Trả về cùng dạng với facebook.service.getPageAudience() để hai nguồn thay
// thế được cho nhau: { available, reason? , breakdowns?, ... }.
// Không ném lỗi khi chưa có dữ liệu — "chưa cào lần nào" là trạng thái bình
// thường, không phải sự cố.
function getCrawledAudience(assetId) {
  if (!assetId) {
    return { available: false, reason: "Thiếu ID trang để tra dữ liệu đã cào." };
  }

  const database = getDb();
  const snapshot = findLatestSnapshot(database, assetId);

  if (!snapshot) {
    return {
      available: false,
      reason:
        "Chưa có dữ liệu cào cho trang này. Chạy `python -m src.cli run` " +
        "trên máy có Edge đã đăng nhập Facebook."
    };
  }

  const rows = findRows(database, snapshot.id);
  if (rows.length === 0) {
    return { available: false, reason: "Bản ghi cào gần nhất không có dòng số liệu nào." };
  }

  return {
    available: true,
    // Cờ này BẮT BUỘC — xem cảnh báo về đơn vị ở đầu file.
    alreadyPercent: true,
    source: "crawler",
    capturedAt: snapshot.captured_at,
    assetType: snapshot.asset_type,
    breakdowns: toBreakdowns(rows)
  };
}

module.exports = {
  getCrawledAudience,
  // Xuất phụ để test độc lập phần đổi hình dạng, không cần DB.
  toBreakdowns,
  genderCode
};
