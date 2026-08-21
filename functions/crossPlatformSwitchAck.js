"use strict";

const { HttpsError } = require("firebase-functions/v2/https");

const CROSS_PLATFORM_SWITCH_ACKS_COLLECTION = "cross_platform_switch_acks";
const CROSS_PLATFORM_SWITCH_NOTICE_VERSION = "cross_platform_switch_v1";
const ALLOWED_PLATFORMS = new Set(["ios", "android"]);
const MAX_APP_VERSION_LENGTH = 32;
const MAX_BUILD_NUMBER_LENGTH = 16;

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizePlatform(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeBoundedString(value, maxLength) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length > maxLength) {
    return normalized.slice(0, maxLength);
  }
  return normalized;
}

function buildCrossPlatformSwitchAckPayload({
  userId,
  fromPlatform,
  toPlatform,
  noticeVersion,
  appVersionName,
  buildNumber,
  FieldValue,
}) {
  const payload = {
    userId,
    fromPlatform,
    toPlatform,
    noticeVersion,
    acknowledgedAt: FieldValue.serverTimestamp(),
  };
  if (appVersionName) {
    payload.appVersionName = appVersionName;
  }
  if (buildNumber) {
    payload.buildNumber = buildNumber;
  }
  return payload;
}

function createAcknowledgeCrossPlatformSwitchHandler({ admin, logger }) {
  return async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }

    const data = request.data || {};
    if (!isPlainObject(data)) {
      throw new HttpsError("invalid-argument", "Request body must be an object.");
    }

    const fromPlatform = normalizePlatform(data.fromPlatform);
    const toPlatform = normalizePlatform(data.toPlatform);
    const noticeVersion = String(data.noticeVersion || "").trim();
    if (!ALLOWED_PLATFORMS.has(fromPlatform) || !ALLOWED_PLATFORMS.has(toPlatform)) {
      throw new HttpsError(
        "invalid-argument",
        "fromPlatform and toPlatform must be ios or android."
      );
    }
    if (fromPlatform === toPlatform) {
      throw new HttpsError(
        "invalid-argument",
        "fromPlatform and toPlatform must differ."
      );
    }
    if (noticeVersion !== CROSS_PLATFORM_SWITCH_NOTICE_VERSION) {
      throw new HttpsError("invalid-argument", "Unsupported noticeVersion.");
    }

    const appVersionName = normalizeBoundedString(
      data.appVersionName,
      MAX_APP_VERSION_LENGTH
    );
    const buildNumber = normalizeBoundedString(
      data.buildNumber,
      MAX_BUILD_NUMBER_LENGTH
    );

    const payload = buildCrossPlatformSwitchAckPayload({
      userId: uid,
      fromPlatform,
      toPlatform,
      noticeVersion,
      appVersionName,
      buildNumber,
      FieldValue: admin.FieldValue,
    });

    await admin
      .getDb()
      .collection(CROSS_PLATFORM_SWITCH_ACKS_COLLECTION)
      .add(payload);

    if (logger && typeof logger.info === "function") {
      logger.info("acknowledgeCrossPlatformSwitch recorded", {
        uidTail: uid.length <= 6 ? uid : uid.slice(-6),
        fromPlatform,
        toPlatform,
        noticeVersion,
      });
    }

    return { ok: true };
  };
}

module.exports = {
  CROSS_PLATFORM_SWITCH_ACKS_COLLECTION,
  CROSS_PLATFORM_SWITCH_NOTICE_VERSION,
  buildCrossPlatformSwitchAckPayload,
  createAcknowledgeCrossPlatformSwitchHandler,
};
