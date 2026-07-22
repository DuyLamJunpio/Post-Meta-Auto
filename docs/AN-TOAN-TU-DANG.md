# Hướng dẫn cơ chế an toàn tự đăng

Tài liệu này mô tả các lớp bảo vệ chống **đăng nhầm / đăng trùng / xả bài hàng loạt** lên page, cách cấu hình và cách vận hành (tạm dừng khẩn, thu hồi bài, nhận cảnh báo Telegram).

## 1. Biến môi trường

Tất cả đều có mặc định an toàn — không đặt vẫn chạy. Đặt trên Render → **Environment**.

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `AUTO_PUBLISH_ENABLED` | `true` | Kill switch cứng. `false` = vòng lặp không đăng gì (cần đổi env + restart để bật lại). |
| `MAX_PUBLISH_PER_RUN` | `5` | Trần số bài đăng mỗi lượt (mỗi ~60 giây). Chống xả bài đồng loạt. |
| `PER_PAGE_COOLDOWN_MS` | `600000` (10 phút) | Khoảng nghỉ tối thiểu giữa 2 bài lên **cùng một page**. `0` = tắt. |
| `AUTO_PUBLISH_ANOMALY_THRESHOLD` | `10` | Nếu số task đến hạn trong 1 lượt vượt ngưỡng này → **tự tạm dừng + cảnh báo**, không đăng. |
| `AUTO_PUBLISH_STUCK_MS` | `900000` (15 phút) | Task kẹt "Đang đăng" quá lâu sẽ được hòa giải. |
| `AUTO_PUBLISH_STRICT_NAME_MATCH` | `false` | `true` = **chặn** khi tên page thật lệch hẳn tên Brand. Mặc định chỉ cảnh báo (tránh báo nhầm). |
| `TELEGRAM_BOT_TOKEN` | (trống) | Token bot Telegram. Trống = tắt cảnh báo. |
| `TELEGRAM_CHAT_ID` | (trống) | Chat/nhóm nhận cảnh báo. |
| `TELEGRAM_NOTIFY_LEVEL` | `important` | `important` = chỉ báo lỗi/pause/thu hồi; `all` = báo cả khi đăng thành công. |

## 2. Tạo bot Telegram để nhận cảnh báo

1. Mở Telegram, tìm **@BotFather** → gõ `/newbot` → đặt tên → nhận **bot token** (dạng `123456:ABC-...`). Đây là `TELEGRAM_BOT_TOKEN`.
2. Lấy **chat id**:
   - Cách cá nhân: nhắn 1 tin bất kỳ cho bot vừa tạo, rồi mở:
     `https://api.telegram.org/bot<TOKEN>/getUpdates`
     Tìm `"chat":{"id":...}` → đó là `TELEGRAM_CHAT_ID`.
   - Cách nhóm: thêm bot vào nhóm, gửi 1 tin trong nhóm, mở link `getUpdates` như trên, lấy `chat.id` (nhóm thường là số âm).
3. Đặt `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` trên Render → Deploy lại.
4. Khi có bài đăng lỗi / hệ thống tự tạm dừng / thu hồi bài, bạn sẽ nhận tin ngay trên Telegram.

> Telegram là **lưới an toàn bền nhất** trên Render Free: dù cơ sở dữ liệu bị xóa khi deploy, cảnh báo vẫn tới bạn.

## 3. Các lớp bảo vệ (tóm tắt)

- **Lớp 1 — Phanh khẩn:** trần số bài/lượt, cooldown theo page, tự tạm dừng khi bất thường, kill switch.
- **Lớp 2 — Đúng page:** chốt "mục tiêu đăng dự kiến" lúc lên lịch; nếu ai đó đổi Facebook Page ID của Brand sau đó → **chặn đăng**. Cảnh báo khi tên page ≠ tên Brand.
- **Lớp 3 — Chống trùng/kẹt:** task kẹt "Đang đăng" quá lâu được hòa giải — có bằng chứng đã đăng thì chuyển "Đã đăng"; không có thì chuyển "Lỗi đăng" + bật *Manual Action Required* và ghi chú **kiểm tra page trước khi đăng lại**. Không bao giờ tự đăng lại.
- **Lớp 4 — Cảnh báo & thu hồi:** cảnh báo Telegram, nhật ký đăng, thu hồi bài ngay trên bảng.

## 3b. Vận hành trên giao diện (trang "Bài đăng & An toàn")

Giao diện đã tách thành các trang riêng ở thanh bên; mọi thao tác an toàn nằm ở trang **Bài đăng & An toàn**:

- **Thanh trạng thái tự đăng** ở đầu trang: xem đang chạy/tạm dừng + nút **Tạm dừng khẩn** / **Bật lại** / **Làm mới**.
- **Lọc theo Page** (chia 2 nhóm: *Có Instagram liên kết* và *Chỉ Facebook*). Chọn 1 Page:
  - Page chỉ có Facebook → hiện **1 bảng** bài đăng Facebook.
  - Page có cả Instagram liên kết → hiện **2 bảng** (Facebook + Instagram), đầu mỗi bảng có thông tin chi tiết của Page/tài khoản.
- **Cột "An toàn tự đăng"** cuối mỗi bảng:
  - Facebook: nút **Thu hồi** — xóa thật khỏi Page (có xác nhận), tự ghi nhật ký + gửi cảnh báo Telegram.
  - Instagram: **chỉ mở bài để xử lý thủ công**. Instagram Graph API **không hỗ trợ xóa bài đã đăng**, nên phải xóa trực tiếp trong app Instagram.
- **Nhật ký đăng gần đây** ở cuối trang: truy vết đã đăng / lỗi / tạm dừng / thu hồi.

## 4. Các endpoint vận hành

Tất cả nằm dưới `/api` nên **cần đăng nhập Facebook** (có cookie phiên). Ví dụ dùng trình duyệt đã đăng nhập hoặc `curl` kèm cookie.

### Xem trạng thái phanh
```
GET /api/auto-publish/status
```
Trả về: bật/tắt theo env, có đang pause không, lý do, và các ngưỡng đang áp dụng.

### Tạm dừng khẩn cấp (khi phát hiện bất thường)
```
POST /api/auto-publish/pause
Body (tùy chọn): { "reason": "Nghi ngờ cấu hình sai" }
```

### Bật lại sau khi xử lý xong
```
POST /api/auto-publish/resume
```

### Xem nhật ký đăng gần đây
```
GET /api/auto-publish/audit?limit=50
```

### Thu hồi (xóa) nhanh một bài Facebook đã đăng
```
POST /api/posts/facebook/retract
Body: { "pageId": "<id page>", "postId": "<id bài>" }
```
Tài khoản đang đăng nhập phải quản lý page đó. Post ID lấy từ cột `[FB] Post ID` trên Notion hoặc từ cảnh báo Telegram.

## 5. Kịch bản kiểm thử nên chạy trước khi tin dùng

Nên thử trên **1 page nháp** trước:

1. **Đổi mapping sau khi lên lịch:** đưa 1 task về "Đã lên lịch", rồi đổi `Facebook Page ID` của Brand → tới giờ đăng phải **bị chặn** (task chuyển Lỗi đăng với lý do "mục tiêu đăng đã thay đổi").
2. **Bất thường hàng loạt:** đặt >10 task cùng đến hạn → hệ thống phải **tự pause** và gửi cảnh báo Telegram, không đăng bài nào.
3. **Cooldown:** 2 task cùng 1 page đến hạn sát nhau → chỉ 1 bài đăng, bài kia hoãn tới khi hết cooldown.
4. **Thu hồi:** gọi endpoint retract với 1 bài test → bài bị xóa khỏi page, nhận cảnh báo Telegram.

Khi các kịch bản trên đúng như mong đợi, mới mở tự đăng cho page thật.
