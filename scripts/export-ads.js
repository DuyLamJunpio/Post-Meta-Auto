require("dotenv").config();

const fs = require("fs");
const path = require("path");

const facebookService = require("../src/services/facebook.service");
const adsInsightsService = require("../src/services/ads-insights.service");

// XUẤT BÁO CÁO QUẢNG CÁO RA FILE — chạy bằng 1 USER token (ads_read), KHÔNG cần
// web/session/Postgres. Dùng ĐÚNG lớp service mà web dùng (buildCampaignInsights +
// buildCampaignDemographics) nên đây cũng là phép thử LIVE thật của Pha 1+2.
//
// Cách dùng (PowerShell):
//   node scripts/export-ads.js --token=<USER_TOKEN> --account=act_830926689974584 --campaign=120248059016220650
//   node scripts/export-ads.js --token=<...> --account=act_... --campaign=... --preset=last_90d --out=./exports
// Token: Graph API Explorer (chọn app, thêm quyền ads_read, Generate) hoặc lấy từ phiên đăng nhập.
//
// Kết quả: ghi 2 file CSV + JSON vào thư mục --out (mặc định ./exports) và in tóm tắt.
// Ghi chú serialize: đây là bản CommonJS song sinh của public/ads-export.js (bản trình duyệt
// dùng ESM nên không require được). Giữ 2 bên đồng bộ khi đổi cấu trúc báo cáo.

function parseArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

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

const GENDER_LABELS = { female: "Nữ", male: "Nam", unknown: "Không rõ" };

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(cells) {
  return cells.map(csvCell).join(",");
}
function numCell(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000);
}

function normalizeDim(dim, arrayKey) {
  if (!dim) return { available: false, reason: "Không có dữ liệu.", rows: [] };
  return {
    available: Boolean(dim.available),
    reason: dim.reason || "",
    rows: Array.isArray(dim[arrayKey]) ? dim[arrayKey] : []
  };
}

function buildReportModel({ insights, demographics, meta }) {
  const ins = insights || {};
  const demo = demographics || {};
  const overview = ins.overview || {};
  return {
    meta: {
      title: "Báo cáo quảng cáo Meta",
      adAccountId: ins.adAccountId || meta.adAccountId || "",
      campaignId: ins.campaignId || meta.campaignId || "",
      datePresetLabel: ins.datePreset || meta.datePreset || "",
      currency: ins.currency || demo.currency || "",
      capturedAt: ins.capturedAt || ""
    },
    overview: OVERVIEW_FIELDS.map((f) => ({ key: f.key, label: f.label, value: overview[f.key] })),
    daily: Array.isArray(ins.daily)
      ? ins.daily.map((d) => ({ date: d.date, spend: d.spend, impressions: d.impressions, reach: d.reach, clicks: d.clicks }))
      : [],
    ageGender: normalizeDim(demo.ageGender, "segments"),
    country: normalizeDim(demo.country, "items"),
    region: normalizeDim(demo.region, "items")
  };
}

function reportToCsv(model) {
  const lines = [];
  const push = (cells) => lines.push(csvRow(cells));

  push([model.meta.title]);
  push(["Mã tài khoản QC", model.meta.adAccountId]);
  push(["Mã chiến dịch", model.meta.campaignId]);
  push(["Khoảng thời gian", model.meta.datePresetLabel]);
  push(["Tiền tệ", model.meta.currency]);
  push(["Thời điểm chụp", model.meta.capturedAt]);
  lines.push("");

  push(["[Tổng quan]"]);
  push(["Chỉ số", "Giá trị"]);
  for (const o of model.overview) push([o.label, numCell(o.value)]);
  lines.push("");

  push(["[Theo ngày]"]);
  push(["Ngày", "Chi tiêu", "Hiển thị", "Tiếp cận", "Lượt nhấp"]);
  for (const d of model.daily) push([d.date, numCell(d.spend), numCell(d.impressions), numCell(d.reach), numCell(d.clicks)]);
  lines.push("");

  push(["[Tuổi × giới tính]"]);
  if (model.ageGender.available) {
    push(["Nhóm tuổi", "Giới tính", "Hiển thị", "Tiếp cận", "Lượt nhấp", "Chi tiêu", "Tỷ trọng (%)"]);
    for (const s of model.ageGender.rows) {
      push([s.age, GENDER_LABELS[s.gender] || s.gender, numCell(s.impressions), numCell(s.reach), numCell(s.clicks), numCell(s.spend), numCell(s.share)]);
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
        push([it.value, numCell(it.impressions), numCell(it.reach), numCell(it.clicks), numCell(it.spend), numCell(it.share)]);
      }
    } else {
      push(["Không khả dụng", dim.reason]);
    }
    lines.push("");
  }

  return lines.join("\r\n");
}

function reportToJson(model) {
  const overviewObj = {};
  for (const o of model.overview) overviewObj[o.key] = o.value === undefined ? null : o.value;
  return JSON.stringify(
    {
      meta: model.meta,
      overview: overviewObj,
      daily: model.daily,
      demographics: { ageGender: model.ageGender, country: model.country, region: model.region }
    },
    null,
    2
  );
}

function slug(text) {
  return String(text).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

async function main() {
  const userAccessToken = parseArg("token") || process.env.FB_USER_TOKEN || "";
  const adAccountId = parseArg("account");
  const campaignId = parseArg("campaign");
  const datePreset = parseArg("preset") || "last_30d";
  const outDir = parseArg("out") || path.join(process.cwd(), "exports");

  if (!userAccessToken || !adAccountId || !campaignId) {
    console.error("Thiếu tham số. Cần: --token=<...> --account=act_... --campaign=...");
    console.error("Ví dụ: node scripts/export-ads.js --token=EAAB... --account=act_830926689974584 --campaign=120248059016220650");
    process.exit(1);
  }

  // Cảnh báo sớm nếu token chưa có ads_read (vẫn chạy tiếp để lấy lý do lỗi cụ thể).
  try {
    const granted = await facebookService.getGrantedPermissions(userAccessToken);
    if (!granted.includes("ads_read")) {
      console.warn("⚠️  Token CHƯA có quyền ads_read — nhiều khả năng sẽ không lấy được số liệu. Hãy cấp ads_read rồi thử lại.\n");
    }
  } catch {
    /* bỏ qua: chỉ là kiểm tra phụ */
  }

  console.log(`Đang kéo số liệu: chiến dịch ${campaignId} · tài khoản ${adAccountId} · khoảng ${datePreset}…\n`);

  const insights = await adsInsightsService.buildCampaignInsights({
    campaignId,
    adAccountId,
    userAccessToken,
    datePreset
  });

  if (!insights.available) {
    console.error("Không có số liệu insights (không đủ quyền/không có dữ liệu):");
    for (const w of insights.warnings || []) console.error("  - " + w);
    process.exit(1);
  }

  // Nhân khẩu học: best-effort — lỗi ở đây KHÔNG chặn xuất phần insights.
  let demographics = null;
  try {
    demographics = await adsInsightsService.buildCampaignDemographics({
      campaignId,
      adAccountId,
      userAccessToken,
      datePreset
    });
  } catch (error) {
    console.warn("⚠️  Không lấy được nhân khẩu học:", error.publicMessage || error.message);
  }

  const model = buildReportModel({
    insights,
    demographics,
    meta: { adAccountId, campaignId, datePreset }
  });

  const dateTag = new Date().toISOString().slice(0, 10);
  const base = slug(`bao-cao-qc_${campaignId}_${datePreset}_${dateTag}`);
  fs.mkdirSync(outDir, { recursive: true });
  const csvPath = path.join(outDir, `${base}.csv`);
  const jsonPath = path.join(outDir, `${base}.json`);

  // BOM (﻿) để Excel đọc đúng tiếng Việt.
  fs.writeFileSync(csvPath, "﻿" + reportToCsv(model), "utf8");
  fs.writeFileSync(jsonPath, reportToJson(model), "utf8");

  // Tóm tắt ra màn hình.
  const ov = insights.overview || {};
  console.log("== Tổng quan ==");
  console.log(`  Chi tiêu: ${ov.spend}  ${insights.currency || ""}`);
  console.log(`  Hiển thị: ${ov.impressions} · Tiếp cận: ${ov.reach} · Nhấp: ${ov.clicks}`);
  console.log(`  Kết quả: ${ov.results} · Chi phí/kết quả: ${ov.costPerResult}`);
  console.log(`  Số ngày trong chuỗi: ${(insights.daily || []).length}`);
  if (demographics) {
    const ag = demographics.ageGender;
    const co = demographics.country;
    console.log("== Nhân khẩu học ==");
    console.log(`  Tuổi×giới: ${ag && ag.available ? (ag.segments || []).length + " phân khúc" : "không khả dụng"}`);
    console.log(`  Quốc gia: ${co && co.available ? (co.items || []).length + " mục" : "không khả dụng"}`);
  }
  for (const w of [...(insights.warnings || []), ...((demographics && demographics.warnings) || [])]) {
    console.log("  ⚠️  " + w);
  }

  console.log("\n✅ Đã ghi file:");
  console.log("  " + csvPath);
  console.log("  " + jsonPath);
}

main().catch((error) => {
  console.error("\nLỗi khi xuất báo cáo quảng cáo:");
  console.error(error.publicMessage || error.message);
  if (error.details) console.error("Chi tiết:", JSON.stringify(error.details));
  process.exit(1);
});
