-- Lớp 2 (xác minh đúng page): chốt "mục tiêu đăng dự kiến" ngay lúc lên lịch.
-- Khi đăng, nếu account hiện tại khác snapshot này => ai đó đã đổi mapping Brand
-- sau khi duyệt/lên lịch => chặn để không đăng nhầm page.
ALTER TABLE publish_jobs ADD COLUMN expected_account_id TEXT;
