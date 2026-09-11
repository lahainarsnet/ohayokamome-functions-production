const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TIMEZONE = "Asia/Tokyo";

function getJstDateKey(baseDate = new Date()) {
  const jst = new Date(baseDate.getTime() + JST_OFFSET_MS);
  return jst.toISOString().slice(0, 10);
}

function getPreviousJstDateKey(baseDate = new Date()) {
  const jst = new Date(baseDate.getTime() + JST_OFFSET_MS);
  jst.setUTCDate(jst.getUTCDate() - 1);
  return jst.toISOString().slice(0, 10);
}

function getReportWindowUtc(reportDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new Error("Invalid reportDate");
  }
  const [year, month, day] = reportDate.split("-").map(Number);
  const windowStartUtc = new Date(Date.UTC(year, month - 1, day, -9, 0, 0, 0));
  const windowEndUtc = new Date(Date.UTC(year, month - 1, day, 14, 59, 59, 999));
  return {
    windowStartUtc: windowStartUtc.toISOString(),
    windowEndUtc: windowEndUtc.toISOString(),
  };
}

function timestampToMillis(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === "object" && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : null;
  }
  if (typeof value === "object" && typeof value._seconds === "number") {
    return value._seconds * 1000;
  }
  return null;
}

function isTimestampInReportWindow(value, reportDate) {
  const millis = timestampToMillis(value);
  if (millis == null) return false;
  const { windowStartUtc, windowEndUtc } = getReportWindowUtc(reportDate);
  const start = Date.parse(windowStartUtc);
  const end = Date.parse(windowEndUtc);
  return millis >= start && millis <= end;
}

module.exports = {
  JST_OFFSET_MS,
  TIMEZONE,
  getJstDateKey,
  getPreviousJstDateKey,
  getReportWindowUtc,
  timestampToMillis,
  isTimestampInReportWindow,
};
