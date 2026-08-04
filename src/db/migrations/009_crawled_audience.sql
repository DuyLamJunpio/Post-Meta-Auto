-- Nhân khẩu học lấy bằng công cụ cào Business Suite (Crawl_demographics_meta).
--
-- VÌ SAO CẦN BẢNG NÀY
-- Meta đã ngừng gần hết metric nhân khẩu học cấp Page trên Graph API
-- (xem ghi chú trong src/services/facebook.service.js). Công cụ cào chạy trên
-- máy Windows có Edge đã đăng nhập, lấy số liệu từ chính giao diện Business
-- Suite rồi ghi thẳng vào đây. Web chỉ ĐỌC.
--
-- LUỒNG:
--   [may cua ban]  python -m src.cli run  --ghi-->  data/app.db  --doc-->  [web]
--
-- LƯU Ý VỀ ĐƠN VỊ: cột `percentage` LÀ PHẦN TRĂM SẴN, không phải số tuyệt đối.
-- Meta có thể trả tổng vượt 100% (thực đo: tổng theo quốc gia ~112%, riêng
-- Việt Nam 106.2%) vì một người có thể được tính vào nhiều quốc gia. Đây là
-- đặc thù dữ liệu phía Meta, KHÔNG phải lỗi. Vì vậy tầng đọc phải dùng
-- normalizeBreakdown({ alreadyPercent: true }) để không chia lại theo tổng.

CREATE TABLE IF NOT EXISTS crawled_audience_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- ID của Page Facebook hoặc tài khoản Instagram
    asset_id    TEXT NOT NULL,
    -- 'page' hoặc 'instagram'
    asset_type  TEXT NOT NULL DEFAULT 'page',
    business_id TEXT,
    -- Nguồn lấy dữ liệu, hiện tại luôn là 'browser'
    source      TEXT NOT NULL DEFAULT 'browser',
    -- ISO-8601 KÈM MÚI GIỜ, ví dụ 2026-08-03T14:33:03+07:00
    captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS crawled_audience_rows (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER NOT NULL
                REFERENCES crawled_audience_snapshots(id) ON DELETE CASCADE,
    -- 'age_gender' | 'city' | 'country'
    dimension   TEXT NOT NULL,
    -- Nhãn gọn để hiển thị: "25-34 / female" hoặc "Huế, Thừa Thiên - Huế"
    segment     TEXT NOT NULL,
    -- Ba cột dưới chỉ điền cho đúng chiều tương ứng, còn lại để NULL
    age_range   TEXT,
    gender      TEXT,
    location    TEXT,
    -- ĐÃ LÀ PHẦN TRĂM (xem ghi chú đầu file)
    percentage  REAL NOT NULL
);

-- Câu hỏi hay dùng nhất: "lấy ảnh chụp MỚI NHẤT của page này"
CREATE INDEX IF NOT EXISTS idx_crawled_snapshots_asset
    ON crawled_audience_snapshots (asset_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_crawled_rows_snapshot
    ON crawled_audience_rows (snapshot_id, dimension);
