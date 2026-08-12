import { fetchJson, el, formatTime } from "/shared/api.js";
import { mountShell } from "/shared/shell.js";
import { mountAdsSection } from "/ads-section.js";

mountShell("/statistics.html");

const pageSelect = document.querySelector("#page-select");
const refreshBtn = document.querySelector("#refresh-btn");
const statusEl = document.querySelector("#status");
const warningsEl = document.querySelector("#warnings");
const reportEl = document.querySelector("#report");

// Chuyển tab Thống kê Page ↔ Quảng cáo.
const statsTabs = document.querySelector("#stats-tabs");
const statsTitle = document.querySelector("#stats-title");
const statsSubtitle = document.querySelector("#stats-subtitle");
const pageStatsControls = document.querySelector("#page-stats-controls");
const pageStatsView = document.querySelector("#page-stats-view");
const adsView = document.querySelector("#ads-view");

let chartInstances = [];
let lastAnalytics = null;
// Danh sách Page đầy đủ (kèm instagramBusinessAccount). Thanh công cụ cần cả
// đối tượng chứ không chỉ id, để biết Page này có Instagram hay không.
let allPages = [];

// --- Định dạng số ----------------------------------------------------------

const intFormatter = new Intl.NumberFormat("vi-VN");

function fmtInt(value) {
  return intFormatter.format(Math.round(Number(value) || 0));
}

function fmtNum(value, digits = 1) {
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: digits }).format(Number(value) || 0);
}

function fmtPercent(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  const sign = Number(value) > 0 ? "+" : "";
  return `${sign}${fmtNum(value, digits)}%`;
}

function fmtPercentPlain(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return `${fmtNum(value, digits)}%`;
}

// --- Bảng màu biểu đồ ------------------------------------------------------

const PALETTE = ["#1877f2", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#ec4899", "#64748b"];
const BRAND = "#1877f2";
const IG_COLOR = "#d6249f";

// --- Vòng đời Chart.js -----------------------------------------------------

function destroyCharts() {
  for (const chart of chartInstances) {
    chart.destroy();
  }
  chartInstances = [];
}

function registerChart(chart) {
  chartInstances.push(chart);
  return chart;
}

const NO_LEGEND = { legend: { display: false } };

function baseOptions(extraPlugins = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: "index" },
    plugins: { ...extraPlugins }
  };
}

// --- Builder DOM -----------------------------------------------------------

function card(children, extraClass = "") {
  return el("div", { class: `rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${extraClass}` }, children);
}

function cardHeading(title, subtitle) {
  return el("div", { class: "mb-4" }, [
    el("h3", { class: "text-sm font-semibold text-slate-900", text: title }),
    subtitle ? el("p", { class: "mt-0.5 text-xs text-slate-500", text: subtitle }) : null
  ]);
}

function chartCard(title, subtitle) {
  const canvas = el("canvas", { attrs: { role: "img", "aria-label": title } });
  const holder = card([cardHeading(title, subtitle), el("div", { class: "relative h-72" }, [canvas])]);
  return { holder, canvas };
}

function kpiTile(label, value, sub, tone = "text-slate-900") {
  return el("div", { class: "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" }, [
    el("p", { class: "text-xs text-slate-500", text: label }),
    el("p", { class: `mt-1 text-2xl font-bold ${tone}`, text: value }),
    sub ? el("p", { class: "mt-0.5 text-xs text-slate-400", text: sub }) : null
  ]);
}

function sectionHeader(title, subtitle, accent) {
  return el("div", { class: "flex items-center gap-3" }, [
    el("span", { class: `inline-block h-8 w-1.5 rounded-full`, attrs: { style: `background:${accent}` } }),
    el("div", {}, [
      el("h2", { class: "text-xl font-bold text-slate-900", text: title }),
      subtitle ? el("p", { class: "text-sm text-slate-500", text: subtitle }) : null
    ])
  ]);
}

function grid(cols, children) {
  return el("div", { class: `grid gap-4 ${cols}` }, children);
}

// --- Bảng thống kê mô tả ---------------------------------------------------

const DESCRIBE_ROWS = [
  ["Số lượng (n)", (d) => fmtInt(d.count)],
  ["Tổng", (d) => fmtInt(d.sum)],
  ["Trung bình (mean)", (d) => fmtNum(d.mean, 2)],
  ["Trung vị (median)", (d) => fmtNum(d.median, 2)],
  ["Nhỏ nhất", (d) => fmtInt(d.min)],
  ["Lớn nhất", (d) => fmtInt(d.max)],
  ["Phân vị 25 (P25)", (d) => fmtNum(d.p25, 2)],
  ["Phân vị 75 (P75)", (d) => fmtNum(d.p75, 2)],
  ["Phân vị 90 (P90)", (d) => fmtNum(d.p90, 2)],
  ["Độ lệch chuẩn (tổng thể)", (d) => fmtNum(d.stdDevPopulation, 2)],
  ["Độ lệch chuẩn (mẫu)", (d) => fmtNum(d.stdDevSample, 2)],
  ["Hệ số biến thiên (CV)", (d) => fmtNum(d.coefficientOfVariation, 3)]
];

function describeTable(distribution, columns) {
  const table = el("table", { class: "w-full text-sm" });
  const thead = el("thead", {}, [
    el(
      "tr",
      { class: "text-left text-xs uppercase tracking-wide text-slate-400" },
      [el("th", { class: "py-2 pr-3 font-medium", text: "Chỉ số" }), ...columns.map((col) =>
        el("th", { class: "py-2 px-3 font-medium text-right", text: col.label })
      )]
    )
  ]);
  const tbody = el("tbody", {});
  for (const [rowLabel, accessor] of DESCRIBE_ROWS) {
    const tr = el("tr", { class: "border-t border-slate-100" }, [
      el("td", { class: "py-1.5 pr-3 text-slate-600", text: rowLabel }),
      ...columns.map((col) =>
        el("td", { class: "py-1.5 px-3 text-right font-medium text-slate-800", text: accessor(col.data) })
      )
    ]);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return card([
    cardHeading("Phân bố thống kê tương tác", "Đơn vị: lượt tương tác trên mỗi bài. CV thấp = ổn định, cao = thất thường."),
    el("div", { class: "overflow-x-auto" }, [table])
  ]);
}

// --- Vẽ các loại biểu đồ ----------------------------------------------------

function drawDoughnut(canvas, labels, data, colors) {
  registerChart(
    new Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: "#fff" }]
      },
      options: baseOptions({ legend: { position: "right", labels: { boxWidth: 12, font: { size: 11 } } } })
    })
  );
}

function drawBar(canvas, labels, data, color, label) {
  registerChart(
    new Chart(canvas, {
      type: "bar",
      data: { labels, datasets: [{ label, data, backgroundColor: color, borderRadius: 4 }] },
      options: {
        ...baseOptions(NO_LEGEND),
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    })
  );
}

// Biểu đồ tháng: cột số bài (trục phải) + đường tương tác (trục trái).
function drawMonthly(canvas, monthly, accentLine) {
  const labels = monthly.map((m) => m.label);
  registerChart(
    new Chart(canvas, {
      data: {
        labels,
        datasets: [
          {
            type: "line",
            label: "Tương tác",
            data: monthly.map((m) => m.engagement || 0),
            borderColor: accentLine,
            backgroundColor: `${accentLine}22`,
            fill: true,
            tension: 0.3,
            yAxisID: "y",
            pointRadius: 2
          },
          {
            type: "bar",
            label: "Số bài",
            data: monthly.map((m) => m.count || 0),
            backgroundColor: "#cbd5e1",
            yAxisID: "y1",
            borderRadius: 3
          }
        ]
      },
      options: {
        ...baseOptions({ legend: { position: "top", labels: { boxWidth: 12, font: { size: 11 } } } }),
        scales: {
          y: { type: "linear", position: "left", beginAtZero: true, title: { display: true, text: "Tương tác" } },
          y1: {
            type: "linear",
            position: "right",
            beginAtZero: true,
            grid: { drawOnChartArea: false },
            ticks: { precision: 0 },
            title: { display: true, text: "Số bài" }
          }
        }
      }
    })
  );
}

// Bar tương tác trung bình theo khung (thứ/giờ), tooltip kèm số bài.
function drawAvgBuckets(canvas, buckets, color) {
  registerChart(
    new Chart(canvas, {
      type: "bar",
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [{ label: "Tương tác TB/bài", data: buckets.map((b) => b.avgValue || 0), backgroundColor: color, borderRadius: 4 }]
      },
      options: {
        ...baseOptions({
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel: (ctx) => `Số bài: ${fmtInt(buckets[ctx.dataIndex].postCount)}`
            }
          }
        }),
        scales: { y: { beginAtZero: true } }
      }
    })
  );
}

// --- Render bảng Top -------------------------------------------------------

function topTable(title, rows, columns) {
  const table = el("table", { class: "w-full text-sm" });
  const thead = el("thead", {}, [
    el(
      "tr",
      { class: "text-left text-xs uppercase tracking-wide text-slate-400" },
      columns.map((col) => el("th", { class: `py-2 px-2 font-medium ${col.align === "right" ? "text-right" : ""}`, text: col.label }))
    )
  ]);
  const tbody = el("tbody", {});
  if (rows.length === 0) {
    tbody.append(el("tr", {}, [el("td", { class: "py-3 text-slate-400", attrs: { colspan: columns.length }, text: "Chưa có dữ liệu." })]));
  }
  for (const row of rows) {
    tbody.append(el("tr", { class: "border-t border-slate-100 align-top" }, columns.map((col) => col.render(row))));
  }
  table.append(thead, tbody);
  return card([cardHeading(title), el("div", { class: "overflow-x-auto" }, [table])]);
}

function textCell(text, extra = "") {
  return el("td", { class: `py-2 px-2 text-slate-700 ${extra}`, text });
}

function numCell(value) {
  return el("td", { class: "py-2 px-2 text-right font-medium text-slate-800", text: fmtInt(value) });
}

function linkCell(url) {
  const td = el("td", { class: "py-2 px-2 text-right" });
  if (url) {
    td.append(el("a", { class: "text-brand-600 hover:underline", text: "Mở", attrs: { href: url, target: "_blank", rel: "noreferrer" } }));
  } else {
    td.append(document.createTextNode("—"));
  }
  return td;
}

// --- Cảnh báo --------------------------------------------------------------

function renderWarnings(warnings) {
  warningsEl.replaceChildren();
  for (const warning of warnings || []) {
    warningsEl.append(
      el("div", { class: "rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800" }, [
        el("span", { text: `⚠️ ${warning}` })
      ])
    );
  }
}

// --- Section Facebook ------------------------------------------------------

function bestTimeText(bestTime) {
  const parts = [];
  if (bestTime.weekday) parts.push(`${bestTime.weekday.label} (TB ${fmtNum(bestTime.weekday.avgValue, 1)})`);
  if (bestTime.hour) parts.push(`${bestTime.hour.label} (TB ${fmtNum(bestTime.hour.avgValue, 1)})`);
  return parts.length ? parts.join(" · ") : "Chưa đủ dữ liệu";
}

function renderFacebook(fb) {
  const container = el("section", { class: "space-y-4" });
  const ov = fb.overview;

  container.append(
    sectionHeader(
      "Facebook Page",
      `${fb.profile.name}${fb.profile.category ? " · " + fb.profile.category : ""} · ${fmtInt(fb.fetch.postCount)} bài phân tích`,
      BRAND
    )
  );

  container.append(
    grid("grid-cols-2 lg:grid-cols-4", [
      kpiTile("Người theo dõi", fmtInt(ov.followers), fb.profile.fanCount ? `${fmtInt(fb.profile.fanCount)} lượt thích Page` : null),
      kpiTile("Tổng bài đăng", fmtInt(ov.totalPosts), `${ov.activeMonths} tháng hoạt động`),
      kpiTile("Tổng tương tác", fmtInt(ov.totalEngagement), "reaction + bình luận + chia sẻ", "text-brand-600"),
      kpiTile("Tương tác TB/bài", fmtNum(ov.avgEngagementPerPost, 1), `Trung vị ${fmtNum(ov.medianEngagementPerPost, 0)}`)
    ])
  );

  container.append(
    grid("grid-cols-2 lg:grid-cols-4", [
      kpiTile("Tỷ lệ tương tác/bài", fmtPercentPlain(ov.engagementRatePerPostPercent), "trên số người theo dõi", "text-emerald-600"),
      kpiTile("Tổng reaction", fmtInt(ov.totalReactions)),
      kpiTile("Tổng bình luận", fmtInt(ov.totalComments)),
      kpiTile("Tổng chia sẻ", fmtInt(ov.totalShares))
    ])
  );

  container.append(
    grid("grid-cols-1 lg:grid-cols-3", [
      kpiTile(
        "Tăng trưởng tương tác (tháng gần nhất)",
        fmtPercent(fb.monthlyGrowth.engagementPercent),
        "so với tháng liền trước",
        Number(fb.monthlyGrowth.engagementPercent) >= 0 ? "text-emerald-600" : "text-red-600"
      ),
      kpiTile("Khung giờ đăng tốt nhất", bestTimeText(fb.bestTime), "theo tương tác trung bình"),
      kpiTile(
        "Khoảng thời gian dữ liệu",
        ov.firstPostAt ? `${formatTime(ov.firstPostAt)}` : "—",
        ov.lastPostAt ? `→ ${formatTime(ov.lastPostAt)}` : null
      )
    ])
  );

  // Biểu đồ hàng 1: tháng + reaction theo loại
  const monthlyC = chartCard("Tương tác & số bài theo tháng", "Đường: tổng tương tác · Cột: số bài đăng");
  const reactionsC = chartCard("Cơ cấu reaction", "Tỷ trọng từng loại cảm xúc");
  container.append(grid("grid-cols-1 lg:grid-cols-3", [el("div", { class: "lg:col-span-2" }, [monthlyC.holder]), reactionsC.holder]));

  // Biểu đồ hàng 2: loại bài + thứ + giờ
  const typesC = chartCard("Phân bố theo loại bài", "Số bài theo định dạng");
  const weekdayC = chartCard("Tương tác theo thứ trong tuần", "Trung bình mỗi bài");
  const hourlyC = chartCard("Tương tác theo giờ trong ngày", "Trung bình mỗi bài · giờ VN");
  container.append(grid("grid-cols-1 lg:grid-cols-3", [typesC.holder, weekdayC.holder, hourlyC.holder]));

  // Phân bố thống kê + top bài
  container.append(
    describeTable(fb.distribution, [
      { label: "Tương tác", data: fb.distribution.engagement },
      { label: "Reaction", data: fb.distribution.reactions },
      { label: "Bình luận", data: fb.distribution.comments },
      { label: "Chia sẻ", data: fb.distribution.shares }
    ])
  );

  container.append(
    topTable("Top 10 bài tương tác cao nhất", fb.topPosts, [
      { label: "Nội dung", render: (r) => textCell(r.snippet, "max-w-md") },
      { label: "Thời gian", render: (r) => textCell(formatTime(r.createdTime)) },
      { label: "Reaction", align: "right", render: (r) => numCell(r.reactions) },
      { label: "Bình luận", align: "right", render: (r) => numCell(r.comments) },
      { label: "Chia sẻ", align: "right", render: (r) => numCell(r.shares) },
      { label: "Tương tác", align: "right", render: (r) => numCell(r.engagement) },
      { label: "Link", align: "right", render: (r) => linkCell(r.permalinkUrl) }
    ])
  );

  // Insight cấp Page
  container.append(renderInsights(fb.insights));

  reportEl.append(container);

  // Vẽ biểu đồ SAU khi canvas đã vào DOM.
  drawMonthly(monthlyC.canvas, fb.monthly, BRAND);
  if (fb.reactionsByType.length && fb.reactionsByType.some((r) => r.total > 0)) {
    drawDoughnut(reactionsC.canvas, fb.reactionsByType.map((r) => r.label), fb.reactionsByType.map((r) => r.total), PALETTE);
  } else {
    reactionsC.canvas.replaceWith(emptyChartNote("Không có dữ liệu reaction theo loại."));
  }
  drawBar(typesC.canvas, fb.postTypes.map((t) => t.label), fb.postTypes.map((t) => t.count), BRAND, "Số bài");
  drawAvgBuckets(weekdayC.canvas, fb.weekday, "#22c55e");
  drawAvgBuckets(hourlyC.canvas, fb.hourly, "#f59e0b");
}

function emptyChartNote(text) {
  return el("div", { class: "flex h-72 items-center justify-center text-sm text-slate-400", text });
}

function renderInsights(insights) {
  if (!insights || !insights.available) {
    return card([
      cardHeading("Insight cấp Page (reach / hiển thị)", "Cần quyền read_insights"),
      el("p", { class: "text-sm text-slate-500", text: insights && insights.reason ? insights.reason : "Không có dữ liệu insight." })
    ]);
  }

  const wrap = el("div", { class: "space-y-4" });
  wrap.append(sectionHeader("Insight cấp Page", "reach, hiển thị, lượt xem — theo ngày", "#8b5cf6"));
  const cards = insights.metrics.map((metric) => {
    const c = chartCard(metric.title || metric.name, `Tổng kỳ: ${fmtInt(metric.total)}`);
    return { metric, ...c };
  });
  wrap.append(grid("grid-cols-1 lg:grid-cols-2", cards.map((c) => c.holder)));

  // Vẽ sau khi thêm vào DOM: trả về wrap, vẽ ngay vì canvas đã trong wrap (đang detached).
  // -> hoãn vẽ bằng cách gắn callback microtask.
  queueMicrotask(() => {
    for (const { metric, canvas } of cards) {
      registerChart(
        new Chart(canvas, {
          type: "line",
          data: {
            labels: metric.series.map((p) => (p.date ? formatTime(p.date) : "")),
            datasets: [{ data: metric.series.map((p) => p.value), borderColor: "#8b5cf6", backgroundColor: "#8b5cf622", fill: true, tension: 0.3, pointRadius: 0 }]
          },
          options: { ...baseOptions(NO_LEGEND), scales: { y: { beginAtZero: true } } }
        })
      );
    }
  });

  return wrap;
}

// --- Section Instagram -----------------------------------------------------

function renderInstagram(ig) {
  const container = el("section", { class: "space-y-4" });
  const ov = ig.overview;

  container.append(
    sectionHeader(
      "Instagram",
      `@${ig.profile.username || "—"} · ${fmtInt(ig.fetch.mediaCount)} bài phân tích`,
      IG_COLOR
    )
  );

  container.append(
    grid("grid-cols-2 lg:grid-cols-4", [
      kpiTile("Người theo dõi", fmtInt(ov.followers), `${fmtInt(ig.profile.mediaCount)} bài trên hồ sơ`),
      kpiTile("Tổng bài (media)", fmtInt(ov.totalMedia), `${ov.activeMonths} tháng hoạt động`),
      kpiTile("Tổng tương tác", fmtInt(ov.totalEngagement), "lượt thích + bình luận", "text-pink-600"),
      kpiTile("Tương tác TB/bài", fmtNum(ov.avgEngagementPerMedia, 1), `Trung vị ${fmtNum(ov.medianEngagementPerMedia, 0)}`)
    ])
  );

  container.append(
    grid("grid-cols-2 lg:grid-cols-4", [
      kpiTile("Tỷ lệ tương tác/bài", fmtPercentPlain(ov.engagementRatePerMediaPercent), "trên số người theo dõi", "text-emerald-600"),
      kpiTile("Tổng lượt thích", fmtInt(ov.totalLikes)),
      kpiTile("Tổng bình luận", fmtInt(ov.totalComments)),
      kpiTile(
        "Tăng trưởng (tháng gần nhất)",
        fmtPercent(ig.monthlyGrowth.engagementPercent),
        "tương tác so tháng trước",
        Number(ig.monthlyGrowth.engagementPercent) >= 0 ? "text-emerald-600" : "text-red-600"
      )
    ])
  );

  const monthlyC = chartCard("Tương tác & số bài theo tháng", "Đường: tương tác · Cột: số bài");
  const typesC = chartCard("Phân bố loại media", "Ảnh · Video · Carousel · Reels");
  container.append(grid("grid-cols-1 lg:grid-cols-3", [el("div", { class: "lg:col-span-2" }, [monthlyC.holder]), typesC.holder]));

  const weekdayC = chartCard("Tương tác theo thứ trong tuần", "Trung bình mỗi bài");
  const hourlyC = chartCard("Tương tác theo giờ trong ngày", "Trung bình mỗi bài · giờ VN");
  container.append(grid("grid-cols-1 lg:grid-cols-2", [weekdayC.holder, hourlyC.holder]));

  container.append(
    describeTable(ig.distribution, [
      { label: "Tương tác", data: ig.distribution.engagement },
      { label: "Lượt thích", data: ig.distribution.likes },
      { label: "Bình luận", data: ig.distribution.comments }
    ])
  );

  container.append(
    topTable("Top 10 media tương tác cao nhất", ig.topMedia, [
      { label: "Nội dung", render: (r) => textCell(r.snippet, "max-w-md") },
      { label: "Loại", render: (r) => textCell(r.mediaProductType || r.mediaType) },
      { label: "Thời gian", render: (r) => textCell(formatTime(r.createdTime)) },
      { label: "Thích", align: "right", render: (r) => numCell(r.likeCount) },
      { label: "Bình luận", align: "right", render: (r) => numCell(r.commentsCount) },
      { label: "Tương tác", align: "right", render: (r) => numCell(r.engagement) },
      { label: "Link", align: "right", render: (r) => linkCell(r.permalinkUrl) }
    ])
  );

  reportEl.append(container);

  drawMonthly(monthlyC.canvas, ig.monthly, IG_COLOR);
  if (ig.mediaTypes.length) {
    drawDoughnut(typesC.canvas, ig.mediaTypes.map((t) => t.label), ig.mediaTypes.map((t) => t.count), PALETTE);
  } else {
    typesC.canvas.replaceWith(emptyChartNote("Không có dữ liệu media."));
  }
  drawAvgBuckets(weekdayC.canvas, ig.weekday, "#ec4899");
  drawAvgBuckets(hourlyC.canvas, ig.hourly, "#8b5cf6");
}

// --- Đối tượng khách hàng (audience) ---------------------------------------

function demographicBarCard(title, subtitle, normalized, color) {
  const c = chartCard(title, subtitle);
  queueMicrotask(() => {
    if (normalized && normalized.items && normalized.items.length) {
      drawBar(c.canvas, normalized.items.map((i) => i.label), normalized.items.map((i) => i.value), color, "Người");
    } else {
      c.canvas.replaceWith(emptyChartNote("Không có dữ liệu."));
    }
  });
  return c.holder;
}

function demographicDoughnutCard(title, subtitle, normalized) {
  const c = chartCard(title, subtitle);
  queueMicrotask(() => {
    if (normalized && normalized.items && normalized.items.length) {
      drawDoughnut(c.canvas, normalized.items.map((i) => i.label), normalized.items.map((i) => i.value), PALETTE);
    } else {
      c.canvas.replaceWith(emptyChartNote("Không có dữ liệu."));
    }
  });
  return c.holder;
}

function segmentCard(demo) {
  const children = [cardHeading("Tệp khách hàng (chân dung)", "Suy ra từ nhân khẩu học người theo dõi")];
  if (demo.summary) {
    const s = demo.summary;
    children.push(
      grid("grid-cols-2 lg:grid-cols-4", [
        kpiTile("Độ tuổi trội", s.topAge ? `${s.topAge.label}` : "—", s.topAge ? `${fmtNum(s.topAge.percent, 0)}%` : null),
        kpiTile("Giới tính trội", s.topGender ? s.topGender.label : "—", s.topGender ? `${fmtNum(s.topGender.percent, 0)}%` : null),
        kpiTile("Quốc gia hàng đầu", s.topCountry ? s.topCountry.label : "—", s.topCountry ? `${fmtNum(s.topCountry.percent, 0)}%` : null),
        kpiTile("Thành phố hàng đầu", s.topCity ? s.topCity.label : "—", s.topCity ? `${fmtNum(s.topCity.percent, 0)}%` : null)
      ])
    );
  }
  const list = el("ul", { class: "mt-3 space-y-1.5 text-sm text-slate-600" });
  for (const seg of demo.segments || []) {
    list.append(el("li", { class: "flex gap-2" }, [el("span", { class: "text-brand-500", text: "•" }), el("span", { text: seg })]));
  }
  if ((demo.segments || []).length) children.push(list);
  return card(children);
}

function unavailableCard(title, reason) {
  return card([
    cardHeading(title, "Meta không cung cấp / chưa đủ điều kiện"),
    el("p", { class: "text-sm text-slate-500", text: reason || "Không có dữ liệu." })
  ]);
}

// Chân dung suy luận cho FB từ dữ liệu tương tác đã tải (khi Meta khóa nhân khẩu học fan).
function inferredFacebookCard(fb) {
  if (!fb) return null;
  const topType = [...(fb.postTypes || [])].sort((a, b) => b.avgEngagement - a.avgEngagement)[0];
  const cv = fb.distribution && fb.distribution.engagement ? fb.distribution.engagement.coefficientOfVariation : null;
  const stability = cv === null ? "—" : cv < 0.5 ? "Ổn định" : cv < 1 ? "Trung bình" : "Thất thường";
  return card([
    cardHeading("Chân dung khách hàng (suy luận từ tương tác)", "Meta đã ngừng nhân khẩu học fan Facebook — đây là suy luận hành vi"),
    grid("grid-cols-1 lg:grid-cols-3", [
      kpiTile("Khung giờ khách hoạt động", bestTimeText(fb.bestTime), "khi tương tác cao nhất"),
      kpiTile("Nội dung khách thích nhất", topType ? topType.label : "—", topType ? `TB ${fmtNum(topType.avgEngagement, 1)}/bài` : null),
      kpiTile("Độ ổn định tương tác", stability, cv === null ? null : `CV ${fmtNum(cv, 2)}`)
    ])
  ]);
}

function renderDemographicsCharts(demo, accent) {
  return grid("grid-cols-1 lg:grid-cols-2", [
    demographicBarCard("Độ tuổi", "Số người theo dõi theo nhóm tuổi", demo.age, accent),
    demographicDoughnutCard("Giới tính", "Tỷ trọng", demo.gender),
    demographicBarCard("Quốc gia hàng đầu", "Top 8", demo.country, accent),
    demographicBarCard("Thành phố hàng đầu", "Top 8", demo.city, accent)
  ]);
}

function renderAudience(audience) {
  const container = el("section", { class: "space-y-4" });
  container.append(sectionHeader("Đối tượng khách hàng", "Nhân khẩu học người theo dõi · tệp khách hàng", "#0ea5e9"));

  // Nói rõ số liệu chụp lúc nào khi nguồn là công cụ cào. Với Graph API thì số
  // liệu là thời gian thực nên không cần; với nguồn cào thì nó chỉ mới bằng
  // lần cào gần nhất — không hiện ra thì người xem dễ tưởng là số của hôm nay
  // trong khi có khi đã một tuần.
  const fb = audience.facebook || {};
  if (fb.available && fb.source === "crawler" && fb.capturedAt) {
    container.append(
      el("p", {
        class: "text-xs text-slate-500",
        text:
          "Nguồn: công cụ cào Business Suite · chụp lúc " +
          new Date(fb.capturedAt).toLocaleString("vi-VN")
      })
    );
  }

  // Instagram (nhân khẩu học thật).
  if (audience.page.hasInstagram) {
    if (audience.instagram && audience.instagram.available) {
      container.append(el("h3", { class: "text-sm font-semibold text-pink-600", text: "Instagram" }));
      container.append(segmentCard(audience.instagram));
      container.append(renderDemographicsCharts(audience.instagram, IG_COLOR));
    } else {
      container.append(unavailableCard("Instagram — nhân khẩu học", audience.instagram && audience.instagram.reason));
    }
  }

  // Facebook: chân dung suy luận (luôn có) + demographics nếu Meta còn trả.
  container.append(el("h3", { class: "mt-2 text-sm font-semibold text-brand-600", text: "Facebook" }));
  const inferred = inferredFacebookCard(lastAnalytics && lastAnalytics.facebook);
  if (inferred) container.append(inferred);
  if (audience.facebook && audience.facebook.available) {
    container.append(segmentCard(audience.facebook));
    container.append(renderDemographicsCharts(audience.facebook, BRAND));
  } else {
    container.append(unavailableCard("Facebook — nhân khẩu học fan", audience.facebook && audience.facebook.reason));
  }

  reportEl.append(container);
}

async function loadAudience(pageId) {
  const loading = el("p", { class: "text-sm text-slate-400", text: "Đang tải đối tượng khách hàng…" });
  reportEl.append(loading);
  try {
    const data = await fetchJson(`/api/stats/pages/${encodeURIComponent(pageId)}/audience`);
    loading.remove();
    renderAudience(data.audience);
  } catch (error) {
    loading.textContent = `Không tải được đối tượng khách hàng: ${error.message}`;
  }
}

// --- Thanh công cụ: cào ngay + xuất file -----------------------------------
//
// Đặt ở <header sticky> nên dùng được ở mọi vị trí cuộn. Trước đây các nút này
// nằm cuối phần "Đối tượng khách hàng", tức phải cuộn qua toàn bộ biểu đồ mới
// bấm được — với Page nhiều bài thì đó là cuộn rất xa.

const crawlToolbar = document.querySelector("#crawl-toolbar");

// Danh sách khoảng thời gian do MÁY CHỦ khai (crawl-jobs.service.js).
// Nạp một lần rồi dùng lại: nó không đổi trong một phiên làm việc.
let timeRanges = null;
// Bộ đếm hỏi lại tiến trình. Giữ tham chiếu để còn dừng được khi đổi trang —
// không dừng thì đổi Page vài lần sẽ có vài bộ đếm cùng chạy, cùng ghi đè
// dòng trạng thái của nhau.
let crawlTimer = null;

async function ensureTimeRanges() {
  if (timeRanges) return timeRanges;
  try {
    const data = await fetchJson("/api/crawl/time-ranges");
    timeRanges = data.timeRanges || [];
  } catch {
    // Máy chủ chưa cấu hình Postgres -> vẫn cho chọn "trọn đời", vì đó là
    // khoảng duy nhất đã xác nhận Meta hỗ trợ.
    timeRanges = [{ value: "lifetime", label: "Trọn đời", verified: true }];
  }
  return timeRanges;
}

function nutPhu(label, extraAttrs) {
  return el("a", {
    class:
      "rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium " +
      "text-slate-700 transition hover:border-slate-400 hover:bg-slate-50",
    text: label,
    attrs: extraAttrs
  });
}

// Bốn liên kết tải dữ liệu thô. Là thẻ <a> thật chứ không phải nút gọi fetch:
// trình duyệt tự lo phần tải file, còn máy chủ đã đặt sẵn tên file trong
// header. Làm bằng fetch thì phải tự dựng Blob, tự tạo URL tạm, tự thu hồi —
// nhiều dòng hơn để làm đúng cái việc thẻ <a> vốn đã làm.
function nutXuatFile(pageId) {
  const base = `/api/stats/pages/${encodeURIComponent(pageId)}/audience/export`;
  return [
    nutPhu("CSV", { href: `${base}?format=csv` }),
    nutPhu("Excel", { href: `${base}?format=xlsx` }),
    nutPhu("JSON", { href: `${base}?format=json` }),
    // PDF mở tab mới rồi tự gọi hộp thoại in — không phải file tải về.
    nutPhu("PDF", { href: `${base}?format=pdf`, target: "_blank", rel: "noopener" })
  ];
}

// Trạng thái "máy cào (app)" — theo TÀI KHOẢN, không theo Page. Cho người dùng
// thấy app cào của họ đã kết nối chưa, để biết bấm "Cào ngay" có máy nhận việc
// hay không. KHÔNG khoá nút: hàng đợi vẫn giữ việc chờ máy bật (và máy cũ chạy
// đường Node chưa gửi nhịp tim nên sẽ hiện "chưa bật" dù đang chạy).
let workerStatusTimer = null;

function datHuyHieuMay(badge, variant, text, title) {
  const mau = {
    on: "border-emerald-200 bg-emerald-50 text-emerald-700",
    off: "border-slate-200 bg-slate-50 text-slate-500",
    unknown: "border-slate-200 bg-slate-50 text-slate-400"
  }[variant];
  badge.className =
    "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium " + mau;
  badge.textContent = text;
  badge.title = title || "";
}

async function capNhatHuyHieuMay(badge) {
  try {
    const data = await fetchJson("/api/crawl/worker-status");
    const status = (data && data.status) || {};
    // Ghi trạng thái mới nhất lên chính badge, để lúc bấm "Cào ngay" đọc lại
    // mà cảnh báo — "1" bật, "0" tắt, "" chưa rõ (đừng cảnh báo khi chưa rõ).
    badge.dataset.online = status.online ? "1" : "0";
    if (status.online) {
      const may = (status.workers || []).find((w) => w.online) || {};
      datHuyHieuMay(
        badge, "on",
        `● Máy cào đang bật${may.hostname ? " · " + may.hostname : ""}`,
        'App cào trên máy bạn đang kết nối — bấm "Cào ngay" sẽ có máy nhận việc.'
      );
    } else {
      datHuyHieuMay(
        badge, "off", "○ Máy cào chưa bật",
        "Chưa thấy app cào nào chạy. Tải app ở trang Tài khoản, dán mã kết nối rồi bật lên; việc cào sẽ chạy khi máy bật."
      );
    }
  } catch {
    badge.dataset.online = "";
    datHuyHieuMay(badge, "unknown", "○ Máy cào: không rõ", "");
  }
}

async function buildToolbar(page) {
  clearInterval(crawlTimer);
  clearInterval(workerStatusTimer);
  crawlTimer = null;
  workerStatusTimer = null;
  crawlToolbar.replaceChildren();

  if (!page) return;

  const ranges = await ensureTimeRanges();
  const coIg = Boolean(page.instagramBusinessAccount && page.instagramBusinessAccount.id);

  const oNguon = el("select", {
    class: "rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700"
  }, [
    el("option", { text: "Facebook", attrs: { value: "facebook" } }),
    // Chỉ hiện Instagram khi Page thật sự có liên kết — cho chọn rồi báo lỗi
    // là kiểu giao diện hứa thứ nó không làm được.
    coIg ? el("option", { text: "Instagram", attrs: { value: "instagram" } }) : null
  ]);

  const oThoiGian = el("select", {
    class: "rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700"
  }, ranges.map((r) =>
    el("option", {
      // Dấu ⚠ cho khoảng CHƯA xác nhận Meta hỗ trợ. Thà nói trước còn hơn để
      // người dùng chọn rồi nhận về một job failed mà không hiểu vì sao.
      text: r.verified ? r.label : `${r.label} (chưa xác nhận)`,
      attrs: { value: r.value }
    })
  ));

  const nutCao = el("button", {
    class:
      "rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white " +
      "transition hover:bg-emerald-700 disabled:opacity-50",
    text: "Cào ngay",
    attrs: { type: "button" }
  });

  const trangThai = el("span", { class: "text-xs text-slate-500" });

  // Huy hiệu "máy cào (app) đang bật/tắt" — poll mỗi 15s ở cuối hàm.
  const huyHieuMay = el("span", {});
  datHuyHieuMay(huyHieuMay, "unknown", "○ Máy cào…", "");

  nutCao.addEventListener("click", async () => {
    // Cảnh báo mềm (KHÔNG khoá nút): chỉ khi biết CHẮC chưa có máy cào nào bật
    // ("0", không phải "" chưa rõ). Việc vẫn xếp hàng được — nhưng hỏi lại để
    // người dùng khỏi tưởng đã cào xong trong khi job đang nằm chờ máy bật.
    if (huyHieuMay.dataset.online === "0") {
      const tiepTuc = window.confirm(
        "Chưa có máy cào nào đang bật.\n\n" +
        "Yêu cầu sẽ được xếp hàng và chỉ chạy khi bạn bật app cào trên máy mình " +
        "(hướng dẫn ở trang Tài khoản).\n\nVẫn đặt yêu cầu?"
      );
      if (!tiepTuc) return;
    }
    nutCao.disabled = true;
    trangThai.textContent = "Đang gửi yêu cầu…";
    try {
      // fetchJson tự đặt Content-Type khi có body — xem shared/api.js
      const data = await fetchJson("/api/crawl/jobs", {
        method: "POST",
        body: JSON.stringify({
          pageId: page.id,
          target: oNguon.value,
          timeRange: oThoiGian.value
        })
      });
      hienTrangThaiJob(trangThai, data.job, data.alreadyQueued);
      theoDoiJob(page.id, oNguon.value, trangThai, nutCao);
    } catch (error) {
      trangThai.textContent = `Lỗi: ${error.message}`;
      nutCao.disabled = false;
    }
  });

  crawlToolbar.append(
    el("span", { class: "text-xs font-medium text-slate-500", text: "Cào dữ liệu:" }),
    oNguon,
    oThoiGian,
    nutCao,
    huyHieuMay,
    trangThai,
    el("span", { class: "ml-auto text-xs font-medium text-slate-500", text: "Xuất:" }),
    ...nutXuatFile(page.id)
  );

  // Có việc đang dang dở từ lần trước (máy vừa bật lên chẳng hạn) thì hiện
  // ngay, đừng để người dùng bấm thêm một yêu cầu nữa cho cùng một trang.
  theoDoiJob(page.id, oNguon.value, trangThai, nutCao, { imLangKhiRong: true });

  // Huy hiệu máy cào: hỏi ngay rồi lặp lại (máy có thể bật/tắt giữa chừng).
  capNhatHuyHieuMay(huyHieuMay);
  workerStatusTimer = setInterval(() => capNhatHuyHieuMay(huyHieuMay), 15000);
}

function hienTrangThaiJob(trangThai, job, daCoSan) {
  if (!job) {
    trangThai.textContent = "";
    return;
  }

  if (job.status === "done") {
    trangThai.textContent =
      `Xong · ${job.rowCount || 0} dòng. Bấm "Tải lại" để xem số mới.`;
    return;
  }
  if (job.status === "failed") {
    trangThai.textContent = `Hỏng: ${job.error || "không rõ nguyên nhân"}`;
    return;
  }
  if (job.status === "pending") {
    // Nói rõ đang chờ CÁI GÌ. "Đang chờ" trơn khiến người dùng tưởng máy chủ
    // chậm, trong khi thật ra máy ở nhà đang tắt.
    trangThai.textContent = daCoSan
      ? "Yêu cầu này đã nằm trong hàng đợi, đang chờ máy cào bật lên."
      : "Đã xếp hàng — sẽ chạy khi máy cào ở nhà bật lên.";
    return;
  }
  trangThai.textContent = "Đang cào… (mở Edge, cuộn trang, chờ số liệu)";
}

// Hỏi lại tiến trình mỗi vài giây cho tới khi xong.
//
// Vì sao hỏi lại chứ không đẩy thẳng? Vì máy chủ không có đường đẩy tới trình
// duyệt (không dùng WebSocket ở dự án này), và một lần cào chỉ kéo dài vài
// phút. Hỏi 5 giây một lần trong vài phút là chi phí không đáng kể, đổi lại
// không phải thêm cả một tầng kết nối thời gian thực.
function theoDoiJob(pageId, target, trangThai, nutCao, { imLangKhiRong = false } = {}) {
  clearInterval(crawlTimer);

  const hoi = async () => {
    try {
      const data = await fetchJson(
        `/api/crawl/jobs?pageId=${encodeURIComponent(pageId)}&target=${encodeURIComponent(target)}`
      );
      const job = (data.jobs || [])[0];

      if (!job) {
        if (!imLangKhiRong) trangThai.textContent = "";
        clearInterval(crawlTimer);
        crawlTimer = null;
        nutCao.disabled = false;
        return;
      }

      hienTrangThaiJob(trangThai, job, false);

      if (job.status === "done" || job.status === "failed") {
        clearInterval(crawlTimer);
        crawlTimer = null;
        nutCao.disabled = false;
      } else {
        nutCao.disabled = true;
      }
    } catch {
      // Mất mạng chốc lát không đáng để xoá dòng trạng thái đang hiện —
      // lần hỏi kế tiếp sẽ tự cập nhật lại.
    }
  };

  hoi();
  crawlTimer = setInterval(hoi, 5000);
}

// --- Tải & điều phối -------------------------------------------------------

async function loadPages() {
  try {
    const data = await fetchJson("/api/pages");
    const pages = (data && data.pages) || [];
    allPages = pages;
    pageSelect.replaceChildren();
    if (pages.length === 0) {
      pageSelect.append(el("option", { text: "Không có Page", attrs: { value: "" } }));
      statusEl.textContent = "Tài khoản Facebook đang đăng nhập không quản lý Page nào.";
      return;
    }
    for (const page of pages) {
      pageSelect.append(
        el("option", {
          text: page.instagramBusinessAccount ? `${page.name} (＋IG)` : page.name,
          attrs: { value: page.id }
        })
      );
    }
    await loadReport(pages[0].id);
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

async function loadReport(pageId) {
  if (!pageId) {
    return;
  }
  destroyCharts();
  reportEl.replaceChildren();
  warningsEl.replaceChildren();

  // Dựng thanh công cụ NGAY, không chờ báo cáo tải xong: kéo toàn bộ lịch sử
  // bài đăng có thể mất vài chục giây, mà nút "Cào ngay" thì dùng được luôn.
  // Bắt nó chờ chỉ làm người dùng tưởng trang bị treo.
  buildToolbar(allPages.find((p) => p.id === pageId));

  statusEl.textContent = "Đang kéo toàn bộ lịch sử và tính thống kê… (có thể mất một lúc với Page nhiều bài)";
  refreshBtn.disabled = true;
  pageSelect.disabled = true;

  try {
    const data = await fetchJson(`/api/stats/pages/${encodeURIComponent(pageId)}`);
    const analytics = data.analytics;

    renderWarnings(analytics.warnings);
    statusEl.textContent = `Báo cáo tạo lúc ${formatTime(analytics.generatedAt)}.`;

    lastAnalytics = analytics;
    renderFacebook(analytics.facebook);
    if (analytics.instagram) {
      renderInstagram(analytics.instagram);
    }
    loadAudience(pageId);
  } catch (error) {
    statusEl.textContent = `Lỗi: ${error.message}`;
  } finally {
    refreshBtn.disabled = false;
    pageSelect.disabled = false;
  }
}

pageSelect.addEventListener("change", () => loadReport(pageSelect.value));
refreshBtn.addEventListener("click", () => loadReport(pageSelect.value));

// --- Chuyển tab: Thống kê Page ↔ Quảng cáo ---------------------------------
//
// Tab Quảng cáo nạp lười (chỉ dựng khi bấm vào lần đầu) và HỦY khi rời tab để
// không giữ Chart.js cũ. Các control riêng của thống kê Page (chọn Page, Tải
// lại, thanh cào) được ẩn ở tab Quảng cáo vì không áp dụng cho quảng cáo.

const TAB_META = {
  page: {
    title: "Thống kê chi tiết theo Page",
    subtitle: "Toàn bộ lịch sử bài đăng · Facebook & Instagram · phân tích tương tác"
  },
  ads: {
    title: "Báo cáo quảng cáo",
    subtitle: "Chi tiêu, hiển thị và hiệu quả chiến dịch · Meta Ads Insights"
  }
};

// Giữ tham chiếu để hủy Chart.js của tab Quảng cáo khi rời tab.
let adsController = null;
let activeTab = "page";

function paintTabButtons(tab) {
  for (const btn of statsTabs.querySelectorAll("[data-stats-tab]")) {
    const isActive = btn.dataset.statsTab === tab;
    btn.className =
      "rounded-lg px-4 py-2 text-sm font-medium transition-colors " +
      (isActive ? "bg-brand-500 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100");
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  }
}

function switchTab(tab) {
  if (tab === activeTab || !TAB_META[tab]) return;
  activeTab = tab;
  paintTabButtons(tab);

  const meta = TAB_META[tab];
  statsTitle.textContent = meta.title;
  statsSubtitle.textContent = meta.subtitle;

  const showAds = tab === "ads";
  pageStatsControls.classList.toggle("hidden", showAds);
  crawlToolbar.classList.toggle("hidden", showAds);
  pageStatsView.classList.toggle("hidden", showAds);
  adsView.classList.toggle("hidden", !showAds);

  if (showAds) {
    // Dựng mới mỗi lần vào tab: dữ liệu luôn tươi, không giữ chart cũ.
    adsController = mountAdsSection(adsView);
  } else if (adsController) {
    // Rời tab Quảng cáo: hủy chart + dọn DOM để không rò rỉ.
    adsController.destroy();
    adsController = null;
  }
}

paintTabButtons("page");
for (const btn of statsTabs.querySelectorAll("[data-stats-tab]")) {
  btn.addEventListener("click", () => switchTab(btn.dataset.statsTab));
}

loadPages();
