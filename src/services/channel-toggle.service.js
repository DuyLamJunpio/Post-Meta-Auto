const { getDb } = require("../db");

// Bật/tắt tự đăng theo từng Brand × kênh (nguồn sự thật: bảng channel_toggles).
// Mặc định BẬT — chỉ khi có dòng enabled=0 mới coi là tắt.

function isChannelEnabled(brandId, channel) {
  if (!brandId || !channel) {
    return true;
  }

  const db = getDb();
  const row = db
    .prepare("SELECT enabled FROM channel_toggles WHERE brand_id = ? AND channel = ?")
    .get(String(brandId), String(channel));

  if (!row) {
    return true;
  }

  return row.enabled === 1;
}

function setChannelEnabled(brandId, channel, enabled) {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO channel_toggles (brand_id, channel, enabled, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(brand_id, channel) DO UPDATE SET
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  ).run(String(brandId), String(channel), enabled ? 1 : 0, now);

  return isChannelEnabled(brandId, channel);
}

function listDisabled() {
  const db = getDb();
  return db
    .prepare("SELECT brand_id, channel FROM channel_toggles WHERE enabled = 0")
    .all()
    .map((row) => ({ brandId: row.brand_id, channel: row.channel }));
}

module.exports = {
  isChannelEnabled,
  setChannelEnabled,
  listDisabled
};
