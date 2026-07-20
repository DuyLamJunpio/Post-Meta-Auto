const { getDb } = require("../db");

// Nhật ký sự kiện đăng (published/failed/paused/retracted) để truy vết nhanh.
// Ghi lỗi ở đây không được làm hỏng luồng đăng -> bọc try/catch, chỉ log.

function record(event) {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO publish_audit
         (event, notion_task_id, channel, account_id, account_name, post_id, permalink_url, title, message, created_at)
       VALUES
         (@event, @notion_task_id, @channel, @account_id, @account_name, @post_id, @permalink_url, @title, @message, @created_at)`
    ).run({
      event: String(event.event || "unknown"),
      notion_task_id: event.notionTaskId || null,
      channel: event.channel || null,
      account_id: event.accountId || null,
      account_name: event.accountName || null,
      post_id: event.postId || null,
      permalink_url: event.permalinkUrl || null,
      title: event.title || null,
      message: event.message || null,
      created_at: new Date().toISOString()
    });
  } catch (error) {
    console.warn("[Publish Audit] Không ghi được nhật ký:", error.message);
  }
}

function listRecent(limit = 50) {
  try {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM publish_audit ORDER BY id DESC LIMIT ?")
      .all(Math.max(1, Math.min(200, Number(limit) || 50)));
    return rows;
  } catch (error) {
    console.warn("[Publish Audit] Không đọc được nhật ký:", error.message);
    return [];
  }
}

module.exports = { record, listRecent };
