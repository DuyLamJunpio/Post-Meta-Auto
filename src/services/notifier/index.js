const { config } = require("../../config");
const telegramNotifier = require("./telegram.notifier");

// Điểm vào cảnh báo đa kênh. Hiện có Telegram; thiết kế để thêm email/Zalo/Messenger sau
// (chỉ cần thêm notifier có isEnabled()/send() vào mảng NOTIFIERS).
const NOTIFIERS = [telegramNotifier];

function shouldNotify(level) {
  // notifyLevel = "important": chỉ gửi sự kiện quan trọng (lỗi/pause/thu hồi).
  if (config.telegram.notifyLevel === "important") {
    return level === "important";
  }
  return true; // "all"
}

// event: { level: "info"|"important", title, lines: string[] }
async function notify(event) {
  if (!shouldNotify(event.level)) {
    return;
  }

  await Promise.all(
    NOTIFIERS.filter((notifier) => notifier.isEnabled()).map((notifier) =>
      notifier.send(event).catch((error) => {
        console.warn("[Notifier] Lỗi khi gửi cảnh báo:", error.message);
      })
    )
  );
}

function isAnyEnabled() {
  return NOTIFIERS.some((notifier) => notifier.isEnabled());
}

module.exports = { notify, isAnyEnabled };
