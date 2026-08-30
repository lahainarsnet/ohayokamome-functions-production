"use strict";

const { HttpsError } = require("firebase-functions/v2/https");

const DEVICE_SWITCH_NOTICE_ACKS_COLLECTION = "device_switch_notice_acks";
const DEVICE_SWITCH_NOTICE_VERSION = "device_switch_notice_v1";
const MAX_LOCAL_DEVICE_ID_LENGTH = 64;
const MAX_APP_VERSION_LENGTH = 32;
const MAX_BUILD_NUMBER_LENGTH = 16;

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
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

function buildDeviceSwitchNoticeAckPayload({
  userId,
  localDeviceId,
  noticeVersion,
  appVersionName,
  buildNumber,
  FieldValue,
}) {
  const payload = {
    userId,
    localDeviceId,
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

function createAcknowledgeDeviceSwitchNoticeHandler({ admin, logger }) {
  return async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }

    const data = request.data || {};
    if (!isPlainObject(data)) {
      throw new HttpsError("invalid-argument", "Request body must be an object.");
    }

    const localDeviceId = normalizeBoundedString(
      data.localDeviceId,
      MAX_LOCAL_DEVICE_ID_LENGTH
    );
    const noticeVersion = String(data.noticeVersion || "").trim();
    if (!localDeviceId) {
      throw new HttpsError("invalid-argument", "localDeviceId is required.");
    }
    if (noticeVersion !== DEVICE_SWITCH_NOTICE_VERSION) {
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

    const payload = buildDeviceSwitchNoticeAckPayload({
      userId: uid,
      localDeviceId,
      noticeVersion,
      appVersionName,
      buildNumber,
      FieldValue: admin.FieldValue,
    });

    await admin
      .getDb()
      .collection(DEVICE_SWITCH_NOTICE_ACKS_COLLECTION)
      .add(payload);

    if (logger && typeof logger.info === "function") {
      logger.info("acknowledgeDeviceSwitchNotice recorded", {
        uidTail: uid.length <= 6 ? uid : uid.slice(-6),
        noticeVersion,
      });
    }

    return { ok: true };
  };
}

module.exports = {
  DEVICE_SWITCH_NOTICE_ACKS_COLLECTION,
  DEVICE_SWITCH_NOTICE_VERSION,
  buildDeviceSwitchNoticeAckPayload,
  createAcknowledgeDeviceSwitchNoticeHandler,
};
