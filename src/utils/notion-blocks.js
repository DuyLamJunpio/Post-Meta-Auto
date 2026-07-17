"use strict";

const { toFacebookStyled } = require("./unicode-style");

// Chuyển block body của Notion thành caption text để đăng, giữ NGUYÊN bố cục người tạo sắp
// xếp (mỗi block = 1 dòng, block rỗng = dòng trống) và giữ in đậm/nghiêng bằng ký tự Unicode.

// Khối chứa caption trong body: toggle hoặc callout đặt tên "Caption".
const CAPTION_CONTAINER_TYPES = new Set(["toggle", "callout"]);
const CAPTION_TITLE = "caption";

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

function getBlockRichText(block) {
  const data = block && block.type ? block[block.type] : null;
  return data && Array.isArray(data.rich_text) ? data.rich_text : null;
}

function richTextPlain(richText) {
  return Array.isArray(richText)
    ? richText.map((run) => (run && run.plain_text) || "").join("")
    : "";
}

// rich_text[] của Notion -> chuỗi, giữ in đậm/nghiêng bằng ký tự Unicode (best-effort).
function renderRichText(richText) {
  if (!Array.isArray(richText)) {
    return "";
  }

  return richText
    .map((run) => {
      const text = run && typeof run.plain_text === "string" ? run.plain_text : "";
      const annotations = (run && run.annotations) || {};
      return toFacebookStyled(text, {
        bold: Boolean(annotations.bold),
        italic: Boolean(annotations.italic)
      });
    })
    .join("");
}

// 1 block -> 1 dòng text. Block không có text -> "" để giữ đúng dòng trống trong bố cục.
function blockToLine(block) {
  const type = block && block.type;
  const richText = getBlockRichText(block);

  if (!richText) {
    return "";
  }

  const text = renderRichText(richText);

  if (type === "bulleted_list_item") {
    return `• ${text}`;
  }

  if (type === "numbered_list_item") {
    return `- ${text}`;
  }

  if (type === "to_do") {
    const checked = Boolean(block[type] && block[type].checked);
    return `${checked ? "☑" : "☐"} ${text}`;
  }

  return text;
}

// Nối các block giữ nguyên bố cục; cắt khoảng trắng cuối mỗi dòng và đầu/cuối toàn bộ.
function blocksToCaptionText(blocks) {
  if (!Array.isArray(blocks)) {
    return "";
  }

  return blocks
    .map(blockToLine)
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

const HEADING_TYPES = new Set(["heading_1", "heading_2", "heading_3"]);

function isCaptionTitled(block) {
  return normalizeTitle(richTextPlain(getBlockRichText(block))) === CAPTION_TITLE;
}

// Xác định vùng caption trong body. Ưu tiên heading "Caption" (đọc các block dưới nó tới heading
// kế tiếp); fallback về callout/toggle "Caption" (đọc children). Trả về một trong hai:
//   { needsChildrenOf: <blockId> }  -> gọi bên gọi tự fetch children rồi blocksToCaptionText
//   { blocks: [...] }               -> đã có sẵn block để blocksToCaptionText
function extractCaptionBlocks(topBlocks) {
  if (!Array.isArray(topBlocks)) {
    return { needsChildrenOf: null, blocks: [] };
  }

  const headingIndex = topBlocks.findIndex(
    (block) => block && HEADING_TYPES.has(block.type) && isCaptionTitled(block)
  );

  if (headingIndex !== -1) {
    const section = [];

    for (let i = headingIndex + 1; i < topBlocks.length; i += 1) {
      const block = topBlocks[i];
      if (block && HEADING_TYPES.has(block.type)) {
        break;
      }
      section.push(block);
    }

    // Heading dạng toggle (nội dung nằm trong children thay vì sibling).
    if (section.length === 0 && topBlocks[headingIndex].has_children) {
      return { needsChildrenOf: topBlocks[headingIndex].id, blocks: null };
    }

    return { needsChildrenOf: null, blocks: section };
  }

  const container = topBlocks.find(
    (block) => block && CAPTION_CONTAINER_TYPES.has(block.type) && isCaptionTitled(block)
  );

  if (container) {
    return { needsChildrenOf: container.id, blocks: null };
  }

  return { needsChildrenOf: null, blocks: [] };
}

module.exports = {
  blocksToCaptionText,
  extractCaptionBlocks
};
