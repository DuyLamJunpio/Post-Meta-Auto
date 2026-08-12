// Orchestrator "trục Page": quét MỌI tài khoản QC user truy cập được, gom chiến dịch
// theo Page (suy Page từ ads' creative qua facebook.getAdsPageMap), rồi dựng cây bằng
// hàm thuần ads-math.buildPageCampaignTree.
//
// KHÔNG lấy kết quả/nhân khẩu học per-chiến-dịch ở đây — phần đó tải LƯỜI qua route
// /insights & /demographics khi user mở từng chiến dịch, để tránh nổ số lệnh API.
//
// BEST-EFFORT theo từng tài khoản: 1 tài khoản lỗi (thiếu quyền/…) -> đẩy vào warnings[]
// và bỏ qua, KHÔNG đánh sập cả cây. Chỉ getAdAccounts lỗi (thiếu ads_read) mới ném ra
// ngoài để route trả lý do rõ ràng.

const facebookService = require("./facebook.service");
const adsMath = require("../utils/ads-math");

async function buildPagesCampaignTree({ userAccessToken, pages }) {
  const warnings = [];
  const managedPages = (Array.isArray(pages) ? pages : []).map((p) => ({
    id: String(p.id),
    name: p.name || ""
  }));

  // Thiếu ads_read -> getAdAccounts ném (handleGraphError). Để route bắt & trả 502/400 rõ.
  const accounts = await facebookService.getAdAccounts(userAccessToken);

  const allCampaigns = [];
  const campaignPageMap = {};

  await Promise.all(
    accounts.map(async (account) => {
      try {
        const [campaigns, adsMap] = await Promise.all([
          facebookService.getCampaigns(account.id, userAccessToken),
          facebookService.getAdsPageMap(account.id, userAccessToken)
        ]);

        for (const campaign of campaigns) {
          allCampaigns.push({
            id: campaign.id,
            name: campaign.name,
            effectiveStatus: campaign.effectiveStatus || campaign.status || "",
            objective: campaign.objective || "",
            adAccountId: account.id,
            adAccountName: account.name || account.accountId || account.id
          });
        }
        Object.assign(campaignPageMap, adsMap.campaignPages || {});
      } catch (error) {
        warnings.push(
          `Không đọc được chiến dịch của tài khoản ${account.name || account.id}: ${
            error.publicMessage || error.message
          }`
        );
      }
    })
  );

  const tree = adsMath.buildPageCampaignTree({
    campaigns: allCampaigns,
    campaignPageMap,
    pages: managedPages
  });

  return {
    ...tree,
    accountCount: accounts.length,
    warnings,
    capturedAt: new Date().toISOString()
  };
}

module.exports = { buildPagesCampaignTree };
