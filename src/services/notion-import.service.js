const xlsx = require("xlsx");
const { Client } = require("@notionhq/client");

const { config } = require("../config");
const notionService = require("./notion.service");

// Import task nhanh từ file Excel: đọc -> kiểm tra hợp lệ -> (người dùng xác nhận) -> tạo page Notion.
// Thiết kế 2 bước: preview (chỉ đọc, không ghi) rồi create (ghi sau khi xác nhận).

const notion = new Client({ auth: config.notion.apiToken });

const UNSCHEDULED_STATUS = "Chưa lên lịch";
const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";
const MAX_TEXT_RUN = 2000;

// Cột Excel -> property Notion. `required` = bắt buộc có giá trị.
const COLUMN_MAP = [
  { header: "Post Title", prop: "Post Title", required: true },
  { header: "Caption", prop: "CAPTION" },
  { header: "Channel", prop: "Channel", required: true },
  { header: "Post Type", prop: "Post Type" },
  { header: "Media URLs", prop: "Media URLs", urlList: true },
  { header: "Brand Code", brandCode: true, required: true },
  { header: "Publish At", prop: "Publish At", date: true },
  { header: "Timezone", prop: "Timezone" },
  { header: "Approval Status", prop: "Approval Status" },
  { header: "Content Workflow", prop: "Content Workflow" },
  { header: "Auto Publish", prop: "Auto Publish", bool: true },
  { header: "Notes", prop: "Notes" },
  { header: "Source Folder URL", prop: "Source Folder URL", url: true }
];

// Các cột ý tưởng/chỉ đạo không có property riêng -> gộp vào Notes để không mất dữ liệu.
const NOTES_EXTRA = [
  { header: "General idea", label: "Ý tưởng" },
  { header: "Visual execution", label: "Hình ảnh" },
  { header: "Reference", label: "Tham khảo" },
  { header: "Sound", label: "Âm thanh" }
];

const REQUIRED_HEADERS = ["Post Title", "Channel", "Brand Code"];

let schemaCache = null;

function createPublicError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details || null;
  return error;
}

function textRuns(value) {
  const text = String(value || "");
  if (!text) {
    return [];
  }
  const runs = [];
  for (let i = 0; i < text.length; i += MAX_TEXT_RUN) {
    runs.push({ type: "text", text: { content: text.slice(i, i + MAX_TEXT_RUN) } });
  }
  return runs;
}

function splitList(value) {
  return String(value || "")
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isValidUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseBool(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes", "có", "co", "x"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "không", "khong", ""].includes(normalized)) {
    return false;
  }
  return null; // không nhận diện được
}

// Chuyển "YYYY-MM-DD HH:mm" theo múi giờ IANA -> ISO instant chuẩn (UTC),
// để new Date(publishAt) ở server (UTC) ra đúng thời điểm.
function toIsoInstant(value, timeZone) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour = "00", minute = "00"] = match;
  // Coi các thành phần là "wall clock" trong múi giờ timeZone.
  const wallAsUtcMs = Date.UTC(+year, +month - 1, +day, +hour, +minute, 0);
  if (Number.isNaN(wallAsUtcMs)) {
    return null;
  }

  const tz = timeZone || DEFAULT_TIMEZONE;
  try {
    const base = new Date(wallAsUtcMs);
    const tzView = new Date(base.toLocaleString("en-US", { timeZone: tz }));
    const utcView = new Date(base.toLocaleString("en-US", { timeZone: "UTC" }));
    const offsetMs = tzView.getTime() - utcView.getTime();
    return new Date(wallAsUtcMs - offsetMs).toISOString();
  } catch {
    // Múi giờ không hợp lệ -> coi như UTC.
    return new Date(wallAsUtcMs).toISOString();
  }
}

// ---------- Đọc file Excel ----------

function parseWorkbook(buffer) {
  let workbook;
  try {
    workbook = xlsx.read(buffer, { type: "buffer" });
  } catch {
    throw createPublicError(400, "Không đọc được file Excel. Hãy chắc chắn đây là file .xlsx hợp lệ.");
  }

  const candidates = [];
  for (const sheetName of workbook.SheetNames) {
    const grid = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "", raw: false });
    if (grid.length === 0) {
      continue;
    }
    const header = grid[0].map((cell) => String(cell || "").trim());
    const hasHeaders = REQUIRED_HEADERS.every((name) => header.includes(name));
    if (!hasHeaders) {
      continue;
    }
    const dataRows = grid
      .slice(1)
      .map((cells, index) => ({ excelRow: index + 2, cells }))
      .filter((row) => row.cells.some((cell) => String(cell || "").trim() !== ""));
    candidates.push({ sheetName, header, dataRows });
  }

  if (candidates.length === 0) {
    throw createPublicError(
      400,
      `File Excel thiếu các cột bắt buộc: ${REQUIRED_HEADERS.join(", ")}. Hãy dùng đúng mẫu Notion-Task-Import.`
    );
  }

  // Ưu tiên sheet KHÔNG phải "mẫu/sample/template" và có dữ liệu.
  const isSample = (name) => /mẫu|mau|sample|template|hướng dẫn|huong dan/i.test(name);
  const withData = candidates.filter((sheet) => sheet.dataRows.length > 0);
  const pool = withData.length > 0 ? withData : candidates;
  const chosen = pool.find((sheet) => !isSample(sheet.sheetName)) || pool[0];

  const rows = chosen.dataRows.map((row) => {
    const values = {};
    chosen.header.forEach((name, index) => {
      values[name] = String(row.cells[index] || "").trim();
    });
    return { excelRow: row.excelRow, values };
  });

  return { sheetName: chosen.sheetName, rows };
}

// ---------- Schema Notion (kiểu + option hợp lệ) ----------

async function getContentSchema() {
  if (schemaCache) {
    return schemaCache;
  }
  try {
    const dataSource = await notion.dataSources.retrieve({ data_source_id: config.notion.contentDataSourceId });
    const properties = dataSource.properties || {};
    const map = {};
    for (const [name, def] of Object.entries(properties)) {
      const options =
        def.type === "select"
          ? (def.select.options || []).map((option) => option.name)
          : def.type === "multi_select"
            ? (def.multi_select.options || []).map((option) => option.name)
            : null;
      map[name] = { type: def.type, options: options ? new Set(options) : null };
    }
    schemaCache = map;
    return map;
  } catch (error) {
    throw createPublicError(502, "Không đọc được cấu trúc Content database từ Notion.", {
      providerMessage: error.message
    });
  }
}

// ---------- Kiểm tra hợp lệ ----------

function validateRow(values, schema, brandCodeMap) {
  const errors = [];

  for (const column of COLUMN_MAP) {
    const value = values[column.header] || "";

    if (column.required && !value) {
      errors.push(`Thiếu "${column.header}".`);
      continue;
    }
    if (!value) {
      continue;
    }

    if (column.brandCode) {
      if (!brandCodeMap.has(value.toUpperCase())) {
        errors.push(`Brand Code "${value}" không có trong bảng Brands.`);
      }
      continue;
    }

    const propSchema = schema[column.prop];

    if (column.date) {
      if (!toIsoInstant(value, values.Timezone)) {
        errors.push(`"${column.header}" không phải ngày giờ hợp lệ (định dạng: YYYY-MM-DD HH:mm).`);
      }
      continue;
    }

    if (column.bool) {
      if (parseBool(value) === null) {
        errors.push(`"${column.header}" phải là TRUE hoặc FALSE.`);
      }
      continue;
    }

    if (column.urlList) {
      const invalid = splitList(value).filter((url) => !isValidUrl(url));
      if (invalid.length > 0) {
        errors.push(`"${column.header}" có link không hợp lệ: ${invalid.join(", ")}.`);
      }
      continue;
    }

    if (column.url && !isValidUrl(value)) {
      errors.push(`"${column.header}" không phải URL hợp lệ.`);
      continue;
    }

    // Ràng buộc option cho select / multi_select theo schema thật.
    if (propSchema && propSchema.type === "multi_select" && propSchema.options) {
      const invalid = splitList(value).filter((name) => !propSchema.options.has(name));
      if (invalid.length > 0) {
        errors.push(`"${column.header}" có giá trị không có trong Notion: ${invalid.join(", ")}.`);
      }
    } else if (propSchema && propSchema.type === "select" && propSchema.options) {
      if (!propSchema.options.has(value)) {
        errors.push(`"${column.header}" = "${value}" không có trong danh sách chọn của Notion.`);
      }
    }
  }

  return errors;
}

// ---------- Dựng properties để tạo page ----------

function buildNotesValue(values) {
  const parts = [];
  if (values.Notes) {
    parts.push(values.Notes);
  }
  for (const extra of NOTES_EXTRA) {
    if (values[extra.header]) {
      parts.push(`${extra.label}: ${values[extra.header]}`);
    }
  }
  return parts.join("\n");
}

function buildProperties(values, schema, brandCodeMap) {
  const properties = {};

  for (const column of COLUMN_MAP) {
    const value = values[column.header] || "";

    if (column.header === "Notes") {
      continue; // xử lý gộp riêng bên dưới
    }

    if (column.brandCode) {
      const brandId = brandCodeMap.get(value.toUpperCase());
      if (brandId) {
        properties["Primary Brand"] = { relation: [{ id: brandId }] };
      }
      continue;
    }

    if (!value) {
      continue;
    }

    const propSchema = schema[column.prop];
    const type = propSchema ? propSchema.type : "rich_text";

    if (column.date) {
      properties[column.prop] = { date: { start: toIsoInstant(value, values.Timezone) } };
      continue;
    }
    if (column.bool || type === "checkbox") {
      properties[column.prop] = { checkbox: Boolean(parseBool(value)) };
      continue;
    }

    if (type === "title") {
      properties[column.prop] = { title: textRuns(value) };
    } else if (type === "multi_select") {
      properties[column.prop] = { multi_select: splitList(value).map((name) => ({ name })) };
    } else if (type === "select") {
      properties[column.prop] = { select: { name: value } };
    } else if (type === "url") {
      properties[column.prop] = { url: value };
    } else if (type === "number") {
      properties[column.prop] = { number: Number(value) };
    } else if (type === "phone_number") {
      properties[column.prop] = { phone_number: value };
    } else {
      properties[column.prop] = { rich_text: textRuns(value) };
    }
  }

  const notes = buildNotesValue(values);
  if (notes && schema.Notes) {
    properties.Notes = { rich_text: textRuns(notes) };
  }

  // Đặt trạng thái mặc định để bộ lập lịch tự động xem xét (nếu Notion có option này).
  if (schema["Publish Status"] && schema["Publish Status"].type === "select") {
    if (!schema["Publish Status"].options || schema["Publish Status"].options.has(UNSCHEDULED_STATUS)) {
      properties["Publish Status"] = { select: { name: UNSCHEDULED_STATUS } };
    }
  }

  return properties;
}

async function buildBrandCodeMap() {
  const brands = await notionService.listBrands();
  const map = new Map();
  for (const brand of brands) {
    if (brand.code) {
      map.set(String(brand.code).trim().toUpperCase(), brand.id);
    }
  }
  return map;
}

// ---------- API chính ----------

// Bước 1: đọc + kiểm tra, KHÔNG ghi Notion. Trả về preview từng dòng.
async function previewImport(buffer) {
  const { sheetName, rows } = parseWorkbook(buffer);
  const [schema, brandCodeMap] = await Promise.all([getContentSchema(), buildBrandCodeMap()]);

  const items = rows.map((row) => {
    const errors = validateRow(row.values, schema, brandCodeMap);
    return {
      excelRow: row.excelRow,
      title: row.values["Post Title"] || "(chưa có tiêu đề)",
      brandCode: row.values["Brand Code"] || "",
      channel: row.values.Channel || "",
      publishAt: row.values["Publish At"] || "",
      values: row.values,
      valid: errors.length === 0,
      errors
    };
  });

  return {
    sheetName,
    total: items.length,
    validCount: items.filter((item) => item.valid).length,
    invalidCount: items.filter((item) => !item.valid).length,
    items
  };
}

// Bước 2: tạo page Notion cho các dòng được gửi lên (đã kiểm tra lại phía server).
async function createTasks(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw createPublicError(400, "Không có dòng nào để tạo.");
  }

  const [schema, brandCodeMap] = await Promise.all([getContentSchema(), buildBrandCodeMap()]);
  const results = [];

  for (const values of rows) {
    const title = (values && values["Post Title"]) || "(chưa có tiêu đề)";
    const errors = validateRow(values || {}, schema, brandCodeMap);

    if (errors.length > 0) {
      results.push({ title, success: false, message: errors.join(" ") });
      continue;
    }

    try {
      const page = await notion.pages.create({
        parent: { type: "data_source_id", data_source_id: config.notion.contentDataSourceId },
        properties: buildProperties(values, schema, brandCodeMap)
      });
      results.push({ title, success: true, url: page.url || null });
    } catch (error) {
      results.push({ title, success: false, message: error.message || "Lỗi tạo task Notion." });
    }
  }

  return {
    total: rows.length,
    successCount: results.filter((item) => item.success).length,
    failureCount: results.filter((item) => !item.success).length,
    results
  };
}

module.exports = {
  previewImport,
  createTasks
};
