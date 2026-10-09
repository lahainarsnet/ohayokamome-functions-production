const { HttpsError } = require("firebase-functions/v2/https");
const { tokenSuffix } = require("./billingFinalTrace");
const {
  resolveVerifiedClientPlatform,
  verifiedDevicePlatformFields,
  PLATFORM_APP_CHECK_MISMATCH,
  UNKNOWN_APP_ID,
} = require("./devicePlatformAppCheck");

const REGISTER_DEVICE_USAGE_TAG = "KAMOME_DEVICE_REGISTRY";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_PLATFORMS = new Set(["ios", "android"]);
const MAX_MODEL_NAME_LENGTH = 64;
const MAX_APP_VERSION_LENGTH = 32;
const MAX_BUILD_NUMBER_LENGTH = 16;

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value, maxLength) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length > maxLength) {
    return normalized.slice(0, maxLength);
  }
  return normalized;
}

function validateRegisterDeviceUsageInput(data) {
  if (!isPlainObject(data)) {
    throw new HttpsError("invalid-argument", "Request body must be an object.");
  }

  const deviceId = normalizeString(data.deviceId, 36);
  if (!UUID_PATTERN.test(deviceId)) {
    throw new HttpsError("invalid-argument", "deviceId must be a valid UUID.");
  }

  const platform = normalizeString(data.platform, 16).toLowerCase();
  if (!ALLOWED_PLATFORMS.has(platform)) {
    throw new HttpsError("invalid-argument", "platform must be ios or android.");
  }

  const modelName = normalizeString(data.modelName, MAX_MODEL_NAME_LENGTH);
  if (!modelName) {
    throw new HttpsError("invalid-argument", "modelName is required.");
  }

  const appVersion = normalizeString(data.appVersion, MAX_APP_VERSION_LENGTH);
  if (!appVersion) {
    throw new HttpsError("invalid-argument", "appVersion is required.");
  }

  const buildNumber = normalizeString(data.buildNumber, MAX_BUILD_NUMBER_LENGTH);
  if (!buildNumber || !/^\d+$/.test(buildNumber)) {
    throw new HttpsError(
      "invalid-argument",
      "buildNumber must be a numeric string."
    );
  }

  return {
    deviceId,
    platform,
    modelName,
    appVersion,
    buildNumber,
  };
}

function createRegisterDeviceUsageHandler({ admin, logger }) {
  return async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    if (!request.app) {
      throw new HttpsError("failed-precondition", "App Check required.");
    }
    const input = validateRegisterDeviceUsageInput(request.data);
    let verifiedPlatform;
    try {
      verifiedPlatform = resolveVerifiedClientPlatform(request, input.platform);
    } catch (error) {
      if (error instanceof HttpsError) {
        const detailCode = error.details && error.details.code;
        if (
          detailCode === PLATFORM_APP_CHECK_MISMATCH ||
          detailCode === UNKNOWN_APP_ID
        ) {
          logger.warn(REGISTER_DEVICE_USAGE_TAG, {
            uidSuffix: tokenSuffix(uid),
            deviceIdSuffix: tokenSuffix(input.deviceId),
            event: "platform_app_check_rejected",
            reason: detailCode,
            declaredPlatform: input.platform,
            appCheckPlatform: error.details.appCheckPlatform || null,
          });
        }
      }
      throw error;
    }
    const db = admin.getDb();
    const deviceRef = db
      .collection("users")
      .doc(uid)
      .collection("devices")
      .doc(input.deviceId);
    const snap = await deviceRef.get();
    const now = admin.FieldValue.serverTimestamp();
    const created = !snap.exists;

    const platformFields = verifiedDevicePlatformFields(verifiedPlatform);
    if (created) {
      await deviceRef.set({
        deviceId: input.deviceId,
        ...platformFields,
        modelName: input.modelName,
        appVersion: input.appVersion,
        buildNumber: input.buildNumber,
        firstUsedAt: now,
        lastUsedAt: now,
      });
    } else {
      await deviceRef.update({
        ...platformFields,
        modelName: input.modelName,
        appVersion: input.appVersion,
        buildNumber: input.buildNumber,
        lastUsedAt: now,
      });
    }

    logger.info(REGISTER_DEVICE_USAGE_TAG, {
      uidSuffix: tokenSuffix(uid),
      deviceIdSuffix: tokenSuffix(input.deviceId),
      platform: verifiedPlatform,
      declaredPlatform: input.platform,
      platformAppCheckVerified: true,
      modelName: input.modelName,
      appVersion: input.appVersion,
      buildNumber: input.buildNumber,
      created,
    });

    return { ok: true, created };
  };
}

module.exports = {
  REGISTER_DEVICE_USAGE_TAG,
  UUID_PATTERN,
  ALLOWED_PLATFORMS,
  validateRegisterDeviceUsageInput,
  createRegisterDeviceUsageHandler,
};
