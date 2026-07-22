import { fetchJson, formatTime, formatOverdue, normalizeText, el } from "/shared/api.js";
import { mountShell } from "/shared/shell.js";

mountShell("/tasks.html");

const tabsEl = document.querySelector("#task-tabs");
const searchInput = document.querySelector("#task-search");
const pageFilter = document.querySelector("#task-page-filter");
const listEl = document.querySelector("#task-list");
const statusEl = document.querySelector("#task-status");

let allTasks = [];
let activeTab = "all";

const STAGE_LABELS = {
  published: "Đã đăng",
  ready_to_schedule: "Sẵn sàng vào lịch",
  ready_to_publish: "Sẵn sàng đăng",
  publishing: "Đang đăng",
  failed: "Lỗi đăng",
  manual: "Đăng thủ công",
  blocked: "Cần kiểm tra"
};

const STAGE_TONE = {
  published: "green",
  ready_to_schedule: "green",
  ready_to_publish: "brand",
  publishing: "brand",
  failed: "red",
  manual: "amber",
  blocked: "amber"
};

// Tab lọc → hàm kiểm tra task thuộc tab.
const TABS = [
  { key: "all", label: "Tất cả", match: () => true },
  { key: "pending", label: "Chờ đăng", match: (t) => ["ready_to_schedule", "ready_to_publish", "publishing"].includes(t.taskStage) },
  { key: "published", label: "Đã đăng", match: (t) => t.taskStage === "published" },
  { key: "failed", label: "Lỗi đăng", match: (t) => t.taskStage === "failed" },
  { key: "attention", label: "Cần kiểm tra", match: (t) => ["blocked", "manual"].includes(t.taskStage) },
  { key: "overdue", label: "Quá hạn <24h", match: (t) => t.overdue && !t.tooOldOverdue }
];

function badge(text, variant = "slate") {
  const map = {
    green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    red: "bg-rose-50 text-rose-700 ring-rose-600/20",
    amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
    brand: "bg-brand-50 text-brand-700 ring-brand-600/20",
    slate: "bg-slate-100 text-slate-600 ring-slate-500/20"
  };
  return el("span", {
    class: `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${map[variant] || map.slate}`,
    text
  });
}

function getTaskReasons(task) {
  if (task.isPublished || task.readyToPublish || task.readyToSchedule) return [];
  if (task.publishStatus === "Chưa lên lịch") return Array.from(new Set(task.scheduleReasons || [])).filter(Boolean);
  if (task.publishStatus === "Đã lên lịch") return Array.from(new Set(task.reasons || [])).filter(Boolean);
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
      const button = el("button", {
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
        el("span", {
          class: `rounded-full px-1.5 text-xs ${isActive ? "bg-white/20" : "bg-slate-100 text-slate-500"}`,
          text: String(count)
        })
      ]);
      return button;
    })
  );
}

function actionCell(task) {
  const wrap = el("div", { class: "flex flex-wrap justify-end gap-1.5" });

  if (!task.isPublished && (task.readyToSchedule || task.readyToPublish) && task.page && task.page.canCreateContent) {
    const btn = el("button", {
      class: "rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50",
      text: task.readyToSchedule ? "Đưa vào lịch" : "Đăng",
      attrs: { type: "button" },
      on: {
        click: async () => {
          btn.disabled = true;
          statusEl.textContent = "Đang xử lý tác vụ...";
          try {
            const data = await fetchJson(`/api/notion/tasks/${encodeURIComponent(task.id)}/publish`, { method: "POST" });
            statusEl.textContent = data.message || "Xử lý thành công.";
            await loadTasks();
          } catch (error) {
            statusEl.textContent = error.message;
            btn.disabled = false;
          }
        }
      }
    });
    wrap.append(btn);
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
  if (task.notionUrl) {
    wrap.append(linkOut("Notion", task.notionUrl));
  }
  if (task.facebookPostUrl) {
    wrap.append(linkOut("Facebook", task.facebookPostUrl));
  }
  if (wrap.children.length === 0) {
    wrap.append(el("span", { class: "text-xs text-slate-400", text: "—" }));
  }
  return el("td", { class: "px-4 py-3 align-top" }, wrap);
}

function linkOut(label, href) {
  return el("a", {
    class: "rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100",
    text: label,
    attrs: { href, target: "_blank", rel: "noreferrer" }
  });
}

function reasonCell(task) {
  const cell = el("td", { class: "max-w-xs px-4 py-3 align-top" });
  if (task.errorMessage) {
    cell.append(el("p", { class: "text-xs font-medium text-rose-600", text: task.errorMessage }));
  }
  const reasons = getTaskReasons(task);
  if (reasons.length > 0) {
    cell.append(
      el("ul", { class: "mt-1 list-disc space-y-0.5 pl-4 text-xs text-slate-500" }, reasons.map((r) => el("li", { text: r })))
    );
  } else if (!task.errorMessage) {
    cell.append(el("span", { class: "text-xs text-slate-400", text: "—" }));
  }
  return cell;
}

function taskRow(task) {
  const titleCell = el("td", { class: "max-w-xs px-4 py-3 align-top" }, [
    el("p", { class: "font-semibold text-slate-800", text: task.title || "(Chưa có tiêu đề)" }),
    el("p", { class: "mt-0.5 line-clamp-2 text-xs text-slate-500", text: task.caption || "Chưa có nội dung" })
  ]);

  const pageCell = el("td", { class: "px-4 py-3 align-top text-slate-600", text: task.page ? task.page.name : "Chưa có Page" });

  const scheduleCell = el("td", { class: "whitespace-nowrap px-4 py-3 align-top text-slate-600" }, [
    el("span", { text: formatTime(task.publishAt) }),
    task.overdue && !task.tooOldOverdue ? el("p", { class: "text-xs text-amber-600", text: formatOverdue(task.overdueMs) }) : null
  ]);

  const formatCell = el("td", { class: "px-4 py-3 align-top text-slate-600" }, [
    el("span", { text: task.postType || task.postFormat || "Văn bản" }),
    el("p", { class: "text-xs text-slate-400", text: `${task.mediaCount || 0} tệp` })
  ]);

  const stageCell = el("td", { class: "px-4 py-3 align-top" }, [
    badge(STAGE_LABELS[task.taskStage] || "Cần kiểm tra", STAGE_TONE[task.taskStage] || "slate"),
    el("p", { class: "mt-1 text-xs text-slate-400", text: task.publishStatus || "" })
  ]);

  return el("tr", { class: "hover:bg-slate-50/60" }, [titleCell, pageCell, scheduleCell, formatCell, stageCell, reasonCell(task), actionCell(task)]);
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
  const pairs = Array.from(
    new Map(allTasks.filter((t) => t.page).map((t) => [t.page.id, t.page.name])).entries()
  ).sort((a, b) => a[1].localeCompare(b[1], "vi"));

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

searchInput.addEventListener("input", render);
pageFilter.addEventListener("change", render);

loadTasks();
