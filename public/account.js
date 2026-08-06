// Trang tài khoản (đăng ký/đăng nhập). Tự chứa, không phụ thuộc shell admin.
(function () {
  const tabLogin = document.querySelector("#tab-login");
  const tabRegister = document.querySelector("#tab-register");
  const loginForm = document.querySelector("#login-form");
  const registerForm = document.querySelector("#register-form");
  const signedIn = document.querySelector("#signed-in");
  const signedInName = document.querySelector("#signed-in-name");
  const alertBox = document.querySelector("#alert");
  const logoutButton = document.querySelector("#logout-button");
  const loginEmail = document.querySelector("#login-email");
  const loginPassword = document.querySelector("#login-password");
  const loginRemember = document.querySelector("#login-remember");

  const REMEMBER_EMAIL_KEY = "app.rememberEmail";

  // Lưu thông tin đăng nhập vào TRÌNH QUẢN LÝ MẬT KHẨU của trình duyệt (mã hóa, an toàn)
  // để lần sau tự điền — không lưu mật khẩu dạng thô ở localStorage.
  async function saveCredentialToBrowser(email, password) {
    if (!window.PasswordCredential || !navigator.credentials) {
      return;
    }
    try {
      const credential = new window.PasswordCredential({ id: email, password, name: email });
      await navigator.credentials.store(credential);
    } catch {
      /* trình duyệt từ chối lưu — bỏ qua, không ảnh hưởng đăng nhập */
    }
  }

  // Ghi nhớ email để lần sau điền sẵn ô email (tiện, không nhạy cảm như mật khẩu).
  function rememberEmail(email, remember) {
    try {
      if (remember && email) {
        window.localStorage.setItem(REMEMBER_EMAIL_KEY, email);
      } else {
        window.localStorage.removeItem(REMEMBER_EMAIL_KEY);
      }
    } catch {
      /* localStorage bị chặn — bỏ qua */
    }
  }

  function prefillLoginEmail() {
    try {
      const saved = window.localStorage.getItem(REMEMBER_EMAIL_KEY);
      if (saved && loginEmail && !loginEmail.value) {
        loginEmail.value = saved;
        if (loginRemember) loginRemember.checked = true;
        if (loginPassword) loginPassword.focus();
      }
    } catch {
      /* bỏ qua */
    }
  }

  const ACTIVE = "rounded-lg py-2 bg-white text-slate-900 shadow-sm";
  const INACTIVE = "rounded-lg py-2 text-slate-600";

  function showAlert(message, type) {
    alertBox.textContent = message;
    alertBox.className =
      type === "error"
        ? "mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700"
        : "mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700";
    alertBox.classList.remove("hidden");
  }

  function hideAlert() {
    alertBox.classList.add("hidden");
  }

  function selectTab(tab) {
    hideAlert();
    const isLogin = tab === "login";
    tabLogin.className = isLogin ? ACTIVE : INACTIVE;
    tabRegister.className = isLogin ? INACTIVE : ACTIVE;
    loginForm.classList.toggle("hidden", !isLogin);
    registerForm.classList.toggle("hidden", isLogin);
  }

  function showSignedIn(user) {
    loginForm.classList.add("hidden");
    registerForm.classList.add("hidden");
    tabLogin.parentElement.classList.add("hidden");
    hideAlert();
    signedIn.classList.remove("hidden");
    signedInName.textContent = user.name ? `${user.name} · ${user.email}` : user.email;
    loadFacebookStatus();
    loadNotionStatus();
    initWorkerTokens();
  }

  async function loadNotionStatus() {
    const statusEl = document.querySelector("#notion-status");
    const connectEl = document.querySelector("#notion-connect");
    const disconnectEl = document.querySelector("#notion-disconnect");
    const picker = document.querySelector("#notion-db-picker");
    try {
      const res = await fetch("/account/notion/status");
      const data = await res.json();
      const status = (data && data.status) || {};
      if (status.connected) {
        statusEl.textContent = status.dbSelected
          ? `Đã kết nối: ${status.workspaceName || "workspace"} · đã chọn database.`
          : `Đã kết nối: ${status.workspaceName || "workspace"} · chưa chọn database.`;
        connectEl.textContent = "Kết nối lại";
        disconnectEl.classList.remove("hidden");
        picker.classList.remove("hidden");
        loadNotionDatabases(status);
      } else {
        statusEl.textContent = "Chưa kết nối Notion.";
        connectEl.textContent = "Kết nối Notion";
        disconnectEl.classList.add("hidden");
        picker.classList.add("hidden");
      }
    } catch {
      statusEl.textContent = "Không kiểm tra được trạng thái Notion.";
    }
  }

  async function loadNotionDatabases(status) {
    const contentSel = document.querySelector("#notion-content-db");
    const brandsSel = document.querySelector("#notion-brands-db");
    try {
      const res = await fetch("/account/notion/databases");
      const data = await res.json();
      const dbs = (data && data.databases) || [];
      const options = ['<option value="">-- Chọn --</option>']
        .concat(dbs.map((d) => `<option value="${d.id}">${d.title}</option>`))
        .join("");
      contentSel.innerHTML = options;
      brandsSel.innerHTML = options;
      if (status.contentDataSourceId) contentSel.value = status.contentDataSourceId;
      if (status.brandsDataSourceId) brandsSel.value = status.brandsDataSourceId;
    } catch {
      /* im lặng */
    }
  }

  document.querySelector("#notion-save-db").addEventListener("click", async () => {
    const statusEl = document.querySelector("#notion-db-status");
    statusEl.textContent = "Đang lưu...";
    try {
      const res = await fetch("/account/notion/databases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentDataSourceId: document.querySelector("#notion-content-db").value,
          brandsDataSourceId: document.querySelector("#notion-brands-db").value
        })
      });
      const data = await res.json();
      statusEl.textContent = data.message || (data.success ? "Đã lưu." : "Lỗi.");
    } catch (error) {
      statusEl.textContent = error.message;
    }
  });

  document.querySelector("#notion-disconnect").addEventListener("click", async () => {
    try {
      await fetch("/account/notion/disconnect", { method: "POST" });
    } finally {
      loadNotionStatus();
    }
  });

  async function loadFacebookStatus() {
    const statusEl = document.querySelector("#fb-status");
    const connectEl = document.querySelector("#fb-connect");
    const disconnectEl = document.querySelector("#fb-disconnect");
    try {
      const res = await fetch("/account/facebook/status");
      const data = await res.json();
      const status = (data && data.status) || {};
      if (status.connected) {
        statusEl.textContent = `Đã kết nối: ${status.fbUserName || status.fbUserId || "Facebook"} · ${status.pageCount || 0} Page.`;
        connectEl.textContent = "Kết nối lại";
        disconnectEl.classList.remove("hidden");
      } else {
        statusEl.textContent = "Chưa kết nối Facebook.";
        connectEl.textContent = "Kết nối Facebook";
        disconnectEl.classList.add("hidden");
      }
    } catch {
      statusEl.textContent = "Không kiểm tra được trạng thái Facebook.";
    }
  }

  document.querySelector("#fb-disconnect").addEventListener("click", async () => {
    try {
      await fetch("/account/facebook/disconnect", { method: "POST" });
    } finally {
      loadFacebookStatus();
    }
  });

  // --- Token cho Công cụ cào (app tải về) ----------------------------------
  const wkNameInput = document.querySelector("#wk-name");
  const wkCreateBtn = document.querySelector("#wk-create");
  const wkNewBox = document.querySelector("#wk-new");
  const wkTokenEl = document.querySelector("#wk-token");
  const wkCopyBtn = document.querySelector("#wk-copy");
  const wkStatus = document.querySelector("#wk-status");
  const wkList = document.querySelector("#wk-list");
  const wkWebUrl = document.querySelector("#wk-web-url");

  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  // Tên token do người dùng đặt -> phải thoát trước khi nhét vào innerHTML.
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }

  function fmtDate(value) {
    if (!value) return "—";
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  }

  function tokenTrangThai(t) {
    if (t.revokedAt) return { text: "Đã thu hồi", cls: "text-slate-400" };
    if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) {
      return { text: "Hết hạn", cls: "text-rose-600" };
    }
    return { text: "Đang hoạt động", cls: "text-emerald-600" };
  }

  function renderTokenList(tokens) {
    if (!tokens.length) {
      wkList.innerHTML = '<p class="text-xs text-slate-400">Chưa có mã kết nối nào.</p>';
      return;
    }
    wkList.innerHTML = tokens
      .map((t) => {
        const tt = tokenTrangThai(t);
        const revokeBtn = t.revokedAt
          ? ""
          : `<button type="button" data-revoke="${esc(t.id)}" class="mt-2 rounded-lg border border-rose-200 px-2 py-1 text-[11px] font-medium text-rose-600 hover:bg-rose-50">Thu hồi</button>`;
        return `
        <div class="rounded-lg border border-slate-200 px-3 py-2">
          <div class="flex items-center justify-between gap-2">
            <span class="truncate text-sm font-medium text-slate-800">${esc(t.name || "(không tên)")}</span>
            <span class="shrink-0 text-xs font-semibold ${tt.cls}">${tt.text}</span>
          </div>
          <p class="mt-0.5 font-mono text-[11px] text-slate-400">${esc(t.tokenPrefix)}…</p>
          <p class="mt-1 text-[11px] text-slate-500">Tạo: ${fmtDate(t.createdAt)} · Hết hạn: ${fmtDate(t.expiresAt)} · Dùng lần cuối: ${fmtDate(t.lastUsedAt)}</p>
          ${revokeBtn}
        </div>`;
      })
      .join("");

    wkList.querySelectorAll("[data-revoke]").forEach((btn) => {
      btn.addEventListener("click", () => revokeWorkerToken(btn.getAttribute("data-revoke")));
    });
  }

  async function loadWorkerTokens() {
    try {
      const res = await fetch("/account/worker-tokens");
      const data = await res.json();
      renderTokenList((data && data.tokens) || []);
    } catch {
      wkList.innerHTML = '<p class="text-xs text-rose-500">Không tải được danh sách mã.</p>';
    }
  }

  async function revokeWorkerToken(id) {
    wkStatus.textContent = "Đang thu hồi...";
    try {
      await postJson(`/account/worker-tokens/${id}/revoke`, {});
      wkStatus.textContent = "Đã thu hồi mã.";
      loadWorkerTokens();
    } catch (error) {
      wkStatus.textContent = error.message;
    }
  }

  if (wkCreateBtn) {
    wkCreateBtn.addEventListener("click", async () => {
      wkCreateBtn.disabled = true;
      wkStatus.textContent = "Đang tạo...";
      try {
        const data = await postJson("/account/worker-tokens", { name: wkNameInput.value.trim() });
        // Token gốc chỉ trả về lần này -> hiện ngay, không lưu ở đâu khác.
        wkTokenEl.textContent = data.token;
        wkNewBox.classList.remove("hidden");
        wkStatus.textContent = "";
        wkNameInput.value = "";
        loadWorkerTokens();
      } catch (error) {
        wkStatus.textContent = error.message;
      } finally {
        wkCreateBtn.disabled = false;
      }
    });
  }

  if (wkCopyBtn) {
    wkCopyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(wkTokenEl.textContent || "");
        wkCopyBtn.textContent = "Đã sao chép ✓";
        setTimeout(() => {
          wkCopyBtn.textContent = "Sao chép";
        }, 1500);
      } catch {
        wkStatus.textContent = "Không sao chép được — hãy bôi đen mã và copy thủ công.";
      }
    });
  }

  function initWorkerTokens() {
    if (wkWebUrl) wkWebUrl.textContent = window.location.origin;
    loadWorkerTokens();
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.success === false) {
      throw new Error((data && data.message) || "Yêu cầu thất bại.");
    }
    return data;
  }

  async function checkSession() {
    try {
      const res = await fetch("/account/me");
      const data = await res.json();
      if (data.user) {
        showSignedIn(data.user);
      }
    } catch {
      /* im lặng */
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = loginForm.querySelector("button");
    button.disabled = true;
    const email = loginEmail.value.trim();
    const password = loginPassword.value;
    const remember = Boolean(loginRemember && loginRemember.checked);
    try {
      const data = await postJson("/account/login", { email, password, remember });
      rememberEmail(email, remember);
      if (remember) {
        await saveCredentialToBrowser(email, password);
      }
      showSignedIn(data.user);
    } catch (error) {
      showAlert(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = registerForm.querySelector("button");
    button.disabled = true;
    try {
      const regEmail = document.querySelector("#reg-email").value.trim();
      const regPassword = document.querySelector("#reg-password").value;
      const data = await postJson("/account/register", {
        name: document.querySelector("#reg-name").value.trim(),
        email: regEmail,
        phone: document.querySelector("#reg-phone").value.trim(),
        password: regPassword
      });
      rememberEmail(regEmail, true);
      await saveCredentialToBrowser(regEmail, regPassword);
      showSignedIn(data.user);
    } catch (error) {
      showAlert(error.message, "error");
    } finally {
      button.disabled = false;
    }
  });

  logoutButton.addEventListener("click", async () => {
    try {
      await fetch("/account/logout", { method: "POST" });
    } finally {
      window.location.reload();
    }
  });

  tabLogin.addEventListener("click", () => selectTab("login"));
  tabRegister.addEventListener("click", () => selectTab("register"));

  selectTab("login");
  prefillLoginEmail();
  checkSession();
})();
