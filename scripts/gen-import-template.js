"use strict";

// Tạo file Excel mẫu để điền task hàng loạt: Notion-Task-Import.xlsx
// Chỉ gồm CỘT NGƯỜI DÙNG THAO TÁC. Bỏ cột hệ thống tự điền (Post ID/URL các kênh, Publish Status,
// Error Message, Last Synced At, Published At, Retry Count) và cột nâng cao chưa hoạt động ([FB] ...).
// Nhập xong chạy: node scripts/import-tasks-from-excel.js

const path = require("path");
const XLSX = require("xlsx");

// Thứ tự cột PHẢI khớp scripts/import-tasks-from-excel.js
const HEADERS = [
  "Post Title", "Caption", "Channel", "Post Type", "Media URLs", "Brand Code",
  "Publish At", "Timezone", "Approval Status", "Content Workflow", "Auto Publish",
  "General idea", "Visual execution", "Reference", "Sound",
  "Notes", "Source Folder URL"
];

function makeRow(obj) {
  return HEADERS.map((h) => (obj[h] === undefined ? "" : obj[h]));
}

const SAMPLES = [
  makeRow({
    "Post Title": "Cập nhật mốc thuế 31/07",
    "Caption": "Những thay đổi chính sách thuế mới đáng chú ý.\n\nLiên hệ OmniFlow để được tư vấn.",
    "Channel": "Facebook", "Post Type": "Post", "Media URLs": "",
    "Brand Code": "OMNI_FLOW", "Publish At": "2026-07-20 09:00", "Timezone": "Asia/Ho_Chi_Minh",
    "Approval Status": "Đã duyệt", "Content Workflow": "Hoàn thành nội dung", "Auto Publish": "TRUE",
    "General idea": "Nhấn mạnh mốc 31/07/2026 để hộ kinh doanh chủ động hoàn thành thủ tục thuế.",
    "Visual execution": "Infographic mốc thời gian, tông xanh, logo thương hiệu.",
    "Reference": "https://thuehaiquan.tapchikinhtetaichinh.vn/",
    "Sound": "Nhạc nền nhẹ nhàng, chuyên nghiệp.",
    "Notes": "Ưu tiên đăng khung giờ sáng.",
    "Source Folder URL": "https://drive.google.com/drive/folders/1AbCdEf"
  }),
  makeRow({
    "Post Title": "Album - BST mới",
    "Caption": "Bộ sưu tập mới đã cập bến!\n#TrueLady #BST2026",
    "Channel": "Facebook", "Post Type": "Post",
    "Media URLs": "https://picsum.photos/id/11/1080/1080.jpg, https://picsum.photos/id/12/1080/1080.jpg",
    "Brand Code": "TRUE_LADY", "Publish At": "2026-07-21 10:00", "Timezone": "Asia/Ho_Chi_Minh",
    "Approval Status": "Đã duyệt", "Content Workflow": "Hoàn thành nội dung", "Auto Publish": "TRUE",
    "General idea": "Giới thiệu BST mới, tôn dáng thanh lịch.",
    "Visual execution": "3 ảnh sản phẩm, nền sáng, bố cục tối giản.",
    "Reference": "https://truelady.vn/bst-moi",
    "Sound": "Nhạc thời trang sôi động.",
    "Notes": "Đã duyệt hình với khách hàng.",
    "Source Folder URL": "https://drive.google.com/drive/folders/2GhIjKl"
  }),
  makeRow({
    "Post Title": "Cross-post FB + IG",
    "Caption": "Cùng một nội dung, đăng đồng thời Facebook và Instagram.",
    "Channel": "Facebook, Instagram", "Post Type": "Post",
    "Media URLs": "https://picsum.photos/id/25/1080/1080.jpg",
    "Brand Code": "OMNI_FLOW", "Publish At": "2026-07-22 08:30", "Timezone": "Asia/Ho_Chi_Minh",
    "Approval Status": "Chờ duyệt", "Content Workflow": "Hoàn thành nội dung", "Auto Publish": "FALSE",
    "General idea": "Thông điệp thống nhất trên cả Facebook và Instagram.",
    "Visual execution": "1 ảnh vuông 1080x1080.",
    "Reference": "https://omniflow.vn/blog/crosspost",
    "Sound": "Nhạc nền hiện đại.",
    "Notes": "Kiểm tra ảnh hiển thị đẹp trên cả 2 nền tảng.",
    "Source Folder URL": "https://drive.google.com/drive/folders/3MnOpQr"
  })
];

// [Cột, Ý nghĩa, Dữ liệu phù hợp, Bắt buộc]
const GUIDE = [
  ["Post Title", "Tên task để nhận diện trong Notion (không phải nội dung bài).", "Chữ tự do. VD: Bài thuế tháng 7", "Bắt buộc"],
  ["Caption", "Nội dung bài đăng thật -> cột CAPTION. Xuống dòng bằng Alt+Enter (giữ nguyên khi đăng). Text thuần.", "Đoạn văn + hashtag. Bài chỉ chữ thì bắt buộc.", "Tùy"],
  ["Channel", "Kênh đăng. Nhiều kênh ngăn bằng dấu phẩy.", "Facebook | Instagram | Facebook, Instagram", "Bắt buộc"],
  ["Post Type", "Loại bài.", "Post hoặc Reel (mặc định Post)", "Tùy"],
  ["Media URLs", "Link ảnh/video CÔNG KHAI có đuôi file. Nhiều link ngăn bằng phẩy.", "https://.../a.jpg, https://.../b.jpg", "Bắt buộc nếu có Instagram"],
  ["Brand Code", "Mã brand (khớp Brand Code trong Brands DB). Đúng 1 brand.", "OMNI_FLOW | TRUE_LADY | LAIXE_247 | M_TIKTOK", "Bắt buộc"],
  ["Publish At", "Thời điểm đăng. Trống = chưa lên lịch.", "YYYY-MM-DD HH:mm", "Tùy"],
  ["Timezone", "Múi giờ.", "Asia/Ho_Chi_Minh", "Tùy"],
  ["Approval Status", "Duyệt để cho phép đăng. Chờ duyệt = nháp, không tự đăng.", "Đã duyệt | Chờ duyệt", "Bắt buộc"],
  ["Content Workflow", "Phải 'Hoàn thành nội dung' mới đủ điều kiện đăng.", "Hoàn thành nội dung", "Bắt buộc"],
  ["Auto Publish", "Cho phép hệ thống tự đăng.", "TRUE | FALSE", "Bắt buộc"],
  ["General idea", "Ý tưởng tổng quát -> body mục 'Idea'. Không đăng.", "Mô tả ngắn ý tưởng/thông điệp.", "Tùy"],
  ["Visual execution", "Cách thể hiện visual -> body mục 'Idea'. Không đăng.", "Mô tả visual, tông màu, layout.", "Tùy"],
  ["Reference", "Link tham khảo -> body mục 'Reference'. Không đăng.", "URL bài tham khảo.", "Tùy"],
  ["Sound", "Nhạc/âm thanh cho video/reel -> body mục 'Sound'. Không đăng.", "Mô tả nhạc nền / link nhạc.", "Tùy"],
  ["Notes", "Ghi chú nội bộ -> cột Notes.", "Chữ tự do.", "Tùy"],
  ["Source Folder URL", "Link thư mục nguồn media (Google Drive).", "URL thư mục Drive.", "Tùy"]
];

const WIDTHS = HEADERS.map((h) => (h === "Caption" ? 46 : /^(General idea|Visual execution|Media URLs|Reference|Source Folder URL)$/.test(h) ? 34 : 16));

function buildSampleSheet() {
  const aoa = [HEADERS, ...SAMPLES, [], ["HƯỚNG DẪN TỪNG CỘT"], ["Cột", "Ý nghĩa / tác dụng", "Dữ liệu phù hợp", "Bắt buộc?"], ...GUIDE, [],
    ["GHI CHÚ:"],
    ["- Excel chỉ gồm cột NGƯỜI DÙNG thao tác. Cột kết quả ([FB]/[IG]/[GBP]/[TikTok] Post ID-URL) và cột trạng thái (Publish Status, Error Message, Last Synced At, Published At, Retry Count) do MÁY tự điền."],
    ["- Có Instagram trong Channel thì BẮT BUỘC có Media URLs (IG không đăng bài chỉ chữ)."],
    ["- Caption = bài đăng thật. General idea / Visual execution / Reference / Sound chỉ vào BODY để làm việc, KHÔNG đăng."],
    ["- Các tính năng nâng cao ([FB] vị trí, tag người, cộng tác... và Instagram vị trí/cộng tác) sẽ được thêm cột khi triển khai xong."],
    ["- Điền task ở sheet 'Danh sách task Notion' rồi chạy: node scripts/import-tasks-from-excel.js"]
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = WIDTHS.map((wch) => ({ wch }));
  return ws;
}

function buildRealSheet() {
  const ws = XLSX.utils.aoa_to_sheet([HEADERS]);
  ws["!cols"] = WIDTHS.map((wch) => ({ wch }));
  return ws;
}

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, buildSampleSheet(), "Dữ liệu mẫu");
XLSX.utils.book_append_sheet(wb, buildRealSheet(), "Danh sách task Notion");

const outPath = path.join(__dirname, "..", "Notion-Task-Import.xlsx");
XLSX.writeFile(wb, outPath);
console.log("Đã tạo:", outPath, "-", HEADERS.length, "cột");
