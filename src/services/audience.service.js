// Phân tích ĐỐI TƯỢNG KHÁCH HÀNG (audience) theo Page/IG: chuẩn hóa nhân khẩu học từ Meta
// thành top-N + %, dịch nhãn (giới tính/quốc gia), và sinh "tệp khách hàng" (segment) mô tả.
// Fetch nằm ở facebook.service; ở đây chỉ TÍNH (dễ kiểm chứng, tách khỏi I/O).

const facebookService = require("./facebook.service");
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
function normalizeBreakdown(items, { limit = 0, relabel } = {}) {
  const list = (items || [])
    .map((item) => ({ label: relabel ? relabel(item.label) : item.label, value: Number(item.value) || 0 }))
    .filter((item) => item.value > 0);

  const total = stats.sum(list.map((item) => item.value));
  const sorted = list
    .map((item) => ({ ...item, percent: total === 0 ? 0 : (item.value / total) * 100 }))
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

  // page_fans_gender_age: nhãn dạng "M.25-34" / "F.18-24" / "U.65+".
  const genderAgeItems = b.genderAge || [];
  const ageAgg = new Map();
  const genderAgg = new Map();
  for (const item of genderAgeItems) {
    const [genderCode, ageBucket] = String(item.label).split(".");
    if (ageBucket) ageAgg.set(ageBucket, (ageAgg.get(ageBucket) || 0) + item.value);
    if (genderCode) genderAgg.set(genderLabel(genderCode), (genderAgg.get(genderLabel(genderCode)) || 0) + item.value);
  }

  const age = normalizeBreakdown(Array.from(ageAgg, ([label, value]) => ({ label, value })));
  age.items = sortAgeBuckets(age.items);
  const gender = normalizeBreakdown(Array.from(genderAgg, ([label, value]) => ({ label, value })));
  const country = normalizeBreakdown(b.country, { limit: 8, relabel: countryName });
  const city = normalizeBreakdown(b.city, { limit: 8 });

  const ageByValue = normalizeBreakdown(Array.from(ageAgg, ([label, value]) => ({ label, value })));

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

// Điểm vào: gọi cả IG (thật) + FB (probe), trả payload + cảnh báo. Không để nhánh nào lỗi làm hỏng cả.
async function buildPageAudience({ page }) {
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
