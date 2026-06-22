const statusElement = document.querySelector("#login-status");

async function redirectIfLoggedIn() {
  try {
    const response = await fetch("/api/me");

    if (response.ok) {
      window.location.href = "/dashboard.html";
      return;
    }

    statusElement.textContent = "";
  } catch (error) {
    statusElement.textContent = "Chưa kết nối được server local.";
  }
}

redirectIfLoggedIn();
