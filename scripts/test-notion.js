require("dotenv").config();

const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_API_TOKEN
});

async function main() {
  const response = await notion.dataSources.query({
    data_source_id: process.env.NOTION_CONTENT_DATA_SOURCE_ID,
    page_size: 10
  });

  console.log(
    JSON.stringify(
      {
        success: true,
        count: response.results.length,
        tasks: response.results.map(page => ({
          id: page.id,
          properties: Object.keys(page.properties)
        }))
      },
      null,
      2
    )
  );
}

main().catch(error => {
  console.error("Lỗi kết nối Notion:");
  console.error(error.body || error.message);
  process.exit(1);
});