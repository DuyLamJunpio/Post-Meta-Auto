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
    try {
      const data = await postJson("/account/login", {
        email: document.querySelector("#login-email").value.trim(),
        password: document.querySelector("#login-password").value
      });
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
      const data = await postJson("/account/register", {
        name: document.querySelector("#reg-name").value.trim(),
        email: document.querySelector("#reg-email").value.trim(),
        phone: document.querySelector("#reg-phone").value.trim(),
        password: document.querySelector("#reg-password").value
      });
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
  checkSession();
})();
