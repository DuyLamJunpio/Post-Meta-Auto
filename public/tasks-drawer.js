// Drawer "Sửa nhanh" task Notion: chỉnh các field để đủ điều kiện đăng ngay trong app,
// không phải mở Notion. Gọi PATCH /api/notion/tasks/:id rồi trả task đã cập nhật cho caller.
import { fetchJson, el } from "/shared/api.js";

const CHANNEL_OPTIONS = [
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "gbp", label: "Google Business Profile" },
  { key: "tiktok", label: "TikTok" }
];

const APPROVAL_OPTIONS = ["Đã duyệt", "Chờ duyệt", "Cần sửa", "Từ chối", "Nháp"];
const WORKFLOW_OPTIONS = [
  "Hoàn thành nội dung",
  "Lên ý tưởng",
  "Viết caption",
  "Thiết kế/Visual",
  "Chờ duyệt nội bộ",
  "Chờ media cuối",
  "Sẵn sàng lên lịch"
];
const POST_TYPE_OPTIONS = ["Post", "Reel"];

// ISO -> giá trị input datetime-local (giờ máy người dùng).
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function labelledField(labelText, control, hint) {
  return el("label", { class: "block space-y-1" }, [
    el("span", { class: "text-xs font-medium text-slate-600", text: labelText }),
    control,
    hint ? el("span", { class: "block text-[11px] text-slate-400", text: hint }) : null
  ]);
}

function selectField(labelText, options, value) {
  const select = el(
    "select",
    { class: "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100" },
    options.map((opt) => el("option", { text: opt, attrs: { value: opt, selected: opt === value ? "" : null } }))
  );
  select.value = value && options.includes(value) ? value : options[0];
  return { field: labelledField(labelText, select), input: select };
}

function textAreaField(labelText, value, rows, hint) {
  const area = el("textarea", {
    class: "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100",
    attrs: { rows: String(rows || 3) },
    text: value || ""
  });
  return { field: labelledField(labelText, area, hint), input: area };
}

function checkbox(labelText, checked) {
  const input = el("input", { attrs: { type: "checkbox", ...(checked ? { checked: "" } : {}) }, class: "h-4 w-4 rounded border-slate-300 text-brand-600" });
  const field = el("label", { class: "flex items-center gap-2 text-sm text-slate-700" }, [input, el("span", { text: labelText })]);
  return { field, input };
}

export function openEditDrawer({ task, brands, onSaved }) {
  const reasons = Array.from(new Set([...(task.scheduleReasons || []), ...(task.reasons || [])])).filter(Boolean);

  // ---- Controls ----
  const approvalCtl = selectField("Duyệt (Approval Status)", APPROVAL_OPTIONS, task.approvalStatus || "Chờ duyệt");
  const workflowCtl = selectField("Trạng thái nội dung (Content Workflow)", WORKFLOW_OPTIONS, task.contentWorkflow || "Lên ý tưởng");
  const postTypeCtl = selectField("Định dạng (Post Type)", POST_TYPE_OPTIONS, POST_TYPE_OPTIONS.includes(task.postType) ? task.postType : "Post");

  const autoCtl = checkbox("Bật tự động đăng (Auto Publish)", task.autoPublish);
  const clearFbCtl = checkbox("Gỡ tính năng FB nâng cao đang chặn (Feeling/CTA/Call/Story/Tag/Location/Collab)", false);

  // Channel checkboxes
  const channelInputs = CHANNEL_OPTIONS.map((opt) => {
    const c = checkbox(opt.label, (task.channels || []).includes(opt.key));
    return { key: opt.key, input: c.input, field: c.field };
  });
  const channelField = labelledField(
    "Kênh đăng (Channel)",
    el("div", { class: "grid grid-cols-2 gap-1.5" }, channelInputs.map((c) => c.field))
  );

  // Primary Brand select
  const brandList = Array.isArray(brands) ? brands : [];
  const brandSelect = el(
    "select",
    { class: "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100" },
    [
      el("option", { text: "— Không đổi / giữ nguyên —", attrs: { value: "" } }),
      ...brandList.map((b) => el("option", { text: `${b.name}${b.active ? "" : " (tắt)"}`, attrs: { value: b.id } }))
    ]
  );
  if (task.brand && task.brand.id) brandSelect.value = task.brand.id;
  const brandField = labelledField("Thương hiệu (Primary Brand)", brandSelect, "Chọn đúng 1 brand có Page/kênh phù hợp.");

  const publishInput = el("input", {
    attrs: { type: "datetime-local", value: toLocalInput(task.publishAt) },
    class: "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
  });
  const publishField = labelledField("Thời điểm đăng (Publish At)", publishInput, "Để đăng ngay: bấm nút 'Lưu & Đăng ngay'.");

  const captionCtl = textAreaField("Caption", task.caption || "", 4);
  const mediaCtl = textAreaField(
    "Media URLs (mỗi link 1 dòng)",
    Array.isArray(task.mediaUrls) ? task.mediaUrls.join("\n") : "",
    3,
    "Link ảnh/video công khai có đuôi file, hoặc link Google Drive từng file."
  );

  const statusLine = el("p", { class: "text-xs text-slate-500", attrs: { "aria-live": "polite" } });

  function buildPatch() {
    const channels = channelInputs.filter((c) => c.input.checked).map((c) => c.key);
    const patch = {
      approval: approvalCtl.input.value,
      workflow: workflowCtl.input.value,
      postType: postTypeCtl.input.value,
      autoPublish: autoCtl.input.checked,
      channels,
      caption: captionCtl.input.value,
      mediaUrls: mediaCtl.input.value
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n")
    };
    if (brandSelect.value) patch.primaryBrandId = brandSelect.value;
    if (publishInput.value) patch.publishAt = new Date(publishInput.value).toISOString();
    if (clearFbCtl.input.checked) patch.clearFbExtras = true;
    return patch;
  }

  const overlay = el("div", { class: "fixed inset-0 z-50 flex justify-end bg-slate-900/40" });
  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onEsc);
  }
  function onEsc(e) {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onEsc);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  async function save({ publishNow }) {
    saveBtn.disabled = true;
    publishBtn.disabled = true;
    statusLine.textContent = publishNow ? "Đang lưu & đăng..." : "Đang lưu...";
    try {
      const patch = buildPatch();
      if (publishNow) {
        patch.publishAt = new Date().toISOString();
        patch.resetSchedule = true;
      }
      const data = await fetchJson(`/api/notion/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      let updated = data.task;

      if (publishNow) {
        const pub = await fetchJson(`/api/notion/tasks/${encodeURIComponent(task.id)}/publish`, { method: "POST" });
        statusLine.textContent = pub.message || "Đã xử lý.";
      }

      if (typeof onSaved === "function") onSaved(updated, { publishNow });
      close();
    } catch (error) {
      statusLine.textContent = error.message + (error.details && error.details.reasons ? " — " + error.details.reasons.join("; ") : "");
      saveBtn.disabled = false;
      publishBtn.disabled = false;
    }
  }

  const saveBtn = el("button", {
    class: "flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100",
    text: "Lưu",
    attrs: { type: "button" },
    on: { click: () => save({ publishNow: false }) }
  });
  const publishBtn = el("button", {
    class: "flex-1 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600",
    text: "Lưu & Đăng ngay",
    attrs: { type: "button" },
    on: { click: () => save({ publishNow: true }) }
  });

  const reasonsBlock = reasons.length
    ? el("div", { class: "rounded-lg bg-amber-50 p-3 ring-1 ring-inset ring-amber-600/20" }, [
        el("p", { class: "text-xs font-semibold text-amber-800", text: "Cần sửa để đủ điều kiện đăng:" }),
        el("ul", { class: "mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-700" }, reasons.map((r) => el("li", { text: r })))
      ])
    : el("div", { class: "rounded-lg bg-emerald-50 p-3 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20", text: "Task đã đủ điều kiện — có thể đăng ngay." });

  const panel = el("div", { class: "flex h-full w-full max-w-md flex-col bg-white shadow-2xl" }, [
    el("div", { class: "flex items-center justify-between border-b border-slate-200 px-4 py-3" }, [
      el("div", { class: "min-w-0" }, [
        el("h2", { class: "truncate text-sm font-bold text-slate-900", text: "Sửa nhanh tác vụ" }),
        el("p", { class: "truncate text-xs text-slate-500", text: task.title || "(Chưa có tiêu đề)" })
      ]),
      el("button", { class: "rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600", attrs: { type: "button", "aria-label": "Đóng" }, text: "✕", on: { click: close } })
    ]),
    el("div", { class: "flex-1 space-y-3 overflow-y-auto px-4 py-4" }, [
      reasonsBlock,
      approvalCtl.field,
      workflowCtl.field,
      autoCtl.field,
      channelField,
      brandField,
      postTypeCtl.field,
      publishField,
      captionCtl.field,
      mediaCtl.field,
      clearFbCtl.field
    ]),
    el("div", { class: "border-t border-slate-200 px-4 py-3 space-y-2" }, [
      statusLine,
      el("div", { class: "flex gap-2" }, [saveBtn, publishBtn])
    ])
  ]);

  overlay.append(panel);
  document.body.append(overlay);
}
