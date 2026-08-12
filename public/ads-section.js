// Tab "Quảng cáo" của trang Thống kê.
//
// Gọi /api/ads/* theo hợp đồng envelope:
//   GET /api/ads/accounts
//       -> { success, accounts:[{id, accountId, name, currency, status, timezone, business}] }
//   GET /api/ads/accounts/:adAccountId/campaigns
//       -> { success, campaigns:[{id, name, objective, status, effectiveStatus, ...}] }
//   GET /api/ads/campaigns/:campaignId/insights?adAccountId=act_...&datePreset=last_30d
//       -> { success, adsInsights:{ available, currency, overview:{...}, daily:[...], warnings:[], source, capturedAt } }
//   GET /api/ads/campaigns/:campaignId/demographics?adAccountId=act_...&datePreset=last_30d
//       -> { success, demographics:{ ageGender:{available, ages, genders, segments[{age,gender,impressions,reach,share}]},
//                                    country:{available, items[{value,impressions,reach,share}]},
//                                    region:{available, items[...]}, currency, warnings, source, capturedAt } }
//       Mỗi chiều nhân khẩu học best-effort: available:false + reason nếu thiếu quyền/không hỗ trợ.
//
// TỰ CHỨA vòng đời Chart.js: mỗi lần mount có mảng `charts` riêng và hàm
// destroyCharts() gọi TRƯỚC mỗi lần vẽ (và khi rời tab). Chart.js đã được nạp
// UMD (biến toàn cục `Chart`) trong statistics.html — module này tham chiếu
// trực tiếp như statistics.js. Không dùng innerHTML với dữ liệu API: mọi node
// dựng qua el() từ /shared/api.js.
//
// XUẤT BÁO CÁO: sau khi tải, người dùng có thể xuất CSV/JSON của đúng báo cáo đang xem
// (insights + nhân khẩu học) — logic serialize nằm ở module thuần /ads-export.js, phần này
// chỉ giữ state báo cáo cuối và kích hoạt tải file phía trình duyệt.

import { fetchJson, el } from "/shared/api.js";
import { buildReportModel, reportToCsv, reportToJson, buildReportFilename } from "/ads-export.js";

// --- Định dạng số (tiếng Việt) ---------------------------------------------

const intFormatter = new Intl.NumberFormat("vi-VN");

function fmtInt(value) {
  return intFormatter.format(Math.round(Number(value) || 0));
}

function fmtNum(value, digits = 2) {
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: digits }).format(Number(value) || 0);
}

function fmtPercent(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return `${fmtNum(value, digits)}%`;
}

// Tiền tệ theo mã ISO trả về từ API (VND, USD…). Mã lạ -> số thường + hậu tố.
function fmtMoney(value, currency) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "—";
  }
  if (currency) {
    try {
      return new Intl.NumberFormat("vi-VN", { style: "currency", currency, maximumFractionDigits: 2 }).format(num);
    } catch {
      return `${fmtNum(num, 2)} ${currency}`;
    }
  }
  return fmtNum(num, 2);
}

// Nhãn trục X: "dd/MM" từ chuỗi ngày "YYYY-MM-DD".
function fmtDateLabel(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit" }).format(d);
}

function fmtDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

// --- Khoảng thời gian (khớp datePreset hợp lệ của backend) ------------------

const DATE_PRESETS = [
  { value: "today", label: "Hôm nay" },
  { value: "yesterday", label: "Hôm qua" },
  { value: "last_7d", label: "7 ngày qua" },
  { value: "last_14d", label: "14 ngày qua" },
  { value: "last_28d", label: "28 ngày qua" },
  { value: "last_30d", label: "30 ngày qua" },
  { value: "last_90d", label: "90 ngày qua" },
  { value: "this_month", label: "Tháng này" },
  { value: "last_month", label: "Tháng trước" },
  { value: "maximum", label: "Tối đa" }
];
const DEFAULT_PRESET = "last_30d";

// Nhãn tiếng Việt cho trạng thái chiến dịch (effectiveStatus của Marketing API).
const STATUS_LABELS = {
  ACTIVE: "Đang chạy",
  PAUSED: "Tạm dừng",
  DELETED: "Đã xóa",
  ARCHIVED: "Lưu trữ",
  IN_PROCESS: "Đang xử lý",
  WITH_ISSUES: "Có vấn đề",
  CAMPAIGN_PAUSED: "Chiến dịch tạm dừng",
  ADSET_PAUSED: "Nhóm QC tạm dừng",
  DISAPPROVED: "Bị từ chối",
  PENDING_REVIEW: "Chờ duyệt",
  PREAPPROVED: "Duyệt sơ bộ",
  PENDING_BILLING_INFO: "Chờ thông tin thanh toán"
};

function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

const BRAND = "#1877f2";
const AMBER = "#f59e0b";

// Nhãn + màu giới tính (giá trị Graph: male/female/unknown).
const GENDER_LABELS = { female: "Nữ", male: "Nam", unknown: "Không rõ" };
const GENDER_COLORS = { female: "#ec4899", male: BRAND, unknown: "#94a3b8" };
// Bảng màu cho biểu đồ thanh xếp hạng (top quốc gia / vùng).
const BAR_PALETTE = [
  "#1877f2", "#f59e0b", "#10b981", "#8b5cf6", "#ec4899",
  "#06b6d4", "#f43f5e", "#84cc16", "#eab308", "#64748b"
];

// Tên quốc gia tiếng Việt từ mã ISO-3166 (VN, US…) qua Intl.DisplayNames (dựng 1 lần).
let regionDisplay = null;
try {
  regionDisplay = new Intl.DisplayNames(["vi"], { type: "region" });
} catch {
  regionDisplay = null;
}
function countryName(code) {
  if (!code || code === "unknown") return "Không rõ";
  if (regionDisplay) {
    try {
      const name = regionDisplay.of(code);
      if (name && name !== code) return `${name} (${code})`;
    } catch {
      /* mã lạ -> giữ nguyên code */
    }
  }
  return code;
}
function regionName(value) {
  return !value || value === "unknown" ? "Không rõ" : value;
}

// --- Builder DOM (cùng phong cách với statistics.js) -----------------------

function card(children, extraClass = "") {
  return el("div", { class: `rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${extraClass}` }, children);
}

function cardHeading(title, subtitle) {
  return el("div", { class: "mb-4" }, [
    el("h3", { class: "text-sm font-semibold text-slate-900", text: title }),
    subtitle ? el("p", { class: "mt-0.5 text-xs text-slate-500", text: subtitle }) : null
  ]);
}

function kpiTile(label, value, sub, tone = "text-slate-900") {
  return el("div", { class: "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" }, [
    el("p", { class: "text-xs text-slate-500", text: label }),
    el("p", { class: `mt-1 text-2xl font-bold ${tone}`, text: value }),
    sub ? el("p", { class: "mt-0.5 text-xs text-slate-400", text: sub }) : null
  ]);
}

function grid(cols, children) {
  return el("div", { class: `grid gap-4 ${cols}` }, children);
}

function selectClass() {
  return "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 focus:border-brand-500 focus:outline-none";
}

function labeledField(label, control) {
  return el("label", { class: "flex flex-col gap-1 text-xs font-medium text-slate-500" }, [
    el("span", { text: label }),
    control
  ]);
}

function emptyNote(text) {
  return el("div", { class: "flex h-72 items-center justify-center text-sm text-slate-400", text });
}

// --- Điểm vào: dựng toàn bộ tab Quảng cáo vào rootEl -----------------------

export function mountAdsSection(rootEl) {
  // --- Vòng đời Chart.js (tự chứa cho lần mount này) ---
  let charts = [];
  function destroyCharts() {
    for (const chart of charts) {
      chart.destroy();
    }
    charts = [];
  }
  function registerChart(chart) {
    charts.push(chart);
    return chart;
  }

  // --- Controls ---
  const accountSelect = el(
    "select",
    { class: selectClass(), attrs: { id: "ads-account-select", "aria-label": "Chọn tài khoản quảng cáo" } },
    [el("option", { text: "Đang tải tài khoản…", attrs: { value: "" } })]
  );
  const campaignSelect = el(
    "select",
    { class: selectClass(), attrs: { id: "ads-campaign-select", "aria-label": "Chọn chiến dịch" } },
    [el("option", { text: "—", attrs: { value: "" } })]
  );
  const datePresetSelect = el(
    "select",
    { class: selectClass(), attrs: { id: "ads-datepreset-select", "aria-label": "Khoảng thời gian" } },
    DATE_PRESETS.map((p) => el("option", { text: p.label, attrs: { value: p.value } }))
  );
  datePresetSelect.value = DEFAULT_PRESET;

  const loadBtn = el("button", {
    class: "rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50",
    text: "Tải",
    attrs: { type: "button" }
  });

  const controls = card([
    cardHeading("Báo cáo quảng cáo Meta", "Chọn tài khoản, chiến dịch và khoảng thời gian rồi bấm Tải."),
    el("div", { class: "flex flex-wrap items-end gap-3" }, [
      labeledField("Tài khoản", accountSelect),
      labeledField("Chiến dịch", campaignSelect),
      labeledField("Khoảng thời gian", datePresetSelect),
      loadBtn
    ])
  ]);

  const statusEl = el("p", { class: "text-sm text-slate-500", attrs: { "aria-live": "polite" } });
  // Thanh nút xuất báo cáo — trống cho tới khi có báo cáo khả dụng để xuất.
  const exportBar = el("div", { class: "flex flex-wrap items-center gap-2" });
  const warningsEl = el("div", { class: "space-y-2" });
  const reportEl = el("div", { class: "space-y-6", attrs: { id: "ads-report" } });

  rootEl.replaceChildren(controls, statusEl, exportBar, warningsEl, reportEl);

  // --- State ---
  let accounts = [];
  // Báo cáo đang xem (để xuất file). Đặt lại mỗi lần Tải; demographics tải sau nên cập nhật riêng.
  let lastInsights = null;
  let lastDemographics = null;
  let lastContext = null;

  // --- Tải danh sách tài khoản quảng cáo ---
  async function loadAccounts() {
    statusEl.textContent = "Đang tải danh sách tài khoản quảng cáo…";
    try {
      const data = await fetchJson("/api/ads/accounts");
      accounts = (data && data.accounts) || [];
      accountSelect.replaceChildren();

      if (accounts.length === 0) {
        accountSelect.append(el("option", { text: "Không có tài khoản quảng cáo", attrs: { value: "" } }));
        campaignSelect.replaceChildren(el("option", { text: "—", attrs: { value: "" } }));
        statusEl.textContent =
          "Tài khoản Facebook đang đăng nhập không có tài khoản quảng cáo nào (hoặc thiếu quyền ads_read).";
        loadBtn.disabled = true;
        return;
      }

      for (const acc of accounts) {
        const bits = [acc.name || acc.accountId || acc.id];
        if (acc.currency) bits.push(acc.currency);
        accountSelect.append(el("option", { text: bits.join(" · "), attrs: { value: acc.id } }));
      }
      statusEl.textContent = "";
      await loadCampaigns(accountSelect.value);
    } catch (error) {
      statusEl.textContent = `Không tải được tài khoản quảng cáo: ${error.message}`;
      loadBtn.disabled = true;
    }
  }

  // --- Tải chiến dịch của 1 tài khoản ---
  async function loadCampaigns(adAccountId) {
    if (!adAccountId) return;
    campaignSelect.replaceChildren(el("option", { text: "Đang tải chiến dịch…", attrs: { value: "" } }));
    loadBtn.disabled = true;
    try {
      const data = await fetchJson(`/api/ads/accounts/${encodeURIComponent(adAccountId)}/campaigns`);
      const campaigns = (data && data.campaigns) || [];
      campaignSelect.replaceChildren();

      if (campaigns.length === 0) {
        campaignSelect.append(el("option", { text: "Không có chiến dịch", attrs: { value: "" } }));
        loadBtn.disabled = true;
        return;
      }

      for (const c of campaigns) {
        const status = c.effectiveStatus || c.status;
        const suffix = status && status !== "ACTIVE" ? ` · ${statusLabel(status)}` : "";
        campaignSelect.append(el("option", { text: `${c.name || c.id}${suffix}`, attrs: { value: c.id } }));
      }
      loadBtn.disabled = false;
    } catch (error) {
      campaignSelect.replaceChildren(el("option", { text: "Lỗi tải chiến dịch", attrs: { value: "" } }));
      statusEl.textContent = `Không tải được chiến dịch: ${error.message}`;
      loadBtn.disabled = true;
    }
  }

  // --- Tải số liệu insights của chiến dịch đang chọn ---
  async function loadInsights() {
    const adAccountId = accountSelect.value;
    const campaignId = campaignSelect.value;
    if (!adAccountId || !campaignId) {
      statusEl.textContent = "Hãy chọn tài khoản và chiến dịch trước khi tải.";
      return;
    }
    const datePreset = datePresetSelect.value || DEFAULT_PRESET;

    destroyCharts();
    reportEl.replaceChildren();
    warningsEl.replaceChildren();
    exportBar.replaceChildren();
    lastInsights = null;
    lastDemographics = null;
    lastContext = null;
    loadBtn.disabled = true;
    statusEl.textContent = "Đang tải số liệu quảng cáo…";

    try {
      const url =
        `/api/ads/campaigns/${encodeURIComponent(campaignId)}/insights` +
        `?adAccountId=${encodeURIComponent(adAccountId)}&datePreset=${encodeURIComponent(datePreset)}`;
      const data = await fetchJson(url);
      lastInsights = data.adsInsights || null;
      lastContext = currentContext();
      renderInsights(data.adsInsights);
      // Nhân khẩu học chỉ có nghĩa khi insights khả dụng (cùng điều kiện quyền).
      if (data.adsInsights && data.adsInsights.available) {
        buildExportButtons();
        await loadDemographics(campaignId, adAccountId, datePreset);
      }
    } catch (error) {
      statusEl.textContent = `Lỗi: ${error.message}`;
    } finally {
      loadBtn.disabled = false;
    }
  }

  // --- Cảnh báo (cùng kiểu trang thống kê) ---
  // Thêm 1 cảnh báo, chống trùng chính xác (insights + nhân khẩu học có thể sinh cùng câu).
  function appendWarning(text) {
    const already = Array.from(warningsEl.querySelectorAll("span")).some(
      (node) => node.textContent === `⚠️ ${text}`
    );
    if (already) return;
    warningsEl.append(
      el("div", { class: "rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800" }, [
        el("span", { text: `⚠️ ${text}` })
      ])
    );
  }

  function renderWarnings(warnings) {
    warningsEl.replaceChildren();
    for (const warning of warnings || []) {
      appendWarning(warning);
    }
  }

  // --- Render KPI + biểu đồ từ adsInsights ---
  function renderInsights(insights) {
    if (!insights) {
      statusEl.textContent = "Máy chủ không trả về dữ liệu quảng cáo.";
      return;
    }

    renderWarnings(insights.warnings);

    const sourceLabel = insights.source === "cache" ? "bộ nhớ đệm" : "Graph API";
    const captured = insights.capturedAt ? ` · lúc ${fmtDateTime(insights.capturedAt)}` : "";
    statusEl.textContent = `Nguồn: ${sourceLabel}${captured}.`;

    if (!insights.available) {
      reportEl.replaceChildren(
        card([
          cardHeading("Chưa có số liệu", "Chiến dịch / khoảng thời gian này chưa có dữ liệu quảng cáo."),
          el("p", {
            class: "text-sm text-slate-500",
            text: "Thử đổi khoảng thời gian hoặc chọn chiến dịch khác."
          })
        ])
      );
      return;
    }

    const overview = insights.overview || {};
    const currency = insights.currency || null;

    // KPI tiles: 9 chỉ số theo lưới 3 cột.
    reportEl.append(
      grid("grid-cols-2 lg:grid-cols-3", [
        kpiTile("Chi tiêu", fmtMoney(overview.spend, currency), "tổng kỳ", "text-brand-600"),
        kpiTile("Hiển thị", fmtInt(overview.impressions), "lượt hiển thị"),
        kpiTile("Tiếp cận", fmtInt(overview.reach), "người tiếp cận"),
        kpiTile("Lượt nhấp", fmtInt(overview.clicks), "clicks"),
        kpiTile("CTR", fmtPercent(overview.ctr), "tỷ lệ nhấp"),
        kpiTile("CPC", fmtMoney(overview.cpc, currency), "chi phí / nhấp"),
        kpiTile("CPM", fmtMoney(overview.cpm, currency), "chi phí / 1.000 hiển thị"),
        kpiTile("Kết quả", fmtInt(overview.results), "theo mục tiêu chiến dịch"),
        kpiTile("Chi phí / kết quả", fmtMoney(overview.costPerResult, currency), "cost per result", "text-emerald-600")
      ])
    );

    // Tần suất (nếu có) — hiển thị/người.
    if (overview.frequency !== undefined && overview.frequency !== null && overview.frequency !== "") {
      reportEl.append(
        grid("grid-cols-2 lg:grid-cols-3", [
          kpiTile("Tần suất", fmtNum(overview.frequency, 2), "lần hiển thị / người")
        ])
      );
    }

    // Biểu đồ đường theo ngày: chi tiêu (trục trái) vs hiển thị (trục phải).
    const daily = Array.isArray(insights.daily) ? insights.daily : [];
    const canvas = el("canvas", { attrs: { role: "img", "aria-label": "Chi tiêu và hiển thị theo ngày" } });
    reportEl.append(
      card([
        cardHeading(
          "Chi tiêu & hiển thị theo ngày",
          "Đường xanh: chi tiêu (trục trái) · Đường cam: hiển thị (trục phải)"
        ),
        el("div", { class: "relative h-72" }, [canvas])
      ])
    );

    if (daily.length === 0) {
      canvas.replaceWith(emptyNote("Không có dữ liệu theo ngày cho khoảng thời gian này."));
    } else {
      drawDailyChart(canvas, daily, currency);
    }
  }

  // Đường đôi 2 trục: spend (trái) vs impressions (phải).
  function drawDailyChart(canvas, daily, currency) {
    registerChart(
      new Chart(canvas, {
        data: {
          labels: daily.map((d) => fmtDateLabel(d.date)),
          datasets: [
            {
              type: "line",
              label: "Chi tiêu",
              data: daily.map((d) => Number(d.spend) || 0),
              borderColor: BRAND,
              backgroundColor: `${BRAND}22`,
              fill: true,
              tension: 0.3,
              pointRadius: 2,
              yAxisID: "y"
            },
            {
              type: "line",
              label: "Hiển thị",
              data: daily.map((d) => Number(d.impressions) || 0),
              borderColor: AMBER,
              backgroundColor: `${AMBER}22`,
              fill: false,
              tension: 0.3,
              pointRadius: 2,
              yAxisID: "y1"
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: "index" },
          plugins: {
            legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const v = ctx.parsed.y;
                  return ctx.dataset.label === "Chi tiêu"
                    ? `Chi tiêu: ${fmtMoney(v, currency)}`
                    : `Hiển thị: ${fmtInt(v)}`;
                }
              }
            }
          },
          scales: {
            y: { type: "linear", position: "left", beginAtZero: true, title: { display: true, text: "Chi tiêu" } },
            y1: {
              type: "linear",
              position: "right",
              beginAtZero: true,
              grid: { drawOnChartArea: false },
              ticks: { precision: 0 },
              title: { display: true, text: "Hiển thị" }
            }
          }
        }
      })
    );
  }

  // --- Nhân khẩu học người xem quảng cáo (Pha 2) ---

  async function loadDemographics(campaignId, adAccountId, datePreset) {
    try {
      const url =
        `/api/ads/campaigns/${encodeURIComponent(campaignId)}/demographics` +
        `?adAccountId=${encodeURIComponent(adAccountId)}&datePreset=${encodeURIComponent(datePreset)}`;
      const data = await fetchJson(url);
      renderDemographics(data.demographics);
    } catch (error) {
      // Nhân khẩu học là phần phụ: lỗi -> ghi chú mềm, KHÔNG xoá phần insights đã render.
      reportEl.append(
        card([
          cardHeading("Nhân khẩu học người xem quảng cáo", "Không tải được nhân khẩu học."),
          el("p", { class: "text-sm text-slate-500", text: `Lỗi: ${error.message}` })
        ])
      );
    }
  }

  function renderDemographics(demo) {
    if (!demo) return;
    // Lưu để nút Xuất gộp cả nhân khẩu học vào báo cáo (nút đọc state này lúc bấm).
    lastDemographics = demo;
    for (const warning of demo.warnings || []) {
      appendWarning(warning);
    }

    reportEl.append(
      el("h3", {
        class: "pt-2 text-base font-semibold text-slate-900",
        text: "Nhân khẩu học người xem quảng cáo"
      })
    );

    renderAgeGenderCard(demo.ageGender);
    renderCategoricalCard(demo.country, {
      title: "Top quốc gia",
      subtitle: "Số lượt hiển thị theo quốc gia (tối đa 10).",
      labeler: countryName
    });
    renderCategoricalCard(demo.region, {
      title: "Top vùng / tỉnh",
      subtitle: "Số lượt hiển thị theo vùng/tỉnh (tối đa 10).",
      labeler: regionName
    });
  }

  function renderAgeGenderCard(ageGender) {
    const heading = cardHeading("Tuổi × giới tính", "Lượt hiển thị theo nhóm tuổi, tách theo giới tính.");
    if (!ageGender || !ageGender.available) {
      reportEl.append(
        card([
          heading,
          el("p", { class: "text-sm text-slate-500", text: (ageGender && ageGender.reason) || "Không có dữ liệu." })
        ])
      );
      return;
    }
    const ages = ageGender.ages || [];
    if (ages.length === 0) {
      reportEl.append(card([heading, emptyNote("Không có dữ liệu tuổi/giới tính.")]));
      return;
    }
    const canvas = el("canvas", { attrs: { role: "img", "aria-label": "Phân bố tuổi và giới tính" } });
    reportEl.append(card([heading, el("div", { class: "relative h-80" }, [canvas])]));
    drawAgeGenderChart(canvas, ageGender);
  }

  function renderCategoricalCard(dimension, opts) {
    const heading = cardHeading(opts.title, opts.subtitle);
    if (!dimension || !dimension.available) {
      reportEl.append(
        card([
          heading,
          el("p", { class: "text-sm text-slate-500", text: (dimension && dimension.reason) || "Không có dữ liệu." })
        ])
      );
      return;
    }
    const items = dimension.items || [];
    if (items.length === 0) {
      reportEl.append(card([heading, emptyNote("Không có dữ liệu.")]));
      return;
    }
    const canvas = el("canvas", { attrs: { role: "img", "aria-label": opts.title } });
    const heightClass = items.length > 6 ? "h-96" : "h-72";
    reportEl.append(card([heading, el("div", { class: `relative ${heightClass}` }, [canvas])]));
    drawCategoricalChart(canvas, items, opts.labeler);
  }

  // Cột nhóm (grouped) tuổi × giới tính: mỗi giới tính là 1 dataset, trục X là nhóm tuổi.
  function drawAgeGenderChart(canvas, ageGender) {
    const ages = ageGender.ages || [];
    const genders = ageGender.genders || [];
    const segIndex = new Map();
    for (const seg of ageGender.segments || []) {
      segIndex.set(`${seg.age}|${seg.gender}`, seg);
    }
    const datasets = genders.map((gender) => ({
      label: GENDER_LABELS[gender] || gender,
      data: ages.map((age) => {
        const seg = segIndex.get(`${age}|${gender}`);
        return seg ? seg.impressions : 0;
      }),
      backgroundColor: GENDER_COLORS[gender] || "#64748b",
      borderRadius: 4
    }));

    registerChart(
      new Chart(canvas, {
        type: "bar",
        data: { labels: ages, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: "index" },
          plugins: {
            legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const age = ages[ctx.dataIndex];
                  const gender = genders[ctx.datasetIndex];
                  const seg = segIndex.get(`${age}|${gender}`);
                  const share = seg ? seg.share : 0;
                  return `${ctx.dataset.label}: ${fmtInt(ctx.parsed.y)} (${fmtPercent(share)})`;
                }
              }
            }
          },
          scales: {
            x: { title: { display: true, text: "Nhóm tuổi" } },
            y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: "Hiển thị" } }
          }
        }
      })
    );
  }

  // Thanh ngang xếp hạng (top quốc gia / vùng) theo lượt hiển thị.
  function drawCategoricalChart(canvas, items, labeler) {
    registerChart(
      new Chart(canvas, {
        type: "bar",
        data: {
          labels: items.map((it) => labeler(it.value)),
          datasets: [
            {
              label: "Hiển thị",
              data: items.map((it) => it.impressions),
              backgroundColor: items.map((_, i) => BAR_PALETTE[i % BAR_PALETTE.length]),
              borderRadius: 4
            }
          ]
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const it = items[ctx.dataIndex];
                  return `${fmtInt(it.impressions)} hiển thị (${fmtPercent(it.share)}) · ${fmtInt(it.reach)} tiếp cận`;
                }
              }
            }
          },
          scales: {
            x: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: "Hiển thị" } },
            y: { ticks: { autoSkip: false, font: { size: 11 } } }
          }
        }
      })
    );
  }

  // --- Xuất báo cáo (CSV / JSON) ---

  // Ngữ cảnh chọn hiện tại (tên hiển thị + mã) để nhúng vào file & đặt tên file.
  function currentContext() {
    const accOpt = accountSelect.options[accountSelect.selectedIndex];
    const campOpt = campaignSelect.options[campaignSelect.selectedIndex];
    const presetOpt = datePresetSelect.options[datePresetSelect.selectedIndex];
    return {
      adAccountId: accountSelect.value,
      accountName: accOpt ? accOpt.textContent : "",
      campaignId: campaignSelect.value,
      campaignName: campOpt ? campOpt.textContent : "",
      datePreset: datePresetSelect.value,
      datePresetLabel: presetOpt ? presetOpt.textContent : datePresetSelect.value
    };
  }

  // Tải chuỗi văn bản xuống dạng file. CSV thêm BOM để Excel đọc đúng tiếng Việt.
  function downloadText(filename, mimeType, text, withBom) {
    const content = withBom ? `﻿${text}` : text;
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Thu hồi URL tạm sau khi trình duyệt đã bắt đầu tải.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function doExport(kind) {
    if (!lastInsights || !lastInsights.available) {
      return;
    }
    const model = buildReportModel({
      insights: lastInsights,
      demographics: lastDemographics,
      context: lastContext
    });
    const dateTag = new Date().toISOString().slice(0, 10);
    if (kind === "csv") {
      downloadText(
        buildReportFilename(lastContext, "csv", dateTag),
        "text/csv;charset=utf-8",
        reportToCsv(model),
        true
      );
    } else {
      downloadText(
        buildReportFilename(lastContext, "json", dateTag),
        "application/json;charset=utf-8",
        reportToJson(model),
        false
      );
    }
  }

  function exportBtn(label, title, onClick) {
    const btn = el("button", {
      class:
        "rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50",
      text: label,
      attrs: { type: "button", title }
    });
    btn.addEventListener("click", onClick);
    return btn;
  }

  function buildExportButtons() {
    exportBar.replaceChildren(
      el("span", { class: "text-xs font-medium text-slate-500", text: "Xuất báo cáo:" }),
      exportBtn("Xuất CSV", "Mở trực tiếp bằng Excel / Google Sheets", () => doExport("csv")),
      exportBtn("Xuất JSON", "Dữ liệu thô có cấu trúc", () => doExport("json"))
    );
  }

  // --- Wire events ---
  accountSelect.addEventListener("change", () => loadCampaigns(accountSelect.value));
  loadBtn.addEventListener("click", () => loadInsights());

  loadAccounts();

  // Controller cho statistics.js: hủy chart + dọn DOM khi rời tab.
  return {
    destroy() {
      destroyCharts();
      rootEl.replaceChildren();
    }
  };
}
