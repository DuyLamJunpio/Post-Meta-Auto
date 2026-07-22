const { getSql, isEnabled } = require("../db/postgres");
const { encrypt, decrypt } = require("../utils/crypto-box");

// Lưu kết nối Facebook theo từng tài khoản (userId) vào Postgres — bền qua redeploy.
// Token (user + page) mã hóa AES-256-GCM qua crypto-box. Đây là nền cho publish loop per-user (pha sau).

async function saveConnection(userId, facebookUser) {
  if (!isEnabled() || !userId || !facebookUser) {
    return;
  }
  const sql = getSql();
  const dataEnc = encrypt(
    JSON.stringify({ userAccessToken: facebookUser.userAccessToken, pages: facebookUser.pages || [] })
  );

  await sql`
    INSERT INTO user_facebook (user_id, fb_user_id, fb_user_name, data_enc, connected_at)
    VALUES (${Number(userId)}, ${facebookUser.id || null}, ${facebookUser.name || null}, ${dataEnc}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      fb_user_id = excluded.fb_user_id,
      fb_user_name = excluded.fb_user_name,
      data_enc = excluded.data_enc,
      connected_at = now()
  `;
}

async function getConnection(userId) {
  if (!isEnabled() || !userId) {
    return null;
  }
  const sql = getSql();
  const rows = await sql`SELECT * FROM user_facebook WHERE user_id = ${Number(userId)} LIMIT 1`;
  if (!rows[0]) {
    return null;
  }

  let data = {};
  try {
    data = JSON.parse(decrypt(rows[0].data_enc));
  } catch {
    data = {};
  }

  return {
    fbUserId: rows[0].fb_user_id,
    fbUserName: rows[0].fb_user_name,
    userAccessToken: data.userAccessToken || null,
    pages: Array.isArray(data.pages) ? data.pages : [],
    connectedAt: rows[0].connected_at
  };
}

async function getStatus(userId) {
  const connection = await getConnection(userId);
  if (!connection) {
    return { connected: false };
  }
  return {
    connected: true,
    fbUserId: connection.fbUserId,
    fbUserName: connection.fbUserName,
    pageCount: connection.pages.length,
    connectedAt: connection.connectedAt
  };
}

async function disconnect(userId) {
  if (!isEnabled() || !userId) {
    return;
  }
  await getSql()`DELETE FROM user_facebook WHERE user_id = ${Number(userId)}`;
}

module.exports = { saveConnection, getConnection, getStatus, disconnect };
