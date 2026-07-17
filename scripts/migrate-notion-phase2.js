require("dotenv").config();
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

const CONTENT_DS = process.env.NOTION_CONTENT_DATA_SOURCE_ID;
const BRANDS_DS = process.env.NOTION_BRANDS_DATA_SOURCE_ID;

const CHANNEL_OPTIONS = [
  { name: "Facebook" },
  { name: "Instagram" },
  { name: "Google Business Profile" },
  { name: "TikTok" }
];

const BRAND_NEW_PROPS = {
  "Instagram Account ID": { rich_text: {} },
  "Google Business Profile ID": { rich_text: {} },
  "TikTok Account ID": { rich_text: {} }
};

async function migrateContentChannel() {
  const ds = await notion.dataSources.retrieve({ data_source_id: CONTENT_DS });
  const channel = ds.properties.Channel;
  console.log(`[Content] Channel hiện tại: type=${channel && channel.type}`);

  await notion.dataSources.update({
    data_source_id: CONTENT_DS,
    properties: {
      Channel: { multi_select: { options: CHANNEL_OPTIONS } }
    }
  });
  console.log("[Content] Đã cập nhật Channel -> multi_select (4 options).");
}

async function migrateBrandsColumns() {
  const ds = await notion.dataSources.retrieve({ data_source_id: BRANDS_DS });
  const toAdd = {};
  for (const [name, def] of Object.entries(BRAND_NEW_PROPS)) {
    if (ds.properties[name]) {
      console.log(`[Brands] Bỏ qua (đã có): ${name}`);
    } else {
      toAdd[name] = def;
    }
  }
  if (Object.keys(toAdd).length === 0) {
    console.log("[Brands] Không có cột mới cần thêm.");
    return;
  }
  await notion.dataSources.update({ data_source_id: BRANDS_DS, properties: toAdd });
  console.log(`[Brands] Đã thêm cột: ${Object.keys(toAdd).join(", ")}`);
}

(async () => {
  await migrateContentChannel();
  await migrateBrandsColumns();
  console.log("\n--- Verify ---");
  const c = await notion.dataSources.retrieve({ data_source_id: CONTENT_DS });
  const ch = c.properties.Channel;
  console.log(`Channel :: ${ch.type} opts=[${(ch.multi_select ? ch.multi_select.options : []).map(o => o.name).join(", ")}]`);
  const b = await notion.dataSources.retrieve({ data_source_id: BRANDS_DS });
  for (const name of Object.keys(BRAND_NEW_PROPS)) {
    console.log(`Brands.${name} :: ${b.properties[name] ? b.properties[name].type : "MISSING"}`);
  }
})().catch(e => { console.error("Lỗi migrate:", e.body || e.message); process.exit(1); });
