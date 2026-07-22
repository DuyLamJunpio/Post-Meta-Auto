import { fetchJson, el } from "/shared/api.js";
import { mountShell } from "/shared/shell.js";

mountShell("/import.html");

const fileInput = document.querySelector("#file-input");
const previewButton = document.querySelector("#preview-button");
const uploadStatus = document.querySelector("#upload-status");
const previewSection = document.querySelector("#preview-section");
const previewSummary = document.querySelector("#preview-summary");
const previewList = document.querySelector("#preview-list");
const selectAll = document.querySelector("#select-all");
const createButton = document.querySelector("#create-button");
const resultSection = document.querySelector("#result-section");
const resultList = document.querySelector("#result-list");

let previewItems = [];

fileInput.addEventListener("change", () => {
  previewButton.disabled = !fileInput.files || fileInput.files.length === 0;
  uploadStatus.textContent = "";
});

function badge(text, variant) {
  const map = {
    green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    red: "bg-rose-50 text-rose-700 ring-rose-600/20"
  };
  return el("span", {
    class: `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${map[variant]}`,
    text
  });
}

function refreshCreateButton() {
  const selected = previewList.querySelectorAll("input[data-row]:checked").length;
  createButton.disabled = selected === 0;
  createButton.textContent = selected > 0 ? `Tạo ${selected} task đã chọn` : "Tạo task đã chọn";
}

function renderPreview(data) {
  previewItems = data.items || [];
  previewSummary.textContent = `Sheet "${data.sheetName}": ${data.total} dòng · ${data.validCount} hợp lệ · ${data.invalidCount} lỗi.`;

  previewList.replaceChildren(
    ...previewItems.map((item, index) => {
      const checkbox = el("input", {
        class: "h-4 w-4",
        attrs: { type: "checkbox", "data-row": String(index), checked: item.valid, disabled: !item.valid }
      });
      checkbox.addEventListener("change", refreshCreateButton);

      const resultCell = item.valid
        ? el("td", { class: "px-3 py-3 align-top" }, badge("Hợp lệ", "green"))
        : el("td", { class: "px-3 py-3 align-top" }, [
            badge("Lỗi", "red"),
            el("ul", { class: "mt-1 list-disc space-y-0.5 pl-4 text-xs text-rose-600" }, item.errors.map((e) => el("li", { text: e })))
          ]);

      return el("tr", { class: item.valid ? "hover:bg-slate-50/60" : "bg-rose-50/40" }, [
        el("td", { class: "px-3 py-3 align-top" }, checkbox),
        el("td", { class: "px-3 py-3 align-top text-slate-400", text: String(item.excelRow) }),
        el("td", { class: "max-w-xs px-3 py-3 align-top font-medium text-slate-800", text: item.title }),
        el("td", { class: "px-3 py-3 align-top text-slate-600", text: item.brandCode || "—" }),
        el("td", { class: "px-3 py-3 align-top text-slate-600", text: item.channel || "—" }),
        el("td", { class: "whitespace-nowrap px-3 py-3 align-top text-slate-600", text: item.publishAt || "—" }),
        resultCell
      ]);
    })
  );

  previewSection.classList.remove("hidden");
  refreshCreateButton();
}

async function runPreview() {
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    return;
  }

  previewButton.disabled = true;
  uploadStatus.textContent = "Đang đọc và kiểm tra file...";
  resultSection.classList.add("hidden");

  try {
    const buffer = await file.arrayBuffer();
    const response = await fetch("/api/notion/import/preview", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buffer
    });

    if (response.status === 401) {
      window.location.href = "/";
      return;
    }

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.success === false) {
      throw new Error((data && data.message) || "Không kiểm tra được file.");
    }

    uploadStatus.textContent = "";
    renderPreview(data);
  } catch (error) {
    uploadStatus.textContent = error.message;
  } finally {
    previewButton.disabled = false;
  }
}

async function runCreate() {
  const selectedIndexes = Array.from(previewList.querySelectorAll("input[data-row]:checked")).map((cb) =>
    Number(cb.getAttribute("data-row"))
  );
  const rows = selectedIndexes.map((index) => previewItems[index].values);

  if (rows.length === 0) {
    return;
  }
  if (!window.confirm(`Tạo ${rows.length} task mới trong Notion?`)) {
    return;
  }

  createButton.disabled = true;
  createButton.textContent = "Đang tạo...";

  try {
    const data = await fetchJson("/api/notion/import/create", {
      method: "POST",
      body: JSON.stringify({ rows })
    });

    resultSection.classList.remove("hidden");
    resultList.replaceChildren(
      el("p", { class: "font-medium text-slate-800", text: data.message || "Hoàn tất." }),
      ...(data.results || []).map((r) =>
        el("div", { class: "flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2" }, [
          badge(r.success ? "OK" : "Lỗi", r.success ? "green" : "red"),
          el("span", { class: "min-w-0 flex-1 truncate text-slate-700", text: r.title }),
          r.url ? el("a", { class: "text-xs font-medium text-brand-600 hover:underline", text: "Mở Notion", attrs: { href: r.url, target: "_blank", rel: "noreferrer" } }) : null,
          r.message ? el("span", { class: "w-full text-xs text-rose-600", text: r.message }) : null
        ])
      )
    );
    resultSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    resultSection.classList.remove("hidden");
    resultList.replaceChildren(el("p", { class: "text-rose-600", text: error.message }));
  } finally {
    createButton.disabled = false;
    refreshCreateButton();
  }
}

selectAll.addEventListener("change", () => {
  previewList.querySelectorAll("input[data-row]:not([disabled])").forEach((cb) => {
    cb.checked = selectAll.checked;
  });
  refreshCreateButton();
});

previewButton.addEventListener("click", runPreview);
createButton.addEventListener("click", runCreate);
