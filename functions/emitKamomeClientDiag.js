const { HttpsError } = require("firebase-functions/v2/https");
const { tokenSuffix } = require("./billingFinalTrace");

const CLIENT_DIAG_TAG = "KAMOME_CLIENT_DIAG";
const MAX_PAYLOAD_BYTES = 2048;
const MAX_STRING_LENGTH = 256;
const MAX_FIELD_COUNT = 32;

const ALLOWED_EVENTS = new Set([
  "subscription_ack_check_trigger",
  "billing_purchase_failed",
  "billing_verify_failed",
  "billing_restore_failed",
  "cf_call_failed",
]);

const COMMON_FIELDS = new Set([
  "platform",
  "appVersion",
  "buildNumber",
  "billingTraceId",
  "provider",
]);

const EVENT_FIELDS = {
  subscription_ack_check_trigger: new Set([
    ...COMMON_FIELDS,
    "path",
    "triggerReason",
    "denyReason",
    "decisionSource",
    "subscriptionStatus",
    "entitlementUsable",
    "subscriptionPlatform",
    "subscriptionExpiryDeltaMs",
    "entitlementExpiryDeltaMs",
    "lastSubscriptionSource",
    "googlePlaySubscriptionState",
    "errorCode",
  ]),
  billing_purchase_failed: new Set([
    ...COMMON_FIELDS,
    "reason",
    "errorCode",
  ]),
  billing_verify_failed: new Set([
    ...COMMON_FIELDS,
    "reason",
    "errorCode",
    "callableName",
  ]),
  billing_restore_failed: new Set([
    ...COMMON_FIELDS,
    "reason",
    "errorCode",
  ]),
  cf_call_failed: new Set([
    ...COMMON_FIELDS,
    "reason",
    "errorCode",
    "callableName",
  ]),
};

const FORBIDDEN_FIELD_KEYS = new Set([
  "uid",
  "userId",
  "email",
  "userEmail",
  "message",
  "messageBody",
  "purchaseToken",
  "token",
  "fcmToken",
  "accountId",
  "kamomeId",
  "apiKey",
  "secret",
]);

const FORBIDDEN_VALUE_PATTERNS = [
  /@/, // email-like
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, // UUID full (billingTraceId is allowed separately)
];

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeString(value, { allowUuid = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length > MAX_STRING_LENGTH) {
    return normalized.slice(0, MAX_STRING_LENGTH);
  }
  if (!allowUuid) {
    for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
      if (pattern.test(normalized)) {
        return "[redacted]";
      }
    }
  }
  return normalized;
}

function sanitizeFieldValue(key, value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (key === "billingTraceId") {
    const text = sanitizeString(value, { allowUuid: true });
    return text || null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return sanitizeString(value);
  }
  return null;
}

function sanitizeClientDiagFields(event, rawFields) {
  if (!ALLOWED_EVENTS.has(event)) {
    return {};
  }
  if (!isPlainObject(rawFields)) {
    return {};
  }

  const allowed = EVENT_FIELDS[event] || new Set();
  const sanitized = {};
  let fieldCount = 0;

  for (const [key, value] of Object.entries(rawFields)) {
    if (fieldCount >= MAX_FIELD_COUNT) {
      break;
    }
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey || FORBIDDEN_FIELD_KEYS.has(normalizedKey)) {
      continue;
    }
    if (!allowed.has(normalizedKey)) {
      continue;
    }
    const sanitizedValue = sanitizeFieldValue(normalizedKey, value);
    if (sanitizedValue === "" || sanitizedValue == null) {
      continue;
    }
    sanitized[normalizedKey] = sanitizedValue;
    fieldCount += 1;
  }

  return sanitized;
}

function buildClientDiagPayload({ event, uid, fields, receivedAt }) {
  return {
    event,
    uidSuffix: tokenSuffix(uid),
    receivedAt: receivedAt || new Date().toISOString(),
    ...fields,
  };
}

function payloadByteLength(payload) {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function createEmitKamomeClientDiagHandler({ logger }) {
  return async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const data = request.data;
    if (!isPlainObject(data)) {
      throw new HttpsError("invalid-argument", "Request body must be an object.");
    }

    const event = sanitizeString(data.event);
    if (!ALLOWED_EVENTS.has(event)) {
      throw new HttpsError("invalid-argument", "Unknown diagnostic event.");
    }

    const fields = sanitizeClientDiagFields(event, data.fields);
    const payload = buildClientDiagPayload({
      event,
      uid,
      fields,
      receivedAt: new Date().toISOString(),
    });

    if (payloadByteLength(payload) > MAX_PAYLOAD_BYTES) {
      throw new HttpsError("invalid-argument", "Diagnostic payload too large.");
    }

    logger.info(CLIENT_DIAG_TAG, payload);
    return { ok: true };
  };
}

module.exports = {
  CLIENT_DIAG_TAG,
  MAX_PAYLOAD_BYTES,
  ALLOWED_EVENTS,
  EVENT_FIELDS,
  FORBIDDEN_FIELD_KEYS,
  sanitizeClientDiagFields,
  buildClientDiagPayload,
  payloadByteLength,
  createEmitKamomeClientDiagHandler,
};
