const channels = require("../channels");
const jobsStore = require("./publish-jobs.service");

// Orchestrator đăng bài đa kênh: chọn adapter theo channelKey, chuẩn hóa nội dung,
// gọi publish, và ghi lại vòng đời job vào publish_jobs.
// Không tự resolve readiness/schedule — đó là việc của lớp Notion; publisher chỉ
// lo bước "đăng thật + ghi job".

function createPublicError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = details || null;
  return error;
}

// options: { channelKey, task, brand, account, contentType, mediaItems, publicMediaUrls, driveAuth }
async function publishTaskToChannel(options) {
  const { channelKey, task, brand, account, contentType, mediaItems, publicMediaUrls, driveAuth } = options;
  const adapter = channels.getAdapter(channelKey);

  if (!adapter) {
    throw createPublicError(400, `Kênh "${channelKey}" chưa được hỗ trợ.`, {
      service: "publisher",
      context: "get_adapter"
    });
  }

  // publicMediaUrls: URL proxy công khai (đã có đuôi file) cho kênh PULL; adapter tự ưu tiên dùng.
  const { content } = adapter.normalizeContent({ task, brand, contentType, publicMediaUrls });

  jobsStore.markPublishing(task.id, channelKey, account && account.id);

  try {
    const result = await adapter.publish({ account, content, mediaItems, driveAuth });

    if (!result || !result.postId) {
      throw createPublicError(502, `${adapter.label} đã nhận yêu cầu nhưng không trả về Post ID.`, {
        service: channelKey,
        context: "publish_no_post_id"
      });
    }

    jobsStore.markPublished(task.id, channelKey, {
      accountId: account && account.id,
      postId: result.postId,
      permalinkUrl: result.permalinkUrl
    });

    return {
      success: true,
      channel: channelKey,
      postId: result.postId,
      permalinkUrl: result.permalinkUrl,
      mediaItems: result.mediaItems || mediaItems || []
    };
  } catch (error) {
    const message = error.publicMessage || error.message || "Đăng bài thất bại.";
    jobsStore.markFailed(task.id, channelKey, message, { accountId: account && account.id });
    throw error;
  }
}

module.exports = {
  publishTaskToChannel
};
