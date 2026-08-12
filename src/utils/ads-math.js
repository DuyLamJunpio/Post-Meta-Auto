// Lõi tính Ads Insights — hàm THUẦN (không I/O), deterministic, an toàn mảng rỗng.
// Tách riêng để kiểm chứng cách tính độc lập với việc gọi Graph / ghi Postgres.
//
// Đầu vào là mảng `rows` thô từ Graph (mỗi phần tử = 1 ngày do time_increment=1),
// mỗi row có dạng { spend, impressions, reach, clicks, actions, results, ... }.
//
// LƯU Ý VỀ reach: cộng reach theo ngày KHÔNG bằng reach thật cả kỳ (một người có
// thể được tiếp cận nhiều ngày -> tính trùng). Đây là xấp xỉ chấp nhận được vì
// nguồn dữ liệu duy nhất ở đây là chuỗi theo ngày; frequency/CPM suy ra cũng mang
// tính xấp xỉ tương ứng. Các metric cộng dồn "an toàn" là spend/impressions/clicks.

const { safeRatio } = require("./stats-math");

// Chuyển giá trị Graph (thường là chuỗi) về số hữu hạn; không parse được -> 0.
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Cộng một metric qua toàn bộ rows (mỗi row = 1 ngày). An toàn mảng rỗng.
function sumSeries(rows, metric) {
  if (!Array.isArray(rows)) {
    return 0;
  }
  return rows.reduce((total, row) => total + toNumber(row && row[metric]), 0);
}

// Thứ tự ưu tiên khi phải SUY "kết quả" từ actions (objective cũ trả results rỗng).
// Ưu tiên hành động có giá trị chuyển đổi cao nhất trước (mua > lead > click).
const RESULT_ACTION_PRIORITY = [
  "offsite_conversion.fb_pixel_purchase",
  "onsite_conversion.purchase",
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_lead",
  "onsite_conversion.lead_grouped",
  "lead",
  "link_click",
  "landing_page_view",
  "post_engagement",
  "page_engagement"
];

// Đọc giá trị đầu tiên từ field results/cost_per_result của Graph.
// Dạng thường gặp: [{ indicator, values: [{ value }] }]. Có version trả thẳng { value }.
function readIndicatorValue(field) {
  if (!Array.isArray(field) || field.length === 0) {
    return null;
  }
  const first = field[0];
  if (!first || typeof first !== "object") {
    return null;
  }
  if (Array.isArray(first.values) && first.values.length > 0) {
    const point = first.values[0];
    return point && point.value != null ? toNumber(point.value) : 0;
  }
  if (first.value != null) {
    return toNumber(first.value);
  }
  return null;
}

// Đọc value của 1 action_type trong mảng actions/cost_per_action_type. Không có -> null.
function readActionValue(actions, actionType) {
  if (!Array.isArray(actions)) {
    return null;
  }
  const found = actions.find((action) => action && action.action_type === actionType);
  return found && found.value != null ? toNumber(found.value) : null;
}

// "Kết quả" của MỘT ngày: ưu tiên field results/cost_per_result; nếu rỗng thì suy từ
// actions theo thứ tự ưu tiên (cost suy từ cost_per_action_type, hoặc spend/results).
// Trả { results, costPerResult } — luôn là số, không NaN.
function pickResults(row) {
  if (!row || typeof row !== "object") {
    return { results: 0, costPerResult: 0 };
  }

  const directResults = readIndicatorValue(row.results);
  if (directResults != null) {
    const directCost = readIndicatorValue(row.cost_per_result);
    return {
      results: directResults,
      costPerResult: directCost != null ? directCost : safeRatio(toNumber(row.spend), directResults)
    };
  }

  for (const actionType of RESULT_ACTION_PRIORITY) {
    const value = readActionValue(row.actions, actionType);
    if (value != null && value > 0) {
      const cost = readActionValue(row.cost_per_action_type, actionType);
      return {
        results: value,
        costPerResult: cost != null ? cost : safeRatio(toNumber(row.spend), value)
      };
    }
  }

  return { results: 0, costPerResult: 0 };
}

// Tổng "kết quả" cả kỳ = cộng dồn kết quả từng ngày.
function sumResults(rows) {
  if (!Array.isArray(rows)) {
    return 0;
  }
  return rows.reduce((total, row) => total + pickResults(row).results, 0);
}

// Bảng tổng hợp cả kỳ. Các TỶ LỆ được tính lại từ TỔNG (ctr/cpc/cpm/frequency/costPerResult)
// — KHÔNG lấy trung bình cộng của tỷ lệ theo ngày (sai về mặt thống kê khi ngày lệch quy mô).
function buildOverview(rows) {
  const list = Array.isArray(rows) ? rows : [];

  const spend = sumSeries(list, "spend");
  const impressions = sumSeries(list, "impressions");
  const reach = sumSeries(list, "reach");
  const clicks = sumSeries(list, "clicks");
  const results = sumResults(list);

  return {
    spend,
    impressions,
    reach,
    clicks,
    ctr: safeRatio(clicks, impressions) * 100, // phần trăm
    cpc: safeRatio(spend, clicks),
    cpm: safeRatio(spend, impressions) * 1000,
    frequency: safeRatio(impressions, reach),
    results,
    costPerResult: safeRatio(spend, results)
  };
}

// Chuỗi theo ngày để vẽ biểu đồ. Chỉ giữ 4 metric cộng-dồn-an-toàn, sắp tăng theo ngày.
function buildDailySeries(rows) {
  const list = Array.isArray(rows) ? rows : [];

  return list
    .map((row) => ({
      date: (row && (row.date_start || row.date_stop)) || null,
      spend: toNumber(row && row.spend),
      impressions: toNumber(row && row.impressions),
      reach: toNumber(row && row.reach),
      clicks: toNumber(row && row.clicks)
    }))
    .filter((point) => point.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// --- Nhân khẩu học (breakdowns) --------------------------------------------
//
// LƯU Ý QUAN TRỌNG VỀ ĐƠN VỊ: rows breakdown từ Ads Insights mang GIÁ TRỊ ĐẾM THÔ
// (impressions/reach/clicks/spend) cho từng phân khúc — KHÔNG phải phần trăm. Vì vậy
// ở đây ta CHIA (segment / tổng) để ra tỷ trọng `share`. Đây là NGƯỢC với dữ liệu nhân
// khẩu học của công cụ cào (đã lưu sẵn dạng %, tuyệt đối KHÔNG được chia lại). Đừng lẫn
// hai nguồn: nguồn cào = % có sẵn; nguồn Ads Insights = đếm thô, phải tự tính tỷ trọng.
//
// `share` xuất ra ở dạng PHẦN TRĂM (0..100) để khớp cách overview.ctr biểu diễn %.

// Thứ tự nhóm tuổi Facebook (giá trị lạ xếp cuối). "unknown" khi Graph không xác định.
const AGE_ORDER = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];
// Thứ tự giới tính hiển thị; giá trị lạ xếp cuối.
const GENDER_ORDER = ["female", "male", "unknown"];

function orderIndex(order, value) {
  const idx = order.indexOf(value);
  return idx === -1 ? order.length : idx;
}

// Cộng dồn 4 metric của 1 phân khúc vào accumulator (immutable-friendly: trả bản mới).
function accumulateSegment(acc, row) {
  return {
    impressions: acc.impressions + toNumber(row && row.impressions),
    reach: acc.reach + toNumber(row && row.reach),
    clicks: acc.clicks + toNumber(row && row.clicks),
    spend: acc.spend + toNumber(row && row.spend)
  };
}

// Nhân khẩu học theo TUỔI × GIỚI TÍNH.
// rows: [{ age, gender, impressions, reach, clicks, spend }] (breakdowns=age,gender).
// Trả:
//   ages:    danh sách nhóm tuổi có mặt, sắp theo AGE_ORDER
//   genders: danh sách giới tính có mặt, sắp theo GENDER_ORDER
//   segments:[{ age, gender, impressions, reach, clicks, spend, share }]  (share = % theo impressions)
//   totalImpressions
function buildAgeGenderBreakdown(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const map = new Map();
  const ageSet = new Set();
  const genderSet = new Set();
  let totalImpressions = 0;

  for (const row of list) {
    const age = (row && row.age) || "unknown";
    const gender = (row && row.gender) || "unknown";
    ageSet.add(age);
    genderSet.add(gender);

    const key = `${age}|${gender}`;
    const prev = map.get(key) || { age, gender, impressions: 0, reach: 0, clicks: 0, spend: 0 };
    map.set(key, { age, gender, ...accumulateSegment(prev, row) });
    totalImpressions += toNumber(row && row.impressions);
  }

  const ages = [...ageSet].sort(
    (a, b) => orderIndex(AGE_ORDER, a) - orderIndex(AGE_ORDER, b) || (a < b ? -1 : a > b ? 1 : 0)
  );
  const genders = [...genderSet].sort(
    (a, b) => orderIndex(GENDER_ORDER, a) - orderIndex(GENDER_ORDER, b) || (a < b ? -1 : a > b ? 1 : 0)
  );
  const segments = [...map.values()].map((seg) => ({
    ...seg,
    share: safeRatio(seg.impressions, totalImpressions) * 100
  }));

  return { ages, genders, segments, totalImpressions };
}

// Nhân khẩu học theo MỘT chiều phân loại (country | region).
// rows: [{ [field], impressions, reach, clicks, spend }]. Gộp theo giá trị field, sắp giảm
// dần theo impressions, lấy topN. `share` tính trên TỔNG toàn bộ (không chỉ topN).
function buildCategoricalBreakdown(rows, field, options) {
  const topN = (options && options.topN) || 10;
  const list = Array.isArray(rows) ? rows : [];
  const map = new Map();
  let totalImpressions = 0;

  for (const row of list) {
    const value = (row && row[field]) || "unknown";
    const prev = map.get(value) || { value, impressions: 0, reach: 0, clicks: 0, spend: 0 };
    map.set(value, { value, ...accumulateSegment(prev, row) });
    totalImpressions += toNumber(row && row.impressions);
  }

  const sorted = [...map.values()].sort((a, b) => b.impressions - a.impressions);
  const items = sorted.slice(0, topN).map((it) => ({
    ...it,
    share: safeRatio(it.impressions, totalImpressions) * 100
  }));
  const otherImpressions = sorted.slice(topN).reduce((sum, it) => sum + it.impressions, 0);

  return { items, totalImpressions, otherImpressions, totalCount: sorted.length };
}

// --- Cây Page -> chiến dịch (thiết kế trục Page) ----------------------------
//
// Phân loại effective_status của Marketing API về 3 nhóm THÔ cho UI:
//   active  = đang chạy (ACTIVE)
//   paused  = tạm dừng / chờ (PAUSED, CAMPAIGN_PAUSED, PENDING_REVIEW, IN_PROCESS...)
//   stopped = đã dừng hẳn / lưu trữ / bị từ chối / rỗng (ARCHIVED, DELETED, DISAPPROVED...)
const PAUSED_STATUSES = new Set([
  "PAUSED",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "PENDING_REVIEW",
  "IN_PROCESS",
  "PENDING_BILLING_INFO",
  "PREAPPROVED"
]);

function classifyRunState(effectiveStatus) {
  const s = String(effectiveStatus || "").toUpperCase();
  if (s === "ACTIVE") {
    return "active";
  }
  if (PAUSED_STATUSES.has(s)) {
    return "paused";
  }
  return "stopped";
}

// Gom chiến dịch theo Page. THUẦN (không I/O).
//   campaigns:       [{ id, name, effectiveStatus, adAccountId, adAccountName, ... }]
//   campaignPageMap: { [campaignId]: pageId }  (thiếu -> "Chưa xác định Page")
//   pages:           [{ id, name }] Page user quản lý (đã lọc ẩn) — tạo nhóm sẵn dù rỗng.
// Trả { groups:[{ pageId, pageName, managed, campaigns:[...+runState], counts }], totalCampaigns }.
// Sắp xếp: Page quản lý trước (nhiều chiến dịch hơn lên trước), rồi Page ngoài, "Chưa xác định" cuối.
function buildPageCampaignTree({ campaigns, campaignPageMap, pages } = {}) {
  const campaignList = Array.isArray(campaigns) ? campaigns : [];
  const pageList = Array.isArray(pages) ? pages : [];
  const pageMap = campaignPageMap || {};
  const UNDETERMINED = "__undetermined__";

  const managedName = new Map(pageList.map((p) => [String(p.id), p.name || `Page ${p.id}`]));
  const groups = new Map();

  function ensureGroup(key, name, managed) {
    if (!groups.has(key)) {
      groups.set(key, {
        pageId: key === UNDETERMINED ? null : key,
        pageName: name,
        managed,
        campaigns: [],
        counts: { active: 0, paused: 0, stopped: 0 }
      });
    }
    return groups.get(key);
  }

  // Tạo sẵn nhóm cho mọi Page quản lý -> Page chưa có chiến dịch vẫn hiển thị.
  for (const p of pageList) {
    ensureGroup(String(p.id), p.name || `Page ${p.id}`, true);
  }

  for (const campaign of campaignList) {
    const rawPageId = pageMap[campaign.id];
    const pageId = rawPageId != null && rawPageId !== "" ? String(rawPageId) : null;

    let group;
    if (!pageId) {
      group = ensureGroup(UNDETERMINED, "Chưa xác định Page", false);
    } else if (managedName.has(pageId)) {
      group = ensureGroup(pageId, managedName.get(pageId), true);
    } else {
      group = ensureGroup(pageId, `Page ${pageId}`, false);
    }

    const runState = classifyRunState(campaign.effectiveStatus);
    group.campaigns.push({ ...campaign, runState });
    group.counts[runState] += 1;
  }

  const groupsArr = [...groups.values()].sort((a, b) => {
    const aUndet = a.pageId === null;
    const bUndet = b.pageId === null;
    if (aUndet !== bUndet) {
      return aUndet ? 1 : -1; // "Chưa xác định" xuống cuối
    }
    if (a.managed !== b.managed) {
      return a.managed ? -1 : 1; // Page quản lý lên trước
    }
    if (b.campaigns.length !== a.campaigns.length) {
      return b.campaigns.length - a.campaigns.length; // nhiều chiến dịch hơn lên trước
    }
    return String(a.pageName).localeCompare(String(b.pageName), "vi");
  });

  return { groups: groupsArr, totalCampaigns: campaignList.length };
}

module.exports = {
  toNumber,
  sumSeries,
  readIndicatorValue,
  readActionValue,
  pickResults,
  sumResults,
  buildOverview,
  buildDailySeries,
  buildAgeGenderBreakdown,
  buildCategoricalBreakdown,
  classifyRunState,
  buildPageCampaignTree
};

// --- Tự kiểm nhỏ khi chạy trực tiếp: `node src/utils/ads-math.js` -----------
if (require.main === module) {
  const assert = require("node:assert");

  // Mảng rỗng -> mọi số 0, không NaN.
  const empty = buildOverview([]);
  for (const key of Object.keys(empty)) {
    assert.strictEqual(empty[key], 0, `overview rỗng: ${key} phải = 0`);
  }
  assert.deepStrictEqual(buildDailySeries([]), []);

  // Hai ngày cơ bản: kiểm tổng + tỷ lệ tính lại từ tổng.
  const rows = [
    {
      date_start: "2026-01-02",
      spend: "10",
      impressions: "1000",
      reach: "800",
      clicks: "50",
      actions: [{ action_type: "link_click", value: "40" }],
      cost_per_action_type: [{ action_type: "link_click", value: "0.25" }]
    },
    {
      date_start: "2026-01-01",
      spend: "30",
      impressions: "1000",
      reach: "900",
      clicks: "50",
      results: [{ indicator: "actions:purchase", values: [{ value: "5" }] }],
      cost_per_result: [{ indicator: "actions:purchase", values: [{ value: "6" }] }]
    }
  ];

  const overview = buildOverview(rows);
  assert.strictEqual(overview.spend, 40);
  assert.strictEqual(overview.impressions, 2000);
  assert.strictEqual(overview.clicks, 100);
  assert.strictEqual(overview.reach, 1700);
  // results = 40 (từ actions ngày 1) + 5 (từ results ngày 2) = 45
  assert.strictEqual(overview.results, 45);
  // ctr = 100/2000*100 = 5 ; cpc = 40/100 = 0.4 ; cpm = 40/2000*1000 = 20
  assert.strictEqual(overview.ctr, 5);
  assert.strictEqual(overview.cpc, 0.4);
  assert.strictEqual(overview.cpm, 20);
  // costPerResult = 40/45
  assert.ok(Math.abs(overview.costPerResult - 40 / 45) < 1e-9);

  // buildDailySeries sắp theo ngày tăng dần.
  const daily = buildDailySeries(rows);
  assert.strictEqual(daily.length, 2);
  assert.strictEqual(daily[0].date, "2026-01-01");
  assert.strictEqual(daily[1].date, "2026-01-02");

  // pickResults suy từ actions khi không có field results.
  assert.deepStrictEqual(pickResults(rows[0]), { results: 40, costPerResult: 0.25 });
  // pickResults đọc thẳng field results khi có.
  assert.deepStrictEqual(pickResults(rows[1]), { results: 5, costPerResult: 6 });
  // pickResults an toàn với đầu vào rác.
  assert.deepStrictEqual(pickResults(null), { results: 0, costPerResult: 0 });

  // --- Nhân khẩu học: tuổi × giới tính ---
  const agEmpty = buildAgeGenderBreakdown([]);
  assert.deepStrictEqual(agEmpty, { ages: [], genders: [], segments: [], totalImpressions: 0 });

  const agRows = [
    { age: "25-34", gender: "female", impressions: "600", reach: "500", clicks: "30", spend: "6" },
    { age: "25-34", gender: "male", impressions: "300", reach: "250", clicks: "10", spend: "3" },
    { age: "18-24", gender: "female", impressions: "100", reach: "90", clicks: "5", spend: "1" }
  ];
  const ag = buildAgeGenderBreakdown(agRows);
  // ages sắp theo AGE_ORDER: 18-24 trước 25-34
  assert.deepStrictEqual(ag.ages, ["18-24", "25-34"]);
  // genders sắp theo GENDER_ORDER: female trước male
  assert.deepStrictEqual(ag.genders, ["female", "male"]);
  assert.strictEqual(ag.totalImpressions, 1000);
  const seg2534f = ag.segments.find((s) => s.age === "25-34" && s.gender === "female");
  assert.strictEqual(seg2534f.impressions, 600);
  assert.strictEqual(seg2534f.reach, 500);
  // share = 600/1000*100 = 60
  assert.strictEqual(seg2534f.share, 60);

  // --- Nhân khẩu học: chiều phân loại (country) + topN + share theo TỔNG ---
  const countryRows = [
    { country: "VN", impressions: "700", reach: "600", clicks: "40", spend: "7" },
    { country: "US", impressions: "200", reach: "180", clicks: "10", spend: "2" },
    { country: "JP", impressions: "100", reach: "90", clicks: "5", spend: "1" }
  ];
  const topCountry = buildCategoricalBreakdown(countryRows, "country", { topN: 2 });
  assert.strictEqual(topCountry.totalCount, 3);
  assert.strictEqual(topCountry.items.length, 2);
  assert.strictEqual(topCountry.items[0].value, "VN");
  assert.strictEqual(topCountry.items[0].share, 70); // 700/1000*100
  // otherImpressions = phần ngoài topN = JP (100)
  assert.strictEqual(topCountry.otherImpressions, 100);
  // rỗng -> an toàn
  assert.deepStrictEqual(buildCategoricalBreakdown([], "country", { topN: 5 }), {
    items: [],
    totalImpressions: 0,
    otherImpressions: 0,
    totalCount: 0
  });

  // --- Cây Page -> chiến dịch ---
  assert.strictEqual(classifyRunState("ACTIVE"), "active");
  assert.strictEqual(classifyRunState("PAUSED"), "paused");
  assert.strictEqual(classifyRunState("CAMPAIGN_PAUSED"), "paused");
  assert.strictEqual(classifyRunState("ARCHIVED"), "stopped");
  assert.strictEqual(classifyRunState(""), "stopped");

  const tree = buildPageCampaignTree({
    campaigns: [
      { id: "c1", name: "CD1", effectiveStatus: "ACTIVE", adAccountId: "act_1", adAccountName: "A1" },
      { id: "c2", name: "CD2", effectiveStatus: "PAUSED", adAccountId: "act_1", adAccountName: "A1" },
      { id: "c3", name: "CD3", effectiveStatus: "ARCHIVED", adAccountId: "act_2", adAccountName: "A2" },
      { id: "c4", name: "CD4", effectiveStatus: "ACTIVE", adAccountId: "act_2", adAccountName: "A2" }
    ],
    campaignPageMap: { c1: "111", c2: "111", c3: "222", c4: null },
    pages: [
      { id: "111", name: "Trang Một" },
      { id: "333", name: "Trang Ba rỗng" }
    ]
  });
  assert.strictEqual(tree.totalCampaigns, 4);
  const g111 = tree.groups.find((g) => g.pageId === "111");
  assert.strictEqual(g111.pageName, "Trang Một");
  assert.strictEqual(g111.managed, true);
  assert.strictEqual(g111.campaigns.length, 2);
  assert.deepStrictEqual(g111.counts, { active: 1, paused: 1, stopped: 0 });
  const g222 = tree.groups.find((g) => g.pageId === "222");
  assert.strictEqual(g222.managed, false); // Page ngoài danh sách quản lý
  assert.strictEqual(g222.pageName, "Page 222");
  assert.strictEqual(g222.counts.stopped, 1);
  // Page quản lý rỗng vẫn hiển thị
  assert.ok(tree.groups.some((g) => g.pageId === "333" && g.campaigns.length === 0));
  // "Chưa xác định Page" (c4) xếp CUỐI
  const last = tree.groups[tree.groups.length - 1];
  assert.strictEqual(last.pageId, null);
  assert.strictEqual(last.campaigns.length, 1);
  assert.strictEqual(last.campaigns[0].id, "c4");
  assert.strictEqual(last.campaigns[0].runState, "active");
  // rỗng an toàn
  assert.deepStrictEqual(buildPageCampaignTree({}), { groups: [], totalCampaigns: 0 });

  console.log("[ads-math] self-check PASS");
}
