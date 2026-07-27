// Lõi thống kê thuần (không phụ thuộc I/O) dùng cho trang Thống kê.
// Mọi hàm ở đây là hàm thuần, deterministic, an toàn với mảng rỗng —
// tách riêng để có thể kiểm chứng độc lập cách tính (mean/median/std/percentile...).
//
// Quy ước về múi giờ: các hàm gom nhóm theo thời gian (tháng, thứ, giờ) quy đổi
// mốc thời gian về múi giờ Việt Nam (Asia/Ho_Chi_Minh) để "khung giờ đăng tốt"
// phản ánh đúng thói quen người xem VN, không lệ thuộc múi giờ server.

const VN_TIME_ZONE = "Asia/Ho_Chi_Minh";

const WEEKDAY_LABELS_VI = [
  "Chủ nhật",
  "Thứ 2",
  "Thứ 3",
  "Thứ 4",
  "Thứ 5",
  "Thứ 6",
  "Thứ 7"
];

// --- Thống kê mô tả cơ bản -------------------------------------------------

function toFiniteNumbers(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map(Number).filter((value) => Number.isFinite(value));
}

function sum(values) {
  return toFiniteNumbers(values).reduce((total, value) => total + value, 0);
}

function mean(values) {
  const numbers = toFiniteNumbers(values);
  if (numbers.length === 0) {
    return 0;
  }
  return sum(numbers) / numbers.length;
}

function median(values) {
  const sorted = toFiniteNumbers(values).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return 0;
  }
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function min(values) {
  const numbers = toFiniteNumbers(values);
  return numbers.length === 0 ? 0 : Math.min(...numbers);
}

function max(values) {
  const numbers = toFiniteNumbers(values);
  return numbers.length === 0 ? 0 : Math.max(...numbers);
}

// Phương sai + độ lệch chuẩn. Trả cả bản "tổng thể" (chia N) và "mẫu" (chia N-1)
// để minh bạch: khi phân tích TOÀN BỘ bài (tổng thể thật) nên dùng bản population;
// bản sample giữ lại vì đó là mặc định quen thuộc của nhiều công cụ.
function variancePopulation(values) {
  const numbers = toFiniteNumbers(values);
  const n = numbers.length;
  if (n === 0) {
    return 0;
  }
  const avg = mean(numbers);
  const squaredDiff = numbers.reduce((total, value) => total + (value - avg) ** 2, 0);
  return squaredDiff / n;
}

function varianceSample(values) {
  const numbers = toFiniteNumbers(values);
  const n = numbers.length;
  if (n < 2) {
    return 0;
  }
  const avg = mean(numbers);
  const squaredDiff = numbers.reduce((total, value) => total + (value - avg) ** 2, 0);
  return squaredDiff / (n - 1);
}

function stdDevPopulation(values) {
  return Math.sqrt(variancePopulation(values));
}

function stdDevSample(values) {
  return Math.sqrt(varianceSample(values));
}

// Percentile theo phương pháp nội suy tuyến tính R-7 (mặc định của NumPy,
// Excel PERCENTILE.INC). p tính theo phần trăm [0, 100].
function percentile(values, p) {
  const sorted = toFiniteNumbers(values).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return 0;
  }
  if (n === 1) {
    return sorted[0];
  }
  const clamped = Math.min(100, Math.max(0, p));
  const rank = (clamped / 100) * (n - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const frac = rank - low;
  return sorted[low] + frac * (sorted[high] - sorted[low]);
}

// Hệ số biến thiên (Coefficient of Variation) = std / mean — đo mức phân tán
// tương đối, dùng để nói "tương tác ổn định hay thất thường".
function coefficientOfVariation(values) {
  const avg = mean(values);
  if (avg === 0) {
    return 0;
  }
  return stdDevPopulation(values) / avg;
}

// Bảng thống kê mô tả đầy đủ cho một dãy số (dùng cho phân bố tương tác/bài).
function describe(values) {
  const numbers = toFiniteNumbers(values);
  return {
    count: numbers.length,
    sum: sum(numbers),
    mean: mean(numbers),
    median: median(numbers),
    min: min(numbers),
    max: max(numbers),
    p25: percentile(numbers, 25),
    p75: percentile(numbers, 75),
    p90: percentile(numbers, 90),
    stdDevPopulation: stdDevPopulation(numbers),
    stdDevSample: stdDevSample(numbers),
    coefficientOfVariation: coefficientOfVariation(numbers)
  };
}

// Tỷ lệ tăng trưởng giữa 2 kỳ (%). previous = 0 -> không xác định (trả null).
function growthRatePercent(current, previous) {
  const currentValue = Number(current) || 0;
  const previousValue = Number(previous) || 0;
  if (previousValue === 0) {
    return null;
  }
  return ((currentValue - previousValue) / previousValue) * 100;
}

// Tỷ lệ an toàn (tránh chia 0). Trả 0 khi mẫu số không hợp lệ.
function safeRatio(numerator, denominator) {
  const num = Number(numerator) || 0;
  const den = Number(denominator) || 0;
  if (den === 0) {
    return 0;
  }
  return num / den;
}

// --- Quy đổi thời gian theo múi giờ VN -------------------------------------

// Trả các thành phần thời gian theo giờ VN: { year, month(1-12), day, weekday(0-6, 0=CN), hour(0-23) }.
function toVnParts(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: VN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short"
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Intl trả giờ "24" cho nửa đêm ở một số môi trường -> quy về 0.
  const hour = Number(parts.hour) % 24;

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday] ?? new Date(date).getDay(),
    hour
  };
}

// Khóa tháng dạng "YYYY-MM" theo giờ VN.
function monthKey(dateInput) {
  const parts = toVnParts(dateInput);
  if (!parts) {
    return null;
  }
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

// --- Gom nhóm theo thời gian ------------------------------------------------

// Gom danh sách item thành chuỗi tháng liên tục (không bỏ trống tháng ở giữa).
// getDate(item) -> mốc thời gian; getMetrics(item) -> object số cần cộng dồn.
// Trả mảng { key: "YYYY-MM", label, count, ...tổng các metric } theo thứ tự tăng dần.
function bucketByMonth(items, getDate, getMetrics) {
  const buckets = new Map();

  for (const item of items || []) {
    const key = monthKey(getDate(item));
    if (!key) {
      continue;
    }
    if (!buckets.has(key)) {
      buckets.set(key, { key, count: 0, metrics: {} });
    }
    const bucket = buckets.get(key);
    bucket.count += 1;
    const metrics = getMetrics ? getMetrics(item) || {} : {};
    for (const [name, value] of Object.entries(metrics)) {
      bucket.metrics[name] = (bucket.metrics[name] || 0) + (Number(value) || 0);
    }
  }

  if (buckets.size === 0) {
    return [];
  }

  const keys = Array.from(buckets.keys()).sort();
  const filledKeys = fillMonthRange(keys[0], keys[keys.length - 1]);

  return filledKeys.map((key) => {
    const bucket = buckets.get(key) || { key, count: 0, metrics: {} };
    return {
      key,
      label: formatMonthLabel(key),
      count: bucket.count,
      ...bucket.metrics
    };
  });
}

// Sinh dãy tháng liên tục từ startKey đến endKey (bao gồm 2 đầu).
function fillMonthRange(startKey, endKey) {
  const [startYear, startMonth] = startKey.split("-").map(Number);
  const [endYear, endMonth] = endKey.split("-").map(Number);
  const result = [];
  let year = startYear;
  let month = startMonth;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return result;
}

function formatMonthLabel(key) {
  const [year, month] = key.split("-");
  return `${month}/${year}`;
}

// Phân bố theo thứ trong tuần (0=CN..6=T7). Trả 7 phần tử cố định để vẽ heatmap/bar.
function bucketByWeekday(items, getDate, getValue) {
  const counts = new Array(7).fill(0);
  const valueSums = new Array(7).fill(0);

  for (const item of items || []) {
    const parts = toVnParts(getDate(item));
    if (!parts) {
      continue;
    }
    counts[parts.weekday] += 1;
    valueSums[parts.weekday] += Number(getValue ? getValue(item) : 0) || 0;
  }

  return WEEKDAY_LABELS_VI.map((label, index) => ({
    weekday: index,
    label,
    postCount: counts[index],
    valueSum: valueSums[index],
    avgValue: counts[index] === 0 ? 0 : valueSums[index] / counts[index]
  }));
}

// Phân bố theo giờ trong ngày (0..23). Trả 24 phần tử cố định.
function bucketByHour(items, getDate, getValue) {
  const counts = new Array(24).fill(0);
  const valueSums = new Array(24).fill(0);

  for (const item of items || []) {
    const parts = toVnParts(getDate(item));
    if (!parts) {
      continue;
    }
    counts[parts.hour] += 1;
    valueSums[parts.hour] += Number(getValue ? getValue(item) : 0) || 0;
  }

  return counts.map((count, hour) => ({
    hour,
    label: `${String(hour).padStart(2, "0")}h`,
    postCount: count,
    valueSum: valueSums[hour],
    avgValue: count === 0 ? 0 : valueSums[hour] / count
  }));
}

module.exports = {
  VN_TIME_ZONE,
  WEEKDAY_LABELS_VI,
  sum,
  mean,
  median,
  min,
  max,
  variancePopulation,
  varianceSample,
  stdDevPopulation,
  stdDevSample,
  percentile,
  coefficientOfVariation,
  describe,
  growthRatePercent,
  safeRatio,
  toVnParts,
  monthKey,
  bucketByMonth,
  fillMonthRange,
  bucketByWeekday,
  bucketByHour
};
