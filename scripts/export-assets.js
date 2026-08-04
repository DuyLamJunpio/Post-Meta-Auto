#!/usr/bin/env node
// Xuất danh sách Page Facebook + tài khoản Instagram đã kết nối, dạng JSON.
//
// DÙNG LÀM GÌ
// Công cụ cào nhân khẩu học (Crawl_demographics_meta, viết bằng Python) cần
// biết phải cào những trang nào. Danh sách đó đã có sẵn ở đây — lấy về lúc
// người dùng kết nối tài khoản Facebook, lưu mã hoá trong Postgres.
//
// VÌ SAO LÀ MỘT SCRIPT NODE CHỨ KHÔNG PHẢI CHÉP LOGIC SANG PYTHON
// Dữ liệu được mã hoá AES-256-GCM bằng crypto-box của dự án này. Chép phần
// giải mã sang Python nghĩa là có HAI bản cùng một thuật toán, phải khớp nhau
// tuyệt đối về khoá, định dạng, cách nối chuỗi — sai một chi tiết là hỏng, mà
// lỗi giải mã thì rất khó lần. Ngoài ra Python sẽ phải thêm thư viện Postgres.
//
// Gọi lại chính code này thì chỉ có MỘT bản, và nó vốn đã chạy đúng trong
// môi trường thật.
//
// CÁCH DÙNG
//   node scripts/export-assets.js                  # tu chon user duy nhat
//   node scripts/export-assets.js --user-id 1      # chi dinh user
//   node scripts/export-assets.js --list-users     # xem co nhung user nao
//
// QUY ƯỚC ĐẦU RA: JSON đi ra stdout, mọi thông báo đi ra stderr.
// Nhờ vậy bên gọi làm được `node scripts/export-assets.js > assets.json` mà
// file không bị lẫn dòng log.

require("dotenv").config();

const { getSql, isEnabled } = require("../src/db/postgres");
const userFacebookService = require("../src/services/user-facebook.service");

// Mã thoát để bên gọi phân biệt được nguyên nhân
const EXIT_OK = 0;
const EXIT_NO_CONFIG = 1; // chua cau hinh DATABASE_URL
const EXIT_NO_DATA = 2; // chua ket noi Facebook

function log(...args) {
  // stderr, không phải stdout — xem "QUY ƯỚC ĐẦU RA" ở trên
  console.error(...args);
}

function parseArgs(argv) {
  const args = { userId: null, listUsers: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--user-id") {
      args.userId = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--list-users") {
      args.listUsers = true;
    }
  }
  return args;
}

async function findUsers() {
  const sql = getSql();
  return sql`
    SELECT user_id, fb_user_name, connected_at
    FROM user_facebook
    ORDER BY user_id
  `;
}

// Một Page có thể kèm một tài khoản Instagram Business. Ta trải cả hai thành
// các "asset" riêng, vì trang Nhân khẩu học của Business Suite nhận từng asset
// một, không phân biệt Page hay IG.
function toAssets(pages) {
  const assets = [];

  for (const page of pages || []) {
    if (!page || !page.id) continue;

    assets.push({
      assetId: String(page.id),
      name: page.name || "",
      type: "page"
    });

    const ig = page.instagramBusinessAccount;
    if (ig && ig.id) {
      assets.push({
        assetId: String(ig.id),
        name: ig.username || "",
        type: "instagram",
        // Giữ lại Page cha để về sau còn đối chiếu IG với Page của nó
        parentPageId: String(page.id)
      });
    }
  }

  return assets;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!isEnabled()) {
    log("[LOI] Chua cau hinh DATABASE_URL — khong doc duoc danh sach da ket noi.");
    log("-> Kiem tra DATABASE_URL trong file .env cua du an nay.");
    return EXIT_NO_CONFIG;
  }

  const users = await findUsers();

  if (args.listUsers) {
    for (const u of users) {
      log(`user_id=${u.user_id}  ${u.fb_user_name || "(khong ten)"}  ${u.connected_at}`);
    }
    process.stdout.write(JSON.stringify({ users }, null, 2) + "\n");
    return EXIT_OK;
  }

  if (users.length === 0) {
    log("[LOI] Chua co tai khoan nao ket noi Facebook.");
    log("-> Dang nhap vao web va ket noi Facebook truoc.");
    return EXIT_NO_DATA;
  }

  // Không tự đoán khi có nhiều user: đoán sai thì sẽ cào nhầm bộ trang của
  // người khác, mà kết quả trông vẫn "bình thường" nên rất khó phát hiện.
  let userId = args.userId;
  if (!userId) {
    if (users.length > 1) {
      log(`[LOI] Co ${users.length} tai khoan da ket noi — can chi ro dung cai nao.`);
      log("-> Chay lai voi --user-id <so>. Xem danh sach: --list-users");
      return EXIT_NO_DATA;
    }
    userId = users[0].user_id;
  }

  const connection = await userFacebookService.getConnection(userId);
  if (!connection) {
    log(`[LOI] Khong thay ket noi Facebook cua user_id=${userId}.`);
    return EXIT_NO_DATA;
  }

  const assets = toAssets(connection.pages);
  const soPage = assets.filter((a) => a.type === "page").length;
  const soIg = assets.filter((a) => a.type === "instagram").length;
  log(`Da lay ${soPage} Page va ${soIg} tai khoan Instagram (user_id=${userId}).`);

  process.stdout.write(
    JSON.stringify(
      {
        userId: Number(userId),
        fbUserName: connection.fbUserName || null,
        assets
      },
      null,
      2
    ) + "\n"
  );

  return EXIT_OK;
}

main()
  .then(async (code) => {
    // Đóng kết nối Postgres, nếu không tiến trình sẽ treo không thoát.
    const sql = getSql();
    if (sql) await sql.end({ timeout: 5 });
    process.exit(code);
  })
  .catch(async (error) => {
    log("[LOI]", error && error.message ? error.message : error);
    const sql = getSql();
    if (sql) await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(EXIT_NO_DATA);
  });
