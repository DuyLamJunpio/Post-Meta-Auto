import { fetchJson, el } from "/shared/api.js";
import { mountShell } from "/shared/shell.js";

mountShell("/dashboard.html");

const userEl = document.querySelector("#overview-user");
const statusEl = document.querySelector("#overview-status");
const channelStatusEl = document.querySelector("#channel-status");

function setMetric(id, value) {
  const node = document.querySelector(id);
  if (node) node.textContent = value;
}

async function loadOverview() {
  try {
    const [me, pagesData] = await Promise.all([fetchJson("/api/me"), fetchJson("/api/pages")]);
    if (me && me.user) userEl.textContent = `Đang đăng nhập: ${me.user.name}`;
    if (pagesData) setMetric("#metric-pages", pagesData.pageCount ?? 0);
  } catch (error) {
    statusEl.textContent = error.message;
  }

  try {
    const data = await fetchJson("/api/notion/tasks");
    const tasks = data.tasks || [];
    const scheduledCount = tasks.filter(
      (t) => !t.isPublished && t.publishStatus === "Đã lên lịch" && !t.readyToPublish
    ).length;
    const publishedCount = tasks.filter((t) => t.isPublished).length;
    const failedCount = tasks.filter((t) => t.taskStage === "failed").length;

    setMetric("#metric-total", data.totalCount ?? tasks.length);
    setMetric("#metric-ready", data.scheduleReadyCount ?? 0);
    setMetric("#metric-publish", data.readyCount ?? 0);
    setMetric("#metric-scheduled", scheduledCount);
    setMetric("#metric-overdue", data.overdueCount ?? 0);
    setMetric("#metric-published", publishedCount);
    setMetric("#metric-failed", failedCount);
    statusEl.textContent = `${data.totalCount} tác vụ · ${data.scheduleReadyCount || 0} sẵn sàng vào lịch · ${data.readyCount || 0} sẵn sàng đăng · ${scheduledCount} đã lên lịch · ${publishedCount} đã đăng · ${failedCount} lỗi.`;
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

// ---------- Trạng thái kênh (chỉ đọc, quản lý ở Settings) ----------

function channelCard(name, statusText, connected, configured) {
  let tone = "bg-slate-100 text-slate-600 ring-slate-500/20";
  let label = "Chưa kết nối";
  if (!configured) {
    tone = "bg-slate-100 text-slate-500 ring-slate-500/20";
    label = "Chưa cấu hình";
  } else if (connected) {
    tone = "bg-emerald-50 text-emerald-700 ring-emerald-600/20";
    label = "Đã kết nối";
  } else {
    tone = "bg-amber-50 text-amber-700 ring-amber-600/20";
    label = "Chưa kết nối";
  }

  return el("div", { class: "rounded-xl border border-slate-100 bg-slate-50 p-4" }, [
    el("div", { class: "flex items-center justify-between" }, [
      el("p", { class: "text-sm font-semibold text-slate-800", text: name }),
      el("span", { class: `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`, text: label })
    ]),
    el("p", { class: "mt-1 text-xs text-slate-500", text: statusText })
  ]);
}

async function loadChannels() {
  const specs = [
    { url: "/api/drive/status", key: "drive", name: "Google Drive", detail: (d) => (d.connected ? "Sẵn sàng đọc media riêng tư" : "Kết nối để đọc ảnh/video Drive") },
    { url: "/api/instagram/status", key: "instagram", name: "Instagram", detail: (d) => (d.connected && d.user ? `@${d.user.username || "đã kết nối"}` : "Kết nối Instagram Business") },
    { url: "/api/gbp/status", key: "gbp", name: "Google Business", detail: () => "Đăng local post theo location" },
    { url: "/api/tiktok/status", key: "tiktok", name: "TikTok", detail: (d) => (d.connected && d.user ? d.user.displayName || "Đã kết nối" : "Kết nối để đăng video") }
  ];

  const cards = await Promise.all(
    specs.map(async (spec) => {
      try {
        const data = await fetchJson(spec.url);
        const channel = data[spec.key] || {};
        return channelCard(spec.name, spec.detail(channel), channel.connected, channel.configured);
      } catch (error) {
        return channelCard(spec.name, error.message, false, true);
      }
    })
  );

  channelStatusEl.replaceChildren(...cards);
}

// Tổng quan chỉ hiển thị thống kê (chỉ đọc). Mọi hành động đăng/lên lịch nằm ở trang Tác vụ.

loadOverview();
loadChannels();
