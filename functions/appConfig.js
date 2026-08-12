const logger = require("firebase-functions/logger");
const admin = require("./firebaseAdmin");

const APP_GATE_COLLECTION = "admin";
const APP_GATE_DOC_ID = "app_gate";
const APP_GATE_MODE_FIELD = "mode";
const ACCESS_MODE_NORMAL = "normal";
const ACCESS_MODE_BLOCK_ALL = "block_all";
const BLOCKED_BY_ADMIN_CODE = "BLOCKED_BY_ADMIN";

const DEFAULT_DAILY_SEND_LIMIT = 120;
const DEFAULT_DAILY_TRANSCRIBE_LIMIT = 120;

/** Console typo guard: above any planned production limit, below runaway cost risk. */
const MAX_DAILY_LIMIT = 1000;

/**
 * Parse a positive integer daily limit from Firestore config.
 * Invalid values fall back to [defaultValue].
 */
function parseDailyLimitField(rawValue, defaultValue, fieldName) {
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    return {
      value: defaultValue,
      usedDefault: true,
      reason: "invalid_type",
      fieldName,
      rawType: rawValue === null ? "null" : typeof rawValue,
    };
  }
  if (!Number.isInteger(rawValue) || rawValue < 1) {
    return {
      value: defaultValue,
      usedDefault: true,
      reason: "invalid_range",
      fieldName,
      rawValue,
    };
  }
  if (rawValue > MAX_DAILY_LIMIT) {
    return {
      value: defaultValue,
      usedDefault: true,
      reason: "too_large",
      fieldName,
      rawValue,
      maxAllowed: MAX_DAILY_LIMIT,
    };
  }
  return {
    value: rawValue,
    usedDefault: false,
    reason: "ok",
    fieldName,
    rawValue,
  };
}

async function loadAppConfig() {
  const defaults = {
    dailyLimit: DEFAULT_DAILY_SEND_LIMIT,
    dailyTranscribeLimit: DEFAULT_DAILY_TRANSCRIBE_LIMIT,
    accessMode: "normal",
  };

  try {
    const doc = await admin.getDb().collection("config").doc("app").get();
    const dailySendLimit = doc?.get("dailySendLimit");
    const dailyTranscribeLimit = doc?.get("dailyTranscribeLimit");
    const appAccessMode = doc?.get("app_access_mode");

    const sendParsed = parseDailyLimitField(
      dailySendLimit,
      DEFAULT_DAILY_SEND_LIMIT,
      "dailySendLimit",
    );
    const transcribeParsed = parseDailyLimitField(
      dailyTranscribeLimit,
      DEFAULT_DAILY_TRANSCRIBE_LIMIT,
      "dailyTranscribeLimit",
    );

    if (sendParsed.usedDefault && sendParsed.reason !== "ok") {
      logger.warn("loadAppConfig invalid dailySendLimit; using default", sendParsed);
    }
    if (transcribeParsed.usedDefault && transcribeParsed.reason !== "ok") {
      logger.warn(
        "loadAppConfig invalid dailyTranscribeLimit; using default",
        transcribeParsed,
      );
    }

    // Legacy field from config/app. Block decisions use admin/app_gate.mode instead.
    const accessMode =
      typeof appAccessMode === "string" && appAccessMode.length > 0
        ? appAccessMode
        : defaults.accessMode;

    const result = {
      dailyLimit: sendParsed.value,
      dailyTranscribeLimit: transcribeParsed.value,
      accessMode,
      dailySendLimitFromDoc:
        typeof dailySendLimit === "number" ? dailySendLimit : null,
      dailyTranscribeLimitFromDoc:
        typeof dailyTranscribeLimit === "number" ? dailyTranscribeLimit : null,
      dailySendLimitUsedDefault: sendParsed.usedDefault,
      dailyTranscribeLimitUsedDefault: transcribeParsed.usedDefault,
    };

    logger.info("loadAppConfig resolved", result);
    return result;
  } catch (e) {
    logger.warn("Failed to read config/app; using defaults.", e);
    return {
      ...defaults,
      dailySendLimitFromDoc: null,
      dailyTranscribeLimitFromDoc: null,
      dailySendLimitUsedDefault: true,
      dailyTranscribeLimitUsedDefault: true,
    };
  }
}

/**
 * Read the canonical admin kill-switch: admin/app_gate.mode.
 * Fail-open on read errors so transient Firestore issues do not block all users.
 */
async function loadAppGateAccessMode(options = {}) {
  const getDb = options.getDb || (() => admin.getDb());
  try {
    const snap = await getDb()
      .collection(APP_GATE_COLLECTION)
      .doc(APP_GATE_DOC_ID)
      .get();
    if (!snap.exists) {
      return {
        accessMode: ACCESS_MODE_NORMAL,
        source: "admin/app_gate",
        readFailed: false,
      };
    }
    const mode = snap.get(APP_GATE_MODE_FIELD);
    if (typeof mode === "string" && mode.trim().length > 0) {
      return {
        accessMode: mode.trim(),
        source: "admin/app_gate",
        readFailed: false,
      };
    }
    return {
      accessMode: ACCESS_MODE_NORMAL,
      source: "admin/app_gate",
      readFailed: false,
    };
  } catch (e) {
    logger.warn("loadAppGateAccessMode: admin/app_gate read failed; fail-open", {
      errorType: e?.constructor?.name || typeof e,
    });
    return {
      accessMode: ACCESS_MODE_NORMAL,
      source: "fail_open",
      readFailed: true,
    };
  }
}

/**
 * Returns blocked=true when admin/app_gate.mode is block_all.
 */
async function assertAccessNotBlocked(options = {}) {
  const gate = await loadAppGateAccessMode(options);
  if (gate.accessMode === ACCESS_MODE_BLOCK_ALL) {
    return {
      blocked: true,
      code: BLOCKED_BY_ADMIN_CODE,
      accessMode: gate.accessMode,
      readFailed: gate.readFailed,
    };
  }
  return {
    blocked: false,
    accessMode: gate.accessMode,
    readFailed: gate.readFailed,
  };
}

module.exports = {
  APP_GATE_COLLECTION,
  APP_GATE_DOC_ID,
  APP_GATE_MODE_FIELD,
  ACCESS_MODE_NORMAL,
  ACCESS_MODE_BLOCK_ALL,
  BLOCKED_BY_ADMIN_CODE,
  DEFAULT_DAILY_SEND_LIMIT,
  DEFAULT_DAILY_TRANSCRIBE_LIMIT,
  MAX_DAILY_LIMIT,
  parseDailyLimitField,
  loadAppConfig,
  loadAppGateAccessMode,
  assertAccessNotBlocked,
};
