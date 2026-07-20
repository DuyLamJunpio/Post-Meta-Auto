const { config } = require("../config");

// Lớp phanh an toàn cho vòng lặp tự đăng. Giữ trạng thái runtime (in-memory):
// - Kill switch cứng qua env (config.autoPublish.enabled).
// - Pause mềm runtime (bật/tắt nhanh qua endpoint admin, không cần restart).
// - Cooldown theo từng page: chặn đăng dồn nhiều bài lên cùng một page trong thời gian ngắn.
//
// Lưu ý: pause runtime nằm trong bộ nhớ tiến trình -> restart sẽ mất pause (fail-open).
// Kill switch bền vững là biến môi trường AUTO_PUBLISH_ENABLED=false.

const state = {
  pausedReason: null, // null = không pause; chuỗi = lý do pause
  pausedAt: null
};

// pageId -> epoch ms của lần đăng gần nhất, để tính cooldown.
const lastPublishByAccount = new Map();

function isEnabledByConfig() {
  return config.autoPublish.enabled;
}

function isPaused() {
  return state.pausedReason !== null;
}

// Vòng lặp tự đăng chỉ chạy khi bật env VÀ không bị pause runtime.
function isActive() {
  return isEnabledByConfig() && !isPaused();
}

function pause(reason) {
  state.pausedReason = reason || "Tạm dừng thủ công.";
  state.pausedAt = new Date().toISOString();
  console.warn("[Publish Guard] Đã PAUSE tự đăng:", state.pausedReason);
  return getStatus();
}

function resume() {
  const was = state.pausedReason;
  state.pausedReason = null;
  state.pausedAt = null;
  if (was) {
    console.warn("[Publish Guard] Đã RESUME tự đăng (trước đó pause vì:", was, ")");
  }
  return getStatus();
}

function getStatus() {
  return {
    enabledByConfig: isEnabledByConfig(),
    paused: isPaused(),
    pausedReason: state.pausedReason,
    pausedAt: state.pausedAt,
    active: isActive(),
    limits: {
      maxPublishPerRun: config.autoPublish.maxPublishPerRun,
      perPageCooldownMs: config.autoPublish.perPageCooldownMs,
      anomalyThreshold: config.autoPublish.anomalyThreshold
    }
  };
}

// Còn được phép đăng lên page này không (đã qua cooldown chưa).
function canPublishToAccount(accountId, now = Date.now()) {
  if (!accountId || config.autoPublish.perPageCooldownMs <= 0) {
    return true;
  }
  const last = lastPublishByAccount.get(String(accountId));
  if (!last) {
    return true;
  }
  return now - last >= config.autoPublish.perPageCooldownMs;
}

// Số ms còn lại của cooldown (để hiển thị/log).
function cooldownRemainingMs(accountId, now = Date.now()) {
  const last = lastPublishByAccount.get(String(accountId));
  if (!last || config.autoPublish.perPageCooldownMs <= 0) {
    return 0;
  }
  return Math.max(0, config.autoPublish.perPageCooldownMs - (now - last));
}

// Ghi nhận vừa đăng thành công lên page (để bắt đầu tính cooldown).
function recordPublish(accountId, now = Date.now()) {
  if (accountId) {
    lastPublishByAccount.set(String(accountId), now);
  }
}

module.exports = {
  isEnabledByConfig,
  isPaused,
  isActive,
  pause,
  resume,
  getStatus,
  canPublishToAccount,
  cooldownRemainingMs,
  recordPublish
};
