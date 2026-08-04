#!/usr/bin/env node
// Cầu nối cho chương trình nền ở máy nhà: nhận việc, báo xong, báo hỏng.
//
// DÙNG LÀM GÌ
// Bạn bấm "Cào ngay" trên web -> một dòng được ghi vào bảng crawl_jobs trên
// Supabase. Máy ở nhà (chạy Python) cần đọc dòng đó, làm, rồi báo kết quả về.
// File này là cửa duy nhất cho ba việc đó.
//
// VÌ SAO LẠI LÀ NODE CHỨ KHÔNG NỐI THẲNG POSTGRES TỪ PYTHON
// Cùng lý do với export-assets.js và import-audience.js: DATABASE_URL là bí
// mật, chỉ nên nằm ở MỘT file .env; và cấu hình pooler cổng 6543
// (prepare:false + ssl) chỉ khai đúng một lần ở src/db/postgres.js.
//
// CÁCH DÙNG
//   node scripts/crawl-worker-cli.js claim   "TEN-MAY"
//   node scripts/crawl-worker-cli.js finish  <jobId> <snapshotId> <rowCount>
//   node scripts/crawl-worker-cli.js fail    <jobId> "cau loi"
//   node scripts/crawl-worker-cli.js release           # don viec bi bo do
//
// QUY ƯỚC ĐẦU RA: JSON đi ra stdout, mọi thông báo đi ra stderr.

require("dotenv").config();

const { getSql, isEnabled, initCrawlJobsSchema } = require("../src/db/postgres");
const crawlJobs = require("../src/services/crawl-jobs.service");

const EXIT_OK = 0;
const EXIT_NO_CONFIG = 1;
const EXIT_BAD_ARGS = 2;

function log(...args) {
  console.error(...args);
}

function xuat(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

// Bảng tra lệnh -> hàm xử lý. Thêm lệnh mới là thêm một dòng, không phải nối
// thêm nhánh if/else.
const LENH = {
  async claim([workerName]) {
    const job = await crawlJobs.claimNextJob(workerName || "unknown");
    if (job) {
      log(`Nhan viec #${job.id}: ${job.assetId} (${job.timeRange})`);
    }
    // LUÔN in ra JSON, kể cả khi rỗng. Bên Python phân biệt "không có việc"
    // với "lệnh hỏng" bằng chính chỗ này — im lặng thì hai thứ giống nhau.
    xuat({ job });
    return EXIT_OK;
  },

  async finish([jobId, snapshotId, rowCount]) {
    if (!jobId) {
      log("[LOI] Thieu jobId.");
      return EXIT_BAD_ARGS;
    }
    const job = await crawlJobs.finishJob(jobId, {
      snapshotId: snapshotId ? Number(snapshotId) : null,
      rowCount: rowCount ? Number(rowCount) : 0
    });
    log(`Viec #${jobId} da xong.`);
    xuat({ job });
    return EXIT_OK;
  },

  async fail([jobId, ...phanConLai]) {
    if (!jobId) {
      log("[LOI] Thieu jobId.");
      return EXIT_BAD_ARGS;
    }
    // Gộp lại phần còn lại: câu lỗi có dấu cách sẽ bị tách thành nhiều tham
    // số, và nếu chỉ lấy phần đầu thì thông báo cụt mất nghĩa.
    const message = phanConLai.join(" ") || "Khong ro nguyen nhan.";
    const job = await crawlJobs.failJob(jobId, message);
    log(`Viec #${jobId} that bai: ${message}`);
    xuat({ job });
    return EXIT_OK;
  },

  async release() {
    const soLuong = await crawlJobs.releaseStaleJobs(60);
    log(`Da don ${soLuong} viec bi bo do.`);
    xuat({ released: soLuong });
    return EXIT_OK;
  }
};

async function main() {
  const [lenh, ...thamSo] = process.argv.slice(2);

  if (!lenh || !LENH[lenh]) {
    log(`[LOI] Lenh khong hop le: ${lenh || "(trong)"}`);
    log(`-> Chon mot trong: ${Object.keys(LENH).join(", ")}`);
    return EXIT_BAD_ARGS;
  }

  if (!isEnabled()) {
    log("[LOI] Chua cau hinh DATABASE_URL — khong doc duoc hang doi.");
    log("-> Kiem tra DATABASE_URL trong file .env cua du an nay.");
    return EXIT_NO_CONFIG;
  }

  // Tự tạo bảng nếu chưa có: máy ở nhà có thể chạy trước lần deploy đầu tiên
  // của web. Câu lệnh đều có IF NOT EXISTS nên gọi bao nhiêu lần cũng vô hại.
  await initCrawlJobsSchema();

  return LENH[lenh](thamSo);
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
    process.exit(EXIT_BAD_ARGS);
  });
