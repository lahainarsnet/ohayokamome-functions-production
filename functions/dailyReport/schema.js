const SCHEMA_VERSION = 1;
const COLLECTION_ID = "daily_reports";

const FORBIDDEN_FIELD_PATTERN =
  /(email|fcmToken|purchaseToken|transactionId|deviceId|uid|text|body|audio|secret|token)/i;

function sanitizeMetricKey(value, fallback = "unknown") {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  if (!normalized || FORBIDDEN_FIELD_PATTERN.test(normalized)) return fallback;
  return normalized.slice(0, 64);
}

function sanitizeErrorCode(code) {
  if (typeof code !== "string" || code.trim() === "") return "UNKNOWN";
  const trimmed = code.trim().slice(0, 64);
  return /^[A-Z0-9_]+$/.test(trimmed) ? trimmed : "UNKNOWN";
}

function assertSafeDailyReportPayload(payload) {
  const json = JSON.stringify(payload);
  if (FORBIDDEN_FIELD_PATTERN.test(json)) {
    throw new Error("Daily report payload contains forbidden field names");
  }
}

function createBaseReportMetadata(reportDate, timezone) {
  return {
    schemaVersion: SCHEMA_VERSION,
    reportDate,
    timezone,
  };
}

module.exports = {
  SCHEMA_VERSION,
  COLLECTION_ID,
  sanitizeMetricKey,
  sanitizeErrorCode,
  assertSafeDailyReportPayload,
  createBaseReportMetadata,
};
