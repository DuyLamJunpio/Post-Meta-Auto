import { fetchJson, el, formatTime } from "/shared/api.js";
import { mountShell } from "/shared/shell.js";

mountShell("/statistics.html");

const pageSelect = document.querySelector("#page-select");
const refreshBtn = document.querySelector("#refresh-btn");
const statusEl = document.querySelector("#status");
const warningsEl = document.querySelector("#warnings");
const reportEl = document.querySelector("#report");

let chartInstances = [];

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

// --- Tải & điều phối -------------------------------------------------------

async function loadPages() {
  try {
    const data = await fetchJson("/api/pages");
    const pages = (data && data.pages) || [];
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
  statusEl.textContent = "Đang kéo toàn bộ lịch sử và tính thống kê… (có thể mất một lúc với Page nhiều bài)";
  refreshBtn.disabled = true;
  pageSelect.disabled = true;

  try {
    const data = await fetchJson(`/api/stats/pages/${encodeURIComponent(pageId)}`);
    const analytics = data.analytics;

    renderWarnings(analytics.warnings);
    statusEl.textContent = `Báo cáo tạo lúc ${formatTime(analytics.generatedAt)}.`;

    renderFacebook(analytics.facebook);
    if (analytics.instagram) {
      renderInstagram(analytics.instagram);
    }
  } catch (error) {
    statusEl.textContent = `Lỗi: ${error.message}`;
  } finally {
    refreshBtn.disabled = false;
    pageSelect.disabled = false;
  }
}

pageSelect.addEventListener("change", () => loadReport(pageSelect.value));
refreshBtn.addEventListener("click", () => loadReport(pageSelect.value));

loadPages();
