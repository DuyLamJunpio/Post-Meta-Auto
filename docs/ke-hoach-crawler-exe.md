# KẾ HOẠCH TRIỂN KHAI CUỐI: App .EXE Crawler Tải Về với Bảo Mật Token Per-Khách

> Bản này đã gộp toàn bộ phản biện 3 lăng kính (Bảo mật / Khả thi-Đóng gói / Đầy đủ). Mọi vấn đề **critical/high** được xử lý ngay trong thân kế hoạch, đánh dấu `✅ ĐÃ XỬ LÝ` kèm cách làm cụ thể. Vấn đề **medium/low** được vá ở đúng phase trước khi phát hành rộng.

---

## 0. Mục tiêu & Ràng buộc cứng

**Mục tiêu:** Đóng gói worker cào nhân khẩu học Facebook thành **một file `.exe` Windows** cho khách tự tải, tự đăng nhập Facebook **của chính họ**, cào **ngay trên máy họ**. Khách không cần demographics thì bỏ qua, web vẫn dùng bình thường. Link tải + hướng dẫn tiếng Việt đặt ở trang đầu.

**Ràng buộc cứng (không thương lượng):**

1. **TUYỆT ĐỐI không nhét `DATABASE_URL` — hay bất kỳ secret nào của người vận hành — vào `.exe`.** Worker trên máy khách **chỉ** gọi API của web kèm **token riêng từng khách**; chỉ web (giữ secret an toàn trên Render) mới chạm Supabase.
2. **`assetId` / danh sách trang suy ra từ TOKEN + JOB ở server**, không tin tham số client gửi lên.
3. **Bỏ Node.js khỏi máy khách:** ba script cầu nối (`crawl-worker-cli.js`, `export-assets.js`, `import-audience.js`) → thay bằng lời gọi HTTP thuần trong Python.
4. **Không nhúng trình duyệt:** dùng Edge THẬT của máy khách qua CDP 9222. `.exe` = Python + Playwright driver + mã crawler.

**Ghi chú Instagram:** IG demographics **không qua .exe** — `facebook.service.getInstagramAudience` (dòng 808) chạy server-side bằng Page Access Token. Bức tranh cuối: **Facebook = app đồng hành .exe**, **Instagram = API server-side**. Nhánh IG nêu ở Phase 4.6.

---

# BƯỚC 0 — TIỀN ĐỀ CHẶN ĐỨNG (làm trước, PASS mới sang Phase 1)

> `✅ ĐÃ XỬ LÝ` (Completeness-CRITICAL "TOKEN_ENCRYPTION_KEY là tiền đề, không phải rủi ro Phase 1"). Nâng từ dòng rủi ro thành cổng chặn độc lập.

**0.1 Kiểm khoá mã hoá token.** Đọc `src/utils/crypto-box.js`: xác định khoá phái sinh từ đâu.
- Nếu phái sinh từ `SESSION_SECRET` → mỗi redeploy Render xoay khoá → token FB/Notion đã mã hoá của user **đã hỏng**. `/worker/assets` giải mã server-side phụ thuộc trực tiếp điều này.
- **Hành động:** đặt `TOKEN_ENCRYPTION_KEY` **cố định** trong env Render; sửa `crypto-box.js` ưu tiên đọc key này; thêm cảnh báo khởi động trong `src/config.js` nếu thiếu.
- **Kiểm chứng (cổng):** `getConnection(userId)` giải mã được token FB/Notion cũ **SAU một redeploy**. Chỉ khi PASS mới bắt đầu Phase 1.

**0.2 Xác nhận hạ tầng Render.**
- Gói Render **không ngủ khi idle** (cron `releaseStaleJobs`/dọn phụ thuộc server luôn sống). Nếu tier có ngủ → dùng health-ping ngoài hoặc cron ngoài.
- Ghi nhận số instance: nếu **scale ngang** thì rate-limit và cron phải idempotent / dựa DB (xem 1.3, 4.5).

---

# PHASE 1 — Nền bảo mật (API worker + token per-khách + tenant-hoá kho + refactor lớp dữ liệu Python)

Mục tiêu: dựng bề mặt HTTP có xác thực token, **tenant-hoá cả GHI lẫn ĐỌC**, thay mô hình "nối thẳng Postgres". Sau phase này, worker chạy bằng token (script Python chưa đóng gói) phải cào end-to-end được, và dữ liệu tenant A không lọt sang tenant B ở bất kỳ đường nào.

## 1.1 Tầng dữ liệu — bảng mới + cột tenant trên kho

Sửa **`src/db/postgres.js`** (điểm DUY NHẤT mở kết nối Supabase), thêm init cạnh `initAccountSchema()`.

### `worker_tokens` (lưu HASH, không lưu token gốc)
```sql
CREATE TABLE IF NOT EXISTS worker_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT,
  token_prefix  TEXT NOT NULL,           -- 10 ký tự đầu, hiển thị cho khách nhận diện
  token_hash    TEXT NOT NULL,           -- sha256(token) hex
  scopes        TEXT NOT NULL DEFAULT 'crawl',   -- 'crawl' | 'admin'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 days'),  -- ✅ không NULL mặc định
  revoked_at    TIMESTAMPTZ,
  UNIQUE(token_hash)
);
CREATE INDEX IF NOT EXISTS idx_worker_tokens_user ON worker_tokens(user_id);
```
> `✅ ĐÃ XỬ LÝ` (Security-HIGH "bearer tĩnh, mặc định KHÔNG hết hạn"): `expires_at` mặc định **90 ngày**, buộc xoay vòng.

### `crawl_workers` (heartbeat + quan sát lỗi trước-claim)
```sql
CREATE TABLE IF NOT EXISTS crawl_workers (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id       BIGINT REFERENCES worker_tokens(id) ON DELETE SET NULL,
  hostname       TEXT,
  app_version    TEXT,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error     TEXT,                   -- ✅ lỗi trước-claim (Edge thiếu, FB hết phiên, CDP fail...)
  last_error_at  TIMESTAMPTZ,
  UNIQUE(token_id)                        -- ✅ khoá theo token_id, KHÔNG theo hostname
);
```
> `✅ ĐÃ XỬ LÝ` (Completeness-LOW "UNIQUE(user_id,hostname) va chạm"): khoá theo `token_id` để nhiều máy trùng hostname mặc định `DESKTOP-XXXX` không đè nhau. `✅ ĐÃ XỬ LÝ` (Completeness-MEDIUM "quan sát lỗi worker trước claim"): thêm `last_error/last_error_at`.

### Tenant-hoá kho demographics — `✅ ĐÃ XỬ LÝ` (Security-CRITICAL, lỗ lớn nhất)
`crawled_audience_snapshots`/`rows` hiện **không có `user_id`**; đường đọc `crawled-audience.service.js:39-40` query `WHERE asset_id = $1` **toàn cục** → dữ liệu tenant A cào cho Page X bị **bất kỳ tenant nào cùng quản Page X đọc được**. Token per-khách chỉ khoá GHI, không khoá ĐỌC.
```sql
ALTER TABLE crawled_audience_snapshots ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_snap_asset_user ON crawled_audience_snapshots(asset_id, user_id);
-- Backfill từ crawl_jobs.user_id (join theo asset_id + capturedAt gần nhất), phần không suy được để NULL và log ra để rà tay.
-- Idempotency chống snapshot trùng khi worker retry:
ALTER TABLE crawled_audience_snapshots ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_snap_idem ON crawled_audience_snapshots(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```
- Ghi `user_id` khi lưu snapshot; **scope MỌI truy vấn đọc** trong `crawled-audience.service.js` theo `(asset_id, user_id)`.
- `✅ ĐÃ XỬ LÝ` (Security-LOW "đọc lịch sử job theo asset_id"): cùng lúc scope `listJobs/getJob` (`crawl-jobs.service.js:134-153`) theo `user_id` để lịch sử + kết quả không chéo tenant trên asset dùng chung.
- `✅ ĐÃ XỬ LÝ` (Completeness-MEDIUM "không idempotency snapshots"): `idempotency_key = sha256(assetId+capturedAt+timeRange)` UNIQUE; POST trùng trả lại `snapshotId` cũ, không tạo mới.

> **Bẫy vị trí bảng:** tất cả ở **Postgres**, KHÔNG phải `app.db` (SQLite bị Render xoá mỗi deploy → token bay). Dùng thư viện `postgres` (pooler 6543, `prepare:false`), không bật prepared statement.

## 1.2 Service phát/kiểm/thu hồi token

**Tạo `src/services/worker-token.service.js`** (khuôn theo `auth.service.js` + `user-facebook.service.js`):
- `issueToken(userId, name)`: `token = 'wk_' + crypto.randomBytes(32).toString('base64url')`; `token_hash = sha256(token)`; `token_prefix = token.slice(0,13)`; INSERT với `expires_at = now()+90d`; **trả token gốc ĐÚNG MỘT LẦN** (kiểu GitHub PAT).
- `verifyToken(token)`: hash lại → `SELECT ... WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()` (tra O(1) theo UNIQUE index). **Tra thẳng theo `token_hash` là đủ an toàn timing** — attacker không điều khiển được preimage.
  > `✅ ĐÃ XỬ LÝ` (Completeness-LOW "timingSafeEqual thừa"): **KHÔNG** sao chép nguyên mẫu password + `timingSafeEqual` từ `auth.service.js`. Chọn MỘT đường: tra theo `token_hash`. Vẫn giữ **check độ dài/format `wk_` trước** để token dị dạng trả 401, không throw.
  - Đạt → `UPDATE last_used_at = now()`, trả `{ userId, tokenId, scopes }`.
- `revokeToken(id, userId)`: soft-revoke `revoked_at = now()`.
- `listTokens(userId)`: trả `name, token_prefix, scopes, last_used_at, created_at, expires_at, revoked_at` — **KHÔNG** trả hash/token.

> SHA-256 thuần chấp nhận được vì token entropy 256-bit (không cần scrypt như mật khẩu người-chọn). **Không** dùng pepper (mất pepper = vô hiệu mọi token).

## 1.3 Middleware xác thực worker + rate-limit

**Tạo `src/middleware/requireWorkerToken.js`:**
```
Đọc 'Authorization: Bearer <token>' (fallback 'X-Worker-Token')
→ workerTokenService.verifyToken(token)
→ req.workerUserId = userId; req.workerTokenId = tokenId; req.workerScopes = scopes
→ 401 {success:false, error:'Token worker không hợp lệ hoặc đã bị thu hồi'} nếu sai
```
- **Tách hẳn khỏi `requireAuth`** (cookie). Worker không có cookie.
- **`✅ ĐÃ XỬ LÝ` (Security-HIGH "không ép TLS"):** thêm guard **từ chối request `http://`** tới `/worker/*` (đọc `req.protocol`/`X-Forwarded-Proto`), trừ `127.0.0.1` khi dev. Bật **HSTS** header toàn site. Token bearer replayable buộc phải đi qua kênh mã hoá cưỡng chế.
- **Rate-limit (`✅ ĐÃ XỬ LÝ` Security-MEDIUM + Completeness-MEDIUM):**
  - Giới hạn **request đã xác thực theo `tokenId`** (không chỉ đếm 401/IP): cap claim/heartbeat/snapshots mỗi phút.
  - Key IP theo **`X-Forwarded-For`** (Render proxy) khi `trust proxy` bật.
  - **Cap `rowCount` mỗi snapshot** + **quota snapshot/ngày mỗi user**.
  - Rate-limit endpoint phát token `/account/worker-tokens`.
  - Nếu Bước 0.2 cho biết **scale ngang** → đếm dựa **DB** (bảng đếm theo `token_prefix`/IP), không RAM per-instance.

## 1.4 Router worker HTTP mới — dưới `/worker/v1/*`

> `✅ ĐÃ XỬ LÝ` (Completeness-MEDIUM "không versioning URL"): mount **`/worker/v1/*`** để .exe đã phát hành còn đường forward-compat khi đổi hợp đồng.

**Tạo `src/routes/worker.routes.js`**, mount trong **`server.js` TRƯỚC dòng 111** (`app.use('/api', requireAuth)`), gác toàn bộ bằng `requireWorkerToken`:

| Method | Path | Payload vào | Payload ra |
|---|---|---|---|
| POST | `/worker/v1/jobs/claim` | `{ worker: hostname, appVersion }` | `{ success, data: { job \| null } }` |
| POST | `/worker/v1/jobs/:id/finish` | `{ snapshotId, rowCount }` | `{ success, data: { job } }` |
| POST | `/worker/v1/jobs/:id/fail` | `{ message }` | `{ success, data: { job } }` |
| POST | `/worker/v1/heartbeat` | `{ hostname, appVersion, lastError? }` | `{ success, data: { ok, connectedLabel } }` |
| GET | `/worker/v1/assets` | — (userId từ token) | `{ success, data: { assets:[{assetId,name,type,parentPageId?}] } }` |
| POST | `/worker/v1/snapshots` | snapshot JSON + `jobId` + `idempotencyKey` (xem 1.6) | `{ success, data: { snapshotId, rowCount } }` |

**Nguyên tắc mỗi endpoint:**

- **claim** — gọi `crawlJobsService.claimNextJob(hostname, { userId, scopes })`. **Giữ NGUYÊN một câu UPDATE atomic** (`FOR UPDATE SKIP LOCKED`) — không tách read/write qua HTTP. Đồng thời upsert `crawl_workers` (last_seen + app_version).
- **finish/fail** — trước update, **verify job thuộc `req.workerUserId` VÀ `user_id IS NOT NULL`** cho token khách (chống khách A sửa job khách B, và chống khách chạm job admin NULL — xem 4.4).
  > `✅ ĐÃ XỬ LÝ` (Security-MEDIUM "finish/fail chưa xử lý NULL"): điều kiện `user_id = $userId AND user_id IS NOT NULL` cho scope `crawl`.
- **assets** — gọi `userFacebookService.getConnection(req.workerUserId)` + `toAssets()` **ở server** (giải mã `crypto-box` server-side). **`userId` suy từ token.** Chỉ trả `{assetId,name,type,parentPageId}` — **TUYỆT ĐỐI không** `userAccessToken`/`pageAccessToken`. Mirror của `scripts/export-assets.js`.
- **snapshots** — `✅ ĐÃ XỬ LÝ` (Security-HIGH "assetId không ràng buộc vào job"): **BẮT BUỘC kèm `jobId`**; verify `job.user_id == req.workerUserId` **VÀ** `payload.assetId == job.asset_id`. Tập asset hợp lệ dựng gồm **cả `page.id` lẫn `instagramBusinessAccount.id`** (IG business id khác shape page.id). PORT `normalizeRow` (whitelist `age_gender`/`city`/`country`, `percentage ≥ 0` **KHÔNG trần trên** — Meta trả 106.2% là dữ liệu ĐÚNG) + `saveSnapshot(sql.begin)`. Ghi kèm `user_id` + `idempotency_key`.

## 1.5 Tách logic dùng chung — và làm rõ rollback

**Tạo `src/services/audience-import.service.js`**: chuyển `normalizeRow`, `readSnapshot`, `saveSnapshot` ra khỏi `scripts/import-audience.js`. Cả `worker.routes.js` lẫn `import-audience.js` (đường di trú) `require` service này → một nguồn validate.

> `✅ ĐÃ XỬ LÝ` (Completeness-HIGH "rollback tự mâu thuẫn"): nói rõ **`import-audience.js` BỊ REFACTOR** (không còn bất biến). Rollback drill phải test **bản đã refactor**, không phải bản gốc. Đây là mức rollback an toàn thực tế.

`crawl-jobs.service.js` giữ `claimNextJob/finishJob/failJob/releaseStaleJobs`.

## 1.6 Hợp đồng I/O + hợp đồng LỖI thống nhất

Envelope `{success, data, error}`, giữ **hình dạng phẳng** trong `data`:
- Job public (`toPublic`): `{id, assetId, assetType, assetName, timeRange, status, statusLabel, requestedAt, startedAt, finishedAt, snapshotId, rowCount, error, worker}`.
- Snapshot vào: `{jobId, assetId, assetType?, businessId?, source?='browser', capturedAt(ISO), timeRange?='lifetime', idempotencyKey, rows:[{dimension∈{age_gender,city,country}, segment, ageRange?, gender?, location?, percentage≥0}]}`.

> `✅ ĐÃ XỬ LÝ` (Completeness-HIGH "envelope lỗi không khớp central error handler"): central handler `server.js:375-388` trả `{success:false, message, details}` — **không có khoá `error`**. **Chốt một hợp đồng lỗi:** thêm **error-handler riêng cho router `/worker/*`** chuẩn hoá field thành `error` (map từ `publicMessage`/`message`). ApiClient Python đọc `data.error`. Ghi hợp đồng này vào tài liệu.

## 1.7 Endpoint quản lý token cho khách (kèm CSRF)

Thêm vào **`src/routes/account.routes.js`** (đã có `req.session.userId` + `requireAccount`, đặt TRƯỚC `requireAuth`):

| Method | Path | Ra |
|---|---|---|
| POST | `/account/worker-tokens` `{name}` | `{token}` (thô, **một lần**) + metadata |
| GET | `/account/worker-tokens` | `[{id,name,token_prefix,scopes,last_used_at,created_at,expires_at,revoked_at}]` |
| POST | `/account/worker-tokens/:id/revoke` | `{ok:true}` |

> `✅ ĐÃ XỬ LÝ` (Security-MEDIUM "thiếu CSRF"): `sameSite:lax` (`server.js:81`) không diệt hết CSRF cho POST cùng-site. Thêm **kiểm `Origin`/`Referer`** (tối thiểu) cho mọi POST state-changing dưới `/account`, đặc biệt phát/thu hồi token. Nếu về sau mở rộng, nâng lên double-submit CSRF token.

## 1.8 Chống-trùng createJob + tương thích claimNextJob

> `✅ ĐÃ XỬ LÝ` (Completeness-CRITICAL "createJob chống-trùng thiếu user_id"): SELECT chống-trùng (`crawl-jobs.service.js:109-115`) hiện lọc `asset_id + time_range + status` **không có user_id** → hai user cùng Page ID, user B nhận LẠI job đang chạy của A (`daCoSan:true`) + rò `asset_name` chéo. **Thêm `AND user_id IS NOT DISTINCT FROM ${userId}`** (xử lý cả NULL) vào SELECT chống-trùng.

> `✅ ĐÃ XỬ LÝ` (Completeness-HIGH "đổi chữ ký claimNextJob phá CLI cũ"): làm `userId`/`scopes` **TÙY CHỌN**:
> - Thiếu `userId` (CLI cũ) **hoặc** `scopes='admin'` → chế độ admin: `WHERE (user_id = $userId OR user_id IS NULL)`.
> - Token khách (`scopes='crawl'`) → `WHERE user_id = $userId AND user_id IS NOT NULL`.
>
> CLI cũ gọi `claimNextJob(workerName)` không truyền userId vẫn claim như trước → máy-nhà không gãy khi pull commit Phase 1.

## 1.9 Cron `releaseStaleJobs` server-side — VÀO NGAY PHASE 1

> `✅ ĐÃ XỬ LÝ` (Completeness-CRITICAL "khoảng trống dọn job kẹt giữa Phase 1↔4"): Phase 1 gỡ lệnh `release` khỏi worker, nên **cron phải vào ĐÚNG commit đó**, không trôi sang Phase 4. Đặt `setInterval(releaseStaleJobs(60), ...).unref()` trong `server.js` cạnh `notionAutoPublishTimer` (dòng 357-360). Không có cái này → worker chết giữa job → job kẹt `running` vĩnh viễn → `createJob` chống-trùng chặn mọi "Cào ngay" mới cho asset đó (comment dòng 209-211 đã cảnh báo).

Bảo đảm cron **idempotent** nếu scale ngang (Bước 0.2).

## 1.10 Refactor lớp dữ liệu worker Python (Node-shell → HTTP)

Thay ba cầu `subprocess.run(node ...)` bằng **`ApiClient` HTTP dùng `urllib` stdlib** (không thêm phụ thuộc → tránh phình PyInstaller).

**Tạo `src/api_client.py`** (dự án Python `d:\By KOD\Anh Giang\Crawl_demographics_meta\`):
- Đọc `WEB_APP_URL` + `WORKER_TOKEN`. Mọi request gắn `Authorization: Bearer <token>`.
- `✅ ĐÃ XỬ LÝ` (Security-HIGH "không ép TLS phía client"): **chỉ chấp nhận scheme `https://`** (ngoại lệ `127.0.0.1` khi dev); ném lỗi cứng nếu `WEB_APP_URL` không phải https.
- Parse envelope `{success,data,error}`; đọc **cả `error` lẫn `message`** phòng hờ; ném `WorkerError` khi `success=false` hoặc HTTP≠2xx.
- **Không bao giờ ghi token ra log/console.**

Ánh xạ refactor:

| File Python | Node cũ | → HTTP mới |
|---|---|---|
| `src/worker.py` (`JobClient`) | `claim <host>` | `POST /worker/v1/jobs/claim {worker,appVersion}` |
| `src/worker.py` | `finish <id> <snap> <rows>` | `POST /worker/v1/jobs/:id/finish {snapshotId,rowCount}` |
| `src/worker.py` | `fail <id> <msg>` | `POST /worker/v1/jobs/:id/fail {message}` |
| `src/worker.py` | `release` | **BỎ** (cron server-side, 1.9) |
| `src/exporters/postgres_store.py` | `import-audience.js <path>` | `POST /worker/v1/snapshots <payload>` — giữ `snapshot_to_payload()`, giữ ghi `data/raw/*.json` đẩy bù, giữ trả `snapshotId`, **thêm `jobId`+`idempotencyKey`** |
| `src/collectors/asset_discovery.py` | `export-assets.js` | `GET /worker/v1/assets` — bỏ `--user-id` |

- Giữ `job_from_payload`/`Job.as_asset()` — worker lấy asset từ payload job, không gọi `/assets` trong vòng lặp.
- `extract_json` (bóc banner dotenvx) giữ hàm để không vỡ test import chéo, nhưng ngừng dùng ở đường HTTP.

## 1.11 Rủi ro Phase 1 + Kiểm chứng

| Rủi ro | Kiểm chứng |
|---|---|
| Gắn token nhầm không gian id (FB id vs `users.id`) | 2 user, mỗi user 1 token; `GET /assets` mỗi token chỉ trả asset đúng user. |
| `claimNextJob`/`createJob` rò job chéo tenant | User A tạo job; token B claim → `null`; B `createJob` cùng asset → tạo job riêng, không nhận lại của A. |
| **ĐỌC kho chéo tenant** | Snapshot của A cho Page X; user B (cũng quản X) đọc `crawled-audience` → KHÔNG thấy dữ liệu của A. |
| Endpoint dưới `/api` (luôn 401) / ngoài `/api` quên middleware | Curl không header → 401; có header → 200; kiểm mount order trước dòng 111. |
| Atomic claim tách 2 câu → trùng | 2 tiến trình claim đồng thời cùng user → mỗi job 1 nơi nhận. |
| Siết trần percentage ≤100 | Gửi `percentage=106.2` → INSERT ok, đọc lại 106.2. |
| `/assets` lỡ trả token FB | Body **không** chứa `userAccessToken`/`pageAccessToken`. |
| finish/fail chạm job NULL | Token khách finish job `user_id=NULL` → 403. |
| Token dị dạng | Token rỗng/ngắn/sai format → 401, không throw. |
| http bị chấp nhận | Request `http://.../worker/*` → bị từ chối; ApiClient https-only. |
| Idempotency | POST snapshot 2 lần cùng key → cùng `snapshotId`, không nhân đôi. |
| Envelope lỗi | Route worker ném lỗi → body có field `error` (tiếng Việt), ApiClient đọc được. |
| Cron release | Dừng worker giữa job → sau 60' job về failed, "Cào ngay" mở lại. |

---

# PHASE 2 — Trải nghiệm app khách

## 2.1 Sửa `config/settings.py` (BẮT BUỘC trước đóng gói)

> `✅ ĐÃ XỬ LÝ` (Feasibility-CRITICAL "load_settings() bắt buộc META_BUSINESS_ID/META_ASSET_ID"): hai biến single-asset vô nghĩa trên máy khách → toàn bộ đường worker chết dòng đầu. **Refactor `load_settings()` sang chế độ worker/frozen:** `META_BUSINESS_ID/META_ASSET_ID` thành **tuỳ chọn** (chỉ cần cho lệnh single-asset thủ công); khi `getattr(sys,'frozen',False)` hoặc có `WORKER_TOKEN` → chỉ bắt buộc `WEB_APP_URL` + `WORKER_TOKEN`. Test: chạy exe không `.env` → vào vòng poll, không `SystemExit`.

> `✅ ĐÃ XỬ LÝ` (Feasibility-HIGH "frozen-path bỏ sót db_path/output_dir/recon_dir"): `settings.py` suy MỌI đường ghi từ `PROJECT_ROOT=Path(__file__).parent.parent` → dưới frozen trỏ vào `_MEIPASS` tạm → ghi `history.db`/CSV vào chỗ chỉ-đọc hoặc bị xoá. **Thêm `base_dir` nhận biết frozen** (`sys.frozen` → `%LOCALAPPDATA%\PostMetaCrawler`) và dẫn xuất **TẤT CẢ** `raw_dir/recon_dir/output_dir/db_path` + `config.json` từ đó, **không** từ `__file__`.

## 2.2 Config store — chỉ `%LOCALAPPDATA%`, mã hoá tại chỗ

**Tạo `src/config_store.py`**: đọc/ghi **`%LOCALAPPDATA%\PostMetaCrawler\config.json`** (`{webAppUrl, workerToken, edgeProfileDir}`).
> `✅ ĐÃ XỬ LÝ` (Feasibility-LOW "config.json cạnh exe có thể không ghi được"): **bỏ nhánh "cạnh exe"**, chỉ dùng `%LOCALAPPDATA%`.
> `✅ ĐÃ XỬ LÝ` (Security-HIGH + Completeness-LOW "token plaintext trên đĩa"): **mã hoá `workerToken` bằng Windows DPAPI** (`CryptProtectData`, phạm vi CurrentUser) trước khi ghi; hoặc Windows Credential Manager. Không ghi token ra log.

## 2.3 Luồng đăng nhập Facebook lần đầu — entry point RIÊNG

Tái dùng `src/auth/session_manager.py` (không tự nhập mật khẩu).
> `✅ ĐÃ XỬ LÝ` (Feasibility-HIGH "login lần đầu vs timeout job 60s"): `_lam_mot_viec` dựng `BrowserCollector(login_timeout=60)` **trong vòng job** → khách phổ thông không kịp (2FA, chọn tài khoản) → fail lặp. **Bắt buộc entry point "Đăng nhập Facebook" riêng** (nút tray **hoặc** `exe --login`) mở Edge **ngoài vòng job** với timeout dài/vô hạn. **Không để tray là "tuỳ chọn" nếu đó là nơi duy nhất login.**

1. `launcher.py:find_edge_executable()` dò `msedge.exe`; mở Edge THẬT `--remote-debugging-port` + `--user-data-dir=%LOCALAPPDATA%\PostMetaCrawler\edge_profile` + **`--no-first-run --no-default-browser-check`**.
   > `✅ ĐÃ XỬ LÝ` (Feasibility-MEDIUM "Edge detection hẹp + first-run"): bổ sung dò **registry `App Paths\msedge.exe`** + **`%LOCALAPPDATA%\Microsoft\Edge\Application`**; cờ no-first-run tắt welcome/import cướp focus.
2. `wait_for_login()` poll 2s tới khi URL có `/latest` (không `/business/loginpage/`).
3. Cookie lưu trong `edge_profile` → lần sau vào thẳng.

## 2.4 App khay (khuyến nghị, không còn "tuỳ chọn thuần")

**Tạo `src/tray_app.py`** (`pystray`+`Pillow` hoặc `infi.systray`): trạng thái "Đang chờ việc / Đang cào / Chưa nhập token / Chưa đăng nhập FB / **Máy cào báo lỗi**"; menu: Đăng nhập FB (entry point 2.3), Dán token, Thoát. Là chủ thể của heartbeat + `lastError`.

## 2.5 Ghép nối worker ↔ tài khoản khách

1. Khách đăng nhập web (`account.html`) → "Công cụ cào" → "Tạo mã kết nối" → `POST /account/worker-tokens` trả token thô **một lần**.
2. Dán vào app (`config_store` mã hoá DPAPI) + `WEB_APP_URL` (điền sẵn URL Render, **https**).
3. App gọi `POST /worker/v1/heartbeat` xác nhận → hiện `connectedLabel`.
   > `✅ ĐÃ XỬ LÝ` (Security-MEDIUM "rò PII qua heartbeat userEmail"): **KHÔNG trả email**. Trả nhãn không định danh (`connectedLabel` = tên thiết bị / "Đã kết nối") hoặc chuỗi rỗng.
4. Worker `claim` chỉ nhận job đúng `users.id` gắn token.

## 2.6 Tự chạy cùng Windows — chỉ phiên tương tác

> `✅ ĐÃ XỬ LÝ` (Feasibility-HIGH "Task Scheduler Session 0"): "Run whether user is logged on or not" chạy **Session 0 không desktop** → Edge headful không mở cửa sổ → không login, có khi không cào. **Chốt cứng (không "hoặc"):** chỉ `shell:startup` **HOẶC** Task Scheduler **"Run only when user is logged on"**. Cấm Session 0/hidden. Kiểm trên VM: đăng xuất/khoá màn hình → xác nhận hành vi.

Kế thừa `chay-nen.bat`: giữ kill tiến trình cũ + `PYTHONIOENCODING=utf-8`, **bỏ `set PATH=...nodejs`**.

## 2.7 Rủi ro Phase 2 + Kiểm chứng

| Rủi ro | Kiểm chứng |
|---|---|
| Frozen-path đọc/ghi sai | Build thử máy sạch: `config.json`/`history.db`/CSV/`data/raw` nằm ở `%LOCALAPPDATA%`, ghi được, còn sau khi chạy. |
| Token hết hạn/sai | Heartbeat 401 → app hiện "Mã kết nối không hợp lệ/hết hạn, tạo lại trên web". |
| Edge profile đụng Edge cá nhân | `--user-data-dir` riêng; test song song không xung đột; no-first-run không cướp focus. |
| Không màn hình đăng nhập | Hướng dẫn: máy phải có phiên đăng nhập Windows mở; cấm Session 0. |
| Token lộ qua đĩa | DPAPI: file config đọc bằng user Windows khác → giải mã thất bại. |

---

# PHASE 3 — Đóng gói & phát hành

## 3.1 PyInstaller

**Tạo `PostMetaCrawler.spec`**, **`onedir`** (không onefile): tránh giải nén Playwright driver mỗi lần + giảm false-positive AV.
> `✅ ĐÃ XỬ LÝ` (Feasibility-MEDIUM "Playwright driver + windowed build"): trong `.spec` — `collect_all('playwright')` + `collect_all('pydantic_core')` + `hiddenimports=['greenlet','pyee']`. **KHÔNG** `playwright install` (dùng Edge hệ thống). **Ưu tiên build có console** (hoặc set `startupinfo` cho subprocess) vì windowed/`--noconsole` khiến `stdout/stderr=None` → driver Node spawn qua pipe dễ vỡ trên Windows frozen. **Kiểm chứng `connect_over_cdp` chạy từ bản FROZEN trên VM sạch**, không chỉ từ `python`.

> `✅ ĐÃ XỬ LÝ` (Feasibility-CRITICAL "secret khác trong .env"): `.env` chứa `FACEBOOK_APP_SECRET`, `META_ACCESS_TOKEN`, `FACEBOOK_APP_ID`. **Ship KHÔNG kèm `.env`**; trong `.spec` **loại trừ tường minh `.env`/`*.key`/`*.pem`** khỏi `datas`. Máy khách chỉ có `config.json {webAppUrl, workerToken}`. **Kiểm chứng:** giải nén bản onedir, **grep chuỗi secret** (`DATABASE_URL`, `FACEBOOK_APP_SECRET`, `META_ACCESS_TOKEN`) toàn thư mục → phải KHÔNG khớp.

Sửa `requirements.txt`: thêm `pyinstaller` (nhóm build); HTTP dùng `urllib`; tray `pystray`+`Pillow`. Sửa `chay-nen.bat`/`chay-tu-dong.bat`: gọi thẳng exe, bỏ nodejs vào PATH.

## 3.2 Ký code / SmartScreen

> `✅ ĐÃ XỬ LÝ` (Feasibility-HIGH "SmartScreen chặn exe chưa ký"): onedir giải quyết heuristic Defender nhưng **KHÔNG** giải quyết SmartScreen — exe chưa ký tải từ Internet dính "Unknown publisher" toàn màn hình → khách phổ thông bỏ cuộc. Đây là điểm chặn **PHÂN PHỐI**, tách khỏi AV. **Quyết định cần chốt (xem mục cuối):** cert OV/EV để có reputation, HOẶC chấp nhận ma sát + **hướng dẫn tiếng Việt "More info → Run anyway" kèm ảnh**.

## 3.3 Phụ thuộc Edge hệ thống

KHÔNG nhúng trình duyệt. Kiểm Edge tồn tại lúc khởi động → thiếu thì báo tiếng Việt "Máy chưa có Microsoft Edge" (không crash). Dò per-user + registry App Paths (2.3).

## 3.4 Trang tải ở đầu web + hướng dẫn tiếng Việt

- **`public/shared/shell.js`** mảng `NAV` (dòng 5–13, nguồn DUY NHẤT khai menu) → thêm "Công cụ cào".
- **Tạo `public/crawler-download.html` + `crawler-download.js`**: link tải `.exe` (Release GitHub / static asset), tạo/thu hồi token (`/account/worker-tokens`), **hướng dẫn tiếng Việt từng bước**:
  1. Tải, giải nén (khuyến nghị KHÔNG vào Program Files).
  2. Web → tạo Mã kết nối → copy.
  3. Chạy `PostMetaCrawler.exe` → dán mã → URL web (https).
  4. Bấm "Đăng nhập Facebook" → đăng nhập tài khoản quản Page.
  5. Về web → "Cào ngay" ở trang Thống kê.
  6. Xử lý sự cố: SmartScreen "Run anyway", Edge chưa cài, token hết hạn, worker offline.
  > `✅ ĐÃ XỬ LÝ` (Completeness-missing "lỗi đánh số §3.2 nhảy 5→7"): đánh lại 1–6 liên tục.
- **`public/dashboard.html`** cạnh `#channel-status` (dòng 71–77) + `dashboard.js loadChannels()`: thẻ "Máy cào: online/offline" + link tải.

## 3.5 GATE PHÁT HÀNH (điều kiện chặn, không phải gợi ý)

> `✅ ĐÃ XỬ LÝ` (Feasibility-missing "GATE"): **chạy end-to-end thật một lượt cào trên VM Windows 11 SẠCH** (không Python/Node/checkout web) TRƯỚC khi đưa link tải. Đối chiếu số dòng + `percentage` khớp đường cũ. Không PASS → không phát hành.

## 3.6 Rủi ro Phase 3 + Kiểm chứng

| Rủi ro | Kiểm chứng |
|---|---|
| Thiếu Playwright/pydantic_core driver | Máy sạch chạy 1 lượt cào end-to-end; `connect_over_cdp` OK từ bản frozen. |
| Secret lọt vào bundle | grep onedir → không khớp secret nào. |
| Antivirus onefile | onedir; Defender không cách ly. |
| SmartScreen | Test tải từ web thật; xác nhận hướng dẫn "Run anyway" đúng. |
| Edge thiếu | Đổi tên `msedge.exe` → báo lỗi tiếng Việt, không crash. |

---

# PHASE 4 — Vận hành đa khách

## 4.1 Heartbeat + trạng thái online/offline + lỗi trước-claim

- Worker ping `POST /worker/v1/heartbeat {hostname, appVersion, lastError?}` mỗi ~30s → upsert `crawl_workers` (`last_seen_at`, `app_version`, `last_error/last_error_at`). `claim` cũng cập nhật `last_seen`.
- **Tạo `GET /api/crawl/worker-status`** trong `src/routes/stats.routes.js` (SAU `requireAuth`, `userId` từ session): trả `{online, lastSeenAt, appVersion, lastError, lastErrorAt}` — online nếu `now() - last_seen_at < 90s` (3× chu kỳ 30s).
  > `✅ ĐÃ XỬ LÝ` (Completeness-MEDIUM "lỗi trước-claim vô hình"): trả `lastError` để web hiện "Máy cào báo lỗi: ..." (Edge thiếu, FB hết phiên, CDP fail, token sai) — vốn không tạo dòng `crawl_jobs` nào.
- Sửa `crawl-jobs.service.js`: thêm hàm đọc/ghi `crawl_workers`.

## 4.2 Khoá nút "Cào ngay" theo trạng thái worker

Sửa `public/statistics.js` `buildToolbar()` (dòng 727) + `theoDoiJob()` (835): poll `GET /api/crawl/worker-status`, render badge. `nutCao.disabled = true` khi **worker offline HOẶC job pending/running**. Offline → "Máy cào chưa bật — mở app trên máy của bạn rồi thử lại".
> `✅ ĐÃ XỬ LÝ` (Completeness-missing "badge vs job.status khi máy ngủ giữa job"): khi worker offline mà job `pending` → hiện "Sẽ chạy khi máy bật", tránh UI hiện "đang cào" sai. (Tuỳ) badge tương tự `dashboard.js`.

## 4.3 Kiểm phiên bản worker

Worker gửi `appVersion`. Server so `MIN_WORKER_VERSION` (env/const). Worker cũ gọi API mới → trả cờ `data.updateRequired=true` (message tiếng Việt "Phiên bản công cụ cào đã cũ, tải bản mới"). Có `/worker/v1/*` (1.4) làm đường forward-compat song song khi cần lên v2.

## 4.4 Chính sách job `user_id = NULL`

> `✅ ĐÃ XỬ LÝ` (Completeness-HIGH "cơ chế admin-worker không cụ thể"): định nghĩa tường minh qua cột `worker_tokens.scopes`:
> - **Token admin** (`scopes='admin'`): claim `WHERE user_id IS NULL OR user_id=$x`.
> - **Token khách** (`scopes='crawl'`): claim/finish/fail `WHERE user_id=$x AND user_id IS NOT NULL`.
>
> `NULL = $x` trong SQL luôn false → nếu không có nhánh admin, job NULL của luồng `.env` cũ **kẹt vĩnh viễn**. **BẮT BUỘC backfill `user_id`** cho job NULL `pending` **TRƯỚC khi bật filter** (không để "tuỳ chọn" như bản nháp). Sau khi web tenant-hoá tạo job (`stats.routes.js` POST `/crawl/jobs` gắn `user_id` session), job mới luôn có chủ.

## 4.5 `releaseStaleJobs` — đã ở Phase 1

Đã chuyển vào Phase 1.9. Phase 4 chỉ đảm bảo idempotent khi scale ngang (Bước 0.2).

## 4.6 Retention / cleanup (bảng phình)

> `✅ ĐÃ XỬ LÝ` (Completeness-MEDIUM "không retention/cleanup"): Supabase free 500MB. Thêm job dọn định kỳ:
> - `crawl_jobs` done/failed cũ hơn N ngày → xoá/gộp.
> - `crawled_audience_snapshots/rows`: giữ bản mới nhất + mốc theo tuần (chính sách retention).
> - Quota snapshot/user/ngày trên `/worker/v1/snapshots` (đã đặt ở 1.3).

## 4.7 Áp lực connection pool Supabase

> `✅ ĐÃ XỬ LÝ` (Completeness-HIGH "pool max:5"): `src/db/postgres.js:23 max:5` dùng chung cho auto-publish + account + stats. N worker long-poll `claim` + heartbeat 30s có thể vét cạn 5 kết nối, nghẽn vòng tự-đăng. **Hành động:** định nghĩa **nhịp claim 3–5s + backoff khi rỗng**; **gộp heartbeat vào response của `claim`** để bớt round-trip; **nâng `max`** hoặc **tách pool riêng** cho `/worker/*`; **load-test N worker đồng thời** trước phát hành.

## 4.8 Nhánh Instagram (nêu, tách nhánh)

IG demographics chạy server-side bằng Page Access Token (`instagram_manage_insights` + ~100 follower), **không qua .exe**.
> **Bẫy đơn vị (ghi nhớ):** IG-API trả **SỐ TUYỆT ĐỐI**; crawler trả **ĐÃ-LÀ-%** (`alreadyPercent:true`). `buildInstagramAudience` (`audience.service.js`) **KHÔNG** đọc `alreadyPercent`. Nếu sau này cắm crawler vào IG, phải cho nó đọc cờ này (như `buildFacebookAudience`), kẻo chia lại % → sai. Phiên bản này **không** đụng nhánh IG.

## 4.9 Rủi ro Phase 4 + Kiểm chứng

| Rủi ro | Kiểm chứng |
|---|---|
| Ngưỡng online nhấp nháy | Heartbeat 30s + ngưỡng 90s ổn định qua mạng chập chờn. |
| Worker cũ gặp API mới | Version thấp → cờ `updateRequired` + message rõ. |
| Worker khách nuốt job NULL | Token khách claim job `user_id=NULL` → `null`; admin token → nhận. |
| Job NULL kẹt sau bật filter | Backfill xong; không job NULL pending còn sót. |
| Cạn pool | Load-test N worker: vòng auto-publish không nghẽn. |
| Lỗi trước-claim vô hình | Ngắt Edge → web hiện "Máy cào báo lỗi". |

---

# ĐƯỜNG DI TRÚ — giữ máy-nhà người vận hành chạy trong/sau khi đổi

Máy nhà chạy `python -m src.worker` shell sang 3 script Node, cầm `DATABASE_URL` trong `.env` của checkout web tại `WEB_APP_DIR=D:\Code\Post-Meta-Auto`. **Không làm gãy cái đang chạy.**

**Chiến lược song song (parallel-run), không big-bang:**

1. **Phase 1 chỉ THÊM, không xoá luồng cũ:** dựng `/worker/v1/*` + token + bảng mới + cột `user_id` kho. **Giữ** `crawl-worker-cli.js`, `export-assets.js`, `import-audience.js` (đã refactor rút ruột sang `audience-import.service.js`) và nhánh `getSql()`. `claimNextJob` tương thích ngược (1.8) → CLI cũ vẫn claim. Máy nhà nối thẳng Postgres như cũ → **zero downtime**.
   > `✅ ĐÃ XỬ LÝ` (Completeness-HIGH "giữ nguyên vs refactor"): làm rõ `import-audience.js` **đã refactor** — rollback drill test bản đã refactor, không tuyên bố sai "giữ nguyên 3 script".
2. **Cấp token admin cho người vận hành:** tạo 1 token `scopes='admin'` (gắn `users.id` của họ) → "admin-worker" nhận cả job NULL (4.4).
3. **Chuyển máy nhà sang HTTP:** cập nhật Python dùng `ApiClient` + token. Chạy `--once` 1 asset, đối chiếu snapshot khớp đường cũ. Lỗi → **rollback tức thì** trỏ lại script Node cũ (`.env` `DATABASE_URL` vẫn còn).
4. **Backfill `user_id` job NULL pending** trước khi bật filter tenant (bắt buộc, 4.4).
5. **Gỡ `DATABASE_URL` khỏi máy nhà = bước CUỐI**, chỉ sau khi HTTP ổn qua vài chu kỳ cào thật. Trước đó giữ làm đường rollback.
6. **Không xoá 3 script Node ngay:** giữ tới khi `.exe` phát hành + ≥1 khách chạy thật thành công.

**Kiểm chứng:** snapshot end-to-end đường cũ vẫn PASS (tiền lệ job#1→snapshot#2, 32 dòng) → đổi HTTP cào cùng asset, so số dòng + `percentage` khớp → rollback drill (trỏ lại Node, đường lui còn sống).

---

# TỔNG HỢP FILE ĐỘNG CHẠM

**Web — tạo mới:**
- `src/services/worker-token.service.js`
- `src/middleware/requireWorkerToken.js`
- `src/routes/worker.routes.js` (+ error-handler riêng chuẩn hoá field `error`)
- `src/services/audience-import.service.js` (tách từ `scripts/import-audience.js`)
- `public/crawler-download.html`, `public/crawler-download.js`

**Web — sửa:**
- `src/db/postgres.js` (bảng `worker_tokens`, `crawl_workers`; cột `user_id`+`idempotency_key` cho `crawled_audience_snapshots`; init)
- `src/services/crawl-jobs.service.js` (`claimNextJob(userId,scopes)` tương thích ngược; `createJob` chống-trùng `user_id`; hàm heartbeat/worker-status; scope `listJobs/getJob` theo `user_id`)
- `src/services/crawled-audience.service.js` (scope đọc theo `(asset_id,user_id)`)
- `src/routes/account.routes.js` (quản lý token + Origin/Referer check)
- `src/routes/stats.routes.js` (`GET /api/crawl/worker-status`)
- `server.js` (mount `worker.routes` trước dòng 111; **cron `releaseStaleJobs`** ; cron retention; HSTS)
- `src/utils/crypto-box.js` + `src/config.js` (`TOKEN_ENCRYPTION_KEY` cố định — Bước 0)
- `public/shared/shell.js` (NAV "Công cụ cào")
- `public/dashboard.html` + `dashboard.js` (thẻ trạng thái máy cào)
- `public/statistics.js` (badge online + khoá nút + "sẽ chạy khi máy bật")

**Python worker — tạo mới:** `src/api_client.py` (https-only), `src/config_store.py` (DPAPI), `src/tray_app.py`, `PostMetaCrawler.spec`

**Python worker — sửa:**
- `config/settings.py` (frozen `base_dir` cho TẤT CẢ đường ghi; `META_*` tuỳ chọn; `WEB_APP_URL`/`WORKER_TOKEN`)
- `src/worker.py` (JobClient → HTTP, bỏ release, entry point `--login`)
- `src/exporters/postgres_store.py` (→ `POST /worker/v1/snapshots` + jobId + idempotencyKey)
- `src/collectors/asset_discovery.py` (→ `GET /worker/v1/assets`)
- `src/launcher.py` (dò Edge registry/per-user + `--no-first-run`)
- `requirements.txt`, `chay-nen.bat`, `chay-tu-dong.bat`

**Tài liệu:** `CLAUDE.md` (mục crawler) + memory `crawler-integration.md` ("nối qua 3 script Node" → stale) + hướng dẫn tiếng Việt.

---

# CÁC QUYẾT ĐỊNH ĐÃ CHỐT

1. Worker **THAY THẾ** mô hình nối-thẳng-Postgres bằng HTTP `/worker/v1/*` có token.
2. Token gắn **`users.id` (Postgres)**, không phải FB user id.
3. Nhiều token/thiết bị mỗi khách (`worker_tokens`), có `expires_at` mặc định 90 ngày + `last_used_at`/`revoked_at`.
4. Job `user_id=NULL` **chỉ token `scopes='admin'` nhận**; token khách chỉ job của mình (`user_id IS NOT NULL`).
5. Token bao trùm claim/finish/fail + snapshots + assets (đều qua `/worker/v1/*`).
6. **BĂM SHA-256 một chiều**; token thô hiện đúng một lần; verify tra thẳng theo `token_hash`.
7. `releaseStaleJobs` = **cron server-side, VÀO Phase 1**; worker bỏ `release`.
8. **PyInstaller onedir**, build **có console**, `collect_all` playwright + pydantic_core.
9. Envelope `{success,data,error}`; **error-handler riêng** cho `/worker/*` chuẩn hoá field `error`.
10. **`urllib` stdlib**, **https-only** phía client.
11. **Tenant-hoá cả GHI lẫn ĐỌC**: thêm `user_id` vào `crawled_audience_snapshots`, scope mọi đường đọc.
12. Token client mã hoá **DPAPI** trong `%LOCALAPPDATA%`; không log token.
13. **Ép TLS**: HSTS + từ chối http trên `/worker/*`.
14. `/worker/v1/snapshots` **bắt buộc `jobId`** + idempotency key; assetId phải khớp job.
15. Heartbeat **không trả email/PII**.
16. Tự chạy = **phiên tương tác** (shell:startup / "only when logged on"), cấm Session 0.
17. URL versioned `/worker/v1/*`.

---

# QUYẾT ĐỊNH CẦN NGƯỜI DÙNG CHỐT

1. **Ký code (SmartScreen):** mua **cert OV/EV** (OV cần thời gian tích reputation; EV có SmartScreen tin ngay nhưng đắt + cần token cứng) **HAY** chấp nhận ma sát + hướng dẫn tiếng Việt "More info → Run anyway" kèm ảnh? → Ảnh hưởng ngân sách + tỷ lệ khách phổ thông bỏ cuộc.
2. **App khay vs Scheduled task:** dùng **tray app** (`pystray`, luôn hiện trạng thái + là entry point login) hay **cửa sổ console tối giản + shortcut startup**? Bản nháp nghiêng tray, nhưng tray làm nặng build + thêm `Pillow`. → Cần chốt vì đây là nơi duy nhất "Đăng nhập FB" long-timeout.
3. **Cơ chế token phía đường truyền:** giữ **bearer tĩnh + TLS + expiry 90 ngày** (đơn giản) hay nâng lên **ký request HMAC per-call** (token + timestamp + path, chống replay/tamper kể cả khi TLS bị hạ cấp)? → HMAC an toàn hơn nhưng tăng độ phức tạp cả 2 phía.
4. **Lưu token phía client:** **Windows DPAPI** (gắn user Windows, đơn giản) hay **Credential Manager** (quản lý tập trung, gỡ dễ)? → Cả hai đều đạt yêu cầu "không plaintext".
5. **Xoay vòng token:** khi hết 90 ngày, cho khách **tự tạo lại trên web** (thủ công, đơn giản) hay app **tự nhắc + hỗ trợ tạo mới in-app**? → Ảnh hưởng UX + số lần hỗ trợ.
6. **Tên miền / URL API:** dùng thẳng **URL Render hiện tại** điền sẵn, hay mua **custom domain** cho `/worker/*` (ổn định link trong exe đã phát hành, tránh phụ thuộc subdomain Render)? → exe cầm URL cứng; đổi domain sau = phải cập nhật exe.
7. **Cách phát hành + auto-update:** host `.exe` ở **GitHub Release** (versioned, dễ) hay **static asset trên web**? Và auto-update kiểu **chặn cứng 426 + tải tay** hay **auto-update thật** (app tự tải bản mới)? → Bản nháp mới chỉ chặn cứng; auto-update thật cần thêm cơ chế + chữ ký.
8. **Cấp token admin cho ai:** chỉ **người vận hành** giữ token `scopes='admin'` cho máy-nhà, hay có thêm admin dự phòng? → Liên quan job NULL di trú.
9. **Retention demographics:** giữ **bao lâu / bao nhiêu mốc** mỗi asset (free tier 500MB)? Ví dụ giữ 12 tuần gần nhất + 1 mốc/tháng cũ hơn. → Cần con số cụ thể để viết job dọn.
10. **Sizing pool Supabase:** **nâng `max`** trên pool chung hay **tách pool riêng** cho `/worker/*`? Phụ thuộc số khách đồng thời dự kiến (cho con số ước lượng để load-test).

---

# THỨ TỰ LÀM & ƯỚC LƯỢNG

**Khối lượng tương đối:** S = nhỏ (≤ nửa ngày), M = vừa (1–2 ngày), L = lớn (3+ ngày). Phụ thuộc ghi rõ.

| Thứ tự | Hạng mục | KL | Phụ thuộc | Ghi chú |
|---|---|---|---|---|
| **0** | Bước 0: `TOKEN_ENCRYPTION_KEY` cố định + verify giải mã sau redeploy; xác nhận Render không ngủ/scale | **S** | — | **Cổng chặn.** Không PASS không làm tiếp. |
| **1** | Phase 1 schema: `worker_tokens`, `crawl_workers`, cột `user_id`+idempotency kho, backfill | **M** | 0 | Nền tenant-hoá; backfill có phần thủ công. |
| **2** | `worker-token.service` + `requireWorkerToken` + rate-limit + HSTS/deny-http | **M** | 1 | Bảo mật lõi. |
| **3** | `crawl-jobs.service`: `claimNextJob` tương thích ngược + `createJob` user_id + scope reads; cron `releaseStaleJobs` vào `server.js` | **M** | 1 | **Cùng commit gỡ release** (Phase 1). Không tách. |
| **4** | `audience-import.service` tách + `worker.routes.js` (`/v1/*`, error-handler, snapshots ràng job) + endpoint `/account/worker-tokens` | **L** | 2,3 | Bề mặt HTTP đầy đủ. |
| **5** | Refactor Python → `ApiClient` HTTP (https-only) + bỏ release + entry `--login` | **M** | 4 | Chạy được end-to-end bằng script (chưa đóng gói). |
| **6** | **Di trú máy-nhà sang HTTP** (token admin, `--once`, đối chiếu, rollback drill) | **M** | 5 | Zero-downtime; giữ đường lui. **Chốt hết Phase 1 mới đóng gói.** |
| **7** | Phase 2: `config/settings.py` frozen base_dir + `META_*` optional; `config_store` DPAPI; login entry; Edge detection; tray | **L** | 5 | Nhiều bẫy frozen-path; test máy sạch. |
| **8** | Phase 3: `.spec` onedir + collect_all + loại `.env`; grep secret; `chay-nen.bat`; trang tải + hướng dẫn TV | **L** | 7 | Song song được với phần web trang tải. |
| **9** | **GATE phát hành:** end-to-end trên VM Win11 sạch | **M** | 8 | Điều kiện chặn link tải. |
| **10** | Phase 4: worker-status + badge/khoá nút + version check + retention + pool sizing/load-test | **M** | 4,6 | Vận hành đa khách; một phần song song với 7–8. |
| **11** | Ký code / SmartScreen (theo quyết định #1) | **S–M** | 8 | Phụ thuộc chốt người dùng. |

**Đường tới hạn (critical path):** 0 → 1 → 3 → 4 → 5 → 6 → 7 → 8 → 9.
**Chạy song song được:** trang tải web (8) song song với đóng gói Python (7–8); Phase 4 badge/worker-status (10) song song sau khi có `/worker/*` (4); quyết định ký code (11) chạy nền.
**Cổng bắt buộc:** Bước 0 PASS trước tất cả; Phase 1 (mục 1–6) hoàn tất + rollback drill trước khi đóng gói; GATE mục 9 trước khi đưa link tải cho khách.