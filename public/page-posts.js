const params = new URLSearchParams(window.location.search);
const pageId = params.get("pageId");

const pageNameElement = document.querySelector("#page-name");
const pagePermissionElement = document.querySelector("#page-permission");
const postListElement = document.querySelector("#post-list");
const postStatusElement = document.querySelector("#post-status");
const createPostForm = document.querySelector("#create-post-form");
const createPostButton = document.querySelector("#create-post-button");
const postMessageElement = document.querySelector("#post-message");
const postTagsElement = document.querySelector("#post-tags");
const manualTaskSelect = document.querySelector("#manual-task-select");
const useTaskDraftButton = document.querySelector("#use-task-draft-button");
const clearManualDraftButton = document.querySelector("#clear-manual-draft-button");
const manualMediaTitleElement = document.querySelector("#manual-media-title");
const manualContentTypeElement = document.querySelector("#manual-content-type");
const manualMediaListElement = document.querySelector("#manual-media-list");
const refreshPostsButton = document.querySelector("#refresh-posts-button");
const notionStatusElement = document.querySelector("#notion-status");
const notionTaskListElement = document.querySelector("#notion-task-list");
const refreshNotionButton = document.querySelector("#refresh-notion-button");
const retryFailedButton = document.querySelector("#retry-failed-button");
const taskSearchInput = document.querySelector("#page-task-search");
const taskStageFilter = document.querySelector("#page-task-stage-filter");
const driveStatusElement = document.querySelector("#drive-status");
const driveStatusDetailElement = document.querySelector("#drive-status-detail");
const driveConnectLink = document.querySelector("#drive-connect-link");
const driveDisconnectButton = document.querySelector("#drive-disconnect-button");

let selectedPage = null;
let pageNotionTasks = [];
let manualDraftMediaUrls = [];
let manualDraftContentType = "text";

const taskStageLabels = {
  published: "Đã đăng",
  ready_to_schedule: "Sẵn sàng vào lịch",
  ready_to_publish: "Sẵn sàng đăng",
  publishing: "Đang đăng",
  failed: "Lỗi đăng",
  manual: "Đăng thủ công",
  blocked: "Cần kiểm tra"
};

const taskStageClasses = {
  published: "success",
  ready_to_schedule: "success",
  ready_to_publish: "success",
  publishing: "info",
  failed: "danger",
  manual: "warning",
  blocked: "warning"
};

async function fetchJson(url, options = {}) {
  const headers = options.body
    ? { "Content-Type": "application/json", ...(options.headers || {}) }
    : options.headers;

  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => null);

  if (response.status === 401) {
    window.location.href = "/";
    return null;
  }

  if (!response.ok || !data || data.success === false) {
    const error = new Error((data && data.message) || "Yêu cầu không thành công.");
    error.details = data && data.details;
    throw error;
  }

  return data;
}

function setStatus(message) {
  postStatusElement.textContent = message || "";
}

function setCreateEnabled(enabled) {
  createPostButton.disabled = !enabled;
  postMessageElement.disabled = !enabled;
  postTagsElement.disabled = !enabled;
  manualTaskSelect.disabled = !enabled;
  useTaskDraftButton.disabled = !enabled;
  clearManualDraftButton.disabled = !enabled;
}

function renderDriveStatus(drive) {
  const configured = drive && drive.configured;
  const connected = drive && drive.connected;

  driveConnectLink.hidden = !configured || connected;
  driveDisconnectButton.hidden = !connected;

  if (!configured) {
    driveStatusElement.textContent = "Chưa cấu hình";
    driveStatusDetailElement.textContent = "Thêm GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET và GOOGLE_DRIVE_REDIRECT_URI vào .env để bật kết nối Drive.";
    return;
  }

  if (connected) {
    driveStatusElement.textContent = "Đã kết nối";
    driveStatusDetailElement.textContent = "Có quyền đọc ảnh/video riêng tư từ Google Drive khi đăng bài.";
    return;
  }

  driveStatusElement.textContent = "Chưa kết nối";
  driveStatusDetailElement.textContent = "Cần kết nối nếu ảnh trong Notion là link Drive không public.";
}

async function loadDriveStatus() {
  try {
    const data = await fetchJson("/api/drive/status");

    if (!data) {
      return;
    }

    renderDriveStatus(data.drive);
  } catch (error) {
    driveStatusElement.textContent = "Không tải được";
    driveStatusDetailElement.textContent = error.message;
    driveConnectLink.hidden = true;
    driveDisconnectButton.hidden = true;
  }
}

async function disconnectDrive() {
  driveDisconnectButton.disabled = true;
  driveStatusDetailElement.textContent = "Đang ngắt kết nối Google Drive...";

  try {
    await fetchJson("/api/drive/disconnect", { method: "POST" });
    await loadDriveStatus();
    await loadNotionTasks();
  } catch (error) {
    driveStatusDetailElement.textContent = error.message;
  } finally {
    driveDisconnectButton.disabled = false;
  }
}

function formatTime(value) {
  if (!value) {
    return "Không rõ thời gian";
  }

  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatScheduleTime(value) {
  return value ? formatTime(value) : "Chưa đặt lịch";
}

function formatOverdue(value) {
  if (!value || value <= 0) {
    return "";
  }

  const minutes = Math.floor(value / 60000);

  if (minutes < 60) {
    return `Quá hạn ${minutes} phút`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `Quá hạn ${hours} giờ ${remainingMinutes} phút` : `Quá hạn ${hours} giờ`;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function createMetaChip(text, variant) {
  const chip = document.createElement("span");
  chip.className = variant ? `meta-chip ${variant}` : "meta-chip";
  chip.textContent = text;
  return chip;
}

function createBadge(text, variant) {
  const badge = document.createElement("span");
  badge.className = `badge ${variant || "warning"} inline-badge`;
  badge.textContent = text;
  return badge;
}

function createSmallText(text) {
  const element = document.createElement("p");
  element.className = "muted table-subtext";
  element.textContent = text;
  return element;
}

function isGoogleDriveUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    return /(\.|^)google\.com$/.test(hostname) || /(\.|^)googleusercontent\.com$/.test(hostname);
  } catch (error) {
    return false;
  }
}

function getPreviewUrl(url) {
  return isGoogleDriveUrl(url) ? `/api/drive/media-preview?url=${encodeURIComponent(url)}` : url;
}

function getManualContentType(task) {
  if (!task || !Array.isArray(task.mediaUrls) || task.mediaUrls.length === 0) {
    return "text";
  }

  if (["photo", "video", "mixed", "reel", "auto"].includes(task.contentType)) {
    return task.contentType;
  }

  const postType = normalizeText(task.postType || task.postFormat);

  if (postType.includes("reel")) {
    return "reel";
  }

  if (postType.includes("video")) {
    return "video";
  }

  return "photo";
}

function getManualContentTypeLabel(contentType) {
  if (contentType === "reel") {
    return "Reel";
  }

  if (contentType === "video") {
    return "Video";
  }

  if (contentType === "mixed") {
    return "Ảnh + video";
  }

  if (contentType === "auto") {
    return "Tự nhận diện";
  }

  if (contentType === "photo") {
    return "Ảnh";
  }

  return "Văn bản";
}

function looksLikeVideoUrl(url) {
  return /\.(m4v|mov|mp4|webm)(\?.*)?$/i.test(String(url || ""));
}

function shouldRenderVideoPreview(url) {
  return ["video", "reel"].includes(manualDraftContentType) ||
    (["mixed", "auto"].includes(manualDraftContentType) && looksLikeVideoUrl(url));
}

function renderManualMediaPreview() {
  manualMediaListElement.innerHTML = "";
  manualContentTypeElement.textContent = getManualContentTypeLabel(manualDraftContentType);

  if (manualDraftMediaUrls.length === 0) {
    manualMediaTitleElement.textContent = "Chưa chọn media";
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Chọn task Notion để xem trước ảnh hoặc video từ Drive.";
    manualMediaListElement.append(empty);
    return;
  }

  manualMediaTitleElement.textContent = `${manualDraftMediaUrls.length} file theo thứ tự trong task`;

  manualDraftMediaUrls.forEach((url, index) => {
    const card = document.createElement("article");
    card.className = "manual-media-card";

    const isVideo = shouldRenderVideoPreview(url);

    if (isVideo) {
      const video = document.createElement("video");
      video.src = getPreviewUrl(url);
      video.controls = true;
      video.preload = "metadata";
      card.append(video);
    } else {
      const image = document.createElement("img");
      image.src = getPreviewUrl(url);
      image.alt = `Ảnh ${index + 1}`;
      image.loading = "lazy";
      card.append(image);
    }

    const meta = document.createElement("div");
    meta.className = "manual-media-meta";

    const title = document.createElement("strong");
    title.textContent = `${isVideo ? "Video" : "Ảnh"} ${index + 1}`;

    const source = document.createElement("span");
    source.className = "manual-media-url";
    source.textContent = url;

    meta.append(title, source);
    card.append(meta);
    manualMediaListElement.append(card);
  });
}

function clearManualDraft() {
  manualTaskSelect.value = "";
  postMessageElement.value = "";
  postTagsElement.value = "";
  manualDraftMediaUrls = [];
  manualDraftContentType = "text";
  renderManualMediaPreview();
}

function useTaskAsManualDraft(task) {
  if (!task) {
    return;
  }

  manualTaskSelect.value = task.id;
  postMessageElement.value = task.caption || "";
  postTagsElement.value = Array.isArray(task.tags) ? task.tags.join(", ") : "";
  manualDraftMediaUrls = Array.isArray(task.mediaUrls) ? task.mediaUrls.slice() : [];
  manualDraftContentType = getManualContentType(task);
  renderManualMediaPreview();
  postMessageElement.focus();
}

function renderManualTaskOptions() {
  const selectedValue = manualTaskSelect.value;
  manualTaskSelect.innerHTML = '<option value="">Chọn task để soạn thủ công</option>';

  for (const task of pageNotionTasks) {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = `${task.title || "(Chưa có tiêu đề)"} - ${task.publishStatus || "Chưa có trạng thái"}`;
    manualTaskSelect.append(option);
  }

  manualTaskSelect.value = pageNotionTasks.some((task) => task.id === selectedValue) ? selectedValue : "";
}

function getTaskState(task) {
  if (task.readyToPublish) {
    return {
      className: "success",
      label: "Sẵn sàng đăng",
      message: "Tác vụ đã vào lịch và đã đến thời điểm đăng."
    };
  }

  if (task.readyToSchedule) {
    return {
      className: "success",
      label: "Sẵn sàng vào lịch",
      message: "Tác vụ đủ điều kiện để chuyển từ Chưa lên lịch sang Đã lên lịch."
    };
  }

  return {
    className: "warning",
    label: "Cần kiểm tra",
    message: "Tác vụ chưa đủ điều kiện để hệ thống tự động xử lý."
  };
}

function getTaskReasons(task) {
  if (task.isPublished || task.readyToPublish || task.readyToSchedule) {
    return [];
  }

  if (task.publishStatus === "Chưa lên lịch") {
    return Array.from(new Set(task.scheduleReasons || [])).filter(Boolean);
  }

  if (task.publishStatus === "Đã lên lịch") {
    return Array.from(new Set(task.reasons || [])).filter(Boolean);
  }

  return Array.from(new Set([...(task.scheduleReasons || []), ...(task.reasons || [])])).filter(Boolean);
}

function appendTaskReasons(container, task) {
  const reasons = getTaskReasons(task);

  if (reasons.length === 0) {
    return;
  }

  const box = document.createElement("div");
  box.className = "reason-box";

  const title = document.createElement("strong");
  title.textContent = "Cần xử lý";

  const list = document.createElement("ul");

  for (const reason of reasons) {
    const item = document.createElement("li");
    item.textContent = reason;
    list.append(item);
  }

  box.append(title, list);
  container.append(box);
}

function getStageLabel(task) {
  return taskStageLabels[task.taskStage] || "Cần kiểm tra";
}

function taskMatchesFilters(task) {
  const query = normalizeText(taskSearchInput.value);
  const stage = taskStageFilter.value;
  const reasons = getTaskReasons(task).join(" ");
  const searchable = normalizeText([
    task.title,
    task.caption,
    selectedPage && selectedPage.name,
    task.brand && task.brand.name,
    task.postType || task.postFormat,
    task.publishStatus,
    Array.isArray(task.tags) ? task.tags.join(" ") : "",
    task.facebookPostId,
    task.facebookPostUrl,
    reasons
  ].join(" "));

  if (query && !searchable.includes(query)) {
    return false;
  }

  if (stage === "overdue") {
    return task.overdue && !task.tooOldOverdue;
  }

  return stage === "all" || task.taskStage === stage;
}

function renderReasonCell(cell, task) {
  const reasons = getTaskReasons(task);

  if (task.isPublished) {
    cell.textContent = "Bài viết đã được đăng thành công.";
    return;
  }

  if (task.readyToPublish) {
    cell.textContent = "Đã vào lịch và đến thời điểm đăng.";
    return;
  }

  if (task.readyToSchedule) {
    cell.textContent = "Đủ điều kiện để đưa vào lịch.";
    return;
  }

  if (reasons.length === 0) {
    cell.textContent = "Chưa có lý do cụ thể.";
    return;
  }

  const list = document.createElement("ul");
  list.className = "compact-reason-list";

  for (const reason of reasons) {
    const item = document.createElement("li");
    item.textContent = reason;
    list.append(item);
  }

  cell.append(list);
}

function renderErrorCell(cell, task) {
  if (!task.errorMessage) {
    cell.textContent = "—";
    cell.className = "muted";
    return;
  }

  cell.className = "error-cell";
  cell.textContent = task.errorMessage;
}

function createActionLink(label, href, className = "button ghost compact") {
  const link = document.createElement("a");
  link.className = className;
  link.href = href;
  link.textContent = label;

  if (href.startsWith("http")) {
    link.target = "_blank";
    link.rel = "noreferrer";
  }

  return link;
}

function renderActionCell(cell, task) {
  const actions = document.createElement("div");
  actions.className = "table-actions";

  if (selectedPage.canCreateContent && (task.caption || task.mediaCount > 0)) {
    const draftButton = document.createElement("button");
    draftButton.className = "button ghost compact";
    draftButton.type = "button";
    draftButton.textContent = "Soạn thủ công";
    draftButton.addEventListener("click", () => useTaskAsManualDraft(task));
    actions.append(draftButton);
  }

  if (!task.isPublished && (task.readyToSchedule || task.readyToPublish) && selectedPage.canCreateContent) {
    const publishButton = document.createElement("button");
    publishButton.className = "button primary compact";
    publishButton.type = "button";
    publishButton.textContent = task.readyToSchedule ? "Đưa vào lịch" : "Đăng";
    publishButton.addEventListener("click", () => publishNotionTask(task, publishButton));
    actions.append(publishButton);
  }

  if (task.notionUrl) {
    actions.append(createActionLink("Notion", task.notionUrl));
  }

  if (task.facebookPostUrl) {
    actions.append(createActionLink("Facebook", task.facebookPostUrl, "button secondary compact"));
  }

  if (actions.children.length === 0) {
    const text = document.createElement("span");
    text.className = "muted";
    text.textContent = "Không có hành động";
    actions.append(text);
  }

  cell.append(actions);
}

function renderPosts(posts) {
  postListElement.innerHTML = "";

  if (posts.length === 0) {
    postListElement.innerHTML = '<p class="empty-state">Chưa có bài viết gần đây để hiển thị.</p>';
    return;
  }

  for (const post of posts) {
    const item = document.createElement("article");
    item.className = "post-item";

    const message = document.createElement("p");
    message.className = "post-message";
    message.textContent = post.message || "(Bài viết không có nội dung text)";

    const meta = document.createElement("div");
    meta.className = "post-meta";
    meta.append(createMetaChip(formatTime(post.createdTime)));

    if (post.permalinkUrl) {
      const link = document.createElement("a");
      link.href = post.permalinkUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Mở trên Facebook";
      meta.append(link);
    }

    const actions = document.createElement("div");
    actions.className = "post-actions";

    const editButton = document.createElement("button");
    editButton.className = "button secondary compact";
    editButton.type = "button";
    editButton.textContent = "Sửa";
    editButton.disabled = !selectedPage.canCreateContent;
    editButton.addEventListener("click", () => editPost(post));

    const deleteButton = document.createElement("button");
    deleteButton.className = "button danger compact";
    deleteButton.type = "button";
    deleteButton.textContent = "Xóa";
    deleteButton.disabled = !selectedPage.canCreateContent;
    deleteButton.addEventListener("click", () => deletePost(post));

    actions.append(editButton, deleteButton);
    item.append(message, meta, actions);
    postListElement.append(item);
  }
}

function renderNotionTasks() {
  const tasks = pageNotionTasks.filter(taskMatchesFilters);
  notionTaskListElement.innerHTML = "";

  if (tasks.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "empty-table-cell";
    cell.textContent = "Không có tác vụ nào khớp với bộ lọc hiện tại.";
    row.append(cell);
    notionTaskListElement.append(row);
    return;
  }

  for (const task of tasks) {
    const row = document.createElement("tr");

    const titleCell = document.createElement("td");
    const title = document.createElement("h3");
    title.textContent = task.title || "(Tác vụ chưa có tiêu đề)";
    titleCell.append(title, createSmallText(task.caption || "Chưa có nội dung"));

    if (Array.isArray(task.tags) && task.tags.length > 0) {
      titleCell.append(createSmallText(task.tags.join(" ")));
    }

    const publishAtCell = document.createElement("td");
    publishAtCell.textContent = formatScheduleTime(task.publishAt);

    if (task.overdue && !task.tooOldOverdue) {
      publishAtCell.append(createSmallText(formatOverdue(task.overdueMs)));
    }

    const formatCell = document.createElement("td");
    formatCell.textContent = task.postType || task.postFormat || "Văn bản";
    formatCell.append(createSmallText(`${task.mediaCount || 0} tệp đính kèm`));

    const publishStatusCell = document.createElement("td");
    publishStatusCell.textContent = task.publishStatus || "Chưa có trạng thái";

    const stageCell = document.createElement("td");
    stageCell.append(createBadge(getStageLabel(task), taskStageClasses[task.taskStage]));

    const errorCell = document.createElement("td");
    renderErrorCell(errorCell, task);

    const reasonCell = document.createElement("td");
    renderReasonCell(reasonCell, task);

    const actionCell = document.createElement("td");
    renderActionCell(actionCell, task);

    row.append(titleCell, publishAtCell, formatCell, publishStatusCell, stageCell, errorCell, reasonCell, actionCell);
    notionTaskListElement.append(row);
  }
}

async function loadPageInfo() {
  const data = await fetchJson("/api/pages");

  if (!data) {
    return;
  }

  selectedPage = data.pages.find((page) => page.id === pageId);

  if (!selectedPage) {
    throw new Error("Page ID không thuộc tài khoản đang đăng nhập.");
  }

  pageNameElement.textContent = selectedPage.name;
  pagePermissionElement.textContent = selectedPage.canCreateContent ? "Có" : "Không";
  setCreateEnabled(selectedPage.canCreateContent);

  if (!selectedPage.canCreateContent) {
    setStatus("Page này không có quyền tạo hoặc sửa bài viết.");
  }
}

async function loadPosts() {
  if (!pageId) {
    throw new Error("Thiếu pageId trên URL.");
  }

  setStatus("Đang tải bài viết...");
  const data = await fetchJson(`/api/pages/${encodeURIComponent(pageId)}/posts`);

  if (!data) {
    return;
  }

  renderPosts(data.posts);
  setStatus(selectedPage && !selectedPage.canCreateContent ? "Page này không có quyền tạo hoặc sửa bài viết." : "");
}

async function loadNotionTasks() {
  try {
    notionStatusElement.textContent = "Đang tải tác vụ Notion...";
    const data = await fetchJson(`/api/notion/tasks?pageId=${encodeURIComponent(pageId)}`);

    if (!data) {
      return;
    }

    pageNotionTasks = data.tasks;
    renderManualTaskOptions();
    renderNotionTasks();
    notionStatusElement.textContent =
      `${data.totalCount} tác vụ, ${data.scheduleReadyCount || 0} tác vụ sẵn sàng vào lịch, ${data.readyCount} tác vụ sẵn sàng đăng, ${data.overdueCount || 0} tác vụ quá hạn dưới 24 giờ.`;
  } catch (error) {
    pageNotionTasks = [];
    renderManualTaskOptions();
    notionStatusElement.textContent = error.message;
    renderNotionTasks();
  }
}

async function createPost(event) {
  event.preventDefault();

  const message = postMessageElement.value.trim();
  const tags = postTagsElement.value.trim();

  if (!message && !tags && manualDraftMediaUrls.length === 0) {
    setStatus("Nội dung bài viết hoặc media không được trống.");
    return;
  }

  createPostButton.disabled = true;
  setStatus("Đang gửi bài viết và media...");

  try {
    const data = await fetchJson(`/api/pages/${encodeURIComponent(pageId)}/posts`, {
      method: "POST",
      body: JSON.stringify({
        message,
        tags,
        mediaUrls: manualDraftMediaUrls,
        contentType: manualDraftContentType,
        taskId: manualTaskSelect.value
      })
    });

    clearManualDraft();
    setStatus(data.permalinkUrl ? `${data.message} ${data.permalinkUrl}` : data.message || "Đăng bài thành công.");
    await loadPosts();
  } catch (error) {
    setStatus(error.message);
  } finally {
    createPostButton.disabled = !selectedPage.canCreateContent;
  }
}

async function publishNotionTask(task, button) {
  button.disabled = true;
  notionStatusElement.textContent = "Đang xử lý tác vụ Notion...";

  try {
    const data = await fetchJson(`/api/notion/tasks/${encodeURIComponent(task.id)}/publish`, {
      method: "POST"
    });

    notionStatusElement.textContent = data.message || "Xử lý tác vụ Notion thành công.";
    await Promise.all([loadNotionTasks(), loadPosts()]);
  } catch (error) {
    const reasons = error.details && Array.isArray(error.details.reasons)
      ? ` ${error.details.reasons.join(" ")}`
      : "";
    notionStatusElement.textContent = `${error.message}${reasons}`;
  } finally {
    button.disabled = false;
  }
}

async function retryFailedTasks() {
  retryFailedButton.disabled = true;
  refreshNotionButton.disabled = true;

  try {
    notionStatusElement.textContent = "Đang chuẩn bị các task lỗi của Page để đăng lại...";
    const data = await fetchJson(`/api/notion/retry-failed?pageId=${encodeURIComponent(pageId)}`, {
      method: "POST"
    });
    notionStatusElement.textContent =
      `Đã chuẩn bị ${data.successCount} task lỗi để đăng lại, bỏ qua ${data.skippedCount} task chưa đủ điều kiện.`;
    await loadNotionTasks();
  } catch (error) {
    notionStatusElement.textContent = error.message;
  } finally {
    retryFailedButton.disabled = false;
    refreshNotionButton.disabled = false;
  }
}

async function editPost(post) {
  const message = window.prompt("Nội dung mới", post.message || "");

  if (message === null) {
    return;
  }

  if (!message.trim()) {
    setStatus("Nội dung bài viết không được trống.");
    return;
  }

  try {
    setStatus("Đang sửa bài viết...");
    await fetchJson(
      `/api/pages/${encodeURIComponent(pageId)}/posts/${encodeURIComponent(post.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ message: message.trim() })
      }
    );

    setStatus("Sửa bài viết thành công.");
    await loadPosts();
  } catch (error) {
    setStatus(error.message);
  }
}

async function deletePost(post) {
  const confirmed = window.confirm("Xóa bài viết này?");

  if (!confirmed) {
    return;
  }

  try {
    setStatus("Đang xóa bài viết...");
    await fetchJson(
      `/api/pages/${encodeURIComponent(pageId)}/posts/${encodeURIComponent(post.id)}`,
      { method: "DELETE" }
    );

    setStatus("Xóa bài thành công.");
    await loadPosts();
  } catch (error) {
    setStatus(error.message);
  }
}

async function init() {
  try {
    if (!pageId) {
      throw new Error("Thiếu pageId trên URL.");
    }

    await loadPageInfo();
    await Promise.all([loadPosts(), loadDriveStatus(), loadNotionTasks()]);
  } catch (error) {
    pageNameElement.textContent = "Không tải được Page";
    setCreateEnabled(false);
    setStatus(error.message);
  }
}

createPostForm.addEventListener("submit", createPost);
refreshPostsButton.addEventListener("click", () => loadPosts().catch((error) => setStatus(error.message)));
refreshNotionButton.addEventListener("click", () => loadNotionTasks().catch((error) => {
  notionStatusElement.textContent = error.message;
}));
retryFailedButton.addEventListener("click", retryFailedTasks);
useTaskDraftButton.addEventListener("click", () => {
  const task = pageNotionTasks.find((item) => item.id === manualTaskSelect.value);
  useTaskAsManualDraft(task);
});
manualTaskSelect.addEventListener("change", () => {
  const task = pageNotionTasks.find((item) => item.id === manualTaskSelect.value);

  if (task) {
    useTaskAsManualDraft(task);
  }
});
clearManualDraftButton.addEventListener("click", clearManualDraft);
taskSearchInput.addEventListener("input", renderNotionTasks);
taskStageFilter.addEventListener("change", renderNotionTasks);
driveDisconnectButton.addEventListener("click", disconnectDrive);

renderManualMediaPreview();
init();
