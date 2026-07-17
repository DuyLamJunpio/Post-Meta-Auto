# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Ngôn ngữ

Toàn bộ thông báo hướng tới người dùng (message API, log, ghi chú Notion, UI) đều bằng **tiếng Việt**. Giữ nguyên quy ước này khi thêm/sửa chuỗi.

## Lệnh thường dùng

```bash
npm run dev      # Chạy dev với nodemon (auto-reload) — server.js
npm start        # Chạy production: node server.js
node scripts/test-notion.js   # Kiểm tra kết nối Notion + in ra property keys của content data source
node scripts/inspect-schema.js        # Dump kiểu + options của mọi property Content & Brands data source
node scripts/migrate-notion-phase2.js # (1 lần) Channel -> multi_select + thêm cột account đa kênh vào Brands (idempotent)
```

- **Không có bước build, không có bộ test tự động, không có linter** cấu hình sẵn. Các script trong `scripts/` là công cụ chẩn đoán/migration thủ công, không phải test framework.
- Server chạy tại `http://localhost:${PORT}` (mặc định 3000). Health check: `GET /api/health`.
- Cần file `.env` đầy đủ mới khởi động được — xem phần Cấu hình.

## Cấu hình (bắt buộc trước khi chạy)

[src/config.js](src/config.js) validate env vars khi khởi động và **`process.exit(1)` nếu thiếu**. Biến bắt buộc: `PORT`, `META_GRAPH_API_VERSION`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_REDIRECT_URI`, `NOTION_API_TOKEN`, `NOTION_BRANDS_DATA_SOURCE_ID`, `NOTION_CONTENT_DATA_SOURCE_ID`, `SESSION_SECRET`.

Tùy chọn: Google Drive (`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`) và Instagram (`INSTAGRAM_APP_ID/SECRET/REDIRECT_URI`) — mỗi tích hợp tự bật/tắt qua flag `enabled` (chỉ hoạt động khi đủ credentials). `NOTION_AUTO_PUBLISH_INTERVAL_MS` (mặc định 60000) điều khiển vòng lặp tự đăng; đặt 0 để tắt. `HIDDEN_FACEBOOK_PAGE_NAMES` (CSV) ẩn Page theo tên.

## Kiến trúc tổng thể

Đây là công cụ tự động hóa **đăng bài từ nội dung lên lịch trong Notion lên nhiều kênh** (hiện đăng tự động Facebook Page; Instagram/Google Business Profile/TikTok đang mở rộng dần), kèm hỗ trợ media từ Google Drive. Express 5 + CommonJS. **Notion là nguồn sự thật cho nội dung/task**; **SQLite** (`node:sqlite`, file `data/app.db`) lưu bền token đa kênh (mã hóa) và trạng thái đăng per-kênh; **session (in-memory) vẫn giữ đăng nhập Facebook hiện hành**.

### Mở rộng đa kênh (đang triển khai theo phase)

- **Adapter layer** [src/channels/](src/channels/): mỗi kênh là 1 adapter theo contract chung (`isConfigured/resolveAccount/getReadinessReasons/normalizeContent/publish`). Registry [src/channels/index.js](src/channels/index.js) map key→adapter; `resolveChannelAccount()` resolve tài khoản đăng per-kênh. Hiện chỉ **facebook.adapter** được đăng ký.
- Notion `Channel` là **multi_select** (Facebook/Instagram/Google Business Profile/TikTok) → `task.channels[]` (mảng key). Brands DB có cột account per-kênh (`Facebook Page ID`, `Instagram Account ID`, `Google Business Profile ID`, `TikTok Account ID`) → `brand.channelAccounts`.
- **Phase hiện tại:** chỉ Facebook có luồng đăng tự động; task cần có Facebook trong `channels` để đủ điều kiện đăng, các kênh khác chưa block. Publish loop đa kênh thật (theo từng kênh + ghi `publish_jobs` per task×channel) là bước kế tiếp.

### Luồng dữ liệu cốt lõi

```
Notion Content DB ──┐
Notion Brands DB  ──┤→ getResolvedTasks() ghép task↔brand, resolve account per-channel
                    │   + tính readiness (điều kiện đăng)
                    ↓
        Google Drive (tải file riêng tư về buffer)
                    ↓
        channels adapter → publisher.service → Facebook Graph API (đăng bài)
                    ↓
        Ghi publish_jobs (SQLite) + ghi ngược trạng thái + Post ID/URL về Notion
```

- **Brands DB** map `Primary Brand` (relation trong task) → account per-kênh. Với Facebook: task hợp lệ phải có đúng 1 Primary Brand, brand đó Active + Connected + có Page ID, và tài khoản Facebook đang đăng nhập phải quản lý Page đó với quyền `CREATE_CONTENT`.

### State machine của task (Notion `Publish Status`)

`Chưa lên lịch` → `Đã lên lịch` → `Đang đăng` → `Đã đăng` (hoặc `Lỗi đăng`). Toàn bộ chuyển trạng thái nằm trong [src/services/notion.service.js](src/services/notion.service.js). Task lỗi có thể được `prepareFailedTasksForRetry` đưa về `Chưa lên lịch` (reset retryCount) nếu chưa có Post ID và chưa vượt `MAX_RETRY_COUNT` (3).

- Hai lớp readiness riêng biệt: `getScheduleReadiness` (điều kiện để lên lịch) và `getPublishReadiness` (điều kiện để đăng, gồm cả kiểm tra `Publish At` đã đến hạn). Cả hai chia sẻ `getBaseReadinessReasons`. Khi một task chưa đủ điều kiện, lý do được trả về dưới dạng mảng chuỗi tiếng Việt để hiển thị cho người dùng.
- `inferContentType` suy ra loại nội dung (text/photo/video/mixed/reel/auto) từ Post Format + phần mở rộng file / link Drive. Nhiều tính năng Notion (Feeling/Activity, Messenger CTA, Share To Story, Collaborator, tag people không có numeric ID...) **cố ý bị chặn tự động** và thêm lý do vào readiness — đây là hành vi mong muốn, không phải bug.

### Vòng lặp tự đăng

[server.js](server.js) chạy `setInterval(runNotionAutoPublish, ...)`: duyệt mọi session Facebook đang lưu trong `MemoryStore`, gọi `scheduleReadyTasks` rồi `publishDueTasks`. Có cờ `notionAutoPublishRunning` chống chạy chồng. Timer dùng `.unref()`. **Lưu ý quan trọng:** vì session lưu trong bộ nhớ, restart server sẽ mất hết đăng nhập và auto-publish dừng cho tới khi có người đăng nhập lại.

### Các service (src/services/)

- **notion.service.js** — Lớp orchestration lớn nhất & phức tạp nhất. Ánh xạ property Notion (`CONTENT_PROPS`, `BRAND_PROPS`), phân tích Media URLs (kể cả cột đánh số như "Final Image URL 1, 2..." và link Drive), điều phối schedule/publish/retry, và tạo ghi chú lỗi tiếng Việt chi tiết (`buildFailureNotes` + `getFailureExplanation`).
- **facebook.service.js** — Wrapper Meta Graph API. Xử lý mọi loại post: text (`/feed`), photo đơn/nhiều (`/photos` unpublished + `attached_media`), video (upload resumable theo chunk 4MB cho file buffer), reel (`/video_reels` start/upload/finish), mixed. `createPageContent` là điểm vào phân loại contentType.
- **google-drive.service.js** — OAuth + tải file Drive riêng tư về **Buffer** để upload trực tiếp lên Facebook (không dùng public URL). Tự refresh access token. `resolveMediaItems` trả về mảng media item (`kind: "url" | "buffer"`).
- **page-visibility.service.js** — Ẩn Page theo tên đã chuẩn hóa (bỏ dấu tiếng Việt) dựa trên `HIDDEN_FACEBOOK_PAGE_NAMES`. Áp dụng cho cả danh sách Page và brand.
- **instagram.service.js** — OAuth Instagram (tích hợp một phần).
- **publisher.service.js** — Orchestrator đăng 1 kênh: chọn adapter theo `channelKey`, `normalizeContent`, gọi `adapter.publish`, ghi vòng đời vào `publish_jobs`. Không tự tính readiness/schedule (việc của notion.service).
- **publish-jobs.service.js** — CRUD bảng `publish_jobs` (mỗi task×kênh = 1 job idempotent): `markPublishing/markPublished/markFailed`. Nguồn sự thật cho trạng thái đăng đa kênh.
- **token-store.service.js** — Đọc/ghi token đa kênh vào bảng `channel_accounts`; access/refresh token mã hóa qua [src/utils/crypto-box.js](src/utils/crypto-box.js) (AES-256-GCM).

### Tầng dữ liệu (SQLite)

[src/db/index.js](src/db/index.js) mở `data/app.db` (`DATABASE_PATH` để override), bật WAL + foreign_keys, tự chạy migration trong [src/db/migrations/](src/db/migrations/) (theo `schema_migrations`). Bảng: `channel_accounts` (token đa kênh mã hóa) và `publish_jobs` (trạng thái đăng per task×kênh). Cần **Node ≥ 22** (dùng `node:sqlite`).

### Routes & auth

- [server.js](server.js) gắn `requireAuth` cho **mọi** route `/api/*` (trừ `/api/health`). Route `/auth/*` xử lý OAuth (Facebook bắt buộc trước, Google Drive/Instagram sau).
- Session lưu: `facebookUser` (id, name, `userAccessToken`, mảng `pages` kèm `pageAccessToken`), `googleDrive` (tokens), `instagram` (tokens). OAuth dùng `state` (crypto random) chống CSRF.
- Frontend là static HTML/JS thuần trong [public/](public/) (dashboard, danh sách bài, không framework).

## Quy ước code

- **Immutability**: dùng spread, không mutate object đầu vào (khớp coding style của dự án).
- **Error convention thống nhất**: mọi service tạo lỗi qua helper `createPublicError(status, message, details)` gán `error.status`, `error.publicMessage`, `error.details`. Central error handler trong [server.js](server.js) ưu tiên `publicMessage`. `details` thường mang `{ service, context, status, providerMessage }` để `notion.service` dịch thành ghi chú lỗi cho người dùng — **giữ nguyên cấu trúc này** khi thêm lỗi mới, vì `getFailureExplanation` phụ thuộc vào `details.service`/`details.context`/`details.status`.
- Log lỗi ra console theo prefix có ngữ cảnh: `[Meta Graph API]`, `[Notion API]`, `[Google Drive API]`, `[Notion Auto Publish]`.
- CommonJS (`require`/`module.exports`), không phải ESM. `"type": "commonjs"` trong package.json.
