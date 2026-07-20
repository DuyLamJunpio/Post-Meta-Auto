const axios = require("axios");

const { config } = require("../../config");

// Notifier Telegram: gửi cảnh báo qua Bot API. Tự tắt nếu thiếu token/chat id
// (giống cách Drive/IG bật/tắt theo credential).

function isEnabled() {
  return config.telegram.enabled;
}

// event: { level: "info"|"important", title, lines: string[] }
async function send(event) {
  if (!isEnabled()) {
    return { skipped: true };
  }

  const text = [event.title, "", ...(event.lines || [])].filter((line) => line !== undefined).join("\n");
  const url = `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`;

  try {
    await axios.post(
      url,
      {
        chat_id: config.telegram.chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true
      },
      { timeout: 10000 }
    );
    return { sent: true };
  } catch (error) {
    // Cảnh báo không được làm hỏng luồng đăng -> chỉ log.
    const detail = error.response && error.response.data ? error.response.data : error.message;
    console.warn("[Telegram Notifier] Gửi cảnh báo thất bại:", detail);
    return { sent: false, error: detail };
  }
}

module.exports = { isEnabled, send };
