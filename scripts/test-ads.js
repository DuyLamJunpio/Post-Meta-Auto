require("dotenv").config();

const facebookService = require("../src/services/facebook.service");
const adsMath = require("../src/utils/ads-math");

// Script chẩn đoán THỦ CÔNG (không phải test tự động) cho Pha 0 tích hợp Ads Insights.
// Kiểm tra: token có quyền ads_read chưa, liệt kê được tài khoản quảng cáo + chiến dịch chưa.
//
// Cách dùng (PowerShell):
//   node scripts/test-ads.js --token=<USER_ACCESS_TOKEN>
//   node scripts/test-ads.js --token=<USER_ACCESS_TOKEN> --account=act_830926689974584
//   node scripts/test-ads.js --token=<...> --account=act_... --campaign=120248059016220650
// Hoặc đặt token qua biến môi trường FB_USER_TOKEN rồi:
//   node scripts/test-ads.js
//
// Lấy USER access token ở đâu: đăng nhập Facebook trong app rồi lấy từ session, hoặc dùng
// Graph API Explorer với đúng các quyền (đặc biệt là ads_read).

function parseArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

const REQUIRED_ADS_PERMISSION = "ads_read";

async function main() {
  const userAccessToken = parseArg("token") || process.env.FB_USER_TOKEN || "";
  const requestedAccount = parseArg("account");
  const requestedCampaign = parseArg("campaign");

  if (!userAccessToken) {
    console.error(
      "Thiếu USER access token. Truyền qua --token=<...> hoặc đặt biến môi trường FB_USER_TOKEN."
    );
    process.exit(1);
  }

  // 1) Kiểm tra quyền đã cấp — ads_read là điều kiện tiên quyết để đọc Ads Insights.
  const granted = await facebookService.getGrantedPermissions(userAccessToken);
  const hasAdsRead = granted.includes(REQUIRED_ADS_PERMISSION);
  console.log("== Quyền đã cấp cho token ==");
  console.log("  Tổng số quyền:", granted.length);
  console.log(`  ${REQUIRED_ADS_PERMISSION}: ${hasAdsRead ? "ĐÃ CẤP ✓" : "CHƯA CẤP ✗"}`);
  if (!hasAdsRead) {
    console.log(
      "  => Token chưa có ads_read. Sau khi thêm scope vào config, hãy đăng xuất/đăng nhập lại Facebook trong app (auth_type=rerequest sẽ hỏi lại quyền)."
    );
  }
  console.log("");

  // 2) Liệt kê tài khoản quảng cáo user truy cập được.
  const accounts = await facebookService.getAdAccounts(userAccessToken);
  console.log(`== Tài khoản quảng cáo (/me/adaccounts): ${accounts.length} ==`);
  for (const account of accounts) {
    console.log(
      `  ${account.id} | ${account.name} | ${account.currency} | status=${account.status}` +
        (account.business ? ` | business=${account.business.name}` : "")
    );
  }
  console.log("");

  // 3) Liệt kê chiến dịch của 1 tài khoản: ưu tiên --account, nếu không thì lấy tài khoản đầu tiên.
  const targetAccountId =
    requestedAccount || (accounts[0] ? accounts[0].id : "");
  if (!targetAccountId) {
    console.log("Không có tài khoản quảng cáo nào để liệt kê chiến dịch.");
    return;
  }

  const campaigns = await facebookService.getCampaigns(targetAccountId, userAccessToken);
  console.log(`== Chiến dịch của ${targetAccountId}: ${campaigns.length} ==`);
  for (const campaign of campaigns) {
    console.log(
      `  ${campaign.id} | ${campaign.name} | objective=${campaign.objective} | ${campaign.effectiveStatus}`
    );
  }
  console.log("");

  // 4) Nhân khẩu học (Pha 2): tách theo tuổi×giới / quốc gia / vùng cho 1 chiến dịch.
  const targetCampaignId = requestedCampaign || (campaigns[0] ? campaigns[0].id : "");
  if (!targetCampaignId) {
    console.log("Không có chiến dịch nào để kiểm tra nhân khẩu học.");
    return;
  }

  console.log(`== Nhân khẩu học chiến dịch ${targetCampaignId} (30 ngày) ==`);
  const { dimensions } = await facebookService.getCampaignBreakdowns({
    campaignId: targetCampaignId,
    userAccessToken,
    datePreset: "last_30d"
  });

  // Tuổi × giới tính
  if (dimensions.ageGender.available) {
    const ag = adsMath.buildAgeGenderBreakdown(dimensions.ageGender.rows);
    console.log(
      `  Tuổi×giới: ${ag.segments.length} phân khúc | nhóm tuổi: ${ag.ages.join(", ") || "—"} | giới: ${ag.genders.join(", ") || "—"}`
    );
    for (const seg of ag.segments.slice(0, 6)) {
      console.log(
        `    ${seg.age} · ${seg.gender}: ${seg.impressions} hiển thị (${seg.share.toFixed(1)}%)`
      );
    }
  } else {
    console.log(`  Tuổi×giới: KHÔNG khả dụng — ${dimensions.ageGender.reason}`);
  }

  // Quốc gia + vùng
  for (const [key, label, field] of [
    ["country", "Quốc gia", "country"],
    ["region", "Vùng/tỉnh", "region"]
  ]) {
    const dim = dimensions[key];
    if (dim.available) {
      const top = adsMath.buildCategoricalBreakdown(dim.rows, field, { topN: 5 });
      console.log(`  ${label}: ${top.totalCount} giá trị, top ${top.items.length}:`);
      for (const item of top.items) {
        console.log(`    ${item.value}: ${item.impressions} hiển thị (${item.share.toFixed(1)}%)`);
      }
    } else {
      console.log(`  ${label}: KHÔNG khả dụng — ${dim.reason}`);
    }
  }
}

main().catch((error) => {
  console.error("Lỗi khi kiểm tra Ads Insights:");
  console.error(error.publicMessage || error.message);
  if (error.details) {
    console.error("Chi tiết:", JSON.stringify(error.details));
  }
  process.exit(1);
});
