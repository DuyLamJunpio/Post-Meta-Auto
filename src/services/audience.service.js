// Phân tích ĐỐI TƯỢNG KHÁCH HÀNG (audience) theo Page/IG: chuẩn hóa nhân khẩu học từ Meta
// thành top-N + %, dịch nhãn (giới tính/quốc gia), và sinh "tệp khách hàng" (segment) mô tả.
// Fetch nằm ở facebook.service; ở đây chỉ TÍNH (dễ kiểm chứng, tách khỏi I/O).

const facebookService = require("./facebook.service");
const crawledAudienceService = require("./crawled-audience.service");
const stats = require("../utils/stats-math");

const GENDER_LABELS = { F: "Nữ", M: "Nam", U: "Không xác định" };

// Bản đồ mã quốc gia phổ biến (đủ dùng cho thị trường VN + khu vực). Mã lạ giữ nguyên.
const COUNTRY_NAMES = {
  VN: "Việt Nam",
  US: "Hoa Kỳ",
  TH: "Thái Lan",
  KR: "Hàn Quốc",
  JP: "Nhật Bản",
  CN: "Trung Quốc",
  TW: "Đài Loan",
  SG: "Singapore",
  MY: "Malaysia",
  ID: "Indonesia",
  PH: "Philippines",
  KH: "Campuchia",
  LA: "Lào",
  AU: "Úc",
  GB: "Anh",
  FR: "Pháp",
  DE: "Đức",
  CA: "Canada",
  IN: "Ấn Độ"
};

function countryName(code) {
  const key = String(code || "").toUpperCase();
  return COUNTRY_NAMES[key] || code || "Không rõ";
}

function genderLabel(code) {
  return GENDER_LABELS[String(code || "").toUpperCase()] || code || "Không rõ";
}

// Chuẩn hóa 1 breakdown [{label,value}] -> sắp giảm dần + thêm % trên tổng, cắt top-N.
//
// alreadyPercent: dữ liệu ĐÃ LÀ PHẦN TRĂM, đừng chia lại theo tổng.
//   Graph API trả SỐ NGƯỜI (tuyệt đối) -> phải chia để ra %.
//   Công cụ cào Business Suite trả sẵn % -> chia lần nữa là sai.
//
//   Vì sao không chia lại được? Meta cho tổng theo quốc gia VƯỢT 100%
//   (thực đo: Việt Nam 106.2%, tổng ~112%) do một người có thể được tính vào
//   nhiều quốc gia. Chia lại sẽ ra 106.2 / 112 * 100 = 94.8% — lệch hẳn so với
//   con số hiển thị trên chính giao diện Meta, và không có gì báo là đã sai.
function normalizeBreakdown(items, { limit = 0, relabel, alreadyPercent = false } = {}) {
  const list = (items || [])
    .map((item) => ({ label: relabel ? relabel(item.label) : item.label, value: Number(item.value) || 0 }))
    .filter((item) => item.value > 0);

  const total = stats.sum(list.map((item) => item.value));
  const sorted = list
    .map((item) => ({
      ...item,
      percent: alreadyPercent ? item.value : total === 0 ? 0 : (item.value / total) * 100
    }))
    .sort((a, b) => b.value - a.value);

  return {
    total,
    items: limit > 0 ? sorted.slice(0, limit) : sorted
  };
}

// Sắp nhóm tuổi theo thứ tự tự nhiên (13-17, 18-24, ...) thay vì theo giá trị.
const AGE_ORDER = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];

function sortAgeBuckets(items) {
  return [...(items || [])].sort((a, b) => {
    const ia = AGE_ORDER.indexOf(a.label);
    const ib = AGE_ORDER.indexOf(b.label);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}

function topOf(normalized) {
  return normalized.items.length > 0 ? normalized.items[0] : null;
}

// Sinh 2-3 "tệp khách hàng" mô tả (rule-based) từ nhân khẩu học đã chuẩn hóa.
function buildSegments({ age, gender, city, country }) {
  const segments = [];
  const topAge = topOf(age);
  const topGender = topOf(gender);
  const topCity = topOf(city);
  const topCountry = topOf(country);

  if (topGender && topAge) {
    const place = topCountry ? ` tại ${topCountry.label}` : "";
    segments.push(
      `Nhóm chính: ${topGender.label} ${topAge.label} tuổi${place} — chiếm ${Math.round(topAge.percent)}% độ tuổi, ` +
        `${Math.round(topGender.percent)}% giới tính.`
    );
  }

  if (topCity) {
    segments.push(`Tập trung địa lý: ${topCity.label} (${Math.round(topCity.percent)}% người theo dõi có địa điểm).`);
  }

  // Nhóm phụ (độ tuổi kế tiếp) nếu có.
  if (age.items.length > 1) {
    const second = age.items[1];
    segments.push(`Nhóm phụ đáng chú ý: ${second.label} tuổi (${Math.round(second.percent)}%).`);
  }

  return segments;
}

// IG: dựng section nhân khẩu học đầy đủ từ dữ liệu thô của facebook.service.
function buildInstagramAudience(raw) {
  if (!raw || !raw.available) {
    return { available: false, reason: raw ? raw.reason : "Không có dữ liệu." };
  }

  const b = raw.breakdowns || {};
  const age = normalizeBreakdown(b.age);
  age.items = sortAgeBuckets(age.items);
  const gender = normalizeBreakdown(b.gender, { relabel: genderLabel });
  const city = normalizeBreakdown(b.city, { limit: 8 });
  const country = normalizeBreakdown(b.country, { limit: 8, relabel: countryName });

  // segments dùng age SẮP GIẢM DẦN để lấy nhóm trội (không phải thứ tự tuổi tự nhiên).
  const ageByValue = normalizeBreakdown(b.age);

  return {
    available: true,
    age,
    gender,
    city,
    country,
    summary: {
      topAge: topOf(ageByValue),
      topGender: topOf(gender),
      topCity: topOf(city),
      topCountry: topOf(country)
    },
    segments: buildSegments({ age: ageByValue, gender, city, country })
  };
}

// FB: tách "M.25-34" -> giới tính + tuổi; probe country/city nếu Meta còn trả.
function buildFacebookAudience(raw) {
  if (!raw || !raw.available) {
    return { available: false, reason: raw ? raw.reason : "Không có dữ liệu." };
  }

  const b = raw.breakdowns || {};

  // Nguồn cào Business Suite trả sẵn PHẦN TRĂM; Graph API trả SỐ NGƯỜI.
  // Cờ này đi theo dữ liệu (do nguồn tự khai) thay vì do nơi gọi truyền vào —
  // dữ liệu tự mô tả đơn vị của nó thì không ai phải nhớ truyền đúng cờ.
  const pct = Boolean(raw.alreadyPercent);

  // page_fans_gender_age: nhãn dạng "M.25-34" / "F.18-24" / "U.65+".
  // Nguồn cào cũng dùng đúng định dạng này nên đoạn tách nhãn dưới đây dùng
  // chung cho cả hai nguồn, không phải viết hai lần.
  const genderAgeItems = b.genderAge || [];
  const ageAgg = new Map();
  const genderAgg = new Map();
  for (const item of genderAgeItems) {
    const [genderCode, ageBucket] = String(item.label).split(".");
    if (ageBucket) ageAgg.set(ageBucket, (ageAgg.get(ageBucket) || 0) + item.value);
    if (genderCode) genderAgg.set(genderLabel(genderCode), (genderAgg.get(genderLabel(genderCode)) || 0) + item.value);
  }

  // Cộng dồn tuổi×giới thành hai chiều riêng: với dữ liệu phần trăm, tổng của
  // "nữ 25-34" + "nam 25-34" chính là phần trăm của nhóm tuổi 25-34. Đúng cả
  // với số tuyệt đối lẫn phần trăm, nên không cần tách nhánh.
  const ageItems = Array.from(ageAgg, ([label, value]) => ({ label, value }));

  const age = normalizeBreakdown(ageItems, { alreadyPercent: pct });
  age.items = sortAgeBuckets(age.items);
  const gender = normalizeBreakdown(
    Array.from(genderAgg, ([label, value]) => ({ label, value })),
    { alreadyPercent: pct }
  );
  const country = normalizeBreakdown(b.country, {
    limit: 8, relabel: countryName, alreadyPercent: pct
  });
  const city = normalizeBreakdown(b.city, { limit: 8, alreadyPercent: pct });

  const ageByValue = normalizeBreakdown(ageItems, { alreadyPercent: pct });

  return {
    available: true,
    // Cho giao diện biết số liệu này từ đâu và chụp lúc nào. Quan trọng với
    // nguồn cào: dữ liệu chỉ mới bằng lần chạy gần nhất trên máy, không phải
    // thời gian thực như gọi API. Không hiện ra thì người xem dễ tưởng là
    // số liệu hôm nay trong khi có khi đã một tuần.
    source: raw.source || "graph_api",
    capturedAt: raw.capturedAt || null,
    age,
    gender,
    city,
    country,
    summary: {
      topAge: topOf(ageByValue),
      topGender: topOf(gender),
      topCity: topOf(city),
      topCountry: topOf(country)
    },
    segments: buildSegments({ age: ageByValue, gender, city, country })
  };
}

// Điểm vào: gọi cả IG (thật) + FB (probe), trả payload + cảnh báo. Không để nhánh nào lỗi làm hỏng cả.
async function buildPageAudience({ page, userId = null }) {
  const warnings = [];
  let instagram = { available: false, reason: "Page chưa liên kết Instagram Business." };
  let facebook = { available: false, reason: "Chưa truy vấn." };

  const igAccount = page.instagramBusinessAccount;

  const [fbResult, igResult] = await Promise.allSettled([
    facebookService.getPageAudience({ pageId: page.id, pageAccessToken: page.pageAccessToken }),
    igAccount && igAccount.id
      ? facebookService.getInstagramAudience({ instagramUserId: igAccount.id, pageAccessToken: page.pageAccessToken })
      : Promise.resolve(null)
  ]);

  if (fbResult.status === "fulfilled") {
    facebook = buildFacebookAudience(fbResult.value);
  } else {
    facebook = { available: false, reason: fbResult.reason.publicMessage || fbResult.reason.message };
  }

  // NGUỒN DỰ PHÒNG: Graph API không ra dữ liệu -> dùng số liệu đã cào.
  //
  // Vì sao đặt ở đây mà không thay thẳng Graph API? Vì hai nguồn có điểm mạnh
  // khác nhau: Graph API là thời gian thực, còn nguồn cào chỉ mới bằng lần
  // chạy gần nhất. Ưu tiên Graph API, chỉ lùi về nguồn cào khi nó không ra —
  // như vậy nếu mai này Meta mở lại metric thì tự động dùng lại, không phải
  // sửa code.
  if (!facebook.available) {
    const lyDoGraphApi = facebook.reason;
    // `await`: kho số liệu cào nằm trên Postgres (Supabase) chứ không phải
    // SQLite cùng máy, nên đây là một lượt đi mạng chứ không đọc đĩa tức thì.
    const daCao = await crawledAudienceService.getCrawledAudience(page.id, userId);

    if (daCao.available) {
      facebook = buildFacebookAudience(daCao);
      warnings.push(
        `Facebook: Graph API không trả dữ liệu (${lyDoGraphApi}) — đang dùng số liệu cào lúc ${daCao.capturedAt}.`
      );
    } else {
      // Cả hai nguồn đều không có -> nói rõ CẢ HAI lý do. Chỉ báo một lý do
      // thì người đọc sẽ đi sửa nhầm chỗ.
      facebook = {
        available: false,
        reason: `${lyDoGraphApi} | Dữ liệu cào: ${daCao.reason}`
      };
    }
  }

  if (!facebook.available && facebook.reason) {
    warnings.push(`Facebook: ${facebook.reason}`);
  }

  if (igAccount && igAccount.id) {
    if (igResult.status === "fulfilled") {
      instagram = buildInstagramAudience(igResult.value);
    } else {
      instagram = { available: false, reason: igResult.reason.publicMessage || igResult.reason.message };
    }
    if (!instagram.available && instagram.reason) {
      warnings.push(`Instagram: ${instagram.reason}`);
    }
  }

  return {
    page: { id: page.id, name: page.name, hasInstagram: Boolean(igAccount && igAccount.id) },
    facebook,
    instagram,
    warnings
  };
}

module.exports = {
  buildPageAudience,
  // Xuất phụ để test độc lập cách chuẩn hóa/sinh segment.
  normalizeBreakdown,
  buildInstagramAudience,
  buildFacebookAudience,
  buildSegments,
  countryName,
  genderLabel
};
