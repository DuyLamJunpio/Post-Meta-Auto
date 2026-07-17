require("dotenv").config();
const { Client } = require("@notionhq/client");
const notion = new Client({ auth: process.env.NOTION_API_TOKEN });

async function dumpSchema(label, dsId) {
  const ds = await notion.dataSources.retrieve({ data_source_id: dsId });
  console.log(`\n===== ${label} (${dsId}) =====`);
  for (const [name, prop] of Object.entries(ds.properties)) {
    let extra = "";
    if (prop.type === "select") extra = " opts=[" + prop.select.options.map(o => o.name).join(", ") + "]";
    if (prop.type === "multi_select") extra = " opts=[" + prop.multi_select.options.map(o => o.name).join(", ") + "]";
    console.log(`  ${name} :: ${prop.type}${extra}`);
  }
}

(async () => {
  await dumpSchema("CONTENT", process.env.NOTION_CONTENT_DATA_SOURCE_ID);
  await dumpSchema("BRANDS", process.env.NOTION_BRANDS_DATA_SOURCE_ID);
})().catch(e => { console.error(e.body || e.message); process.exit(1); });
