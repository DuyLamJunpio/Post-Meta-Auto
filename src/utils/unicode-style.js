"use strict";

// Post Facebook không có lớp định dạng thật. "In đậm/in nghiêng" chỉ hiển thị được bằng
// ký tự Unicode Mathematical Alphanumeric — đúng cách trình soạn thảo Facebook tự đổi khi
// người dùng dán (copy-paste) văn bản có định dạng. Graph API `message` chỉ nhận text thuần,
// nên đây là cách duy nhất để tự động ra in đậm/nghiêng khi đăng qua API.
//
// GIỚI HẠN QUAN TRỌNG: bộ ký tự này chỉ có cho A-Z, a-z, 0-9 — KHÔNG có cho chữ tiếng Việt
// có dấu (ầ, ế, ộ, ữ, đ...). Vì vậy dùng quy tắc "all-or-nothing" theo từng run: chỉ đổi khi
// mọi chữ/số trong run đều đổi được; nếu run có chữ có dấu thì giữ nguyên chữ thường để tránh
// lem nhem giữa câu. Đây chính là kết quả bạn thấy khi dán tay lên Facebook.

const ASCII = Object.freeze({
  upperA: 0x41,
  upperZ: 0x5a,
  lowerA: 0x61,
  lowerZ: 0x7a,
  zero: 0x30,
  nine: 0x39
});

// Dùng biến thể sans-serif để khớp đúng style mà composer Facebook tạo ra.
const STYLE_BASE = Object.freeze({
  bold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
  italic: { upper: 0x1d608, lower: 0x1d622, digit: null },
  boldItalic: { upper: 0x1d63c, lower: 0x1d656, digit: null }
});

const LETTER_OR_NUMBER = /\p{L}|\p{N}/u;

function styleChar(ch, base) {
  const code = ch.codePointAt(0);

  if (code >= ASCII.upperA && code <= ASCII.upperZ) {
    return String.fromCodePoint(base.upper + (code - ASCII.upperA));
  }

  if (code >= ASCII.lowerA && code <= ASCII.lowerZ) {
    return String.fromCodePoint(base.lower + (code - ASCII.lowerA));
  }

  if (code >= ASCII.zero && code <= ASCII.nine) {
    return base.digit === null ? null : String.fromCodePoint(base.digit + (code - ASCII.zero));
  }

  return null;
}

/**
 * Đổi text sang ký tự Unicode in đậm/nghiêng để hiển thị trên Facebook.
 * Giữ nguyên cả run nếu có bất kỳ chữ/số nào không đổi được (vd tiếng Việt có dấu).
 *
 * @param {string} text
 * @param {{ bold?: boolean, italic?: boolean }} [style]
 * @returns {string}
 */
function toFacebookStyled(text, style = {}) {
  const value = String(text || "");
  const bold = Boolean(style.bold);
  const italic = Boolean(style.italic);

  if (!value || (!bold && !italic)) {
    return value;
  }

  const base = bold && italic ? STYLE_BASE.boldItalic : bold ? STYLE_BASE.bold : STYLE_BASE.italic;
  let out = "";

  for (const ch of value) {
    const styled = styleChar(ch, base);

    if (styled !== null) {
      out += styled;
      continue;
    }

    // Chữ/số không có bản Unicode đậm/nghiêng (vd chữ có dấu) -> giữ NGUYÊN cả run cho sạch.
    if (LETTER_OR_NUMBER.test(ch)) {
      return value;
    }

    // Dấu cách/dấu câu -> giữ nguyên, không làm hỏng run.
    out += ch;
  }

  return out;
}

module.exports = { toFacebookStyled };
