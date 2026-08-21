const { HttpsError } = require("firebase-functions/v2/https");
const { tokenSuffix } = require("./billingFinalTrace");
const { UUID_PATTERN } = require("./registerDeviceUsage");

const CLEAR_DEVICE_FCM_TOKEN_TAG = "KAMOME_DEVICE_FCM_TOKEN_CLEAR";

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateClearDeviceFcmTokenInput(data) {
  if (!isPlainObject(data)) {
    throw new HttpsError("invalid-argument", "Request body must be an object.");
  }
  const deviceId = String(data.deviceId ?? "").trim();
  if (!UUID_PATTERN.test(deviceId)) {
    throw new HttpsError("invalid-argument", "deviceId must be a valid UUID.");
  }
  return { deviceId };
}

function createClearDeviceFcmTokenHandler({ admin, logger }) {
  return async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    // activeDeviceId gate は付けない。旧端末 logout が自分の token だけ消せるようにする。
    const input = validateClearDeviceFcmTokenInput(request.data);
    const deviceRef = admin
      .getDb()
      .collection("users")
      .doc(uid)
      .collection("devices")
      .doc(input.deviceId);
    const snap = await deviceRef.get();
    if (!snap.exists) {
      logger.info(CLEAR_DEVICE_FCM_TOKEN_TAG, {
        uidSuffix: tokenSuffix(uid),
        deviceIdSuffix: tokenSuffix(input.deviceId),
        cleared: false,
        reason: "missing_doc",
      });
      return { ok: true, cleared: false };
    }

    await deviceRef.set(
      {
        fcmToken: admin.FieldValue.delete(),
        fcmUpdatedAt: admin.FieldValue.delete(),
      },
      { merge: true }
    );

    logger.info(CLEAR_DEVICE_FCM_TOKEN_TAG, {
      uidSuffix: tokenSuffix(uid),
      deviceIdSuffix: tokenSuffix(input.deviceId),
      cleared: true,
    });
    return { ok: true, cleared: true };
  };
}

module.exports = {
  CLEAR_DEVICE_FCM_TOKEN_TAG,
  validateClearDeviceFcmTokenInput,
  createClearDeviceFcmTokenHandler,
};
