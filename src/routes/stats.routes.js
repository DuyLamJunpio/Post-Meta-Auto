const express = require("express");

const analyticsService = require("../services/analytics.service");
const audienceService = require("../services/audience.service");
const audienceExportService = require("../services/audience-export.service");
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

// Báo cáo thống kê đầy đủ (FB + IG) cho MỘT Page theo ID.
router.get("/stats/pages/:pageId", async (req, res, next) => {
  try {
    const page = findSessionPage(req);

    if (!page) {
      throw createPublicError(404, "Page ID không thuộc tài khoản đang đăng nhập.");
    }

    // Trần an toàn tùy chọn qua query (?maxItems=), mặc định 3000, tối đa 5000.
    const requestedMax = Number(req.query.maxItems);
    const maxItems = Number.isFinite(requestedMax)
      ? Math.min(5000, Math.max(100, Math.floor(requestedMax)))
      : 3000;

    const analytics = await analyticsService.buildPageAnalytics({
      page,
      userAccessToken: req.session.facebookUser.userAccessToken,
      maxItems
    });

    res.json({ success: true, analytics });
  } catch (error) {
    next(error);
  }
});

// Đối tượng khách hàng (nhân khẩu học) — tải riêng vì gọi IG demographics chậm & có thể bị chặn.
router.get("/stats/pages/:pageId/audience", async (req, res, next) => {
  try {
    const page = findSessionPage(req);

    if (!page) {
      throw createPublicError(404, "Page ID không thuộc tài khoản đang đăng nhập.");
    }

    const audience = await audienceService.buildPageAudience({ page });
    res.json({ success: true, audience });
  } catch (error) {
    next(error);
  }
});

// Bốn định dạng xuất file. Bảng tra thay cho chuỗi if/else, và cũng là NƠI
// DUY NHẤT khai danh sách định dạng hợp lệ — thêm định dạng mới là thêm một
// dòng ở đây, không phải sửa ba chỗ.
//
// pdf trả về HTML chứ không phải file .pdf: trang đó tự mở hộp thoại in để
// trình duyệt dựng PDF bằng font hệ thống (có dấu tiếng Việt). Xem giải thích
// đầy đủ ở buildPrintableHtml() trong audience-export.service.js.
const EXPORT_FORMATS = {
  csv: { ext: "csv", contentType: "text/csv; charset=utf-8" },
  json: { ext: "json", contentType: "application/json; charset=utf-8" },
  xlsx: {
    ext: "xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  },
  pdf: { ext: "html", contentType: "text/html; charset=utf-8" }
};

// Xuất dữ liệu nhân khẩu học thô: ?format=csv|json|xlsx|pdf
//
// Dùng LẠI buildPageAudience() thay vì đọc thẳng DB, để con số trong file tải
// về luôn khớp con số trên màn hình. Đọc thẳng DB sẽ bỏ qua bước gom nhóm và
// dịch nhãn, nên hai bên sẽ lệch nhau mà chẳng ai để ý cho tới lúc gửi báo
// cáo cho khách.
router.get("/stats/pages/:pageId/audience/export", async (req, res, next) => {
  try {
    const page = findSessionPage(req);

    if (!page) {
      throw createPublicError(404, "Page ID không thuộc tài khoản đang đăng nhập.");
    }

    const format = String(req.query.format || "csv").toLowerCase();
    const spec = EXPORT_FORMATS[format];
    if (!spec) {
      throw createPublicError(
        400,
        `Định dạng "${format}" không hỗ trợ. ` +
          `Chọn một trong: ${Object.keys(EXPORT_FORMATS).join(", ")}.`
      );
    }

    const audience = await audienceService.buildPageAudience({ page });
    const rows = audienceExportService.buildRows(audience);
    const filename = audienceExportService.buildFilename(page.id, spec.ext);

    // JSON đi TRƯỚC phần kiểm tra rỗng: nó là định dạng để soi lỗi, nên một
    // payload rỗng kèm `warnings` giải thích vì sao rỗng còn hữu ích hơn hẳn
    // một câu 404 chung chung.
    if (format === "json") {
      res.setHeader("Content-Type", spec.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(JSON.stringify({ audience, rows }, null, 2));
    }

    if (rows.length === 0) {
      throw createPublicError(
        404,
        "Chưa có số liệu nhân khẩu học để xuất. " +
          "Chạy công cụ cào (python -m src.cli run --all) rồi thử lại."
      );
    }

    if (format === "pdf") {
      // KHÔNG đặt Content-Disposition: trang phải hiện ra trong tab thì
      // window.print() mới chạy được. Ép tải về sẽ cho ra một file .html nằm
      // im trong thư mục Downloads, và người dùng không hiểu phải làm gì tiếp.
      res.setHeader("Content-Type", spec.contentType);
      return res.send(
        audienceExportService.buildPrintableHtml({
          audience,
          rows,
          title: `Nhân khẩu học — ${page.name || page.id}`
        })
      );
    }

    res.setHeader("Content-Type", spec.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    if (format === "xlsx") {
      return res.send(audienceExportService.toWorkbookBuffer(rows));
    }
    return res.send(audienceExportService.toCsv(rows));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
