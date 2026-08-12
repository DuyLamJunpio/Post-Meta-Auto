// Xuất báo cáo quảng cáo ra CSV / JSON — MODULE THUẦN (không đụng DOM).
//
// Tách khỏi ads-section.js theo đúng lớp "util thuần" của dự án (như src/utils/ads-math.js):
// nhận payload đã tải (insights + demographics + ngữ cảnh chọn) rồi trả về CHUỖI để tải xuống.
// Vì không phụ thuộc DOM/Chart nên kiểm thử được bằng Node (copy sang .mjs rồi import).
//
// LƯU Ý ĐỊNH DẠNG SỐ: CSV/JSON là dữ liệu THÔ cho máy đọc — xuất số nguyên bản (dấu chấm
// thập phân, KHÔNG format kiểu vi-VN có dấu phẩy). Định dạng vi-VN chỉ dùng cho màn hình;
// nếu nhét dấu phẩy thập phân/ngăn cách nghìn vào CSV sẽ phá cột. `share` đã là phần trăm
// (0..100) nên xuất nguyên.

// Nhãn giới tính (giá trị Graph: male/female/unknown). Giữ bản cục bộ để module thuần này
// không phải import từ tầng UI (chấp nhận trùng nhỏ với ads-section.js — KISS hơn là ghép chéo).
const GENDER_LABELS = { female: "Nữ", male: "Nam", unknown: "Không rõ" };

function genderLabel(gender) {
  return GENDER_LABELS[gender] || gender || "Không rõ";
}

// Thứ tự + nhãn tiếng Việt của các chỉ số tổng quan (khớp overview của ads-math).
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

// --- Escape/format cho CSV --------------------------------------------------

// Quy tắc CSV chuẩn: bọc trong dấu nháy kép nếu ô chứa dấu phẩy, nháy kép, hoặc xuống dòng;
// nháy kép bên trong nhân đôi. Ô rỗng cho null/undefined.
function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

// Số cho CSV: nguyên bản (dấu chấm thập phân). Số thực làm tròn 4 chữ số để không dài lê thê.
function numCell(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "";
  }
  if (Number.isInteger(n)) {
    return String(n);
  }
  return String(Math.round(n * 10000) / 10000);
}

// --- Dựng model chuẩn hóa (dùng chung cho CSV & JSON) -----------------------

// Chuẩn hóa 1 chiều nhân khẩu học về { available, reason, rows[] } bất kể tên mảng gốc
// (ageGender.segments vs country/region.items).
function normalizeDim(dim, arrayKey) {
  if (!dim) {
    return { available: false, reason: "Không có dữ liệu.", rows: [] };
  }
  return {
    available: Boolean(dim.available),
    reason: dim.reason || "",
    rows: Array.isArray(dim[arrayKey]) ? dim[arrayKey] : []
  };
}

// Gom insights + demographics + ngữ cảnh chọn thành 1 model phẳng, không phụ thuộc thứ tự
// tải (demographics có thể null nếu chưa/không tải được — vẫn xuất phần insights).
export function buildReportModel({ insights, demographics, context } = {}) {
  const ctx = context || {};
  const ins = insights || {};
  const demo = demographics || {};
  const overview = ins.overview || {};

  return {
    meta: {
      title: "Báo cáo quảng cáo Meta",
      accountName: ctx.accountName || "",
      adAccountId: ctx.adAccountId || ins.adAccountId || "",
      campaignName: ctx.campaignName || "",
      campaignId: ctx.campaignId || ins.campaignId || "",
      datePresetLabel: ctx.datePresetLabel || ctx.datePreset || ins.datePreset || "",
      datePreset: ctx.datePreset || ins.datePreset || "",
      currency: ins.currency || demo.currency || "",
      capturedAt: ins.capturedAt || ""
    },
    overview: OVERVIEW_FIELDS.map((f) => ({ key: f.key, label: f.label, value: overview[f.key] })),
    daily: Array.isArray(ins.daily)
      ? ins.daily.map((d) => ({
          date: d.date,
          spend: d.spend,
          impressions: d.impressions,
          reach: d.reach,
          clicks: d.clicks
        }))
      : [],
    ageGender: normalizeDim(demo.ageGender, "segments"),
    country: normalizeDim(demo.country, "items"),
    region: normalizeDim(demo.region, "items")
  };
}

// --- Serialize -------------------------------------------------------------

// CSV nhiều "khối" (mỗi phần một tiêu đề + hàng cột), cách nhau 1 dòng trống — Excel/Sheets
// đọc được ngay. Trả CHUỖI (chưa có BOM); tầng tải sẽ thêm BOM để Excel hiện đúng tiếng Việt.
export function reportToCsv(model) {
  const lines = [];
  const push = (cells) => lines.push(csvRow(cells));

  push([model.meta.title]);
  push(["Tài khoản", model.meta.accountName || model.meta.adAccountId]);
  push(["Mã tài khoản QC", model.meta.adAccountId]);
  push(["Chiến dịch", model.meta.campaignName || model.meta.campaignId]);
  push(["Mã chiến dịch", model.meta.campaignId]);
  push(["Khoảng thời gian", model.meta.datePresetLabel]);
  push(["Tiền tệ", model.meta.currency]);
  push(["Thời điểm chụp", model.meta.capturedAt]);
  lines.push("");

  push(["[Tổng quan]"]);
  push(["Chỉ số", "Giá trị"]);
  for (const o of model.overview) {
    push([o.label, numCell(o.value)]);
  }
  lines.push("");

  push(["[Theo ngày]"]);
  push(["Ngày", "Chi tiêu", "Hiển thị", "Tiếp cận", "Lượt nhấp"]);
  for (const d of model.daily) {
    push([d.date, numCell(d.spend), numCell(d.impressions), numCell(d.reach), numCell(d.clicks)]);
  }
  lines.push("");

  push(["[Tuổi × giới tính]"]);
  if (model.ageGender.available) {
    push(["Nhóm tuổi", "Giới tính", "Hiển thị", "Tiếp cận", "Lượt nhấp", "Chi tiêu", "Tỷ trọng (%)"]);
    for (const s of model.ageGender.rows) {
      push([
        s.age,
        genderLabel(s.gender),
        numCell(s.impressions),
        numCell(s.reach),
        numCell(s.clicks),
        numCell(s.spend),
        numCell(s.share)
      ]);
    }
  } else {
    push(["Không khả dụng", model.ageGender.reason]);
  }
  lines.push("");

  for (const [dimKey, title, header] of [
    ["country", "[Top quốc gia]", "Quốc gia"],
    ["region", "[Top vùng/tỉnh]", "Vùng/tỉnh"]
  ]) {
    const dim = model[dimKey];
    push([title]);
    if (dim.available) {
      push([header, "Hiển thị", "Tiếp cận", "Lượt nhấp", "Chi tiêu", "Tỷ trọng (%)"]);
      for (const it of dim.rows) {
        push([
          it.value,
          numCell(it.impressions),
          numCell(it.reach),
          numCell(it.clicks),
          numCell(it.spend),
          numCell(it.share)
        ]);
      }
    } else {
      push(["Không khả dụng", dim.reason]);
    }
    lines.push("");
  }

  return lines.join("\r\n");
}

// JSON có cấu trúc: overview thành object map (tiện cho máy đọc), giữ nguyên demographics.
export function reportToJson(model) {
  const overviewObj = {};
  for (const o of model.overview) {
    overviewObj[o.key] = o.value === undefined ? null : o.value;
  }
  const payload = {
    meta: model.meta,
    overview: overviewObj,
    daily: model.daily,
    demographics: {
      ageGender: model.ageGender,
      country: model.country,
      region: model.region
    }
  };
  return JSON.stringify(payload, null, 2);
}

// --- Tên file ---------------------------------------------------------------

function slug(text) {
  return String(text)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Tên file tải xuống: bao-cao-qc_<campaign>_<preset>_<ngày>.<ext>. dateTag truyền vào để
// module này thuần (không gọi Date), tầng UI cấp ngày.
export function buildReportFilename(context, ext, dateTag) {
  const ctx = context || {};
  const parts = ["bao-cao-qc", ctx.campaignId || "chien-dich", ctx.datePreset || "", dateTag || ""];
  return `${slug(parts.filter(Boolean).join("_"))}.${ext}`;
}
