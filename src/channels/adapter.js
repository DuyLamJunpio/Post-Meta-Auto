// Hợp đồng (contract) chung cho mọi channel adapter.
// JS không có interface nên dùng defineAdapter() để kiểm tra lúc nạp module:
// mỗi adapter phải khai báo đủ các hàm bắt buộc, tránh lỗi ngầm khi chạy pipeline.
//
// Hình dạng một adapter:
//   {
//     key:          "facebook" | "instagram" | "gbp" | "tiktok"
//     label:        tên hiển thị tiếng Việt
//     isConfigured(): boolean                       // server đã có app id/secret cho kênh chưa
//     resolveAccount(context): account | null       // brand + session/DB -> tài khoản đăng của kênh
//     getReadinessReasons(context): string[]        // lý do (tiếng Việt) chưa đăng được; rỗng = sẵn sàng
//     normalizeContent(context): { content, reasons } // chuẩn hóa caption/media theo luật kênh
//     publish(context): Promise<{ postId, permalinkUrl }>
//   }
//
// context (truyền vào các hàm) gồm: { task, brand, account, content, session, driveAuth }

const CHANNELS = Object.freeze({
  FACEBOOK: "facebook",
  INSTAGRAM: "instagram",
  GBP: "gbp",
  TIKTOK: "tiktok"
});

const CHANNEL_LABELS = Object.freeze({
  facebook: "Facebook",
  instagram: "Instagram",
  gbp: "Google Business Profile",
  tiktok: "TikTok"
});

// Nhãn dùng trong option multi-select "Channel" của Notion (khớp CHANNEL_LABELS).
const CHANNEL_NOTION_LABELS = CHANNEL_LABELS;

// Chuẩn hóa nhãn Notion để so khớp (bỏ dấu, gộp khoảng trắng, thường hóa).
function normalizeChannelLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const LABEL_TO_KEY = Object.freeze(
  Object.entries(CHANNEL_NOTION_LABELS).reduce((accumulator, [key, label]) => {
    accumulator[normalizeChannelLabel(label)] = key;
    return accumulator;
  }, {})
);

// Nhãn Notion (vd "Google Business Profile") -> channel key ("gbp"); không khớp -> null.
function channelKeyFromLabel(label) {
  return LABEL_TO_KEY[normalizeChannelLabel(label)] || null;
}

const REQUIRED_METHODS = [
  "isConfigured",
  "resolveAccount",
  "getReadinessReasons",
  "normalizeContent",
  "publish"
];

function defineAdapter(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("Channel adapter phải là một object.");
  }

  if (!spec.key || !Object.values(CHANNELS).includes(spec.key)) {
    throw new Error(`Channel adapter có key không hợp lệ: ${spec && spec.key}`);
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof spec[method] !== "function") {
      throw new Error(`Channel adapter "${spec.key}" thiếu hàm bắt buộc: ${method}()`);
    }
  }

  return Object.freeze({
    key: spec.key,
    label: spec.label || CHANNEL_LABELS[spec.key] || spec.key,
    isConfigured: spec.isConfigured,
    resolveAccount: spec.resolveAccount,
    getReadinessReasons: spec.getReadinessReasons,
    normalizeContent: spec.normalizeContent,
    publish: spec.publish
  });
}

module.exports = {
  CHANNELS,
  CHANNEL_LABELS,
  CHANNEL_NOTION_LABELS,
  channelKeyFromLabel,
  defineAdapter
};
