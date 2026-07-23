const express = require("express");

const facebookService = require("../services/facebook.service");
const googleDriveService = require("../services/google-drive.service");
const notionService = require("../services/notion.service");
const pageVisibilityService = require("../services/page-visibility.service");

const router = express.Router();

function createPublicError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.publicMessage = message;
  error.details = null;
  return error;
}

function findSessionPage(req) {
  const { pageId } = req.params;
  return pageVisibilityService
    .getVisiblePages(req.session.facebookUser.pages)
    .find((page) => page.id === pageId);
}

function validateMessage(message) {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw createPublicError(400, "Nội dung bài viết không được trống.");
  }

  return message.trim();
}

function normalizeOptionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMediaUrls(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.flatMap(normalizeTags);
  }

  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(/[,\n]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") || tag.startsWith("@") ? tag : `#${tag}`));
}

function buildManualPostMessage(message, tags) {
  const text = normalizeOptionalText(message);
  const tagText = normalizeTags(tags).join(" ");

  return [text, tagText].filter(Boolean).join("\n\n");
}

function normalizeContentType(value, mediaUrls) {
  const contentType = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (!mediaUrls.length) {
    return "text";
  }

  if (["photo", "video", "mixed", "reel", "auto"].includes(contentType)) {
    return contentType;
  }

  return "photo";
}

function validateManualPostPayload(body) {
  const mediaUrls = normalizeMediaUrls(body.mediaUrls);
  const contentType = normalizeContentType(body.contentType, mediaUrls);
  const message = buildManualPostMessage(body.message, body.tags);

  if (!message && mediaUrls.length === 0) {
    throw createPublicError(400, "Nội dung bài viết hoặc media không được trống.");
  }

  if (["video", "reel"].includes(contentType) && mediaUrls.length !== 1) {
    throw createPublicError(400, "Bài video/Reel thủ công cần đúng 1 link video.");
  }

  return {
    message,
    mediaUrls,
    contentType,
    taskId: typeof body.taskId === "string" ? body.taskId.trim() : ""
  };
}

function ensurePage(page) {
  if (!page) {
    throw createPublicError(404, "Page ID không thuộc tài khoản đang đăng nhập.");
  }
}

function ensurePageCanCreateContent(page) {
  if (!facebookService.canCreateContent(page)) {
    throw createPublicError(403, "Page không có quyền tạo bài viết.");
  }
}

router.get("/pages/:pageId/posts", async (req, res, next) => {
  try {
    const page = findSessionPage(req);
    ensurePage(page);

    const { posts, warning } = await facebookService.getPagePostsWithDiagnosis({
      pageId: page.id,
      pageAccessToken: page.pageAccessToken,
      userAccessToken: req.session.facebookUser.userAccessToken
    });

    res.json({
      success: true,
      posts,
      warning
    });
  } catch (error) {
    next(error);
  }
});

router.get("/pages/:pageId/instagram/media", async (req, res, next) => {
  try {
    const page = findSessionPage(req);
    ensurePage(page);

    const igAccount = page.instagramBusinessAccount;

    if (!igAccount || !igAccount.id) {
      throw createPublicError(400, "Page này chưa liên kết tài khoản Instagram Business.");
    }

    const media = await facebookService.getInstagramMedia(igAccount.id, page.pageAccessToken);

    res.json({
      success: true,
      instagram: {
        id: igAccount.id,
        username: igAccount.username || "",
        profilePictureUrl: igAccount.profilePictureUrl || null
      },
      media
    });
  } catch (error) {
    next(error);
  }
});

router.post("/pages/:pageId/posts", async (req, res, next) => {
  try {
    const page = findSessionPage(req);
    ensurePage(page);
    ensurePageCanCreateContent(page);

    const payload = validateManualPostPayload(req.body);
    const mediaItems = await googleDriveService.resolveMediaItems(
      payload.mediaUrls,
      googleDriveService.getSessionAuth(req.session)
    );
    const result = await facebookService.createPageContent(page.id, page.pageAccessToken, {
      message: payload.message,
      mediaUrls: payload.mediaUrls,
      mediaItems,
      contentType: payload.contentType
    });
    let permalinkUrl = result.permalinkUrl;
    let notionUpdateMessage = "";

    if (payload.taskId) {
      try {
        permalinkUrl = await notionService.markTaskManualPostSuccess(
          payload.taskId,
          req.session.facebookUser.pages,
          page.id,
          result
        );
      } catch (notionError) {
        console.error("[Manual Post Notion Update]", notionError.publicMessage || notionError.message);
        notionUpdateMessage = " Facebook đã đăng bài nhưng chưa cập nhật được task Notion.";
      }
    }

    res.json({
      success: true,
      message: `Đăng bài thành công.${notionUpdateMessage}`,
      postId: result.postId,
      permalinkUrl
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/pages/:pageId/posts/:postId", async (req, res, next) => {
  try {
    const page = findSessionPage(req);
    ensurePage(page);
    ensurePageCanCreateContent(page);

    const message = validateMessage(req.body.message);
    await facebookService.updatePagePost(req.params.postId, page.pageAccessToken, message);

    res.json({
      success: true,
      message: "Sửa bài viết thành công."
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/pages/:pageId/posts/:postId", async (req, res, next) => {
  try {
    const page = findSessionPage(req);
    ensurePage(page);
    ensurePageCanCreateContent(page);

    await facebookService.deletePagePost(req.params.postId, page.pageAccessToken);

    res.json({
      success: true,
      message: "Xóa bài thành công."
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
