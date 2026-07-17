require("dotenv").config();
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const CONTENT_DS = process.env.NOTION_CONTENT_DATA_SOURCE_ID;

// Cột kết quả đăng Instagram, để xem id/link bài trực tiếp trên Notion (song song publish_jobs).
const CONTENT_NEW_PROPS = {
  "Instagram Post ID": { rich_text: {} },
  "Instagram Post URL": { rich_text: {} }
};

(async () => {
  const ds = await notion.dataSources.retrieve({ data_source_id: CONTENT_DS });
  const toAdd = {};

  for (const [name, def] of Object.entries(CONTENT_NEW_PROPS)) {
    if (ds.properties[name]) {
      console.log(`[Content] Bỏ qua (đã có): ${name}`);
    } else {
      toAdd[name] = def;
    }
  }

  if (Object.keys(toAdd).length === 0) {
    console.log("[Content] Không có cột mới cần thêm.");
  } else {
    await notion.dataSources.update({ data_source_id: CONTENT_DS, properties: toAdd });
    console.log(`[Content] Đã thêm cột: ${Object.keys(toAdd).join(", ")}`);
  }

  console.log("\n--- Verify ---");
  const verify = await notion.dataSources.retrieve({ data_source_id: CONTENT_DS });
  for (const name of Object.keys(CONTENT_NEW_PROPS)) {
    console.log(`Content.${name} :: ${verify.properties[name] ? verify.properties[name].type : "MISSING"}`);
  }
})().catch((e) => {
  console.error("Lỗi migrate:", e.body || e.message);
  process.exit(1);
});
