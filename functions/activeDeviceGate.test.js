"use strict";

const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  ACTIVE_DEVICE_MISMATCH,
  INVALID_DEVICE_ID,
  extractRequestDeviceId,
  evaluateActiveDeviceGate,
  assertActiveDeviceAllowed,
} = require("./activeDeviceGate");

const DEVICE_A = "550e8400-e29b-41d4-a716-446655440000";
const DEVICE_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const OWNER_UID = "owner-uid-001";

async function evaluate(userData, deviceId) {
  return evaluateActiveDeviceGate({
    uid: OWNER_UID,
    data: { deviceId },
    getUserData: async () => userData,
  });
}

{
  const extracted = extractRequestDeviceId({ deviceId: DEVICE_A });
  assert.equal(extracted.ok, true);
  assert.equal(extracted.deviceId, DEVICE_A);
}

{
  const missing = extractRequestDeviceId({});
  assert.equal(missing.ok, false);
  assert.equal(missing.code, INVALID_DEVICE_ID);
}

{
  const invalid = extractRequestDeviceId({ deviceId: "not-a-uuid" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, INVALID_DEVICE_ID);
}

(async () => {
  const match = await evaluate({ activeDeviceId: DEVICE_A }, DEVICE_A);
  assert.equal(match.ok, true);
  assert.equal(match.deviceId, DEVICE_A);

  const mismatch = await evaluate({ activeDeviceId: DEVICE_A }, DEVICE_B);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, ACTIVE_DEVICE_MISMATCH);
  assert.equal(mismatch.httpsError instanceof HttpsError, true);
  assert.equal(mismatch.httpsError.code, "failed-precondition");
  assert.equal(mismatch.httpsError.message, ACTIVE_DEVICE_MISMATCH);
  assert.equal(mismatch.httpsError.details.code, ACTIVE_DEVICE_MISMATCH);

  const unset = await evaluate({}, DEVICE_A);
  assert.equal(unset.ok, false);
  assert.equal(unset.code, ACTIVE_DEVICE_MISMATCH);

  const empty = await evaluate({ activeDeviceId: "   " }, DEVICE_A);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, ACTIVE_DEVICE_MISMATCH);

  const missingUser = await evaluateActiveDeviceGate({
    uid: OWNER_UID,
    data: { deviceId: DEVICE_A },
    getUserData: async () => null,
  });
  assert.equal(missingUser.ok, false);
  assert.equal(missingUser.code, ACTIVE_DEVICE_MISMATCH);

  const invalid = await evaluate({ activeDeviceId: DEVICE_A }, "bad");
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, INVALID_DEVICE_ID);
  assert.equal(invalid.httpsError.code, "invalid-argument");

  const mockAdmin = {
    getDb() {
      return {
        collection() {
          return {
            doc() {
              return {
                async get() {
                  return {
                    exists: true,
                    data: () => ({ activeDeviceId: DEVICE_A }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  const allowed = await assertActiveDeviceAllowed({
    admin: mockAdmin,
    uid: OWNER_UID,
    data: { deviceId: DEVICE_A },
  });
  assert.equal(allowed, DEVICE_A);

  let thrown = null;
  try {
    await assertActiveDeviceAllowed({
      admin: mockAdmin,
      uid: OWNER_UID,
      data: { deviceId: DEVICE_B },
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown instanceof HttpsError, true);
  assert.equal(thrown.code, "failed-precondition");
  assert.equal(thrown.details.code, ACTIVE_DEVICE_MISMATCH);

  console.log("activeDeviceGate.test.js: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
