// Xuất dữ liệu nhân khẩu học ra file: CSV, Excel, JSON, và bản in PDF.
//
// NGUYÊN TẮC: file này KHÔNG LẤY DỮ LIỆU VÀ KHÔNG TÍNH TOÁN.
// Nó nhận nguyên payload mà audience.service đã dựng xong rồi ĐỔI ĐỊNH DẠNG.
// Nhờ vậy con số trong file xuất ra luôn khớp tuyệt đối với con số trên màn
// hình — không có đường nào để hai bên lệch nhau, vì chỉ có một phép tính.
//
// BỐN ĐỊNH DẠNG, HAI CÁCH NGHĨ
//   json         -> nguyên payload, không mất gì. Dành cho việc đưa sang hệ khác.
//   csv / xlsx   -> bảng phẳng. Dành cho việc mở lên xem, lọc, dựng pivot.
//   pdf          -> trang in sẵn. Dành cho việc gửi cho người khác đọc.

const XLSX = require("xlsx");

// Thứ tự cột. Ba cột đầu lặp lại ở mọi dòng — cố ý.
//
// Vì sao chấp nhận lặp? Vì file phẳng phải TỰ MÔ TẢ. Người nhận file qua email
// ba tháng sau không có ngữ cảnh nào ngoài chính file đó; thiếu tên trang và
// thời điểm thì con số 30.1 chẳng nói lên điều gì. Ngoài ra Excel dựng pivot
// theo cột, nên dữ liệu lặp kiểu này còn tiện hơn là ghi ở đầu file.
const COLUMNS = [
  "Trang",
  "ID trang",
  "Nền tảng",
  "Nguồn số liệu",
  "Thời điểm số liệu",
  "Chiều",
  "Nhóm",
  "Phần trăm",
  "Giá trị gốc"
];

// Nhãn tiếng Việt cho từng chiều dữ liệu, dùng chung cho mọi định dạng.
const DIMENSION_LABELS = {
  age: "Độ tuổi",
  gender: "Giới tính",
  city: "Thành phố",
  country: "Quốc gia"
};

// Nguồn nào ra số này — quan trọng vì hai nguồn có ý nghĩa khác hẳn nhau.
const SOURCE_LABELS = {
  crawler: "Cào từ Business Suite",
  graph_api: "Graph API"
};

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source || "Không rõ";
}

function formatTime(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return String(isoString);
  // Giờ Việt Nam, vì người đọc file ở Việt Nam. Để nguyên UTC thì số liệu cào
  // lúc 8 giờ tối sẽ hiện thành 1 giờ chiều và trông như dữ liệu của hôm trước.
  return date.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

// Đổi MỘT nền tảng (Facebook hoặc Instagram) thành các dòng phẳng.
function platformRows({ pageName, pageId, platform, demo }) {
  if (!demo || !demo.available) return [];

  const nguon = sourceLabel(demo.source);
  const thoiDiem = formatTime(demo.capturedAt);
  const rows = [];

  for (const [key, label] of Object.entries(DIMENSION_LABELS)) {
    const normalized = demo[key];
    if (!normalized || !Array.isArray(normalized.items)) continue;

    for (const item of normalized.items) {
      rows.push({
        Trang: pageName,
        "ID trang": pageId,
        "Nền tảng": platform,
        "Nguồn số liệu": nguon,
        "Thời điểm số liệu": thoiDiem,
        Chiều: label,
        Nhóm: item.label,
        // Làm tròn 2 chữ số: số gốc của Meta có tới 13 chữ số thập phân, mở
        // trong Excel trông như dữ liệu hỏng mà chẳng thêm thông tin gì.
        "Phần trăm": Math.round(item.percent * 100) / 100,
        // Với nguồn cào, "giá trị gốc" chính là phần trăm (Meta chỉ cho %).
        // Với Graph API thì đây là SỐ NGƯỜI. Giữ cả hai cột để người đọc phân
        // biệt được, thay vì phải đoán đơn vị từ tên nguồn.
        "Giá trị gốc": Math.round(item.value * 100) / 100
      });
    }
  }

  return rows;
}

// Điểm vào chính: payload của buildPageAudience -> mảng dòng phẳng.
//
// Hàm THUẦN: vào object, ra mảng. Không đụng DB, không đụng mạng — test được
// bằng một payload dựng tay.
function buildRows(audience) {
  const pageName = (audience.page && audience.page.name) || "";
  const pageId = (audience.page && audience.page.id) || "";

  return [
    ...platformRows({ pageName, pageId, platform: "Facebook", demo: audience.facebook }),
    ...platformRows({ pageName, pageId, platform: "Instagram", demo: audience.instagram })
  ];
}

// --- CSV -------------------------------------------------------------------

function escapeCsv(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Bọc nháy kép khi có dấu phẩy, nháy kép, hoặc xuống dòng — nếu không thì
  // "Huế, Thừa Thiên - Huế" sẽ bị Excel tách thành hai cột.
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function toCsv(rows) {
  const lines = [COLUMNS.map(escapeCsv).join(",")];
  for (const row of rows) {
    lines.push(COLUMNS.map((col) => escapeCsv(row[col])).join(","));
  }

  // \r\n vì file này chủ yếu được mở trên Windows.
  // BOM (﻿) BẮT BUỘC: thiếu nó thì Excel đọc file UTF-8 bằng bảng mã hệ
  // thống và mọi chữ có dấu thành ký tự lạ ("Huế" -> "Huáº¿").
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// --- Excel -----------------------------------------------------------------

function toWorkbookBuffer(rows) {
  // header: COLUMNS để thứ tự cột cố định. Thiếu tham số này thì thư viện tự
  // suy thứ tự từ khoá của dòng ĐẦU TIÊN, nên một trang không có dữ liệu
  // thành phố sẽ cho ra file thiếu cột — mà không báo gì.
  const sheet = XLSX.utils.json_to_sheet(rows, { header: COLUMNS });

  // Đặt bề rộng cột, nếu không thì tên thành phố dài bị cắt cụt khi mở lên.
  sheet["!cols"] = [
    { wch: 26 }, { wch: 20 }, { wch: 11 }, { wch: 24 },
    { wch: 20 }, { wch: 12 }, { wch: 28 }, { wch: 11 }, { wch: 13 }
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Nhân khẩu học");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

// --- Bản in (PDF) ----------------------------------------------------------

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Trả về một trang HTML tự gọi hộp thoại in.
//
// VÌ SAO KHÔNG DỰNG PDF Ở MÁY CHỦ?
// Thư viện PDF cho Node đều dùng font gốc không có dấu tiếng Việt — "Huế" sẽ
// in ra "Hu" hoặc ô vuông. Muốn đúng thì phải nhúng kèm một file font tiếng
// Việt vài trăm KB vào kho mã, rồi tự lo bố cục, ngắt trang, canh bảng.
//
// Trình duyệt đã làm sẵn tất cả những việc đó, bằng đúng font hệ thống mà máy
// người dùng có. "Lưu thành PDF" là một lựa chọn có sẵn trong mọi hộp thoại
// in. Đổi lại: thêm một cú bấm, và file do máy người dùng tạo chứ không phải
// máy chủ. Với một bản báo cáo để đọc thì đánh đổi đó là hời.
function buildPrintableHtml({ audience, rows, title }) {
  const warnings = (audience.warnings || []).map((w) => `<li>${escapeHtml(w)}</li>`);

  const body = rows
    .map(
      (row) => `<tr>
      <td>${escapeHtml(row["Nền tảng"])}</td>
      <td>${escapeHtml(row["Chiều"])}</td>
      <td>${escapeHtml(row["Nhóm"])}</td>
      <td class="num">${escapeHtml(row["Phần trăm"])}%</td>
      <td>${escapeHtml(row["Nguồn số liệu"])}</td>
      <td>${escapeHtml(row["Thời điểm số liệu"])}</td>
    </tr>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: "Segoe UI", Arial, sans-serif; margin: 28px; color: #1e293b; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #64748b; font-size: 13px; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 9px; text-align: left; }
  th { background: #f1f5f9; }
  td.num { text-align: right; }
  .warn { background: #fffbeb; border: 1px solid #fcd34d; padding: 10px 14px;
          border-radius: 6px; font-size: 12px; margin-bottom: 16px; }
  .warn ul { margin: 6px 0 0 16px; padding: 0; }
  /* Lặp lại hàng tiêu đề ở mỗi trang giấy, và không cắt đôi một hàng */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">Xuất lúc ${escapeHtml(formatTime(new Date().toISOString()))}</div>
${warnings.length ? `<div class="warn"><strong>Lưu ý về nguồn số liệu</strong><ul>${warnings.join("")}</ul></div>` : ""}
<table>
  <thead><tr>
    <th>Nền tảng</th><th>Chiều</th><th>Nhóm</th>
    <th>Phần trăm</th><th>Nguồn</th><th>Thời điểm</th>
  </tr></thead>
  <tbody>
${body}
  </tbody>
</table>
<p class="no-print" style="margin-top:20px;color:#64748b;font-size:12px">
  Hộp thoại in sẽ tự mở. Chọn <strong>Đích đến &rarr; Lưu dưới dạng PDF</strong>.
</p>
<script>window.addEventListener("load", function () { window.print(); });</script>
</body>
</html>`;
}

// Tên file tải về. CỐ Ý CHỈ DÙNG KÝ TỰ ASCII: tên file có dấu đi qua header
// Content-Disposition sẽ thành ký tự lạ trên một số trình duyệt, và người dùng
// nhận về một file không mở nổi.
function buildFilename(pageId, extension) {
  const ngay = new Date().toISOString().slice(0, 10);
  const idSach = String(pageId || "unknown").replace(/[^\w-]/g, "");
  return `nhan-khau-hoc_${idSach}_${ngay}.${extension}`;
}

module.exports = {
  buildRows,
  toCsv,
  toWorkbookBuffer,
  buildPrintableHtml,
  buildFilename,
  // Xuất phụ để test đọc được, và để route dùng lại danh sách nhãn.
  COLUMNS,
  DIMENSION_LABELS
};
