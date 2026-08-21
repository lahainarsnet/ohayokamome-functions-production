"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { tokenSuffix } = require("./billingFinalTrace");
const {
  validateRegisterDeviceUsageInput,
} = require("./registerDeviceUsage");
const {
  MAX_FCM_TOKEN_LENGTH,
  MIN_FCM_TOKEN_LENGTH,
} = require("./registerDeviceFcmToken");

const CLAIM_ACTIVE_DEVICE_TAG = "KAMOME_CLAIM_ACTIVE_DEVICE";
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalFcmToken(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (
    normalized.length < MIN_FCM_TOKEN_LENGTH ||
    normalized.length > MAX_FCM_TOKEN_LENGTH ||
    !FCM_TOKEN_PATTERN.test(normalized)
  ) {
    throw new HttpsError("invalid-argument", "fcmToken is invalid.");
  }
  return normalized;
}

function validateClaimActiveDeviceInput(data) {
  const deviceInput = validateRegisterDeviceUsageInput(data);
  if (!isPlainObject(data)) {
    throw new HttpsError("invalid-argument", "Request body must be an object.");
  }
  const fcmToken = Object.prototype.hasOwnProperty.call(data, "fcmToken")
    ? normalizeOptionalFcmToken(data.fcmToken)
    : "";
  return {
    ...deviceInput,
    fcmToken,
  };
}

function createClaimActiveDeviceHandler({ admin, logger }) {
  return async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }
    if (!request.app) {
      throw new HttpsError("failed-precondition", "App Check required.");
    }

    const input = validateClaimActiveDeviceInput(request.data);
    const db = admin.getDb();
    const userRef = db.collection("users").doc(uid);
    const deviceRef = userRef.collection("devices").doc(input.deviceId);
    const now = admin.FieldValue.serverTimestamp();

    const result = await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      const deviceSnap = await tx.get(deviceRef);
      const userData = userSnap.exists ? userSnap.data() || {} : {};
      const previousActiveDeviceId = String(userData.activeDeviceId || "").trim();
      const created = !deviceSnap.exists;
      const switched =
        Boolean(previousActiveDeviceId) &&
        previousActiveDeviceId !== input.deviceId;

      const userUpdate = {
        activeDeviceId: input.deviceId,
        activeDeviceUpdatedAt: now,
      };
      if (input.fcmToken) {
        userUpdate.fcmToken = input.fcmToken;
      }
      tx.set(userRef, userUpdate, { merge: true });

      const deviceUpdate = {
        deviceId: input.deviceId,
        platform: input.platform,
        modelName: input.modelName,
        appVersion: input.appVersion,
        buildNumber: input.buildNumber,
        lastUsedAt: now,
      };
      if (created) {
        deviceUpdate.firstUsedAt = now;
      }
      if (input.fcmToken) {
        deviceUpdate.fcmToken = input.fcmToken;
        deviceUpdate.fcmUpdatedAt = now;
      }
      tx.set(deviceRef, deviceUpdate, { merge: true });

      return {
        created,
        switched,
        previousActiveDeviceId,
      };
    });

    logger.info(CLAIM_ACTIVE_DEVICE_TAG, {
      uidSuffix: tokenSuffix(uid),
      deviceIdSuffix: tokenSuffix(input.deviceId),
      previousDeviceIdSuffix: result.previousActiveDeviceId
        ? tokenSuffix(result.previousActiveDeviceId)
        : null,
      platform: input.platform,
      created: result.created,
      switched: result.switched,
      hasFcmToken: Boolean(input.fcmToken),
    });

    return {
      ok: true,
      created: result.created,
      switched: result.switched,
    };
  };
}

module.exports = {
  CLAIM_ACTIVE_DEVICE_TAG,
  validateClaimActiveDeviceInput,
  createClaimActiveDeviceHandler,
};
