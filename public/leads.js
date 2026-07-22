import { fetchJson, formatTime, el } from "/shared/api.js";
import { mountShell } from "/shared/shell.js";

mountShell("/leads.html");

const listEl = document.querySelector("#leads-list");
const statusEl = document.querySelector("#leads-status");
const refreshButton = document.querySelector("#refresh-button");
const notionStatusEl = document.querySelector("#notion-status");
const createNotionButton = document.querySelector("#create-notion-button");
const notionDetailEl = document.querySelector("#notion-detail");

function badge(text, ok) {
  return el("span", {
    class: `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
      ok ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" : "bg-slate-100 text-slate-500 ring-slate-500/20"
    }`,
    text
  });
}

function row(lead) {
  return el("tr", { class: "hover:bg-slate-50/60" }, [
    el("td", { class: "whitespace-nowrap px-4 py-3 text-slate-500", text: formatTime(lead.createdAt, "") }),
    el("td", { class: "px-4 py-3 font-medium text-slate-800", text: lead.name || "(không tên)" }),
    el("td", { class: "whitespace-nowrap px-4 py-3" }, lead.phone ? el("a", { class: "text-brand-600 hover:underline", text: lead.phone, attrs: { href: `tel:${lead.phone}` } }) : el("span", { class: "text-slate-400", text: "—" })),
    el("td", { class: "px-4 py-3 text-slate-600", text: lead.email || "—" }),
    el("td", { class: "max-w-xs px-4 py-3 text-slate-600", text: lead.note || "—" }),
    el("td", { class: "px-4 py-3 text-xs text-slate-400", text: lead.fbId || "—" }),
    el("td", { class: "px-4 py-3" }, badge(lead.consent ? "Đã đồng ý" : "Chưa", lead.consent))
  ]);
}

async function loadLeads() {
  refreshButton.disabled = true;
  statusEl.textContent = "Đang tải danh sách lead...";
  try {
    const data = await fetchJson("/api/leads");
    const leads = data.leads || [];
    if (leads.length === 0) {
      listEl.replaceChildren(el("tr", {}, el("td", { class: "px-4 py-10 text-center text-slate-400", attrs: { colspan: 7 }, text: "Chưa có lead nào." })));
      statusEl.textContent = "0 lead.";
      return;
    }
    listEl.replaceChildren(...leads.map(row));
    statusEl.textContent = `${leads.length} lead.`;
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    refreshButton.disabled = false;
  }
}

async function loadNotionStatus() {
  try {
    const data = await fetchJson("/api/leads/notion/status");
    const status = data.status || {};

    if (status.dataSourceId) {
      notionStatusEl.textContent = status.fromEnv
        ? "✅ Đang đồng bộ lead sang Notion (id lấy từ biến môi trường — ổn định)."
        : "✅ Đang đồng bộ lead sang Notion. Nên đặt NOTION_LEADS_DATA_SOURCE_ID để giữ ổn định qua redeploy.";
      createNotionButton.classList.add("hidden");
      notionDetailEl.textContent = `NOTION_LEADS_DATA_SOURCE_ID=${status.dataSourceId}`;
      notionDetailEl.classList.remove("hidden");
      return;
    }

    notionDetailEl.classList.add("hidden");
    if (status.parentConfigured) {
      notionStatusEl.textContent = "Chưa có bảng Leads. Bấm nút để tạo bảng trong Notion.";
      createNotionButton.classList.remove("hidden");
    } else {
      notionStatusEl.textContent =
        "Chưa bật. Cần đặt NOTION_LEADS_PARENT_PAGE_ID (trang Notion đã chia sẻ với integration) rồi tải lại.";
      createNotionButton.classList.add("hidden");
    }
  } catch (error) {
    notionStatusEl.textContent = error.message;
  }
}

async function createNotionTable() {
  createNotionButton.disabled = true;
  notionStatusEl.textContent = "Đang tạo bảng Leads trong Notion...";
  try {
    const data = await fetchJson("/api/leads/notion/setup", { method: "POST" });
    notionStatusEl.textContent = data.message || "Đã tạo bảng Leads.";
    if (data.dataSourceId) {
      notionDetailEl.textContent = `NOTION_LEADS_DATA_SOURCE_ID=${data.dataSourceId}`;
      notionDetailEl.classList.remove("hidden");
    }
    createNotionButton.classList.add("hidden");
  } catch (error) {
    notionStatusEl.textContent = error.message;
    createNotionButton.disabled = false;
  }
}

createNotionButton.addEventListener("click", createNotionTable);
refreshButton.addEventListener("click", loadLeads);
loadLeads();
loadNotionStatus();
