// Tab "Quảng cáo" của trang Thống kê — TRỤC PAGE.
//
// Cấu trúc hiển thị: mỗi Page (bạn quản lý) → các chiến dịch quảng bá Page đó (kèm huy
// hiệu trạng thái Đang chạy / Tạm dừng / Đã dừng) → bấm 1 chiến dịch để xem KẾT QUẢ +
// NHÂN KHẨU HỌC (tải lười, chỉ gọi khi mở). Vì Marketing API không gắn chiến dịch vào
// Page, backend suy Page từ creative của ads (xem ads-pages.service + getAdsPageMap).
//
// Hợp đồng envelope:
//   GET /api/ads/pages-tree
//     -> { success, tree:{ groups:[{ pageId, pageName, managed, campaigns:[{id,name,runState,
//          effectiveStatus,adAccountId,adAccountName}], counts:{active,paused,stopped} }],
//          totalCampaigns, accountCount, warnings, capturedAt } }
//   GET /api/ads/campaigns/:id/insights?adAccountId=act_...&datePreset=...
//     -> { success, adsInsights:{ available, currency, overview, daily, warnings, capturedAt } }
//   GET /api/ads/campaigns/:id/demographics?adAccountId=act_...&datePreset=...
//     -> { success, demographics:{ ageGender, country, region, warnings, ... } }
//
// TỰ CHỨA vòng đời Chart.js: mảng `charts` + destroyCharts() gọi trước mỗi lần vẽ và khi
// rời tab. CHỈ mở 1 chiến dịch chi tiết tại một thời điểm để đơn giản vòng đời chart.
// Không dùng innerHTML với dữ liệu API: mọi node dựng qua el() từ /shared/api.js.
//
// XUẤT BÁO CÁO: mỗi chiến dịch đang mở có nút Xuất CSV/JSON — serialize ở module thuần
// /ads-export.js, phần này chỉ kích hoạt tải file phía trình duyệt.

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

function presetLabel(value) {
  const found = DATE_PRESETS.find((p) => p.value === value);
  return found ? found.label : value;
}

// --- Trạng thái chạy (3 nhóm thô, khớp ads-math.classifyRunState) -----------

const RUN_STATE = {
  active: { label: "Đang chạy", dot: "🟢", badge: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  paused: { label: "Tạm dừng", dot: "⏸️", badge: "border-amber-200 bg-amber-50 text-amber-700" },
  stopped: { label: "Đã dừng", dot: "⏹️", badge: "border-slate-200 bg-slate-100 text-slate-600" }
};

const STATUS_FILTERS = [
  { value: "all", label: "Tất cả trạng thái" },
  { value: "active", label: "Đang chạy" },
  { value: "paused", label: "Tạm dừng" },
  { value: "stopped", label: "Đã dừng" }
];

const BRAND = "#1877f2";
const AMBER = "#f59e0b";

const GENDER_LABELS = { female: "Nữ", male: "Nam", unknown: "Không rõ" };
const GENDER_COLORS = { female: "#ec4899", male: BRAND, unknown: "#94a3b8" };
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

// Huy hiệu trạng thái chiến dịch.
function statusBadge(runState) {
  const info = RUN_STATE[runState] || RUN_STATE.stopped;
  return el("span", {
    class: `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${info.badge}`,
    text: `${info.dot} ${info.label}`
  });
}

// Chip đếm nhỏ (dùng ở tiêu đề Page): dot + số.
function countChip(runState, count) {
  const info = RUN_STATE[runState];
  return el(
    "span",
    { class: "inline-flex items-center gap-1 text-xs text-slate-500", attrs: { title: info.label } },
    [el("span", { text: info.dot }), el("span", { class: "font-medium", text: String(count) })]
  );
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
  const datePresetSelect = el(
    "select",
    { class: selectClass(), attrs: { id: "ads-datepreset-select", "aria-label": "Khoảng thời gian" } },
    DATE_PRESETS.map((p) => el("option", { text: p.label, attrs: { value: p.value } }))
  );
  datePresetSelect.value = DEFAULT_PRESET;

  const statusFilter = el(
    "select",
    { class: selectClass(), attrs: { id: "ads-status-filter", "aria-label": "Lọc trạng thái" } },
    STATUS_FILTERS.map((o) => el("option", { text: o.label, attrs: { value: o.value } }))
  );

  const refreshBtn = el("button", {
    class: "rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50",
    text: "Làm mới",
    attrs: { type: "button" }
  });

  const controls = card([
    cardHeading(
      "Báo cáo quảng cáo theo Page",
      "Mỗi Page → các chiến dịch (kèm trạng thái). Bấm một chiến dịch để xem kết quả & nhân khẩu học."
    ),
    el("div", { class: "flex flex-wrap items-end gap-3" }, [
      labeledField("Khoảng thời gian", datePresetSelect),
      labeledField("Lọc trạng thái", statusFilter),
      refreshBtn
    ])
  ]);

  const statusEl = el("p", { class: "text-sm text-slate-500", attrs: { "aria-live": "polite" } });
  const warningsEl = el("div", { class: "space-y-2" });
  const treeEl = el("div", { class: "space-y-3", attrs: { id: "ads-page-tree" } });

  rootEl.replaceChildren(controls, statusEl, warningsEl, treeEl);

  // --- State ---
  let currentTree = null;
  // Chi tiết chiến dịch đang mở (chỉ 1 tại một thời điểm).
  let openDetailEl = null;
  let openToggleBtn = null;
  let openChevron = null;
  let openState = null; // { insights, demographics, context }

  // --- Cảnh báo (dedupe theo container) ---
  function appendWarning(container, text) {
    const already = Array.from(container.querySelectorAll("span")).some(
      (node) => node.textContent === `⚠️ ${text}`
    );
    if (already) return;
    container.append(
      el("div", { class: "rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800" }, [
        el("span", { text: `⚠️ ${text}` })
      ])
    );
  }

  // --- Tải cây Page → chiến dịch ---
  async function loadTree() {
    closeOpenDetail();
    destroyCharts();
    treeEl.replaceChildren();
    warningsEl.replaceChildren();
    statusEl.textContent = "Đang tải danh sách Page & chiến dịch…";
    refreshBtn.disabled = true;
    try {
      const data = await fetchJson("/api/ads/pages-tree");
      currentTree = (data && data.tree) || null;
      renderTree(currentTree);
    } catch (error) {
      statusEl.textContent = `Không tải được danh sách: ${error.message}`;
    } finally {
      refreshBtn.disabled = false;
    }
  }

  function renderTree(tree) {
    warningsEl.replaceChildren();
    treeEl.replaceChildren();
    if (!tree) {
      statusEl.textContent = "Máy chủ không trả về dữ liệu.";
      return;
    }
    for (const warning of tree.warnings || []) {
      appendWarning(warningsEl, warning);
    }

    const groups = tree.groups || [];
    statusEl.textContent =
      `${groups.length} Page · ${tree.totalCampaigns || 0} chiến dịch · ` +
      `${tree.accountCount || 0} tài khoản QC` +
      (tree.capturedAt ? ` · lúc ${fmtDateTime(tree.capturedAt)}` : "");

    const filter = statusFilter.value || "all";
    let shown = 0;
    for (const group of groups) {
      const campaigns =
        filter === "all" ? group.campaigns : (group.campaigns || []).filter((c) => c.runState === filter);
      // Khi lọc trạng thái: ẩn Page không có chiến dịch khớp.
      if (filter !== "all" && campaigns.length === 0) {
        continue;
      }
      treeEl.append(renderPageGroup(group, campaigns));
      shown += 1;
    }

    if (shown === 0) {
      treeEl.append(
        card([emptyNote(filter === "all" ? "Không có Page/chiến dịch nào." : "Không có chiến dịch khớp bộ lọc.")])
      );
    }
  }

  function renderPageGroup(group, campaigns) {
    const chevron = el("span", { class: "text-slate-400", text: "▾" });
    const listEl = el("div", { class: "divide-y divide-slate-100 border-t border-slate-100" });

    const header = el(
      "button",
      {
        class: "flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50",
        attrs: { type: "button", "aria-expanded": "true" }
      },
      [
        chevron,
        el("span", { class: "flex-1" }, [
          el("span", { class: "text-sm font-semibold text-slate-900", text: group.pageName }),
          group.managed
            ? null
            : el("span", { class: "ml-2 text-xs text-slate-400", text: "(Page ngoài / chưa xác định)" })
        ]),
        el("span", { class: "flex items-center gap-3" }, [
          countChip("active", group.counts.active),
          countChip("paused", group.counts.paused),
          countChip("stopped", group.counts.stopped)
        ])
      ]
    );

    header.addEventListener("click", () => {
      const hidden = listEl.classList.toggle("hidden");
      chevron.textContent = hidden ? "▸" : "▾";
      header.setAttribute("aria-expanded", hidden ? "false" : "true");
    });

    if (campaigns.length === 0) {
      listEl.append(el("p", { class: "px-4 py-3 text-sm text-slate-400", text: "Chưa có chiến dịch." }));
    } else {
      for (const campaign of campaigns) {
        listEl.append(renderCampaignRow(campaign));
      }
    }

    return el("div", { class: "overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" }, [
      header,
      listEl
    ]);
  }

  function renderCampaignRow(campaign) {
    const detail = el("div", { class: "hidden bg-slate-50/60 px-4 py-4" });
    const chevron = el("span", { class: "text-slate-300", text: "▸" });

    const toggle = el(
      "button",
      {
        class: "flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50",
        attrs: { type: "button", "aria-expanded": "false" }
      },
      [
        chevron,
        statusBadge(campaign.runState),
        el("span", { class: "flex-1 text-sm font-medium text-slate-800", text: campaign.name || campaign.id }),
        el("span", { class: "text-xs text-slate-400", text: campaign.adAccountName || "" })
      ]
    );

    toggle.addEventListener("click", () => {
      if (openDetailEl === detail) {
        closeOpenDetail();
      } else {
        openCampaignDetail(campaign, detail, toggle, chevron);
      }
    });

    return el("div", {}, [toggle, detail]);
  }

  // --- Chi tiết 1 chiến dịch (kết quả + nhân khẩu học), tải lười ---

  function closeOpenDetail() {
    if (openDetailEl) {
      destroyCharts();
      openDetailEl.replaceChildren();
      openDetailEl.classList.add("hidden");
    }
    if (openToggleBtn) {
      openToggleBtn.setAttribute("aria-expanded", "false");
    }
    if (openChevron) {
      openChevron.textContent = "▸";
    }
    openDetailEl = null;
    openToggleBtn = null;
    openChevron = null;
    openState = null;
  }

  async function openCampaignDetail(campaign, detail, toggle, chevron) {
    closeOpenDetail();
    destroyCharts();

    openDetailEl = detail;
    openToggleBtn = toggle;
    openChevron = chevron;
    toggle.setAttribute("aria-expanded", "true");
    chevron.textContent = "▾";
    detail.classList.remove("hidden");
    detail.replaceChildren(el("p", { class: "text-sm text-slate-500", text: "Đang tải kết quả…" }));

    const datePreset = datePresetSelect.value || DEFAULT_PRESET;
    const context = {
      campaignId: campaign.id,
      campaignName: campaign.name,
      adAccountId: campaign.adAccountId,
      accountName: campaign.adAccountName,
      datePreset,
      datePresetLabel: presetLabel(datePreset)
    };
    const state = { insights: null, demographics: null, context };
    openState = state;

    try {
      const url =
        `/api/ads/campaigns/${encodeURIComponent(campaign.id)}/insights` +
        `?adAccountId=${encodeURIComponent(campaign.adAccountId)}&datePreset=${encodeURIComponent(datePreset)}`;
      const data = await fetchJson(url);
      // Người dùng có thể đã đóng/mở chiến dịch khác trong lúc chờ -> bỏ kết quả cũ.
      if (openState !== state) return;
      state.insights = data.adsInsights;

      detail.replaceChildren();
      const warnBox = el("div", { class: "mb-3 space-y-2" });
      const body = el("div", { class: "space-y-6" });
      detail.append(warnBox, body);

      renderInsights(body, warnBox, data.adsInsights, state);

      if (data.adsInsights && data.adsInsights.available) {
        const demoUrl =
          `/api/ads/campaigns/${encodeURIComponent(campaign.id)}/demographics` +
          `?adAccountId=${encodeURIComponent(campaign.adAccountId)}&datePreset=${encodeURIComponent(datePreset)}`;
        try {
          const demoData = await fetchJson(demoUrl);
          if (openState !== state) return;
          state.demographics = demoData.demographics;
          renderDemographics(body, warnBox, demoData.demographics);
        } catch (error) {
          body.append(
            card([
              cardHeading("Nhân khẩu học người xem quảng cáo", "Không tải được nhân khẩu học."),
              el("p", { class: "text-sm text-slate-500", text: `Lỗi: ${error.message}` })
            ])
          );
        }
      }
    } catch (error) {
      if (openState !== state) return;
      detail.replaceChildren(el("p", { class: "text-sm text-rose-600", text: `Lỗi: ${error.message}` }));
    }
  }

  // --- Render KẾT QUẢ (insights) vào body ---
  function renderInsights(body, warnBox, insights, state) {
    if (!insights) {
      body.append(el("p", { class: "text-sm text-slate-500", text: "Máy chủ không trả về dữ liệu quảng cáo." }));
      return;
    }
    for (const warning of insights.warnings || []) {
      appendWarning(warnBox, warning);
    }

    if (!insights.available) {
      body.append(
        card([
          cardHeading("Chưa có số liệu", "Chiến dịch / khoảng thời gian này chưa có dữ liệu quảng cáo."),
          el("p", { class: "text-sm text-slate-500", text: "Thử đổi khoảng thời gian ở trên rồi mở lại." })
        ])
      );
      return;
    }

    const overview = insights.overview || {};
    const currency = insights.currency || null;

    // Thanh nút xuất + nguồn.
    body.append(
      el("div", { class: "flex flex-wrap items-center justify-between gap-2" }, [
        buildExportBar(state),
        el("span", {
          class: "text-xs text-slate-400",
          text: insights.capturedAt ? `Nguồn: Graph API · lúc ${fmtDateTime(insights.capturedAt)}` : "Nguồn: Graph API"
        })
      ])
    );

    body.append(
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

    if (overview.frequency !== undefined && overview.frequency !== null && overview.frequency !== "") {
      body.append(
        grid("grid-cols-2 lg:grid-cols-3", [
          kpiTile("Tần suất", fmtNum(overview.frequency, 2), "lần hiển thị / người")
        ])
      );
    }

    const daily = Array.isArray(insights.daily) ? insights.daily : [];
    const canvas = el("canvas", { attrs: { role: "img", "aria-label": "Chi tiêu và hiển thị theo ngày" } });
    body.append(
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

  // --- Render NHÂN KHẨU HỌC vào body ---

  function renderDemographics(body, warnBox, demo) {
    if (!demo) return;
    for (const warning of demo.warnings || []) {
      appendWarning(warnBox, warning);
    }

    body.append(
      el("h3", {
        class: "pt-2 text-base font-semibold text-slate-900",
        text: "Nhân khẩu học người xem quảng cáo"
      })
    );

    renderAgeGenderCard(body, demo.ageGender);
    renderCategoricalCard(body, demo.country, {
      title: "Top quốc gia",
      subtitle: "Số lượt hiển thị theo quốc gia (tối đa 10).",
      labeler: countryName
    });
    renderCategoricalCard(body, demo.region, {
      title: "Top vùng / tỉnh",
      subtitle: "Số lượt hiển thị theo vùng/tỉnh (tối đa 10).",
      labeler: regionName
    });
  }

  function renderAgeGenderCard(body, ageGender) {
    const heading = cardHeading("Tuổi × giới tính", "Lượt hiển thị theo nhóm tuổi, tách theo giới tính.");
    if (!ageGender || !ageGender.available) {
      body.append(
        card([
          heading,
          el("p", { class: "text-sm text-slate-500", text: (ageGender && ageGender.reason) || "Không có dữ liệu." })
        ])
      );
      return;
    }
    const ages = ageGender.ages || [];
    if (ages.length === 0) {
      body.append(card([heading, emptyNote("Không có dữ liệu tuổi/giới tính.")]));
      return;
    }
    const canvas = el("canvas", { attrs: { role: "img", "aria-label": "Phân bố tuổi và giới tính" } });
    body.append(card([heading, el("div", { class: "relative h-80" }, [canvas])]));
    drawAgeGenderChart(canvas, ageGender);
  }

  function renderCategoricalCard(body, dimension, opts) {
    const heading = cardHeading(opts.title, opts.subtitle);
    if (!dimension || !dimension.available) {
      body.append(
        card([
          heading,
          el("p", { class: "text-sm text-slate-500", text: (dimension && dimension.reason) || "Không có dữ liệu." })
        ])
      );
      return;
    }
    const items = dimension.items || [];
    if (items.length === 0) {
      body.append(card([heading, emptyNote("Không có dữ liệu.")]));
      return;
    }
    const canvas = el("canvas", { attrs: { role: "img", "aria-label": opts.title } });
    const heightClass = items.length > 6 ? "h-96" : "h-72";
    body.append(card([heading, el("div", { class: `relative ${heightClass}` }, [canvas])]));
    drawCategoricalChart(canvas, items, opts.labeler);
  }

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

  // --- Xuất báo cáo (CSV / JSON) cho chiến dịch đang mở ---

  function buildExportBar(state) {
    return el("div", { class: "flex flex-wrap items-center gap-2" }, [
      el("span", { class: "text-xs font-medium text-slate-500", text: "Xuất báo cáo:" }),
      exportBtn("Xuất CSV", "Mở trực tiếp bằng Excel / Google Sheets", () => doExport("csv", state)),
      exportBtn("Xuất JSON", "Dữ liệu thô có cấu trúc", () => doExport("json", state))
    ]);
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
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function doExport(kind, state) {
    if (!state || !state.insights || !state.insights.available) {
      return;
    }
    const model = buildReportModel({
      insights: state.insights,
      demographics: state.demographics,
      context: state.context
    });
    const dateTag = new Date().toISOString().slice(0, 10);
    if (kind === "csv") {
      downloadText(
        buildReportFilename(state.context, "csv", dateTag),
        "text/csv;charset=utf-8",
        reportToCsv(model),
        true
      );
    } else {
      downloadText(
        buildReportFilename(state.context, "json", dateTag),
        "application/json;charset=utf-8",
        reportToJson(model),
        false
      );
    }
  }

  // --- Wire events ---
  refreshBtn.addEventListener("click", () => loadTree());
  statusFilter.addEventListener("change", () => {
    closeOpenDetail();
    if (currentTree) renderTree(currentTree);
  });
  // Đổi khoảng thời gian: đóng chi tiết đang mở để lần mở sau dùng khoảng mới.
  datePresetSelect.addEventListener("change", () => closeOpenDetail());

  loadTree();

  // Controller cho statistics.js: hủy chart + dọn DOM khi rời tab.
  return {
    destroy() {
      destroyCharts();
      rootEl.replaceChildren();
    }
  };
}
