import { fetchJson, formatFull, formatCountdown, normalizeText, el } from "/shared/api.js";
import { mountShell } from "/shared/shell.js";
import { openEditDrawer } from "/tasks-drawer.js";

mountShell("/tasks.html");

const tabsEl = document.querySelector("#task-tabs");
const searchInput = document.querySelector("#task-search");
const pageFilter = document.querySelector("#task-page-filter");
const listEl = document.querySelector("#task-list");
const statusEl = document.querySelector("#task-status");
const actStatusEl = document.querySelector("#act-status");

let allTasks = [];
let brands = [];
let activeTab = "all";

const SCHEDULED_STATUS = "Đã lên lịch";

const STAGE_LABELS = {
  published: "Đã đăng",
  ready_to_schedule: "Sẵn sàng vào lịch",
  ready_to_publish: "Sẵn sàng đăng",
  scheduled: "Đã lên lịch",
  publishing: "Đang đăng",
  failed: "Lỗi đăng",
  manual: "Đăng thủ công",
  blocked: "Cần kiểm tra"
};

const STAGE_TONE = {
  published: "green",
  ready_to_schedule: "green",
  ready_to_publish: "brand",
  scheduled: "blue",
  publishing: "brand",
  failed: "red",
  manual: "amber",
  blocked: "amber"
};

// Trạng thái hiển thị: task "Đã lên lịch" nhưng chưa tới giờ vốn bị xếp "blocked" (lý do chưa đến giờ)
// -> hiển thị đúng là "Đã lên lịch" cho rõ ràng.
function displayStage(task) {
  if (!task.isPublished && task.publishStatus === SCHEDULED_STATUS && !task.readyToPublish) {
    return "scheduled";
  }
  return task.taskStage;
}

// Tab lọc → hàm kiểm tra task thuộc tab.
const TABS = [
  { key: "all", label: "Tất cả", match: () => true },
  { key: "pending", label: "Sẵn sàng", match: (t) => ["ready_to_schedule", "ready_to_publish", "publishing"].includes(displayStage(t)) },
  { key: "scheduled", label: "Đã lên lịch", match: (t) => displayStage(t) === "scheduled" },
  { key: "published", label: "Đã đăng", match: (t) => displayStage(t) === "published" },
  { key: "failed", label: "Lỗi đăng", match: (t) => displayStage(t) === "failed" },
  { key: "attention", label: "Cần kiểm tra", match: (t) => ["blocked", "manual"].includes(displayStage(t)) },
  { key: "overdue", label: "Quá hạn", match: (t) => t.overdue }
];

function badge(text, variant = "slate") {
  const map = {
    green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    red: "bg-rose-50 text-rose-700 ring-rose-600/20",
    amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
    brand: "bg-brand-50 text-brand-700 ring-brand-600/20",
    blue: "bg-sky-50 text-sky-700 ring-sky-600/20",
    slate: "bg-slate-100 text-slate-600 ring-slate-500/20"
  };
  return el("span", {
    class: `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${map[variant] || map.slate}`,
    text
  });
}

function getTaskReasons(task) {
  if (task.isPublished || task.readyToPublish || task.readyToSchedule) return [];
  // Task đã lên lịch chờ đến giờ: không phải lỗi, không liệt kê "chưa đến giờ" như một vấn đề.
  if (displayStage(task) === "scheduled") return [];
  if (task.publishStatus === "Chưa lên lịch") return Array.from(new Set(task.scheduleReasons || [])).filter(Boolean);
  if (task.publishStatus === SCHEDULED_STATUS) return Array.from(new Set(task.reasons || [])).filter(Boolean);
  return Array.from(new Set([...(task.scheduleReasons || []), ...(task.reasons || [])])).filter(Boolean);
}

function matchesSearchAndPage(task) {
  const query = normalizeText(searchInput.value);
  const page = pageFilter.value;
  if (page !== "all" && (!task.page || task.page.id !== page)) return false;
  if (!query) return true;
  const searchable = normalizeText(
    [
      task.title,
      task.caption,
      task.page && task.page.name,
      task.brand && task.brand.name,
      task.postType || task.postFormat,
      task.publishStatus,
      Array.isArray(task.tags) ? task.tags.join(" ") : "",
      task.facebookPostId,
      task.facebookPostUrl,
      getTaskReasons(task).join(" ")
    ].join(" ")
  );
  return searchable.includes(query);
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...TABS.map((tab) => {
      const count = allTasks.filter((t) => tab.match(t) && matchesSearchAndPage(t)).length;
      const isActive = tab.key === activeTab;
      return el("button", {
        class: [
          "inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
          isActive ? "bg-brand-500 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
        ].join(" "),
        attrs: { type: "button" },
        on: {
          click: () => {
            activeTab = tab.key;
            render();
          }
        }
      }, [
        el("span", { text: tab.label }),
        el("span", { class: `rounded-full px-1.5 text-xs ${isActive ? "bg-white/20" : "bg-slate-100 text-slate-500"}`, text: String(count) })
      ]);
    })
  );
}

// PATCH nhanh 1 field rồi reload.
async function patchTask(task, patch, workingLabel) {
  statusEl.textContent = workingLabel || "Đang lưu...";
  const data = await fetchJson(`/api/notion/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
  statusEl.textContent = data.message || "Đã lưu.";
  await loadTasks();
}

function primaryButton(text, onClick, tone = "brand") {
  const cls = tone === "brand"
    ? "rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
    : "rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50";
  const btn = el("button", { class: cls, text, attrs: { type: "button" } });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await onClick();
    } catch (error) {
      statusEl.textContent = error.message;
      btn.disabled = false;
    }
  });
  return btn;
}

function linkOut(label, href) {
  return el("a", {
    class: "rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100",
    text: label,
    attrs: { href, target: "_blank", rel: "noreferrer" }
  });
}

function actionCell(task) {
  const wrap = el("div", { class: "flex flex-wrap justify-end gap-1.5" });
  const canPost = task.page && task.page.canCreateContent;

  // Sẵn sàng: đưa vào lịch / đăng.
  if (!task.isPublished && (task.readyToSchedule || task.readyToPublish) && canPost) {
    wrap.append(
      primaryButton(task.readyToSchedule ? "Đưa vào lịch" : "Đăng", async () => {
        statusEl.textContent = "Đang xử lý tác vụ...";
        const data = await fetchJson(`/api/notion/tasks/${encodeURIComponent(task.id)}/publish`, { method: "POST" });
        statusEl.textContent = data.message || "Xử lý thành công.";
        await loadTasks();
      })
    );
  }

  // Đã lên lịch (chưa tới giờ): cho phép đăng ngay (dời giờ về hiện tại rồi đăng).
  if (displayStage(task) === "scheduled" && canPost) {
    wrap.append(
      primaryButton("Đăng ngay", async () => {
        await patchTask(task, { publishAt: new Date().toISOString(), resetSchedule: true }, "Đang chuyển sang đăng ngay...");
        const data = await fetchJson(`/api/notion/tasks/${encodeURIComponent(task.id)}/publish`, { method: "POST" });
        statusEl.textContent = data.message || "Đã đăng.";
        await loadTasks();
      })
    );
  }

  // Quá hạn >24h: dời lịch về bây giờ để đủ điều kiện lại.
  if (task.tooOldOverdue && !task.isPublished) {
    wrap.append(
      primaryButton("Dời lịch → bây giờ", () => patchTask(task, { publishAt: new Date().toISOString(), resetSchedule: true }, "Đang dời lịch..."), "ghost")
    );
  }

  // Sửa nhanh (luôn có cho task chưa đăng).
  if (!task.isPublished) {
    wrap.append(
      primaryButton("Sửa nhanh", () => {
        openEditDrawer({ task, brands, onSaved: () => loadTasks() });
        return Promise.resolve();
      }, "ghost")
    );
  }

  if (task.page) {
    wrap.append(
      el("a", {
        class: "rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100",
        text: "Page",
        attrs: { href: `/page-posts.html?pageId=${encodeURIComponent(task.page.id)}` }
      })
    );
  }
  if (task.notionUrl) wrap.append(linkOut("Notion", task.notionUrl));
  if (task.facebookPostUrl) wrap.append(linkOut("Facebook", task.facebookPostUrl));
  if (wrap.children.length === 0) wrap.append(el("span", { class: "text-xs text-slate-400", text: "—" }));

  return el("td", { class: "px-4 py-3 align-top" }, wrap);
}

function reasonCell(task) {
  const cell = el("td", { class: "max-w-xs px-4 py-3 align-top" });
  if (task.errorMessage) {
    cell.append(el("p", { class: "text-xs font-medium text-rose-600", text: task.errorMessage }));
  }
  const reasons = getTaskReasons(task);
  if (reasons.length > 0) {
    cell.append(el("ul", { class: "mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-500" }, reasons.map((r) => el("li", { text: r }))));
  } else if (!task.errorMessage) {
    cell.append(el("span", { class: "text-xs text-slate-400", text: "—" }));
  }
  return cell;
}

function scheduleCell(task) {
  const cd = formatCountdown(task.publishAt);
  const tone = cd.tone === "overdue" ? "text-rose-600" : cd.tone === "future" ? "text-sky-600" : "text-slate-400";
  return el("td", { class: "whitespace-nowrap px-4 py-3 align-top" }, [
    el("p", { class: "text-slate-700", text: formatFull(task.publishAt) }),
    el("p", { class: `text-xs ${tone}`, text: cd.label }),
    task.timezone ? el("p", { class: "text-[11px] text-slate-400", text: task.timezone }) : null
  ]);
}

function taskRow(task) {
  const stage = displayStage(task);
  const titleCell = el("td", { class: "max-w-xs px-4 py-3 align-top" }, [
    el("p", { class: "font-semibold text-slate-800", text: task.title || "(Chưa có tiêu đề)" }),
    el("p", { class: "mt-0.5 line-clamp-2 text-xs text-slate-500", text: task.caption || "Chưa có nội dung" }),
    task.channel ? el("p", { class: "mt-1 text-[11px] font-medium text-slate-400", text: task.channel }) : null
  ]);

  const pageCell = el("td", { class: "px-4 py-3 align-top text-slate-600", text: task.page ? task.page.name : task.brand ? task.brand.name : "Chưa có Page" });

  const formatCell = el("td", { class: "px-4 py-3 align-top text-slate-600" }, [
    el("span", { text: task.postType || task.postFormat || "Văn bản" }),
    el("p", { class: "text-xs text-slate-400", text: `${task.contentType || "?"} · ${task.mediaCount || 0} tệp` })
  ]);

  const stageCell = el("td", { class: "px-4 py-3 align-top" }, [
    badge(STAGE_LABELS[stage] || "Cần kiểm tra", STAGE_TONE[stage] || "slate"),
    el("p", { class: "mt-1 text-xs text-slate-400", text: task.publishStatus || "" })
  ]);

  return el("tr", { class: "hover:bg-slate-50/60" }, [titleCell, pageCell, scheduleCell(task), formatCell, stageCell, reasonCell(task), actionCell(task)]);
}

function render() {
  renderTabs();
  const tab = TABS.find((t) => t.key === activeTab) || TABS[0];
  const rows = allTasks.filter((t) => tab.match(t) && matchesSearchAndPage(t));
  if (rows.length === 0) {
    listEl.replaceChildren(
      el("tr", {}, el("td", { class: "px-4 py-10 text-center text-slate-400", attrs: { colspan: 7 }, text: "Không có tác vụ nào khớp bộ lọc." }))
    );
    return;
  }
  listEl.replaceChildren(...rows.map(taskRow));
}

function buildPageFilter() {
  const current = pageFilter.value || "all";
  const pairs = Array.from(new Map(allTasks.filter((t) => t.page).map((t) => [t.page.id, t.page.name])).entries()).sort((a, b) =>
    a[1].localeCompare(b[1], "vi")
  );
  pageFilter.replaceChildren(
    el("option", { text: "Tất cả Page", attrs: { value: "all" } }),
    ...pairs.map(([id, name]) => el("option", { text: name, attrs: { value: id } }))
  );
  pageFilter.value = pairs.some(([id]) => id === current) ? current : "all";
}

async function loadTasks() {
  try {
    statusEl.textContent = "Đang tải tác vụ Notion...";
    const data = await fetchJson("/api/notion/tasks");
    allTasks = data.tasks || [];
    buildPageFilter();
    render();
    statusEl.textContent = `${data.totalCount} tác vụ · ${data.scheduleReadyCount || 0} sẵn sàng vào lịch · ${data.readyCount || 0} sẵn sàng đăng · ${data.overdueCount || 0} quá hạn dưới 24 giờ.`;
  } catch (error) {
    allTasks = [];
    render();
    statusEl.textContent = error.message;
  }
}

async function loadBrands() {
  try {
    const data = await fetchJson("/api/notion/brands");
    brands = data.brands || [];
  } catch {
    brands = [];
  }
}

// ---- Hành động hàng loạt ----
function wireBulk(id, url, label) {
  const btn = document.querySelector(id);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const buttons = document.querySelectorAll("#act-publish-due, #act-publish-overdue, #act-retry-failed, #act-refresh");
    buttons.forEach((b) => (b.disabled = true));
    actStatusEl.textContent = `Đang ${label}...`;
    try {
      const data = await fetchJson(url, { method: "POST" });
      const parts = [];
      if (data.schedule) parts.push(`${data.schedule.successCount} vào lịch`);
      if (typeof data.successCount === "number") parts.push(`${data.successCount} thành công`);
      if (typeof data.failureCount === "number") parts.push(`${data.failureCount} lỗi`);
      if (typeof data.skippedCount === "number") parts.push(`${data.skippedCount} bỏ qua`);
      actStatusEl.textContent = parts.length ? parts.join(" · ") : data.message || "Hoàn tất.";
      await loadTasks();
    } catch (error) {
      actStatusEl.textContent = error.message;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  });
}

function disableBulk(v) {
  document
    .querySelectorAll("#act-publish-due, #act-publish-overdue, #act-retry-failed, #act-refresh, #act-publish-all, #act-stagger")
    .forEach((b) => (b.disabled = v));
}

// Ứng viên đăng hàng loạt: task đã đủ nội dung nhưng còn kẹt vì lịch/giờ (KHÔNG gồm task bị chặn thật sự).
function isBulkCandidate(task) {
  if (task.isPublished || !task.page || !task.page.canCreateContent) return false;
  return task.readyToPublish || task.readyToSchedule || displayStage(task) === "scheduled" || task.overdue;
}

// Đăng NGAY toàn bộ task sẵn sàng, lần lượt từng cái (đi qua endpoint đăng đơn -> bỏ qua phanh an toàn).
async function publishAllReady() {
  const targets = allTasks.filter(isBulkCandidate);
  if (targets.length === 0) {
    actStatusEl.textContent = "Không có task nào sẵn sàng để đăng.";
    return;
  }
  if (!window.confirm(`Đăng NGAY ${targets.length} bài lên Page/Instagram thật?\nHành động này bỏ qua phanh an toàn (trần/cooldown) và không thể hoàn tác.`)) {
    return;
  }
  disableBulk(true);
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    actStatusEl.textContent = `Đang đăng ${i + 1}/${targets.length}: ${t.title || "(không tên)"}...`;
    try {
      if (!t.readyToPublish) {
        await fetchJson(`/api/notion/tasks/${encodeURIComponent(t.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ publishAt: new Date().toISOString(), resetSchedule: true })
        });
      }
      await fetchJson(`/api/notion/tasks/${encodeURIComponent(t.id)}/publish`, { method: "POST" });
      ok++;
    } catch {
      fail++;
    }
  }
  actStatusEl.textContent = `Đăng xong: ${ok} thành công · ${fail} lỗi.`;
  disableBulk(false);
  await loadTasks();
}

// Giãn lịch: rải Publish At cách đều nhau (mặc định 11 phút) để vòng lặp tự đăng lần lượt.
async function staggerSchedule() {
  const targets = allTasks.filter(isBulkCandidate);
  if (targets.length === 0) {
    actStatusEl.textContent = "Không có task nào để giãn lịch.";
    return;
  }
  const input = window.prompt(
    `Giãn lịch ${targets.length} task: mỗi bài cách nhau bao nhiêu phút?\n(Khuyến nghị ≥ 10 phút để tránh phanh an toàn của page.)`,
    "11"
  );
  if (input === null) return;
  const spacing = Math.max(1, Number(input) || 11);
  disableBulk(true);
  const base = Date.now();
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const when = new Date(base + i * spacing * 60000).toISOString();
    actStatusEl.textContent = `Đang đặt lịch ${i + 1}/${targets.length}...`;
    try {
      await fetchJson(`/api/notion/tasks/${encodeURIComponent(targets[i].id)}`, {
        method: "PATCH",
        body: JSON.stringify({ publishAt: when, resetSchedule: true })
      });
      ok++;
    } catch {
      fail++;
    }
  }
  await resumeGuardIfPaused();
  actStatusEl.textContent = `Đã giãn lịch ${ok} task (mỗi ${spacing} phút)${fail ? ` · ${fail} lỗi` : ""}. Vòng lặp sẽ tự đăng lần lượt.`;
  disableBulk(false);
  await loadTasks();
}

// ---- Phanh an toàn (guard) ----
async function loadGuardStatus() {
  const banner = document.querySelector("#guard-banner");
  try {
    const data = await fetchJson("/api/auto-publish/status");
    const s = data.status || {};
    if (s.paused) {
      document.querySelector("#guard-reason").textContent = s.pausedReason || "Tự đăng đang tạm dừng.";
      banner.classList.remove("hidden");
      banner.classList.add("flex");
    } else {
      banner.classList.add("hidden");
      banner.classList.remove("flex");
    }
  } catch {
    banner.classList.add("hidden");
  }
}

async function resumeGuardIfPaused() {
  try {
    const data = await fetchJson("/api/auto-publish/status");
    if (data.status && data.status.paused) {
      await fetchJson("/api/auto-publish/resume", { method: "POST" });
    }
  } catch {
    /* bỏ qua */
  }
}

document.querySelector("#guard-resume").addEventListener("click", async () => {
  try {
    await fetchJson("/api/auto-publish/resume", { method: "POST" });
    actStatusEl.textContent = "Đã bật lại tự đăng.";
    await loadGuardStatus();
  } catch (error) {
    actStatusEl.textContent = error.message;
  }
});

document.querySelector("#act-refresh").addEventListener("click", () => {
  loadGuardStatus();
  loadTasks();
});
document.querySelector("#act-publish-all").addEventListener("click", publishAllReady);
document.querySelector("#act-stagger").addEventListener("click", staggerSchedule);
wireBulk("#act-publish-due", "/api/notion/publish-due", "xử lý tác vụ đến hạn");
wireBulk("#act-publish-overdue", "/api/notion/publish-overdue", "đăng lại bài quá hạn");
wireBulk("#act-retry-failed", "/api/notion/retry-failed", "chuẩn bị task lỗi");

searchInput.addEventListener("input", render);
pageFilter.addEventListener("change", render);

loadBrands();
loadGuardStatus();
loadTasks();
