"use strict";

// Đọc Notion-Task-Import.xlsx (sheet "Danh sách task Notion") -> tạo task Notion hàng loạt.
// Caption đổ vào cột CAPTION; body tạo sẵn heading IDEA (ghi chú). Brand Code map sang relation Primary Brand.

require("dotenv").config();
const path = require("path");
const XLSX = require("xlsx");
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_API_TOKEN });
const CONTENT_DS = process.env.NOTION_CONTENT_DATA_SOURCE_ID;
const BRANDS_DS = process.env.NOTION_BRANDS_DATA_SOURCE_ID;
const FILE = path.join(__dirname, "..", "Notion-Task-Import.xlsx");
const SHEET = "Danh sách task Notion";

const t = (content) => ({ type: "text", text: { content } });
const boldRun = (content) => ({ type: "text", text: { content }, annotations: { bold: true } });
const linkRun = (content, url) => ({ type: "text", text: { content, link: { url } } });
const h1 = (title) => ({ type: "heading_1", heading_1: { rich_text: [t(title)] } });
const para = (content) => ({ type: "paragraph", paragraph: { rich_text: content ? [t(content)] : [] } });
const paraRuns = (...runs) => ({ type: "paragraph", paragraph: { rich_text: runs.filter(Boolean) } });

// Dựng body theo cấu trúc Idea mẫu: Idea (General idea, Visual execution) / Reference / Sound.
function buildIdeaBody(row) {
  const general = String(row["General idea"] || "").trim();
  const visual = String(row["Visual execution"] || "").trim();
  const reference = String(row["Reference"] || "").trim();
  const sound = String(row["Sound"] || "").trim();

  const referenceRuns = [boldRun("Reference ")];
  if (reference) {
    referenceRuns.push(/^https?:\/\//i.test(reference) ? linkRun(reference, reference) : t(reference));
  }

  return [
    h1("Idea"),
    para("General idea: " + general),
    para("Visual execution: " + visual),
    para(""),
    paraRuns(...referenceRuns),
    h1("Sound"),
    para(sound)
  ];
}

function splitList(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toIsoDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.replace(" ", "T");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function loadBrandsByCode() {
  const map = new Map();
  let cur;
  do {
    const r = await notion.dataSources.query({ data_source_id: BRANDS_DS, page_size: 100, start_cursor: cur });
    for (const p of r.results) {
      const code = (p.properties["Brand Code"].rich_text || []).map((x) => x.plain_text).join("").trim();
      if (code) map.set(code.toUpperCase(), p.id);
    }
    cur = r.has_more ? r.next_cursor : null;
  } while (cur);
  return map;
}

async function run() {
  const wb = XLSX.readFile(FILE);
  const ws = wb.Sheets[SHEET];
  if (!ws) throw new Error(`Không thấy sheet "${SHEET}" trong ${FILE}`);

  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const dataRows = rows.filter((r) => String(r["Post Title"] || "").trim());
  if (dataRows.length === 0) {
    console.log("Sheet trống — chưa có task nào để import.");
    return;
  }

  const brands = await loadBrandsByCode();
  let ok = 0;
  const errors = [];

  for (const [i, row] of dataRows.entries()) {
    const title = String(row["Post Title"]).trim();
    try {
      const code = String(row["Brand Code"] || "").trim().toUpperCase();
      const brandId = brands.get(code);
      if (!brandId) throw new Error(`Brand Code "${code}" không tồn tại trong Brands DB`);

      const channels = splitList(row["Channel"]);
      const mediaUrls = splitList(row["Media URLs"]);
      const publishAt = toIsoDate(row["Publish At"]);
      const autoPublish = /^true$|^1$|^x$|^có$/i.test(String(row["Auto Publish"]).trim());

      const properties = {
        "Post Title": { title: [t(title)] },
        "Primary Brand": { relation: [{ id: brandId }] },
        "Channel": { multi_select: channels.map((name) => ({ name })) },
        "Post Type": { select: { name: String(row["Post Type"] || "Post").trim() || "Post" } },
        "Approval Status": { select: { name: String(row["Approval Status"] || "Chờ duyệt").trim() } },
        "Content Workflow": { select: { name: String(row["Content Workflow"] || "Hoàn thành nội dung").trim() } },
        "Timezone": { select: { name: String(row["Timezone"] || "Asia/Ho_Chi_Minh").trim() } },
        "Publish Status": { select: { name: "Chưa lên lịch" } },
        "Auto Publish": { checkbox: autoPublish }
      };
      if (mediaUrls.length) {
        properties["Media URLs"] = { rich_text: [{ type: "text", text: { content: mediaUrls.join("\n") } }] };
      }
      const captionText = String(row["Caption"] || "").slice(0, 2000);
      if (captionText) {
        properties["CAPTION"] = { rich_text: [{ type: "text", text: { content: captionText } }] };
      }
      if (publishAt) {
        properties["Publish At"] = { date: { start: publishAt } };
      }

      // Cột nhập tùy chọn (Notes + nâng cao Facebook). Chỉ ghi khi có giá trị.
      const setText = (col, prop) => {
        const v = String(row[col] || "").trim();
        if (v) properties[prop] = { rich_text: [{ type: "text", text: { content: v.slice(0, 2000) } }] };
      };
      const setUrl = (col, prop) => {
        const v = String(row[col] || "").trim();
        if (v) properties[prop] = { url: v };
      };
      const setCheckbox = (col, prop) => {
        const v = String(row[col] || "").trim();
        if (v) properties[prop] = { checkbox: /^(true|1|x|có|yes)$/i.test(v) };
      };
      setText("Notes", "Notes");
      setUrl("Source Folder URL", "Source Folder URL");
      setText("[FB] Location Name", "[FB] Location Name");
      setUrl("[FB] Location URL", "[FB] Location URL");
      setText("[FB] Tag People URLs", "[FB] Tag People URLs");
      setText("[FB] Feeling/Activity", "[FB] Feeling/Activity");
      setCheckbox("[FB] Messenger CTA", "[FB] Messenger CTA");
      setCheckbox("[FB] Share To Story", "[FB] Share To Story");
      const phone = String(row["[FB] Call Phone Number"] || "").trim();
      if (phone) properties["[FB] Call Phone Number"] = { phone_number: phone };
      const collabCode = String(row["[FB] Collaborator Brand"] || "").trim().toUpperCase();
      if (collabCode) {
        const collabId = brands.get(collabCode);
        if (collabId) properties["[FB] Collaborator Brand"] = { relation: [{ id: collabId }] };
      }

      await notion.pages.create({
        parent: { type: "data_source_id", data_source_id: CONTENT_DS },
        properties,
        children: buildIdeaBody(row)
      });
      ok += 1;
      console.log(`✓ [${i + 1}] ${title}`);
    } catch (e) {
      errors.push({ title, message: e.body ? JSON.stringify(e.body) : e.message });
      console.log(`✗ [${i + 1}] ${title} :: ${e.message}`);
    }
  }

  console.log(`\nXong: ${ok} tạo thành công, ${errors.length} lỗi / ${dataRows.length} dòng.`);
}

run().catch((e) => {
  console.error("Lỗi import:", e.body || e.message);
  process.exit(1);
});
