const { CHANNELS, CHANNEL_LABELS, CHANNEL_NOTION_LABELS, channelKeyFromLabel } = require("./adapter");
const facebookAdapter = require("./facebook.adapter");
const instagramAdapter = require("./instagram.adapter");
const gbpAdapter = require("./gbp.adapter");
const tiktokAdapter = require("./tiktok.adapter");

// Registry của các channel adapter. Thêm kênh mới = thêm 1 dòng vào ADAPTERS.
const ADAPTERS = Object.freeze({
  [CHANNELS.FACEBOOK]: facebookAdapter,
  [CHANNELS.INSTAGRAM]: instagramAdapter,
  [CHANNELS.GBP]: gbpAdapter,
  [CHANNELS.TIKTOK]: tiktokAdapter
});

function getAdapter(channelKey) {
  return ADAPTERS[channelKey] || null;
}

function hasAdapter(channelKey) {
  return Boolean(ADAPTERS[channelKey]);
}

function listAdapters() {
  return Object.values(ADAPTERS);
}

function listChannelKeys() {
  return Object.keys(ADAPTERS);
}

// Resolve tài khoản đăng của 1 kênh cho 1 brand (per-channel account resolution).
// Trả về trạng thái đủ để lớp trên quyết định readiness mà không cần biết chi tiết kênh:
//   supported  = kênh đã có adapter đăng ký chưa
//   configured = server đã có credentials cho kênh chưa
//   account    = tài khoản đăng cụ thể (page/ig business/...) hoặc null
// context: { brand, sessionPages } (mỗi adapter tự đọc field brand/token phù hợp)
function resolveChannelAccount(channelKey, context) {
  const adapter = getAdapter(channelKey);

  if (!adapter) {
    return { supported: false, configured: false, account: null };
  }

  return {
    supported: true,
    configured: adapter.isConfigured(),
    account: adapter.resolveAccount(context || {})
  };
}

module.exports = {
  CHANNELS,
  CHANNEL_LABELS,
  CHANNEL_NOTION_LABELS,
  channelKeyFromLabel,
  getAdapter,
  hasAdapter,
  listAdapters,
  listChannelKeys,
  resolveChannelAccount
};
