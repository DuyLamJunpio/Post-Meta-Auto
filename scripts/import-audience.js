#!/usr/bin/env node
// Nhận một ảnh chụp nhân khẩu học (JSON) và ghi vào Postgres (Supabase).
//
// DÙNG LÀM GÌ
// Công cụ cào viết bằng Python chạy trên máy bạn. Nó cần đẩy số liệu lên đúng
// kho mà web đọc. File này là cửa vào duy nhất cho việc đó.
//
// VÌ SAO LÀ MỘT SCRIPT NODE CHỨ KHÔNG PHẢI PYTHON NỐI THẲNG POSTGRES
// Giống lý do ở export-assets.js: chuỗi kết nối Supabase, cấu hình SSL và
// prepare:false của pooler cổng 6543 đã được khai đúng một lần ở
// src/db/postgres.js. Chép sang Python nghĩa là có HAI bản cùng một cấu hình,
// và DATABASE_URL — một bí mật — phải nằm ở hai file .env khác nhau.
// Gọi lại chính code này thì chỉ có MỘT bản, và bí mật ở đúng một chỗ.
//
// CÁCH DÙNG
//   node scripts/import-audience.js duong-dan-file.json
//
// VÌ SAO NHẬN ĐƯỜNG DẪN FILE CHỨ KHÔNG PHẢI ĐỌC STDIN
// Khi hỏng, file JSON vẫn nằm đó để mở ra xem. Với stdin thì dữ liệu bay mất
// theo tiến trình, muốn dựng lại phải cào lại từ đầu. Thêm nữa, tiếng Việt đi
// qua stdin trên Windows còn phụ thuộc bảng mã của console.
//
// QUY ƯỚC ĐẦU RA: JSON đi ra stdout, mọi thông báo đi ra stderr.

require("dotenv").config();

const fs = require("fs");

const { getSql, isEnabled, initCrawledAudienceSchema } = require("../src/db/postgres");

// Mã thoát để bên gọi phân biệt được nguyên nhân
const EXIT_OK = 0;
const EXIT_NO_CONFIG = 1; // chua cau hinh DATABASE_URL
const EXIT_BAD_INPUT = 2; // JSON thieu truong hoac sai dinh dang
const EXIT_WRITE_FAILED = 3; // ghi that bai

// Ba chiều dữ liệu công cụ cào biết lấy. Chặn ở đây để một chiều lạ (Meta đổi
// tên chẳng hạn) không lặng lẽ chui vào DB rồi làm hỏng phần đọc.
const DIMENSIONS = new Set(["age_gender", "city", "country"]);

function log(...args) {
  console.error(...args);
}

class InputError extends Error {}

function normalizeRow(row, index) {
  const dimension = String(row.dimension || "");
  if (!DIMENSIONS.has(dimension)) {
    throw new InputError(
      `Dong ${index}: chieu du lieu la '${dimension}', chi chap nhan ` +
        `${[...DIMENSIONS].join(" | ")}.`
    );
  }

  const percentage = Number(row.percentage);
  if (!Number.isFinite(percentage) || percentage < 0) {
    throw new InputError(`Dong ${index}: percentage khong hop le (${row.percentage}).`);
  }

  // KHÔNG chặn percentage > 100. Meta thật sự trả những giá trị như vậy
  // (Việt Nam 106.2%) vì một người có thể được tính vào nhiều quốc gia.
  // Đặt trần 100 ở đây sẽ loại bỏ dữ liệu đúng.
  return {
    dimension,
    segment: String(row.segment || ""),
    age_range: row.ageRange || null,
    gender: row.gender || null,
    location: row.location || null,
    percentage
  };
}

// Đọc và KIỂM TRA đầu vào trước khi mở kết nối.
//
// Vì sao kiểm tra kỹ ở đây? Vì sai sót về tên chiều hay đơn vị sẽ KHÔNG làm
// câu INSERT thất bại — nó ghi thành công một bản ghi sai, rồi web hiển thị số
// sai mà không có dấu hiệu nào. Sai ở biên thì phải chặn ngay tại biên.
function readSnapshot(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new InputError(`Khong doc duoc file ${filePath}: ${error.message}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new InputError(`File khong phai JSON hop le: ${error.message}`);
  }

  const assetId = String(payload.assetId || "").trim();
  if (!assetId) {
    throw new InputError("Thieu assetId.");
  }

  const capturedAt = new Date(payload.capturedAt);
  if (Number.isNaN(capturedAt.getTime())) {
    throw new InputError(`capturedAt khong doc duoc: ${payload.capturedAt}`);
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.length === 0) {
    throw new InputError("Khong co dong so lieu nao (rows rong).");
  }

  return {
    assetId,
    assetType: payload.assetType === "instagram" ? "instagram" : "page",
    businessId: payload.businessId ? String(payload.businessId) : null,
    source: String(payload.source || "browser"),
    capturedAt,
    rows: rows.map(normalizeRow)
  };
}

async function saveSnapshot(sql, snapshot) {
  // MỘT GIAO DỊCH cho cả ảnh chụp lẫn các dòng: ghi tới dòng thứ 20 mà lỗi thì
  // 19 dòng trước bị huỷ theo. Không có giao dịch thì web sẽ đọc phải một ảnh
  // chụp dở dang — mà nhìn bề ngoài không có cách nào biết nó dở dang.
  return sql.begin(async (tx) => {
    const [created] = await tx`
      INSERT INTO crawled_audience_snapshots
        (asset_id, asset_type, business_id, source, captured_at)
      VALUES (${snapshot.assetId}, ${snapshot.assetType}, ${snapshot.businessId},
              ${snapshot.source}, ${snapshot.capturedAt})
      RETURNING id
    `;

    const snapshotId = created.id;
    const rows = snapshot.rows.map((row) => ({ ...row, snapshot_id: snapshotId }));

    // Helper tx(...) của thư viện postgres sinh câu INSERT nhiều dòng có tham
    // số hoá đầy đủ — không nối chuỗi, nên không có chỗ cho SQL injection.
    await tx`
      INSERT INTO crawled_audience_rows ${tx(
        rows,
        "snapshot_id",
        "dimension",
        "segment",
        "age_range",
        "gender",
        "location",
        "percentage"
      )}
    `;

    return snapshotId;
  });
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    log("[LOI] Thieu duong dan file JSON.");
    log("-> node scripts/import-audience.js duong-dan-file.json");
    return EXIT_BAD_INPUT;
  }

  if (!isEnabled()) {
    log("[LOI] Chua cau hinh DATABASE_URL — khong ghi duoc so lieu.");
    log("-> Kiem tra DATABASE_URL trong file .env cua du an nay.");
    return EXIT_NO_CONFIG;
  }

  let snapshot;
  try {
    snapshot = readSnapshot(filePath);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    log(`[LOI] ${error.message}`);
    return EXIT_BAD_INPUT;
  }

  // Tự tạo bảng nếu chưa có: công cụ cào có thể chạy trước lần deploy đầu tiên
  // của web, và câu lệnh đều có IF NOT EXISTS nên gọi bao nhiêu lần cũng vô hại.
  await initCrawledAudienceSchema();

  const sql = getSql();
  let snapshotId;
  try {
    snapshotId = await saveSnapshot(sql, snapshot);
  } catch (error) {
    log(`[LOI] Ghi that bai: ${error.message}`);
    return EXIT_WRITE_FAILED;
  }

  log(
    `Da ghi ${snapshot.rows.length} dong cho asset ${snapshot.assetId} ` +
      `(${snapshot.assetType}), ban ghi #${snapshotId}.`
  );

  process.stdout.write(
    JSON.stringify({ snapshotId: Number(snapshotId), rowCount: snapshot.rows.length }, null, 2) +
      "\n"
  );

  return EXIT_OK;
}

main()
  .then(async (code) => {
    // Đóng kết nối Postgres, nếu không tiến trình sẽ treo không thoát.
    const sql = getSql();
    if (sql) await sql.end({ timeout: 5 });
    process.exit(code);
  })
  .catch(async (error) => {
    log("[LOI]", error && error.message ? error.message : error);
    const sql = getSql();
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(EXIT_WRITE_FAILED);
  });
