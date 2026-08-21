const { HttpsError } = require("firebase-functions/v2/https");
const { tokenSuffix } = require("./billingFinalTrace");
const { UUID_PATTERN } = require("./registerDeviceUsage");
const { assertActiveDeviceAllowed } = require("./activeDeviceGate");

const REGISTER_DEVICE_FCM_TOKEN_TAG = "KAMOME_DEVICE_FCM_TOKEN";
const MAX_FCM_TOKEN_LENGTH = 4096;
const MIN_FCM_TOKEN_LENGTH = 64;
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeDeviceId(value) {
  return String(value ?? "").trim();
}

function normalizeFcmToken(value) {
  return String(value ?? "").trim();
}

function validateRegisterDeviceFcmTokenInput(data) {
  if (!isPlainObject(data)) {
    throw new HttpsError("invalid-argument", "Request body must be an object.");
  }

  const deviceId = normalizeDeviceId(data.deviceId);
  if (!UUID_PATTERN.test(deviceId)) {
    throw new HttpsError("invalid-argument", "deviceId must be a valid UUID.");
  }

  const fcmToken = normalizeFcmToken(data.fcmToken);
  if (
    !fcmToken ||
    fcmToken.length < MIN_FCM_TOKEN_LENGTH ||
    fcmToken.length > MAX_FCM_TOKEN_LENGTH ||
    !FCM_TOKEN_PATTERN.test(fcmToken)
  ) {
    throw new HttpsError("invalid-argument", "fcmToken is invalid.");
  }

  return { deviceId, fcmToken };
}

function createRegisterDeviceFcmTokenHandler({ admin, logger }) {
  return async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const input = validateRegisterDeviceFcmTokenInput(request.data);
    await assertActiveDeviceAllowed({
      admin,
      uid,
      data: { deviceId: input.deviceId },
    });
    const db = admin.getDb();
    const userRef = db.collection("users").doc(uid);
    const deviceRef = userRef.collection("devices").doc(input.deviceId);
    const snap = await deviceRef.get();
    const created = !snap.exists;

    await deviceRef.set(
      {
        fcmToken: input.fcmToken,
        fcmUpdatedAt: admin.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await userRef.set(
      {
        fcmToken: input.fcmToken,
      },
      { merge: true }
    );

    logger.info(REGISTER_DEVICE_FCM_TOKEN_TAG, {
      uidSuffix: tokenSuffix(uid),
      deviceIdSuffix: tokenSuffix(input.deviceId),
      tokenLength: input.fcmToken.length,
      created,
    });

    return { ok: true, created };
  };
}

module.exports = {
  REGISTER_DEVICE_FCM_TOKEN_TAG,
  MAX_FCM_TOKEN_LENGTH,
  MIN_FCM_TOKEN_LENGTH,
  validateRegisterDeviceFcmTokenInput,
  createRegisterDeviceFcmTokenHandler,
};
