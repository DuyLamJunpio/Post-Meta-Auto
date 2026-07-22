// Module dùng chung: gọi API + tiện ích format/DOM cho mọi trang.

export async function fetchJson(url, options = {}) {
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

export function formatTime(value, emptyLabel = "Chưa đặt lịch") {
  if (!value) {
    return emptyLabel;
  }

  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function formatOverdue(value) {
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

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Tạo phần tử DOM an toàn (không dùng innerHTML với dữ liệu người dùng).
// opts: { class, text, html, attrs:{}, on:{} }
export function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);

  if (opts.class) {
    node.className = opts.class;
  }

  if (typeof opts.text === "string") {
    node.textContent = opts.text;
  }

  if (typeof opts.html === "string") {
    node.innerHTML = opts.html;
  }

  if (opts.attrs) {
    for (const [key, value] of Object.entries(opts.attrs)) {
      if (value !== null && value !== undefined && value !== false) {
        node.setAttribute(key, value === true ? "" : value);
      }
    }
  }

  if (opts.on) {
    for (const [event, handler] of Object.entries(opts.on)) {
      node.addEventListener(event, handler);
    }
  }

  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }

  return node;
}
