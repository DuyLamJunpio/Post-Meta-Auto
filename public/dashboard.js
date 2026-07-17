const userNameElement = document.querySelector("#user-name");
const pageCountElement = document.querySelector("#page-count");
const notionReadyCountElement = document.querySelector("#notion-ready-count");
const notionOverdueCountElement = document.querySelector("#notion-overdue-count");
const pageListElement = document.querySelector("#page-list");
const statusElement = document.querySelector("#dashboard-status");
const notionStatusElement = document.querySelector("#notion-status");
const notionTaskListElement = document.querySelector("#notion-task-list");
const taskSearchInput = document.querySelector("#task-search");
const taskStageFilter = document.querySelector("#task-stage-filter");
const taskPageFilter = document.querySelector("#task-page-filter");
const publishDueButton = document.querySelector("#publish-due-button");
const publishOverdueButton = document.querySelector("#publish-overdue-button");
const retryFailedButton = document.querySelector("#retry-failed-button");
const logoutButton = document.querySelector("#logout-button");
const driveStatusElement = document.querySelector("#drive-status");
const driveStatusDetailElement = document.querySelector("#drive-status-detail");
const driveConnectLink = document.querySelector("#drive-connect-link");
const driveDisconnectButton = document.querySelector("#drive-disconnect-button");
const instagramStatusElement = document.querySelector("#instagram-status");
const instagramStatusDetailElement = document.querySelector("#instagram-status-detail");
const instagramConnectLink = document.querySelector("#instagram-connect-link");
const instagramDisconnectButton = document.querySelector("#instagram-disconnect-button");
const gbpStatusElement = document.querySelector("#gbp-status");
const gbpStatusDetailElement = document.querySelector("#gbp-status-detail");
const gbpConnectLink = document.querySelector("#gbp-connect-link");
const gbpDisconnectButton = document.querySelector("#gbp-disconnect-button");
const tiktokStatusElement = document.querySelector("#tiktok-status");
const tiktokStatusDetailElement = document.querySelector("#tiktok-status-detail");
const tiktokConnectLink = document.querySelector("#tiktok-connect-link");
const tiktokDisconnectButton = document.querySelector("#tiktok-disconnect-button");
const channelIdListElement = document.querySelector("#channel-id-list");
const gbpLocationsButton = document.querySelector("#gbp-locations-button");
const gbpLocationsStatusElement = document.querySelector("#gbp-locations-status");
const gbpLocationsListElement = document.querySelector("#gbp-locations-list");

let allNotionTasks = [];

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
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);

  if (response.status === 401) {
    window.location.href = "/";
    return null;
  }

  if (!response.ok || !data || data.success === false) {
    throw new Error((data && data.message) || "Yêu cầu không thành công.");
  }

  return data;
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

function formatInstagramExpiry(expiresAt) {
  if (!expiresAt) {
    return "";
  }

  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(expiresAt));
}

function renderInstagramStatus(instagram) {
  const configured = instagram && instagram.configured;
  const connected = instagram && instagram.connected;
  const user = instagram && instagram.user;
  const redirectText = instagram && instagram.redirectUri
    ? `Redirect URI: ${instagram.redirectUri}`
    : "";

  instagramConnectLink.hidden = !configured || connected;
  instagramDisconnectButton.hidden = !connected;

  if (!configured) {
    instagramStatusElement.textContent = "Chưa cấu hình";
    instagramStatusDetailElement.textContent = "Thêm INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET và INSTAGRAM_REDIRECT_URI vào .env để bật kết nối Instagram.";
    return;
  }

  if (connected) {
    instagramStatusElement.textContent = "Đã kết nối";
    instagramStatusDetailElement.textContent = [
      user && user.username ? `@${user.username}` : "Instagram account đã kết nối",
      user && user.accountType ? user.accountType : "",
      user && user.expiresAt ? `token hết hạn ${formatInstagramExpiry(user.expiresAt)}` : "",
      redirectText
    ].filter(Boolean).join(" · ");
    return;
  }

  instagramStatusElement.textContent = "Chưa kết nối";
  instagramStatusDetailElement.textContent = [
    "Kết nối Instagram Business để chuẩn bị publish/sync IG từ Notion.",
    redirectText
  ].filter(Boolean).join(" ");
}

async function loadInstagramStatus() {
  try {
    const data = await fetchJson("/api/instagram/status");

    if (!data) {
      return;
    }

    renderInstagramStatus(data.instagram);
  } catch (error) {
    instagramStatusElement.textContent = "Không tải được";
    instagramStatusDetailElement.textContent = error.message;
    instagramConnectLink.hidden = true;
    instagramDisconnectButton.hidden = true;
  }
}

async function disconnectInstagram() {
  instagramDisconnectButton.disabled = true;
  instagramStatusDetailElement.textContent = "Đang ngắt kết nối Instagram...";

  try {
    await fetchJson("/api/instagram/disconnect", { method: "POST" });
    await loadInstagramStatus();
  } catch (error) {
    instagramStatusDetailElement.textContent = error.message;
  } finally {
    instagramDisconnectButton.disabled = false;
  }
}

function renderGbpStatus(gbp) {
  const configured = gbp && gbp.configured;
  const connected = gbp && gbp.connected;

  gbpConnectLink.hidden = !configured || connected;
  gbpDisconnectButton.hidden = !connected;

  if (!configured) {
    gbpStatusElement.textContent = "Chưa cấu hình";
    gbpStatusDetailElement.textContent = "Thêm GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET và GOOGLE_BUSINESS_REDIRECT_URI vào .env để bật kết nối Google Business Profile.";
    return;
  }

  if (connected) {
    gbpStatusElement.textContent = "Đã kết nối";
    gbpStatusDetailElement.textContent = [
      "Có quyền đăng local post lên location của brand.",
      gbp.expiresAt ? `token hết hạn ${formatInstagramExpiry(gbp.expiresAt)}` : ""
    ].filter(Boolean).join(" · ");
    return;
  }

  gbpStatusElement.textContent = "Chưa kết nối";
  gbpStatusDetailElement.textContent = "Kết nối Google (scope business.manage) để đăng Google Business Profile từ Notion.";
}

async function loadGbpStatus() {
  try {
    const data = await fetchJson("/api/gbp/status");

    if (!data) {
      return;
    }

    renderGbpStatus(data.gbp);
  } catch (error) {
    gbpStatusElement.textContent = "Không tải được";
    gbpStatusDetailElement.textContent = error.message;
    gbpConnectLink.hidden = true;
    gbpDisconnectButton.hidden = true;
  }
}

async function disconnectGbp() {
  gbpDisconnectButton.disabled = true;
  gbpStatusDetailElement.textContent = "Đang ngắt kết nối Google Business Profile...";

  try {
    await fetchJson("/api/gbp/disconnect", { method: "POST" });
    await loadGbpStatus();
  } catch (error) {
    gbpStatusDetailElement.textContent = error.message;
  } finally {
    gbpDisconnectButton.disabled = false;
  }
}

function renderTiktokStatus(tiktok) {
  const configured = tiktok && tiktok.configured;
  const connected = tiktok && tiktok.connected;
  const user = tiktok && tiktok.user;
  const redirectText = tiktok && tiktok.redirectUri ? `Redirect URI: ${tiktok.redirectUri}` : "";

  tiktokConnectLink.hidden = !configured || connected;
  tiktokDisconnectButton.hidden = !connected;

  if (!configured) {
    tiktokStatusElement.textContent = "Chưa cấu hình";
    tiktokStatusDetailElement.textContent = "Thêm TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET và TIKTOK_REDIRECT_URI vào .env để bật kết nối TikTok.";
    return;
  }

  if (connected) {
    tiktokStatusElement.textContent = "Đã kết nối";
    tiktokStatusDetailElement.textContent = [
      user && user.displayName ? user.displayName : "Tài khoản TikTok đã kết nối",
      user && user.openId ? `open_id ${user.openId}` : "",
      user && user.expiresAt ? `token hết hạn ${formatInstagramExpiry(user.expiresAt)}` : "",
      redirectText
    ].filter(Boolean).join(" · ");
    return;
  }

  tiktokStatusElement.textContent = "Chưa kết nối";
  tiktokStatusDetailElement.textContent = [
    "Kết nối TikTok (scope video.publish) để đăng video từ Notion.",
    redirectText
  ].filter(Boolean).join(" ");
}

async function loadTiktokStatus() {
  try {
    const data = await fetchJson("/api/tiktok/status");

    if (!data) {
      return;
    }

    renderTiktokStatus(data.tiktok);
  } catch (error) {
    tiktokStatusElement.textContent = "Không tải được";
    tiktokStatusDetailElement.textContent = error.message;
    tiktokConnectLink.hidden = true;
    tiktokDisconnectButton.hidden = true;
  }
}

async function disconnectTiktok() {
  tiktokDisconnectButton.disabled = true;
  tiktokStatusDetailElement.textContent = "Đang ngắt kết nối TikTok...";

  try {
    await fetchJson("/api/tiktok/disconnect", { method: "POST" });
    await loadTiktokStatus();
  } catch (error) {
    tiktokStatusDetailElement.textContent = error.message;
  } finally {
    tiktokDisconnectButton.disabled = false;
  }
}

function formatTime(value) {
  if (!value) {
    return "Chưa đặt lịch";
  }

  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
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

function getStageLabel(task) {
  return taskStageLabels[task.taskStage] || "Cần kiểm tra";
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

function renderPages(pages) {
  pageListElement.innerHTML = "";

  if (pages.length === 0) {
    pageListElement.innerHTML = '<p class="empty-state">Tài khoản này chưa có Page nào có thể quản lý.</p>';
    return;
  }

  for (const page of pages) {
    const card = document.createElement("article");
    card.className = "page-card";

    const image = document.createElement("img");
    image.className = "page-avatar";
    image.alt = "";
    image.src = page.pictureUrl || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'%3E%3Crect width='96' height='96' fill='%23eef2f7'/%3E%3Ctext x='48' y='56' text-anchor='middle' font-family='Arial' font-size='32' fill='%234b5563'%3Ef%3C/text%3E%3C/svg%3E";

    const content = document.createElement("div");
    content.className = "page-card-body";

    const title = document.createElement("h3");
    title.textContent = page.name;

    const permission = document.createElement("p");
    permission.className = page.canCreateContent ? "badge success" : "badge warning";
    permission.textContent = page.canCreateContent ? "Có quyền đăng bài" : "Chưa có quyền đăng bài";

    const link = document.createElement("a");
    link.className = "button secondary";
    link.href = `/page-posts.html?pageId=${encodeURIComponent(page.id)}`;
    link.textContent = "Quản lý bài viết";

    content.append(title, permission, link);
    card.append(image, content);
    pageListElement.append(card);
  }
}

function renderPageFilter(tasks) {
  const currentValue = taskPageFilter.value || "all";
  const pages = Array.from(
    new Map(
      tasks
        .filter((task) => task.page)
        .map((task) => [task.page.id, task.page.name])
    ).entries()
  ).sort((a, b) => a[1].localeCompare(b[1], "vi"));

  taskPageFilter.innerHTML = '<option value="all">Tất cả Page</option>';

  for (const [pageId, pageName] of pages) {
    const option = document.createElement("option");
    option.value = pageId;
    option.textContent = pageName;
    taskPageFilter.append(option);
  }

  taskPageFilter.value = pages.some(([pageId]) => pageId === currentValue) ? currentValue : "all";
}

function taskMatchesFilters(task) {
  const query = normalizeText(taskSearchInput.value);
  const stage = taskStageFilter.value;
  const page = taskPageFilter.value;
  const reasons = getTaskReasons(task).join(" ");
  const searchable = normalizeText([
    task.title,
    task.caption,
    task.page && task.page.name,
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
    if (!task.overdue || task.tooOldOverdue) {
      return false;
    }
  } else if (stage !== "all" && task.taskStage !== stage) {
    return false;
  }

  if (page !== "all" && (!task.page || task.page.id !== page)) {
    return false;
  }

  return true;
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

async function processSingleTask(task, button) {
  button.disabled = true;
  notionStatusElement.textContent = "Đang xử lý tác vụ Notion...";

  try {
    const data = await fetchJson(`/api/notion/tasks/${encodeURIComponent(task.id)}/publish`, {
      method: "POST"
    });

    notionStatusElement.textContent = data.message || "Xử lý tác vụ Notion thành công.";
    await loadNotionTasks();
  } catch (error) {
    notionStatusElement.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderActionCell(cell, task) {
  const actions = document.createElement("div");
  actions.className = "table-actions";

  if (!task.isPublished && (task.readyToSchedule || task.readyToPublish) && task.page && task.page.canCreateContent) {
    const button = document.createElement("button");
    button.className = "button primary compact";
    button.type = "button";
    button.textContent = task.readyToSchedule ? "Đưa vào lịch" : "Đăng";
    button.addEventListener("click", () => processSingleTask(task, button));
    actions.append(button);
  }

  if (task.page) {
    actions.append(createActionLink("Page", `/page-posts.html?pageId=${encodeURIComponent(task.page.id)}`, "button secondary compact"));
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

function renderNotionTasks() {
  const tasks = allNotionTasks.filter(taskMatchesFilters);
  notionTaskListElement.innerHTML = "";

  if (tasks.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.className = "empty-table-cell";
    cell.textContent = "Không có tác vụ nào khớp với bộ lọc hiện tại.";
    row.append(cell);
    notionTaskListElement.append(row);
    return;
  }

  for (const task of tasks) {
    const row = document.createElement("tr");

    const titleCell = document.createElement("td");
    const title = document.createElement("strong");
    title.textContent = task.title || "(Tác vụ chưa có tiêu đề)";
    titleCell.append(title, createSmallText(task.caption || "Chưa có nội dung"));

    if (Array.isArray(task.tags) && task.tags.length > 0) {
      titleCell.append(createSmallText(task.tags.join(" ")));
    }

    const pageCell = document.createElement("td");
    pageCell.textContent = task.page ? task.page.name : "Chưa có Page";

    const publishAtCell = document.createElement("td");
    publishAtCell.textContent = formatTime(task.publishAt);

    if (task.overdue && !task.tooOldOverdue) {
      publishAtCell.append(createSmallText(formatOverdue(task.overdueMs)));
    }

    const formatCell = document.createElement("td");
    formatCell.textContent = task.postType || task.postFormat || "Văn bản";
    formatCell.append(createSmallText(`${task.mediaCount} tệp đính kèm`));

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

    row.append(
      titleCell,
      pageCell,
      publishAtCell,
      formatCell,
      publishStatusCell,
      stageCell,
      errorCell,
      reasonCell,
      actionCell
    );
    notionTaskListElement.append(row);
  }
}

async function loadNotionTasks() {
  try {
    notionStatusElement.textContent = "Đang tải tác vụ Notion...";
    const data = await fetchJson("/api/notion/tasks");

    if (!data) {
      return;
    }

    allNotionTasks = data.tasks;
    notionReadyCountElement.textContent = data.scheduleReadyCount || 0;
    notionOverdueCountElement.textContent = data.overdueCount || 0;
    renderPageFilter(allNotionTasks);
    renderNotionTasks();
    notionStatusElement.textContent =
      `${data.totalCount} tác vụ, ${data.scheduleReadyCount || 0} tác vụ sẵn sàng vào lịch, ${data.readyCount} tác vụ sẵn sàng đăng, ${data.overdueCount || 0} tác vụ quá hạn dưới 24 giờ.`;
  } catch (error) {
    allNotionTasks = [];
    notionReadyCountElement.textContent = "0";
    notionOverdueCountElement.textContent = "0";
    notionStatusElement.textContent = error.message;
    renderNotionTasks();
  }
}

// Tạo 1 dòng ID: nhãn (kênh + tên) · giá trị ID · nút Copy. Dùng createElement để tránh XSS.
function buildChannelIdRow(brandColumn, label, id) {
  const row = document.createElement("div");
  row.className = "channel-id-row";
  row.style.display = "flex";
  row.style.flexWrap = "wrap";
  row.style.alignItems = "center";
  row.style.gap = "10px";
  row.style.padding = "8px 0";
  row.style.borderBottom = "1px solid rgba(148,163,184,0.25)";

  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  labelEl.style.minWidth = "220px";
  labelEl.style.fontWeight = "600";

  const colEl = document.createElement("span");
  colEl.className = "muted";
  colEl.textContent = `→ ${brandColumn}`;
  colEl.style.minWidth = "180px";
  colEl.style.fontSize = "12px";

  const valueEl = document.createElement("code");
  valueEl.textContent = id;
  valueEl.style.flex = "1";
  valueEl.style.minWidth = "160px";
  valueEl.style.wordBreak = "break-all";

  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "button ghost compact";
  copyButton.textContent = "Copy";
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(id);
      copyButton.textContent = "Đã copy";
      setTimeout(() => { copyButton.textContent = "Copy"; }, 1500);
    } catch (error) {
      copyButton.textContent = "Lỗi copy";
    }
  });

  row.append(labelEl, colEl, valueEl, copyButton);
  return row;
}

function renderChannelIds(pages, instagram, tiktok) {
  channelIdListElement.replaceChildren();
  let count = 0;

  for (const page of Array.isArray(pages) ? pages : []) {
    channelIdListElement.append(
      buildChannelIdRow("Facebook Page ID", `Facebook · ${page.name || page.id}`, page.id)
    );
    count += 1;
  }

  if (instagram && instagram.connected && instagram.user && instagram.user.id) {
    const name = instagram.user.username ? `Instagram · @${instagram.user.username}` : "Instagram";
    channelIdListElement.append(buildChannelIdRow("Instagram Account ID", name, instagram.user.id));
    count += 1;
  }

  if (tiktok && tiktok.connected && tiktok.user && tiktok.user.openId) {
    const name = tiktok.user.displayName ? `TikTok · ${tiktok.user.displayName}` : "TikTok";
    channelIdListElement.append(buildChannelIdRow("TikTok Account ID", name, tiktok.user.openId));
    count += 1;
  }

  if (count === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Chưa có ID nào. Hãy kết nối Facebook/Instagram/TikTok để hiện ID.";
    channelIdListElement.append(empty);
  }
}

async function loadChannelIds() {
  try {
    const [pagesData, igData, tiktokData] = await Promise.all([
      fetchJson("/api/pages"),
      fetchJson("/api/instagram/status"),
      fetchJson("/api/tiktok/status")
    ]);
    renderChannelIds(
      pagesData && pagesData.pages,
      igData && igData.instagram,
      tiktokData && tiktokData.tiktok
    );
  } catch (error) {
    channelIdListElement.replaceChildren();
    const el = document.createElement("p");
    el.className = "muted";
    el.textContent = `Không tải được ID kênh: ${error.message}`;
    channelIdListElement.append(el);
  }
}

async function loadGbpLocations() {
  gbpLocationsButton.disabled = true;
  gbpLocationsStatusElement.textContent = "Đang lấy danh sách địa điểm Google Business...";
  gbpLocationsListElement.replaceChildren();

  try {
    const data = await fetchJson("/api/gbp/locations");
    const locations = (data && data.locations) || [];

    if (locations.length === 0) {
      gbpLocationsStatusElement.textContent = "Không tìm thấy địa điểm nào (kiểm tra quyền tài khoản Google hoặc allowlist Business Profile API).";
      return;
    }

    for (const location of locations) {
      const label = location.title
        ? `Google Business · ${location.title}${location.address ? ` (${location.address})` : ""}`
        : "Google Business";
      gbpLocationsListElement.append(
        buildChannelIdRow("Google Business Profile ID", label, location.id)
      );
    }
    gbpLocationsStatusElement.textContent = `Tìm thấy ${locations.length} địa điểm. Copy ID dán vào cột Google Business Profile ID của brand.`;
  } catch (error) {
    gbpLocationsStatusElement.textContent = error.message;
  } finally {
    gbpLocationsButton.disabled = false;
  }
}

async function loadDashboard() {
  try {
    statusElement.textContent = "Đang tải dữ liệu...";
    const [me, pagesData] = await Promise.all([fetchJson("/api/me"), fetchJson("/api/pages")]);

    if (!me || !pagesData) {
      return;
    }

    userNameElement.textContent = me.user.name;
    pageCountElement.textContent = pagesData.pageCount;
    renderPages(pagesData.pages);
    statusElement.textContent = "";
    await Promise.all([
      loadDriveStatus(),
      loadInstagramStatus(),
      loadGbpStatus(),
      loadTiktokStatus(),
      loadChannelIds(),
      loadNotionTasks()
    ]);
  } catch (error) {
    statusElement.textContent = error.message;
  }
}

async function publishDueTasks() {
  publishDueButton.disabled = true;
  publishOverdueButton.disabled = true;

  try {
    notionStatusElement.textContent = "Đang xử lý tác vụ Notion...";
    const data = await fetchJson("/api/notion/publish-due", { method: "POST" });
    notionStatusElement.textContent =
      `${data.schedule ? data.schedule.successCount : 0} tác vụ vào lịch, ${data.successCount} tác vụ đăng thành công, ${data.failureCount} tác vụ lỗi.`;
    await loadNotionTasks();
  } catch (error) {
    notionStatusElement.textContent = error.message;
  } finally {
    publishDueButton.disabled = false;
    publishOverdueButton.disabled = false;
  }
}

async function publishOverdueTasks() {
  publishDueButton.disabled = true;
  publishOverdueButton.disabled = true;

  try {
    notionStatusElement.textContent = "Đang xử lý bài quá hạn dưới 24 giờ...";
    const data = await fetchJson("/api/notion/publish-overdue", { method: "POST" });
    notionStatusElement.textContent =
      `${data.schedule ? data.schedule.successCount : 0} bài quá hạn vào lịch, ${data.successCount} bài quá hạn đăng thành công, ${data.failureCount} bài lỗi.`;
    await loadNotionTasks();
  } catch (error) {
    notionStatusElement.textContent = error.message;
  } finally {
    publishDueButton.disabled = false;
    publishOverdueButton.disabled = false;
  }
}

async function retryFailedTasks() {
  publishDueButton.disabled = true;
  publishOverdueButton.disabled = true;
  retryFailedButton.disabled = true;

  try {
    notionStatusElement.textContent = "Đang chuẩn bị các task lỗi để đăng lại...";
    const data = await fetchJson("/api/notion/retry-failed", { method: "POST" });
    notionStatusElement.textContent =
      `Đã chuẩn bị ${data.successCount} task lỗi để đăng lại, bỏ qua ${data.skippedCount} task chưa đủ điều kiện.`;
    await loadNotionTasks();
  } catch (error) {
    notionStatusElement.textContent = error.message;
  } finally {
    publishDueButton.disabled = false;
    publishOverdueButton.disabled = false;
    retryFailedButton.disabled = false;
  }
}

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;

  try {
    await fetchJson("/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/";
  }
});

taskSearchInput.addEventListener("input", renderNotionTasks);
taskStageFilter.addEventListener("change", renderNotionTasks);
taskPageFilter.addEventListener("change", renderNotionTasks);
publishDueButton.addEventListener("click", publishDueTasks);
publishOverdueButton.addEventListener("click", publishOverdueTasks);
retryFailedButton.addEventListener("click", retryFailedTasks);
driveDisconnectButton.addEventListener("click", disconnectDrive);
instagramDisconnectButton.addEventListener("click", disconnectInstagram);
gbpDisconnectButton.addEventListener("click", disconnectGbp);
tiktokDisconnectButton.addEventListener("click", disconnectTiktok);
gbpLocationsButton.addEventListener("click", loadGbpLocations);

loadDashboard();
