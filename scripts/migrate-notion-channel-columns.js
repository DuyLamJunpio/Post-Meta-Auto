require("dotenv").config();
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const CONTENT_DS = process.env.NOTION_CONTENT_DATA_SOURCE_ID;

// Đổi tên cột theo kênh: prefix [FB]/[IG]/[GBP]/[TikTok]; cột chung giữ nguyên.
// PHẢI khớp CONTENT_PROPS trong src/services/notion.service.js.
const RENAMES = [
  ["Facebook Post ID", "[FB] Post ID"],
  ["Facebook Post URL", "[FB] Post URL"],
  ["Location Name", "[FB] Location Name"],
  ["Location Facebook URL", "[FB] Location URL"],
  ["Tag People URLs", "[FB] Tag People URLs"],
  ["Feeling/Activity", "[FB] Feeling/Activity"],
  ["Messenger CTA", "[FB] Messenger CTA"],
  ["Call Phone Number", "[FB] Call Phone Number"],
  ["Share To Story", "[FB] Share To Story"],
  ["Collaborator Brand", "[FB] Collaborator Brand"],
  ["Instagram Post ID", "[IG] Post ID"],
  ["Instagram Post URL", "[IG] Post URL"]
];

const ADD = {
  "[GBP] Post URL": { rich_text: {} },
  "[TikTok] Post ID": { rich_text: {} },
  "[TikTok] Post URL": { rich_text: {} }
};

const DELETE = ["Caption"];

(async () => {
  const ds = await notion.dataSources.retrieve({ data_source_id: CONTENT_DS });
  const props = ds.properties;
  const update = {};

  for (const [oldName, newName] of RENAMES) {
    if (props[oldName]) {
      update[oldName] = { name: newName };
    } else if (props[newName]) {
      console.log(`[rename] Bỏ qua (đã đổi): ${newName}`);
    } else {
      console.log(`[rename] CẢNH BÁO: không thấy "${oldName}" lẫn "${newName}".`);
    }
  }

  for (const [name, def] of Object.entries(ADD)) {
    if (props[name]) {
      console.log(`[add] Bỏ qua (đã có): ${name}`);
    } else {
      update[name] = def;
    }
  }

  for (const name of DELETE) {
    if (props[name]) {
      update[name] = null;
    } else {
      console.log(`[delete] Bỏ qua (không có): ${name}`);
    }
  }

  if (Object.keys(update).length === 0) {
    console.log("Không có thay đổi nào cần áp dụng.");
    return;
  }

  await notion.dataSources.update({ data_source_id: CONTENT_DS, properties: update });
  console.log(`Đã áp dụng ${Object.keys(update).length} thay đổi.`);

  console.log("\n--- Verify ---");
  const verify = await notion.dataSources.retrieve({ data_source_id: CONTENT_DS });
  const names = Object.keys(verify.properties).sort();
  console.log("Cột [FB]/[IG]/[GBP]/[TikTok]:");
  names.filter((n) => /^\[/.test(n)).forEach((n) => console.log("  " + n));
  console.log("Caption còn tồn tại:", Boolean(verify.properties["Caption"]));
})().catch((e) => {
  console.error("Lỗi migrate:", e.body || e.message);
  process.exit(1);
});
