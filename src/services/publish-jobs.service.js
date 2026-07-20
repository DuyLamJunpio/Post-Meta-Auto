const { getDb } = require("../db");

// Quản lý bảng publish_jobs: mỗi task Notion × mỗi kênh = 1 job idempotent.
// Là nguồn sự thật cho trạng thái đăng đa kênh; Notion chỉ là bản chiếu tổng hợp.

const STATUS = Object.freeze({
  PENDING: "pending",
  PUBLISHING: "publishing",
  PUBLISHED: "published",
  FAILED: "failed",
  SKIPPED: "skipped"
});

function mapRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    notionTaskId: row.notion_task_id,
    channel: row.channel,
    status: row.status,
    accountId: row.account_id,
    expectedAccountId: row.expected_account_id,
    postId: row.post_id,
    permalinkUrl: row.permalink_url,
    retryCount: row.retry_count,
    errorMessage: row.error_message,
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getJob(notionTaskId, channel) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM publish_jobs WHERE notion_task_id = ? AND channel = ?")
    .get(String(notionTaskId), String(channel));

  return mapRow(row);
}

function listJobsForTask(notionTaskId) {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM publish_jobs WHERE notion_task_id = ? ORDER BY channel")
    .all(String(notionTaskId));

  return rows.map(mapRow);
}

// Tạo job nếu chưa có, hoặc cập nhật các trường được truyền (patch từng phần).
function upsertJob(notionTaskId, channel, patch = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const taskId = String(notionTaskId);
  const channelKey = String(channel);
  const existing = getJob(taskId, channelKey);

  if (!existing) {
    db.prepare(
      `INSERT INTO publish_jobs
         (notion_task_id, channel, status, account_id, expected_account_id, post_id, permalink_url,
          retry_count, error_message, scheduled_at, published_at, created_at, updated_at)
       VALUES
         (@notion_task_id, @channel, @status, @account_id, @expected_account_id, @post_id, @permalink_url,
          @retry_count, @error_message, @scheduled_at, @published_at, @created_at, @updated_at)`
    ).run({
      notion_task_id: taskId,
      channel: channelKey,
      status: patch.status || STATUS.PENDING,
      account_id: patch.accountId || null,
      expected_account_id: patch.expectedAccountId || null,
      post_id: patch.postId || null,
      permalink_url: patch.permalinkUrl || null,
      retry_count: typeof patch.retryCount === "number" ? patch.retryCount : 0,
      error_message: patch.errorMessage || null,
      scheduled_at: patch.scheduledAt || null,
      published_at: patch.publishedAt || null,
      created_at: now,
      updated_at: now
    });

    return getJob(taskId, channelKey);
  }

  const next = {
    status: patch.status !== undefined ? patch.status : existing.status,
    account_id: patch.accountId !== undefined ? patch.accountId : existing.accountId,
    expected_account_id:
      patch.expectedAccountId !== undefined ? patch.expectedAccountId : existing.expectedAccountId,
    post_id: patch.postId !== undefined ? patch.postId : existing.postId,
    permalink_url: patch.permalinkUrl !== undefined ? patch.permalinkUrl : existing.permalinkUrl,
    retry_count: patch.retryCount !== undefined ? patch.retryCount : existing.retryCount,
    error_message: patch.errorMessage !== undefined ? patch.errorMessage : existing.errorMessage,
    scheduled_at: patch.scheduledAt !== undefined ? patch.scheduledAt : existing.scheduledAt,
    published_at: patch.publishedAt !== undefined ? patch.publishedAt : existing.publishedAt
  };

  db.prepare(
    `UPDATE publish_jobs SET
       status = @status,
       account_id = @account_id,
       expected_account_id = @expected_account_id,
       post_id = @post_id,
       permalink_url = @permalink_url,
       retry_count = @retry_count,
       error_message = @error_message,
       scheduled_at = @scheduled_at,
       published_at = @published_at,
       updated_at = @updated_at
     WHERE notion_task_id = @notion_task_id AND channel = @channel`
  ).run({
    ...next,
    notion_task_id: taskId,
    channel: channelKey,
    updated_at: now
  });

  return getJob(taskId, channelKey);
}

// Chốt "mục tiêu đăng dự kiến" lúc lên lịch (snapshot page id) để phát hiện đổi mapping.
function recordExpectedAccount(notionTaskId, channel, expectedAccountId) {
  return upsertJob(notionTaskId, channel, {
    expectedAccountId: expectedAccountId || null
  });
}

function markPublishing(notionTaskId, channel, accountId) {
  return upsertJob(notionTaskId, channel, {
    status: STATUS.PUBLISHING,
    accountId: accountId || null,
    errorMessage: null
  });
}

function markPublished(notionTaskId, channel, { accountId, postId, permalinkUrl } = {}) {
  return upsertJob(notionTaskId, channel, {
    status: STATUS.PUBLISHED,
    accountId: accountId || null,
    postId: postId || null,
    permalinkUrl: permalinkUrl || null,
    errorMessage: null,
    publishedAt: new Date().toISOString()
  });
}

function markFailed(notionTaskId, channel, errorMessage, { accountId } = {}) {
  const existing = getJob(notionTaskId, channel);
  const retryCount = (existing ? existing.retryCount : 0) + 1;

  return upsertJob(notionTaskId, channel, {
    status: STATUS.FAILED,
    accountId: accountId || (existing && existing.accountId) || null,
    retryCount,
    errorMessage: errorMessage || "Không rõ lỗi."
  });
}

module.exports = {
  STATUS,
  getJob,
  listJobsForTask,
  upsertJob,
  recordExpectedAccount,
  markPublishing,
  markPublished,
  markFailed
};
