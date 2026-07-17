const { getDb } = require("../db");
const cryptoBox = require("../utils/crypto-box");

// Lưu/đọc token đa kênh trong bảng channel_accounts.
// access_token/refresh_token luôn được mã hóa khi ghi, giải mã khi đọc.

function serializeMetadata(metadata) {
  if (metadata === null || metadata === undefined) {
    return null;
  }

  try {
    return JSON.stringify(metadata);
  } catch (error) {
    console.error("[Token Store] Không serialize được metadata:", error.message);
    return null;
  }
}

function parseMetadata(raw) {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

function mapRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    accountId: row.account_id,
    accountName: row.account_name,
    accessToken: cryptoBox.decrypt(row.access_token),
    refreshToken: cryptoBox.decrypt(row.refresh_token),
    scope: row.scope,
    tokenType: row.token_type,
    expiresAt: row.expires_at,
    metadata: parseMetadata(row.metadata),
    connectedAt: row.connected_at,
    updatedAt: row.updated_at
  };
}

function upsertAccount(account) {
  const db = getDb();
  const now = new Date().toISOString();
  const userId = String(account.userId);
  const channel = String(account.channel);
  const accountId = account.accountId ? String(account.accountId) : "";

  const existing = db
    .prepare(
      "SELECT connected_at FROM channel_accounts WHERE user_id = ? AND channel = ? AND account_id = ?"
    )
    .get(userId, channel, accountId);

  const connectedAt = (existing && existing.connected_at) || account.connectedAt || now;

  db.prepare(
    `INSERT INTO channel_accounts
       (user_id, channel, account_id, account_name, access_token, refresh_token,
        scope, token_type, expires_at, metadata, connected_at, updated_at)
     VALUES
       (@user_id, @channel, @account_id, @account_name, @access_token, @refresh_token,
        @scope, @token_type, @expires_at, @metadata, @connected_at, @updated_at)
     ON CONFLICT (user_id, channel, account_id) DO UPDATE SET
       account_name  = excluded.account_name,
       access_token  = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, channel_accounts.refresh_token),
       scope         = excluded.scope,
       token_type    = excluded.token_type,
       expires_at    = excluded.expires_at,
       metadata      = excluded.metadata,
       updated_at    = excluded.updated_at`
  ).run({
    user_id: userId,
    channel,
    account_id: accountId,
    account_name: account.accountName || null,
    access_token: cryptoBox.encrypt(account.accessToken),
    refresh_token: cryptoBox.encrypt(account.refreshToken),
    scope: account.scope || null,
    token_type: account.tokenType || null,
    expires_at: account.expiresAt || null,
    metadata: serializeMetadata(account.metadata),
    connected_at: connectedAt,
    updated_at: now
  });

  return getAccount(userId, channel, accountId);
}

function getAccount(userId, channel, accountId = "") {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM channel_accounts WHERE user_id = ? AND channel = ? AND account_id = ?"
    )
    .get(String(userId), String(channel), String(accountId));

  return mapRow(row);
}

function listAccounts(userId, channel) {
  const db = getDb();
  const rows = channel
    ? db
        .prepare("SELECT * FROM channel_accounts WHERE user_id = ? AND channel = ? ORDER BY updated_at DESC")
        .all(String(userId), String(channel))
    : db
        .prepare("SELECT * FROM channel_accounts WHERE user_id = ? ORDER BY updated_at DESC")
        .all(String(userId));

  return rows.map(mapRow);
}

function deleteAccount(userId, channel, accountId = "") {
  const db = getDb();
  db.prepare(
    "DELETE FROM channel_accounts WHERE user_id = ? AND channel = ? AND account_id = ?"
  ).run(String(userId), String(channel), String(accountId));
}

module.exports = {
  upsertAccount,
  getAccount,
  listAccounts,
  deleteAccount
};
