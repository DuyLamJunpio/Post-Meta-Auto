import { fetchJson, formatTime, el } from "/shared/api.js";
import { mountShell } from "/shared/shell.js";

mountShell("/posts.html");

const pageFilter = document.querySelector("#page-filter");
const tablesMount = document.querySelector("#tables-mount");
const autopublishStatus = document.querySelector("#autopublish-status");
const auditList = document.querySelector("#audit-list");

let pages = [];

const AVATAR_FALLBACK =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'%3E%3Crect width='96' height='96' fill='%23eef2f7'/%3E%3Ctext x='48' y='58' text-anchor='middle' font-family='Arial' font-size='34' fill='%234b5563'%3E%23%3C/text%3E%3C/svg%3E";

// ---------- Helpers dựng UI ----------

function badge(text, variant = "slate") {
  const map = {
    green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    red: "bg-rose-50 text-rose-700 ring-rose-600/20",
    amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
    slate: "bg-slate-100 text-slate-600 ring-slate-500/20",
    ig: "bg-pink-50 text-pink-700 ring-pink-600/20"
  };
  return el("span", {
    class: `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${map[variant] || map.slate}`,
    text
  });
}

function linkButton(label, href, tone = "slate") {
  const tones = {
    slate: "border-slate-200 text-slate-600 hover:bg-slate-100",
    brand: "border-brand-200 text-brand-700 hover:bg-brand-50",
    ig: "border-pink-200 text-pink-700 hover:bg-pink-50"
  };
  return el("a", {
    class: `inline-flex items-center rounded-lg border px-2.5 py-1.5 text-xs font-medium ${tones[tone] || tones.slate}`,
    text: label,
    attrs: { href, target: "_blank", rel: "noreferrer" }
  });
}

function dangerButton(label, onClick) {
  return el("button", {
    class: "inline-flex items-center rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50",
    text: label,
    attrs: { type: "button" },
    on: { click: onClick }
  });
}

function detailHeader({ avatarUrl, title, subtitle, tone, statusBadge }) {
  const ring = tone === "ig" ? "ring-pink-100" : "ring-brand-100";
  const avatar = el("img", {
    class: `h-11 w-11 rounded-full object-cover ring-2 ${ring}`,
    attrs: { alt: "", src: avatarUrl || AVATAR_FALLBACK }
  });
  avatar.addEventListener("error", () => {
    avatar.src = AVATAR_FALLBACK;
  });

  return el("div", { class: "flex items-center gap-3 border-b border-slate-100 p-4" }, [
    avatar,
    el("div", { class: "min-w-0 flex-1" }, [
      el("p", { class: "truncate text-sm font-bold text-slate-900", text: title }),
      el("p", { class: "truncate text-xs text-slate-500", text: subtitle })
    ]),
    statusBadge || null
  ]);
}

function tableCard(header, columns, rowsHtml) {
  const thead = el(
    "thead",
    { class: "bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500" },
    el(
      "tr",
      {},
      columns.map((c) =>
        el("th", { class: `px-4 py-3 ${c.align === "right" ? "text-right" : ""}`, text: c.label })
      )
    )
  );
  const tbody = el("tbody", { class: "divide-y divide-slate-100 text-sm" }, rowsHtml);
  const table = el("table", { class: "min-w-full" }, [thead, tbody]);
  const scroll = el("div", { class: "overflow-x-auto" }, table);
  return el("section", { class: "overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" }, [
    header,
    scroll
  ]);
}

function emptyRow(colSpan, text) {
  return el("tr", {}, el("td", { class: "px-4 py-10 text-center text-slate-400", attrs: { colspan: colSpan }, text }));
}

function contentCell(text) {
  return el("td", { class: "max-w-md px-4 py-3 align-top" }, [
    el("p", { class: "line-clamp-3 whitespace-pre-wrap text-slate-700", text: text || "(Không có nội dung văn bản)" })
  ]);
}

// ---------- Bảng Facebook ----------

async function renderFacebookTable(page) {
  const header = detailHeader({
    avatarUrl: page.pictureUrl,
    title: page.name,
    subtitle: `Facebook Page · ID ${page.id}`,
    tone: "brand",
    statusBadge: page.canCreateContent ? badge("Có quyền đăng", "green") : badge("Thiếu quyền đăng", "amber")
  });

  const columns = [
    { label: "Nội dung" },
    { label: "Thời gian" },
    { label: "Liên kết" },
    { label: "An toàn tự đăng", align: "right" }
  ];

  const section = tableCard(header, columns, [emptyRow(4, "Đang tải bài đăng Facebook...")]);

  try {
    const data = await fetchJson(`/api/pages/${encodeURIComponent(page.id)}/posts`);
    const posts = (data && data.posts) || [];
    const rows =
      posts.length === 0
        ? [emptyRow(4, "Chưa có bài đăng gần đây.")]
        : posts.map((post) => buildFacebookRow(page, post));
    replaceRows(section, rows);
  } catch (error) {
    replaceRows(section, [emptyRow(4, error.message)]);
  }

  return section;
}

function buildFacebookRow(page, post) {
  const timeCell = el("td", { class: "whitespace-nowrap px-4 py-3 align-top text-slate-500", text: formatTime(post.createdTime, "Không rõ") });
  const linkCell = el(
    "td",
    { class: "px-4 py-3 align-top" },
    post.permalinkUrl ? linkButton("Mở FB", post.permalinkUrl, "brand") : el("span", { class: "text-slate-400", text: "—" })
  );

  const retract = dangerButton("Thu hồi", async () => {
    if (!window.confirm(`Thu hồi (xóa) bài này khỏi Page "${page.name}"? Không thể hoàn tác.`)) {
      return;
    }
    retract.disabled = true;
    retract.textContent = "Đang thu hồi...";
    try {
      await fetchJson("/api/posts/facebook/retract", {
        method: "POST",
        body: JSON.stringify({ pageId: page.id, postId: post.id })
      });
      const row = retract.closest("tr");
      if (row) {
        row.classList.add("opacity-50");
        retract.replaceWith(badge("Đã thu hồi", "slate"));
      }
    } catch (error) {
      retract.disabled = false;
      retract.textContent = "Thu hồi";
      window.alert(error.message);
    }
  });

  const actionCell = el("td", { class: "px-4 py-3 align-top" }, el("div", { class: "flex justify-end" }, retract));

  return el("tr", { class: "hover:bg-slate-50/60" }, [contentCell(post.message), timeCell, linkCell, actionCell]);
}

// ---------- Bảng Instagram ----------

function igTypeLabel(type) {
  if (type === "VIDEO") return "Video";
  if (type === "CAROUSEL_ALBUM") return "Album";
  if (type === "IMAGE") return "Ảnh";
  return type || "—";
}

async function renderInstagramTable(page) {
  const ig = page.instagramBusinessAccount;
  const header = detailHeader({
    avatarUrl: ig.profilePictureUrl,
    title: ig.username ? `@${ig.username}` : "Instagram Business",
    subtitle: `Instagram · ID ${ig.id} · liên kết ${page.name}`,
    tone: "ig",
    statusBadge: badge("Instagram", "ig")
  });

  const columns = [
    { label: "Nội dung" },
    { label: "Loại" },
    { label: "Thời gian" },
    { label: "Liên kết" },
    { label: "An toàn tự đăng", align: "right" }
  ];

  const section = tableCard(header, columns, [emptyRow(5, "Đang tải bài đăng Instagram...")]);

  try {
    const data = await fetchJson(`/api/pages/${encodeURIComponent(page.id)}/instagram/media`);
    const media = (data && data.media) || [];
    const rows =
      media.length === 0 ? [emptyRow(5, "Chưa có bài đăng Instagram gần đây.")] : media.map((item) => buildInstagramRow(item));
    replaceRows(section, rows);
  } catch (error) {
    replaceRows(section, [emptyRow(5, error.message)]);
  }

  return section;
}

function buildInstagramRow(item) {
  const typeCell = el("td", { class: "whitespace-nowrap px-4 py-3 align-top" }, badge(igTypeLabel(item.mediaType), "slate"));
  const timeCell = el("td", { class: "whitespace-nowrap px-4 py-3 align-top text-slate-500", text: formatTime(item.createdTime, "Không rõ") });
  const linkCell = el(
    "td",
    { class: "px-4 py-3 align-top" },
    item.permalinkUrl ? linkButton("Mở IG", item.permalinkUrl, "ig") : el("span", { class: "text-slate-400", text: "—" })
  );

  // IG Graph API không hỗ trợ xóa bài đã đăng → chỉ ghi chú, xử lý thủ công trong app.
  const actionCell = el(
    "td",
    { class: "px-4 py-3 align-top text-right" },
    el("span", {
      class: "inline-flex max-w-[200px] items-center gap-1 rounded-lg bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20",
      text: "IG không cho xóa qua API — xóa thủ công trong app"
    })
  );

  return el("tr", { class: "hover:bg-slate-50/60" }, [contentCell(item.caption), typeCell, timeCell, linkCell, actionCell]);
}

// ---------- Tiện ích ----------

function replaceRows(section, rows) {
  const tbody = section.querySelector("tbody");
  if (!tbody) return;
  tbody.replaceChildren(...rows);
}

async function onSelectPage() {
  const pageId = pageFilter.value;
  tablesMount.replaceChildren();

  if (!pageId) {
    tablesMount.append(
      el("div", {
        class: "rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500",
        text: "Chọn một Page ở trên để xem danh sách bài đăng."
      })
    );
    return;
  }

  const page = pages.find((p) => p.id === pageId);
  if (!page) return;

  const hasInstagram = Boolean(page.instagramBusinessAccount && page.instagramBusinessAccount.id);

  // Chèn placeholder trước để giữ thứ tự (FB trước, IG sau) khi fetch song song.
  const fbSlot = el("div");
  tablesMount.append(fbSlot);
  renderFacebookTable(page).then((section) => fbSlot.replaceWith(section));

  if (hasInstagram) {
    const igSlot = el("div");
    tablesMount.append(igSlot);
    renderInstagramTable(page).then((section) => igSlot.replaceWith(section));
  }
}

function buildPageFilter() {
  const withIg = pages.filter((p) => p.instagramBusinessAccount && p.instagramBusinessAccount.id);
  const fbOnly = pages.filter((p) => !(p.instagramBusinessAccount && p.instagramBusinessAccount.id));

  const options = [el("option", { text: "— Chọn Page —", attrs: { value: "" } })];

  const makeOption = (p) => el("option", { text: p.name, attrs: { value: p.id } });

  if (withIg.length > 0) {
    const group = el("optgroup", { attrs: { label: "Có Instagram liên kết" } }, withIg.map(makeOption));
    options.push(group);
  }
  if (fbOnly.length > 0) {
    const group = el("optgroup", { attrs: { label: "Chỉ Facebook" } }, fbOnly.map(makeOption));
    options.push(group);
  }

  pageFilter.replaceChildren(...options);
}

async function loadPages() {
  try {
    const data = await fetchJson("/api/pages");
    pages = (data && data.pages) || [];
    if (pages.length === 0) {
      pageFilter.replaceChildren(el("option", { text: "Không có Page nào", attrs: { value: "" } }));
      return;
    }
    buildPageFilter();
  } catch (error) {
    pageFilter.replaceChildren(el("option", { text: error.message, attrs: { value: "" } }));
  }
}

// ---------- Điều khiển an toàn (pause/resume/status) ----------

function describeStatus(status) {
  if (!status.enabledByConfig) {
    return "⛔ Đã TẮT bằng biến môi trường (AUTO_PUBLISH_ENABLED=false).";
  }
  if (status.paused) {
    return `🛑 ĐANG TẠM DỪNG — ${status.pausedReason || "không rõ lý do"}.`;
  }
  const limits = status.limits || {};
  return `✅ Đang hoạt động — trần ${limits.maxPublishPerRun || "?"} bài/lượt, cooldown ${Math.round((limits.perPageCooldownMs || 0) / 60000)} phút/page, ngưỡng bất thường ${limits.anomalyThreshold || "?"}.`;
}

async function loadAutoPublishStatus() {
  try {
    const data = await fetchJson("/api/auto-publish/status");
    autopublishStatus.textContent = describeStatus(data.status);
  } catch (error) {
    autopublishStatus.textContent = error.message;
  }
}

async function pauseAutoPublish() {
  const reason = window.prompt("Lý do tạm dừng (tùy chọn):", "Tạm dừng thủ công bởi quản trị viên.");
  if (reason === null) return;
  try {
    const data = await fetchJson("/api/auto-publish/pause", {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    autopublishStatus.textContent = describeStatus(data.status);
  } catch (error) {
    autopublishStatus.textContent = error.message;
  }
}

async function resumeAutoPublish() {
  try {
    const data = await fetchJson("/api/auto-publish/resume", { method: "POST" });
    autopublishStatus.textContent = describeStatus(data.status);
  } catch (error) {
    autopublishStatus.textContent = error.message;
  }
}

// ---------- Nhật ký ----------

async function loadAudit() {
  auditList.textContent = "Đang tải nhật ký...";
  try {
    const data = await fetchJson("/api/auto-publish/audit?limit=20");
    const rows = (data && data.audit) || [];
    if (rows.length === 0) {
      auditList.textContent = "Chưa có nhật ký.";
      return;
    }
    const labels = { published: ["✅ Đã đăng", "green"], failed: ["❌ Lỗi", "red"], paused: ["🛑 Tạm dừng", "amber"], retracted: ["🗑️ Thu hồi", "slate"] };
    auditList.replaceChildren(
      ...rows.map((row) => {
        const [label, variant] = labels[row.event] || [row.event, "slate"];
        const detail = row.title || row.account_name || row.post_id || row.message || "";
        return el("div", { class: "flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2" }, [
          badge(label, variant),
          el("span", { class: "min-w-0 flex-1 truncate text-slate-600", text: detail }),
          el("span", { class: "text-xs text-slate-400", text: formatTime(row.created_at, "") })
        ]);
      })
    );
  } catch (error) {
    auditList.textContent = error.message;
  }
}

// ---------- Wiring ----------

pageFilter.addEventListener("change", onSelectPage);
document.querySelector("#autopublish-refresh").addEventListener("click", loadAutoPublishStatus);
document.querySelector("#autopublish-pause").addEventListener("click", pauseAutoPublish);
document.querySelector("#autopublish-resume").addEventListener("click", resumeAutoPublish);
document.querySelector("#audit-refresh").addEventListener("click", loadAudit);

loadPages();
loadAutoPublishStatus();
