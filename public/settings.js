import { fetchJson, formatTime, el } from "/shared/api.js";
import { mountShell } from "/shared/shell.js";

mountShell("/settings.html");

const channelsMount = document.querySelector("#channels-mount");
const channelIdsMount = document.querySelector("#channel-ids-mount");
const gbpLocationsButton = document.querySelector("#gbp-locations-button");
const gbpLocationsStatus = document.querySelector("#gbp-locations-status");
const gbpLocationsList = document.querySelector("#gbp-locations-list");

// Định nghĩa từng kênh: cách đọc trạng thái + link kết nối + endpoint ngắt.
const CHANNELS = [
  {
    key: "drive",
    name: "Google Drive",
    statusUrl: "/api/drive/status",
    connectUrl: "/auth/google/drive",
    disconnectUrl: "/api/drive/disconnect",
    notConfigured: "Thêm GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET và GOOGLE_DRIVE_REDIRECT_URI vào .env.",
    connectedText: () => "Có quyền đọc ảnh/video riêng tư từ Google Drive khi đăng bài.",
    disconnectedText: () => "Cần kết nối nếu ảnh trong Notion là link Drive không public."
  },
  {
    key: "instagram",
    name: "Instagram",
    statusUrl: "/api/instagram/status",
    connectUrl: "/auth/instagram",
    disconnectUrl: "/api/instagram/disconnect",
    notConfigured: "Thêm INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET và INSTAGRAM_REDIRECT_URI vào .env.",
    connectedText: (c) => [c.user && c.user.username ? `@${c.user.username}` : "Đã kết nối", c.user && c.user.expiresAt ? `hết hạn ${formatTime(c.user.expiresAt, "")}` : ""].filter(Boolean).join(" · "),
    disconnectedText: () => "Kết nối Instagram Business để chuẩn bị publish/sync IG."
  },
  {
    key: "gbp",
    name: "Google Business Profile",
    statusUrl: "/api/gbp/status",
    connectUrl: "/auth/google/business",
    disconnectUrl: "/api/gbp/disconnect",
    notConfigured: "Thêm GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET và GOOGLE_BUSINESS_REDIRECT_URI vào .env.",
    connectedText: (c) => ["Có quyền đăng local post.", c.expiresAt ? `hết hạn ${formatTime(c.expiresAt, "")}` : ""].filter(Boolean).join(" · "),
    disconnectedText: () => "Kết nối Google (scope business.manage) để đăng Google Business Profile."
  },
  {
    key: "tiktok",
    name: "TikTok",
    statusUrl: "/api/tiktok/status",
    connectUrl: "/auth/tiktok",
    disconnectUrl: "/api/tiktok/disconnect",
    notConfigured: "Thêm TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET và TIKTOK_REDIRECT_URI vào .env.",
    connectedText: (c) => [c.user && c.user.displayName ? c.user.displayName : "Đã kết nối", c.user && c.user.expiresAt ? `hết hạn ${formatTime(c.user.expiresAt, "")}` : ""].filter(Boolean).join(" · "),
    disconnectedText: () => "Kết nối TikTok (scope video.publish) để đăng video."
  }
];

function statusPill(configured, connected) {
  if (!configured) return el("span", { class: "inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 ring-1 ring-inset ring-slate-500/20", text: "Chưa cấu hình" });
  if (connected) return el("span", { class: "inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20", text: "Đã kết nối" });
  return el("span", { class: "inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20", text: "Chưa kết nối" });
}

function renderChannelCard(spec, channel) {
  const configured = Boolean(channel.configured);
  const connected = Boolean(channel.connected);
  const detail = !configured ? spec.notConfigured : connected ? spec.connectedText(channel) : spec.disconnectedText(channel);

  const actions = el("div", { class: "mt-4 flex gap-2" });
  if (configured && !connected) {
    actions.append(el("a", { class: "rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600", text: "Kết nối", attrs: { href: spec.connectUrl } }));
  }
  if (connected) {
    const disconnectBtn = el("button", {
      class: "rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50",
      text: "Ngắt kết nối",
      attrs: { type: "button" },
      on: {
        click: async () => {
          disconnectBtn.disabled = true;
          try {
            await fetchJson(spec.disconnectUrl, { method: "POST" });
            await loadChannels();
          } catch (error) {
            disconnectBtn.disabled = false;
            window.alert(error.message);
          }
        }
      }
    });
    actions.append(disconnectBtn);
  }

  return el("div", { class: "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" }, [
    el("div", { class: "flex items-center justify-between" }, [
      el("p", { class: "text-sm font-semibold text-slate-900", text: spec.name }),
      statusPill(configured, connected)
    ]),
    el("p", { class: "mt-2 text-xs text-slate-500", text: detail }),
    actions
  ]);
}

async function loadChannels() {
  const cards = await Promise.all(
    CHANNELS.map(async (spec) => {
      try {
        const data = await fetchJson(spec.statusUrl);
        return renderChannelCard(spec, data[spec.key] || {});
      } catch (error) {
        return renderChannelCard(spec, { configured: true, connected: false, __error: error.message });
      }
    })
  );
  channelsMount.replaceChildren(...cards);
}

// ---------- ID kênh để copy ----------

function channelIdRow(brandColumn, label, id) {
  const copyBtn = el("button", {
    class: "shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100",
    text: "Copy",
    attrs: { type: "button" },
    on: {
      click: async () => {
        try {
          await navigator.clipboard.writeText(id);
          copyBtn.textContent = "Đã copy";
          setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
        } catch {
          copyBtn.textContent = "Lỗi copy";
        }
      }
    }
  });

  return el("div", { class: "flex flex-wrap items-center gap-3 py-3" }, [
    el("div", { class: "min-w-[200px] flex-1" }, [
      el("p", { class: "text-sm font-medium text-slate-800", text: label }),
      el("p", { class: "text-xs text-slate-400", text: `→ ${brandColumn}` })
    ]),
    el("code", { class: "min-w-[140px] flex-1 break-all rounded bg-slate-50 px-2 py-1 text-xs text-slate-700", text: id }),
    copyBtn
  ]);
}

async function loadChannelIds() {
  try {
    const [pagesData, igData, tiktokData] = await Promise.all([
      fetchJson("/api/pages"),
      fetchJson("/api/instagram/status"),
      fetchJson("/api/tiktok/status")
    ]);

    const rows = [];
    for (const page of (pagesData && pagesData.pages) || []) {
      rows.push(channelIdRow("Facebook Page ID", `Facebook · ${page.name || page.id}`, page.id));
      const ig = page.instagramBusinessAccount;
      if (ig && ig.id) {
        rows.push(channelIdRow("Instagram Account ID", `Instagram · ${ig.username ? "@" + ig.username : "liên kết " + (page.name || page.id)}`, ig.id));
      }
    }
    const igStatus = igData && igData.instagram;
    if (igStatus && igStatus.connected && igStatus.user && igStatus.user.id) {
      rows.push(channelIdRow("Instagram Account ID", igStatus.user.username ? `Instagram · @${igStatus.user.username}` : "Instagram", igStatus.user.id));
    }
    const tiktok = tiktokData && tiktokData.tiktok;
    if (tiktok && tiktok.connected && tiktok.user && tiktok.user.openId) {
      rows.push(channelIdRow("TikTok Account ID", tiktok.user.displayName ? `TikTok · ${tiktok.user.displayName}` : "TikTok", tiktok.user.openId));
    }

    if (rows.length === 0) {
      channelIdsMount.replaceChildren(el("p", { class: "py-3 text-sm text-slate-400", text: "Chưa có ID nào. Hãy kết nối Facebook/Instagram/TikTok." }));
      return;
    }
    channelIdsMount.replaceChildren(...rows);
  } catch (error) {
    channelIdsMount.replaceChildren(el("p", { class: "py-3 text-sm text-rose-600", text: `Không tải được ID kênh: ${error.message}` }));
  }
}

async function loadGbpLocations() {
  gbpLocationsButton.disabled = true;
  gbpLocationsStatus.textContent = "Đang lấy danh sách địa điểm Google Business...";
  gbpLocationsList.replaceChildren();
  try {
    const data = await fetchJson("/api/gbp/locations");
    const locations = (data && data.locations) || [];
    if (locations.length === 0) {
      gbpLocationsStatus.textContent = "Không tìm thấy địa điểm nào (kiểm tra quyền tài khoản Google hoặc allowlist Business Profile API).";
      return;
    }
    gbpLocationsList.replaceChildren(
      ...locations.map((loc) =>
        channelIdRow("Google Business Profile ID", loc.title ? `Google Business · ${loc.title}${loc.address ? ` (${loc.address})` : ""}` : "Google Business", loc.id)
      )
    );
    gbpLocationsStatus.textContent = `Tìm thấy ${locations.length} địa điểm. Copy ID dán vào cột Google Business Profile ID của brand.`;
  } catch (error) {
    gbpLocationsStatus.textContent = error.message;
  } finally {
    gbpLocationsButton.disabled = false;
  }
}

gbpLocationsButton.addEventListener("click", loadGbpLocations);

loadChannels();
loadChannelIds();
