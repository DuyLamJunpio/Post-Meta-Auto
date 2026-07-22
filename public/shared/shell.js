// Khung điều hướng dùng chung: render sidebar + wire đăng xuất + set link active.
// Mỗi trang gọi mountShell("/duong-dan.html") sau khi DOM sẵn sàng.
import { fetchJson, el } from "/shared/api.js";

const NAV = [
  { href: "/dashboard.html", label: "Tổng quan", icon: iconGrid },
  { href: "/tasks.html", label: "Tác vụ Notion", icon: iconCalendar },
  { href: "/import.html", label: "Nhập Excel", icon: iconUpload },
  { href: "/posts.html", label: "Bài đăng & An toàn", icon: iconShield },
  { href: "/settings.html", label: "Kết nối kênh", icon: iconPlug }
];

function svg(pathMarkup) {
  const wrap = document.createElement("span");
  wrap.className = "shrink-0";
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor" class="w-5 h-5">${pathMarkup}</svg>`;
  return wrap;
}

function iconGrid() {
  return svg('<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h1.5A2.25 2.25 0 019.75 6v1.5A2.25 2.25 0 017.5 9.75H6A2.25 2.25 0 013.75 7.5V6zM3.75 16.5A2.25 2.25 0 016 14.25h1.5a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-1.5zM14.25 6A2.25 2.25 0 0116.5 3.75H18A2.25 2.25 0 0120.25 6v1.5A2.25 2.25 0 0118 9.75h-1.5A2.25 2.25 0 0114.25 7.5V6zM14.25 16.5a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-1.5A2.25 2.25 0 0114.25 18v-1.5z" />');
}
function iconCalendar() {
  return svg('<path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />');
}
function iconShield() {
  return svg('<path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12c0 5.25-4.5 9-9 9s-9-3.75-9-9c0-.828.11-1.63.316-2.393a11.96 11.96 0 018.684-3.69 11.96 11.96 0 018.684 3.69c.206.763.316 1.565.316 2.393z" />');
}
function iconUpload() {
  return svg('<path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 7.5L12 3m0 0L7.5 7.5M12 3v13.5" />');
}
function iconPlug() {
  return svg('<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 3.75v3.75m-7.5-3.75v3.75M6 7.5h12a.75.75 0 01.75.75v3a6.75 6.75 0 01-6.75 6.75A6.75 6.75 0 015.25 11.25v-3A.75.75 0 016 7.5zM12 18.75V21" />');
}

function buildLink(item, activeHref) {
  const isActive = item.href === activeHref;
  const link = el(
    "a",
    {
      class: [
        "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
        isActive
          ? "bg-brand-500 text-white shadow-sm shadow-brand-500/30"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      ].join(" "),
      attrs: { href: item.href, "aria-current": isActive ? "page" : null }
    },
    [item.icon(), el("span", { text: item.label })]
  );
  return link;
}

async function logout(button) {
  button.disabled = true;
  try {
    await fetch("/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/";
  }
}

function wireMobileToggle(sidebar) {
  const backdrop = document.querySelector("#sidebar-backdrop");
  const open = () => {
    sidebar.classList.remove("-translate-x-full");
    if (backdrop) backdrop.classList.remove("hidden");
  };
  const close = () => {
    sidebar.classList.add("-translate-x-full");
    if (backdrop) backdrop.classList.add("hidden");
  };

  document.querySelectorAll("[data-sidebar-toggle]").forEach((btn) => btn.addEventListener("click", open));
  if (backdrop) backdrop.addEventListener("click", close);
  sidebar.querySelectorAll("a").forEach((link) => link.addEventListener("click", close));
}

export function mountShell(activeHref) {
  const mount = document.querySelector("#sidebar-mount");
  if (!mount) {
    return;
  }

  const nameEl = el("p", { class: "text-sm font-semibold text-slate-800 truncate", text: "Đang tải..." });
  const logoutButton = el("button", {
    class: "w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors",
    text: "Đăng xuất",
    attrs: { type: "button" }
  });
  logoutButton.addEventListener("click", () => logout(logoutButton));

  const sidebar = el("div", { class: "flex h-full flex-col gap-6 p-4" }, [
    el("div", { class: "flex items-center gap-3 px-1 pt-1" }, [
      el("div", {
        class: "flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500 text-lg font-bold text-white",
        text: "f"
      }),
      el("div", { class: "min-w-0" }, [
        el("p", { class: "text-sm font-bold text-slate-900 leading-tight", text: "Notion → Kênh" }),
        el("p", { class: "text-xs text-slate-500 leading-tight", text: "Bảng quản trị tự đăng" })
      ])
    ]),
    el("nav", { class: "flex flex-col gap-1" }, NAV.map((item) => buildLink(item, activeHref))),
    el("div", { class: "mt-auto flex flex-col gap-3 border-t border-slate-100 pt-4" }, [
      el("div", { class: "px-1" }, [
        el("p", { class: "text-xs uppercase tracking-wide text-slate-400", text: "Đang đăng nhập" }),
        nameEl
      ]),
      logoutButton
    ])
  ]);

  mount.append(sidebar);
  wireMobileToggle(mount);

  // Lấy tên tài khoản để hiển thị (đồng thời là cổng kiểm tra đăng nhập cho mọi trang).
  fetchJson("/api/me")
    .then((data) => {
      if (data && data.user) {
        nameEl.textContent = data.user.name || "Tài khoản Facebook";
      }
    })
    .catch(() => {
      nameEl.textContent = "Không tải được tài khoản";
    });
}
