"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { UUID_PATTERN } = require("./registerDeviceUsage");

const ACTIVE_DEVICE_MISMATCH = "ACTIVE_DEVICE_MISMATCH";
const INVALID_DEVICE_ID = "INVALID_DEVICE_ID";

function normalizeDeviceId(value) {
  return String(value ?? "").trim();
}

function extractRequestDeviceId(data) {
  const deviceId = normalizeDeviceId(data && data.deviceId);
  if (!UUID_PATTERN.test(deviceId)) {
    return { ok: false, code: INVALID_DEVICE_ID, deviceId: "" };
  }
  return { ok: true, deviceId };
}

function createActiveDeviceMismatchError() {
  return new HttpsError("failed-precondition", ACTIVE_DEVICE_MISMATCH, {
    code: ACTIVE_DEVICE_MISMATCH,
  });
}

function createInvalidDeviceIdError() {
  return new HttpsError("invalid-argument", "deviceId must be a valid UUID.", {
    code: INVALID_DEVICE_ID,
  });
}

async function evaluateActiveDeviceGate({
  getUserData,
  uid,
  data,
  allowPendingDevice = false,
}) {
  const extracted = extractRequestDeviceId(data);
  if (!extracted.ok) {
    return {
      ok: false,
      code: extracted.code,
      httpsError: createInvalidDeviceIdError(),
    };
  }

  const userData = (await getUserData(uid)) || {};
  const activeDeviceId = normalizeDeviceId(userData.activeDeviceId);
  if (activeDeviceId && activeDeviceId === extracted.deviceId) {
    return { ok: true, deviceId: extracted.deviceId };
  }
  const pendingDeviceId = normalizeDeviceId(userData.pendingActiveDeviceId);
  if (
    allowPendingDevice &&
    pendingDeviceId &&
    pendingDeviceId === extracted.deviceId
  ) {
    return { ok: true, deviceId: extracted.deviceId, viaPending: true };
  }
  // Step 2 で初回 claim 済みが前提。未設定は旧端末/未移行の重要処理を拒否する。
  return {
    ok: false,
    code: ACTIVE_DEVICE_MISMATCH,
    httpsError: createActiveDeviceMismatchError(),
  };

  return { ok: true, deviceId: extracted.deviceId };
}

async function evaluateActiveDeviceGateForRequest({
  admin,
  uid,
  data,
  allowPendingDevice = false,
}) {
  return evaluateActiveDeviceGate({
    uid,
    data,
    allowPendingDevice,
    getUserData: async (userId) => {
      const snap = await admin.getDb().collection("users").doc(userId).get();
      return snap.exists ? snap.data() || {} : {};
    },
  });
}

async function assertActiveDeviceAllowed({
  admin,
  uid,
  data,
  allowPendingDevice = false,
}) {
  const result = await evaluateActiveDeviceGateForRequest({
    admin,
    uid,
    data,
    allowPendingDevice,
  });
  if (!result.ok) {
    throw result.httpsError;
  }
  return result.deviceId;
}

module.exports = {
  ACTIVE_DEVICE_MISMATCH,
  INVALID_DEVICE_ID,
  extractRequestDeviceId,
  evaluateActiveDeviceGate,
  evaluateActiveDeviceGateForRequest,
  assertActiveDeviceAllowed,
};
