// Trang thu lead công khai (không dùng shell admin). Tự chứa, không import module admin.
(function () {
  const alertBox = document.querySelector("#alert");
  const loginStep = document.querySelector("#login-step");
  const form = document.querySelector("#lead-form");
  const successStep = document.querySelector("#success-step");
  const helloName = document.querySelector("#hello-name");
  const nameInput = document.querySelector("#name");
  const emailInput = document.querySelector("#email");
  const phoneInput = document.querySelector("#phone");
  const noteInput = document.querySelector("#note");
  const consentInput = document.querySelector("#consent");
  const consentText = document.querySelector("#consent-text");
  const submitButton = document.querySelector("#submit-button");

  function showAlert(message, type) {
    alertBox.textContent = message;
    alertBox.className =
      type === "error"
        ? "mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700"
        : "mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700";
    alertBox.classList.remove("hidden");
  }

  async function loadProfile() {
    if (new URLSearchParams(location.search).get("error") === "auth") {
      showAlert("Đăng nhập Facebook chưa hoàn tất. Vui lòng thử lại.", "error");
    }

    try {
      const res = await fetch("/lead/me");
      const data = await res.json();
      consentText.textContent = data.consentText || "";

      if (data.profile) {
        loginStep.classList.add("hidden");
        form.classList.remove("hidden");
        helloName.textContent = data.profile.name || "bạn";
        if (data.profile.name) nameInput.value = data.profile.name;
        if (data.profile.email) emailInput.value = data.profile.email;
      }
    } catch {
      showAlert("Không tải được trang. Vui lòng tải lại.", "error");
    }
  }

  async function submitForm(event) {
    event.preventDefault();

    if (!consentInput.checked) {
      showAlert("Vui lòng tick đồng ý để tiếp tục.", "error");
      return;
    }
    if (!phoneInput.value.trim()) {
      showAlert("Vui lòng nhập số điện thoại.", "error");
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Đang gửi...";

    try {
      const res = await fetch("/lead/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: nameInput.value.trim(),
          phone: phoneInput.value.trim(),
          email: emailInput.value.trim(),
          note: noteInput.value.trim(),
          consent: consentInput.checked
        })
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data || data.success === false) {
        throw new Error((data && data.message) || "Gửi đăng ký thất bại.");
      }

      form.classList.add("hidden");
      alertBox.classList.add("hidden");
      successStep.classList.remove("hidden");
    } catch (error) {
      showAlert(error.message, "error");
      submitButton.disabled = false;
      submitButton.textContent = "Gửi đăng ký";
    }
  }

  form.addEventListener("submit", submitForm);
  loadProfile();
})();
