const axios = require("axios");

const { config } = require("../../config");

// Notifier Telegram: gửi cảnh báo qua Bot API. Tự tắt nếu thiếu token/chat id
// (giống cách Drive/IG bật/tắt theo credential).

function isEnabled() {
  return config.telegram.enabled;
}

// event: { level, title, lines: string[], imageUrl?, linkPreview? }
// - imageUrl: nếu có, gửi kèm ảnh (sendPhoto) để nhận diện bài ngay trên Telegram.
// - linkPreview: cho phép Telegram bung xem trước link (vd permalink Facebook).
async function send(event) {
  if (!isEnabled()) {
    return { skipped: true };
  }

  const text = [event.title, "", ...(event.lines || [])].filter((line) => line !== undefined && line !== null).join("\n");
  const base = `https://api.telegram.org/bot${config.telegram.botToken}`;

  async function sendMessage() {
    await axios.post(
      `${base}/sendMessage`,
      {
        chat_id: config.telegram.chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: !event.linkPreview
      },
      { timeout: 10000 }
    );
  }

  try {
    if (event.imageUrl) {
      // Caption của sendPhoto tối đa 1024 ký tự.
      await axios.post(
        `${base}/sendPhoto`,
        {
          chat_id: config.telegram.chatId,
          photo: event.imageUrl,
          caption: text.slice(0, 1024)
        },
        { timeout: 15000 }
      );
      return { sent: true };
    }

    await sendMessage();
    return { sent: true };
  } catch (error) {
    // Nếu gửi ảnh lỗi (URL ảnh không tải được) -> vẫn gửi tin nhắn chữ để không mất cảnh báo.
    if (event.imageUrl) {
      try {
        await sendMessage();
        return { sent: true, fallback: true };
      } catch {
        // rơi xuống log bên dưới
      }
    }
    // Cảnh báo không được làm hỏng luồng đăng -> chỉ log.
    const detail = error.response && error.response.data ? error.response.data : error.message;
    console.warn("[Telegram Notifier] Gửi cảnh báo thất bại:", detail);
    return { sent: false, error: detail };
  }
}

module.exports = { isEnabled, send };
