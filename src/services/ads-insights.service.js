// Orchestrator báo cáo Ads Insights cho MỘT chiến dịch:
//   facebook.getCampaignInsights (Graph, thô)
//     -> ads-math dựng overview + daily
//     -> GHI snapshot + rows vào Postgres (best-effort, KHÔNG chặn nếu Postgres tắt)
//     -> trả payload đúng ENVELOPE adsInsights (source: "graph").
//
// Nguyên tắc: 1 nhánh phụ lỗi (vd ghi Postgres) -> đẩy vào warnings[], KHÔNG làm hỏng
// cả báo cáo. Chỉ lỗi mạng cứng của Graph (không phải quyền) mới ném ra ngoài.

const crypto = require("crypto");

const facebookService = require("./facebook.service");
const adsMath = require("../utils/ads-math");
const { getSql, isEnabled } = require("../db/postgres");

// Metric lưu ở hàng tổng hợp cả kỳ (row_date NULL). Khớp key trong overview.
const OVERVIEW_METRICS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "frequency",
  "results",
  "costPerResult"
];

// Metric lưu theo từng ngày (chuỗi thời gian). Chỉ 4 metric cộng-dồn-an-toàn.
const DAILY_METRICS = ["spend", "impressions", "reach", "clicks"];

// Key idempotency ỔN ĐỊNH: cùng (tài khoản, chiến dịch, khoảng, NGÀY CHỐT) -> cùng key.
// captureDay (YYYY-MM-DD) làm "ngày chốt": mỗi ngày tối đa 1 snapshot cho một bộ tham số
// -> chạy lại báo cáo trong ngày sẽ dedup, sang ngày mới tạo bản mới để giữ lịch sử.
function stableIdempotencyKey({ adAccountId, campaignId, datePreset, captureDay }) {
  return crypto
    .createHash("sha256")
    .update(`${adAccountId}|${campaignId}|${datePreset}|${captureDay}`)
    .digest("hex");
}

// Dựng các dòng metric để chèn hàng loạt vào ads_insights_rows.
function buildMetricRows(snapshotId, overview, daily) {
  const rows = [];

  for (const metric of OVERVIEW_METRICS) {
    rows.push({
      snapshot_id: snapshotId,
      row_date: null,
      breakdown_key: "total",
      breakdown_value: null,
      metric,
      value: Number(overview[metric]) || 0
    });
  }

  for (const point of daily) {
    for (const metric of DAILY_METRICS) {
      rows.push({
        snapshot_id: snapshotId,
        row_date: point.date,
        breakdown_key: "total",
        breakdown_value: null,
        metric,
        value: Number(point[metric]) || 0
      });
    }
  }

  return rows;
}

// Ghi snapshot + rows trong MỘT giao dịch. Idempotent theo idempotency_key.
// KHÔNG throw: Postgres tắt / lỗi ghi -> đẩy lý do vào warnings[] rồi trả về.
async function persistSnapshot({ payload, overview, daily, userId, capturedAt, warnings }) {
  if (!isEnabled()) {
    warnings.push("Postgres chưa cấu hình — chỉ hiển thị số liệu realtime, không lưu lịch sử.");
    return;
  }

  const sql = getSql();
  if (!sql) {
    warnings.push("Postgres chưa sẵn sàng — không lưu lịch sử số liệu quảng cáo.");
    return;
  }

  const dateStart = daily.length > 0 ? daily[0].date : null;
  const dateStop = daily.length > 0 ? daily[daily.length - 1].date : null;
  const captureDay = capturedAt.toISOString().slice(0, 10);
  const idempotencyKey = stableIdempotencyKey({
    adAccountId: payload.adAccountId,
    campaignId: payload.campaignId,
    datePreset: payload.datePreset,
    captureDay
  });

  try {
    const existing = await sql`
      SELECT id FROM ads_insights_snapshots
      WHERE idempotency_key = ${idempotencyKey} LIMIT 1
    `;
    if (existing.length > 0) {
      return; // đã lưu bản của ngày hôm nay -> bỏ qua (idempotent)
    }

    await sql.begin(async (tx) => {
      const [snapshot] = await tx`
        INSERT INTO ads_insights_snapshots
          (ad_account_id, level, object_id, date_preset, date_start, date_stop,
           currency, user_id, idempotency_key, captured_at)
        VALUES (${payload.adAccountId}, 'campaign', ${payload.campaignId}, ${payload.datePreset},
                ${dateStart}, ${dateStop}, ${payload.currency || null}, ${userId},
                ${idempotencyKey}, ${capturedAt})
        RETURNING id
      `;

      const metricRows = buildMetricRows(snapshot.id, overview, daily);
      if (metricRows.length > 0) {
        await tx`
          INSERT INTO ads_insights_rows ${tx(
            metricRows,
            "snapshot_id",
            "row_date",
            "breakdown_key",
            "breakdown_value",
            "metric",
            "value"
          )}
        `;
      }
    });
  } catch (error) {
    // Đua chèn cùng key -> unique violation (23505): bản khác đã lưu, coi như xong.
    if (error && error.code === "23505") {
      return;
    }
    console.warn("[Ads Insights] Không lưu được snapshot vào Postgres:", error.message);
    warnings.push("Lưu lịch sử số liệu quảng cáo thất bại (vẫn hiển thị số liệu realtime).");
  }
}

// Điểm vào: dựng báo cáo Ads Insights cho 1 chiến dịch theo ENVELOPE adsInsights.
async function buildCampaignInsights({
  campaignId,
  adAccountId,
  userAccessToken,
  userId = null,
  datePreset = "last_30d",
  timeRange = null
}) {
  const normalizedAccount = facebookService.normalizeAdAccountId(adAccountId);
  const warnings = [];
  const capturedAt = new Date();

  const insight = await facebookService.getCampaignInsights({
    campaignId,
    userAccessToken,
    datePreset,
    timeRange
  });

  // Lỗi quyền/vai trò -> báo cáo "không khả dụng" kèm lý do, KHÔNG ném.
  if (!insight.available) {
    return {
      available: false,
      campaignId,
      adAccountId: normalizedAccount,
      datePreset,
      currency: "",
      overview: adsMath.buildOverview([]),
      daily: [],
      warnings: insight.reason ? [insight.reason] : [],
      source: "graph",
      capturedAt: capturedAt.toISOString()
    };
  }

  const rows = Array.isArray(insight.rows) ? insight.rows : [];
  const overview = adsMath.buildOverview(rows);
  const daily = adsMath.buildDailySeries(rows);

  // Tiền tệ: best-effort (getAdAccountCurrency tự nuốt lỗi, trả "").
  const currency = await facebookService.getAdAccountCurrency(normalizedAccount, userAccessToken);

  const payload = {
    available: true,
    campaignId,
    adAccountId: normalizedAccount,
    datePreset,
    currency,
    overview,
    daily,
    warnings,
    source: "graph",
    capturedAt: capturedAt.toISOString()
  };

  // Ghi lịch sử (best-effort). warnings là cùng tham chiếu với payload.warnings,
  // nên mọi cảnh báo ghi-DB phát sinh ở đây vẫn xuất hiện trong payload trả về.
  await persistSnapshot({ payload, overview, daily, userId, capturedAt, warnings });

  return payload;
}

// --- Nhân khẩu học (Pha 2) --------------------------------------------------
//
// Orchestrator nhân khẩu học cho MỘT chiến dịch:
//   facebook.getCampaignBreakdowns (age,gender / country / region — best-effort từng chiều)
//     -> ads-math dựng phân khúc + tỷ trọng
//     -> GHI snapshot + rows breakdown vào Postgres (best-effort, KHÔNG chặn)
//     -> trả ENVELOPE adsDemographics (source: "graph").
//
// Snapshot nhân khẩu học DÙNG idempotency_key RIÊNG (tiền tố "demographics|") nên KHÔNG
// đụng snapshot insights cùng ngày/tham số. Rows dùng breakdown_key ∈ {age_gender,country,region}.

// Metric lưu cho mỗi phân khúc nhân khẩu học (đếm thô; share suy lại khi đọc).
const BREAKDOWN_METRICS = ["impressions", "reach", "clicks", "spend"];

// Key idempotency cho snapshot nhân khẩu học — tách hẳn khỏi snapshot insights.
function stableDemographicsKey({ adAccountId, campaignId, datePreset, captureDay }) {
  return crypto
    .createHash("sha256")
    .update(`demographics|${adAccountId}|${campaignId}|${datePreset}|${captureDay}`)
    .digest("hex");
}

// Dựng các dòng metric breakdown để chèn hàng loạt vào ads_insights_rows (row_date NULL
// vì đây là tổng hợp cả kỳ, không phải chuỗi theo ngày).
function buildDemographicRows(snapshotId, payload) {
  const rows = [];

  function pushSegment(breakdownKey, breakdownValue, seg) {
    for (const metric of BREAKDOWN_METRICS) {
      rows.push({
        snapshot_id: snapshotId,
        row_date: null,
        breakdown_key: breakdownKey,
        breakdown_value: breakdownValue,
        metric,
        value: Number(seg[metric]) || 0
      });
    }
  }

  if (payload.ageGender && payload.ageGender.available) {
    for (const seg of payload.ageGender.segments || []) {
      pushSegment("age_gender", `${seg.age}|${seg.gender}`, seg);
    }
  }
  for (const dim of ["country", "region"]) {
    if (payload[dim] && payload[dim].available) {
      for (const item of payload[dim].items || []) {
        pushSegment(dim, item.value, item);
      }
    }
  }

  return rows;
}

// Ghi snapshot nhân khẩu học + rows trong MỘT giao dịch. Idempotent theo key riêng.
// KHÔNG throw: Postgres tắt / lỗi ghi -> đẩy lý do vào warnings[] rồi trả về.
async function persistDemographics({ payload, userId, capturedAt, warnings }) {
  if (!isEnabled()) {
    warnings.push("Postgres chưa cấu hình — chỉ hiển thị nhân khẩu học realtime, không lưu lịch sử.");
    return;
  }

  const sql = getSql();
  if (!sql) {
    warnings.push("Postgres chưa sẵn sàng — không lưu lịch sử nhân khẩu học quảng cáo.");
    return;
  }

  const captureDay = capturedAt.toISOString().slice(0, 10);
  const idempotencyKey = stableDemographicsKey({
    adAccountId: payload.adAccountId,
    campaignId: payload.campaignId,
    datePreset: payload.datePreset,
    captureDay
  });

  try {
    const existing = await sql`
      SELECT id FROM ads_insights_snapshots
      WHERE idempotency_key = ${idempotencyKey} LIMIT 1
    `;
    if (existing.length > 0) {
      return; // đã lưu bản nhân khẩu học của hôm nay -> bỏ qua (idempotent)
    }

    await sql.begin(async (tx) => {
      const [snapshot] = await tx`
        INSERT INTO ads_insights_snapshots
          (ad_account_id, level, object_id, date_preset, date_start, date_stop,
           currency, user_id, idempotency_key, captured_at)
        VALUES (${payload.adAccountId}, 'campaign', ${payload.campaignId}, ${payload.datePreset},
                ${null}, ${null}, ${payload.currency || null}, ${userId},
                ${idempotencyKey}, ${capturedAt})
        RETURNING id
      `;

      const demographicRows = buildDemographicRows(snapshot.id, payload);
      if (demographicRows.length > 0) {
        await tx`
          INSERT INTO ads_insights_rows ${tx(
            demographicRows,
            "snapshot_id",
            "row_date",
            "breakdown_key",
            "breakdown_value",
            "metric",
            "value"
          )}
        `;
      }
    });
  } catch (error) {
    if (error && error.code === "23505") {
      return;
    }
    console.warn("[Ads Insights] Không lưu được nhân khẩu học vào Postgres:", error.message);
    warnings.push("Lưu lịch sử nhân khẩu học thất bại (vẫn hiển thị số liệu realtime).");
  }
}

// Gắn kết quả tính (ads-math) vào 1 chiều nếu Graph trả về được; nếu không giữ nguyên
// { available:false, reason } để frontend hiển thị lý do rõ ràng cho từng chiều.
function resolveDimension(dimension, builder) {
  if (dimension && dimension.available) {
    return { available: true, ...builder(dimension.rows) };
  }
  return { available: false, reason: (dimension && dimension.reason) || "Không có dữ liệu." };
}

// Điểm vào: dựng báo cáo NHÂN KHẨU HỌC cho 1 chiến dịch theo ENVELOPE adsDemographics.
async function buildCampaignDemographics({
  campaignId,
  adAccountId,
  userAccessToken,
  userId = null,
  datePreset = "last_30d",
  timeRange = null
}) {
  const normalizedAccount = facebookService.normalizeAdAccountId(adAccountId);
  const warnings = [];
  const capturedAt = new Date();

  const { dimensions } = await facebookService.getCampaignBreakdowns({
    campaignId,
    userAccessToken,
    datePreset,
    timeRange
  });

  const ageGender = resolveDimension(dimensions.ageGender, adsMath.buildAgeGenderBreakdown);
  const country = resolveDimension(dimensions.country, (rows) =>
    adsMath.buildCategoricalBreakdown(rows, "country", { topN: 10 })
  );
  const region = resolveDimension(dimensions.region, (rows) =>
    adsMath.buildCategoricalBreakdown(rows, "region", { topN: 10 })
  );

  // Tiền tệ: best-effort (để định dạng cột spend nếu UI cần).
  const currency = await facebookService.getAdAccountCurrency(normalizedAccount, userAccessToken);

  const payload = {
    campaignId,
    adAccountId: normalizedAccount,
    datePreset,
    currency,
    ageGender,
    country,
    region,
    warnings,
    source: "graph",
    capturedAt: capturedAt.toISOString()
  };

  await persistDemographics({ payload, userId, capturedAt, warnings });

  return payload;
}

module.exports = { buildCampaignInsights, buildCampaignDemographics };
