"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  createClaimActiveDeviceHandler,
  validateClaimActiveDeviceInput,
  CLAIM_ACTIVE_DEVICE_NEEDS_CONFIRMATION,
} = require("./claimActiveDevice");

const DEVICE_A = "550e8400-e29b-41d4-a716-446655440000";
const DEVICE_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const OWNER_UID = "owner-uid-001";
const OTHER_UID = "other-uid-002";
const VALID_FCM_TOKEN = "dK3exampleTokenSegment:APA91b" + "A".repeat(120);

function devicePayload(deviceId, overrides = {}) {
  return {
    deviceId,
    platform: "ios",
    modelName: "iPhone14,6",
    appVersion: "6.0.0",
    buildNumber: "257",
    ...overrides,
  };
}

function createMockAdmin(initialDocs = {}, options = {}) {
  const docs = new Map(Object.entries(initialDocs));

  return {
    FieldValue: {
      serverTimestamp() {
        return { __type: "serverTimestamp" };
      },
    },
    getDb() {
      return {
        collection(name) {
          if (name !== "users") {
            throw new Error(`Unexpected collection: ${name}`);
          }
          return {
            doc(uid) {
              const userPath = `users/${uid}`;
              return {
                path: userPath,
                collection(subName) {
                  if (subName !== "devices") {
                    throw new Error(`Unexpected subcollection: ${subName}`);
                  }
                  return {
                    doc(deviceId) {
                      return {
                        path: `${userPath}/devices/${deviceId}`,
                      };
                    },
                  };
                },
              };
            },
          };
        },
        async runTransaction(callback) {
          const pending = [];
          const tx = {
            async get(ref) {
              const value = docs.get(ref.path);
              return {
                exists: value != null,
                data: () => value,
                get(field) {
                  return value ? value[field] : undefined;
                },
              };
            },
            set(ref, data, setOptions = {}) {
              pending.push({ type: "set", ref, data, setOptions });
            },
            update(ref, data) {
              pending.push({ type: "update", ref, data });
            },
          };
          const result = await callback(tx);
          if (options.throwBeforeCommit) {
            throw new Error("simulated commit failure");
          }
          for (const op of pending) {
            if (op.type === "set") {
              if (op.setOptions.merge) {
                docs.set(op.ref.path, {
                  ...(docs.get(op.ref.path) || {}),
                  ...op.data,
                });
              } else {
                docs.set(op.ref.path, { ...op.data });
              }
            } else {
              const existing = docs.get(op.ref.path);
              if (!existing) {
                throw new Error(`Missing document: ${op.ref.path}`);
              }
              docs.set(op.ref.path, { ...existing, ...op.data });
            }
          }
          return result;
        },
      };
    },
    docs,
  };
}

function createTestLogger() {
  const entries = [];
  return {
    entries,
    info: (tag, payload) => entries.push({ tag, payload }),
  };
}

async function runHandler(handler, request) {
  try {
    const result = await handler(request);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

function authedRequest(uid, data) {
  return {
    auth: { uid },
    app: { appId: "1:test:ios:claim" },
    data,
  };
}

async function run() {
  const input = validateClaimActiveDeviceInput(devicePayload(DEVICE_A));
  assert.equal(input.deviceId, DEVICE_A);
  assert.equal(input.fcmToken, "");
  assert.equal(input.claimReason, null);
  assert.equal(input.mode, "auto");

  const confirmedInput = validateClaimActiveDeviceInput(
    devicePayload(DEVICE_A, { claimReason: "confirmed" })
  );
  assert.equal(confirmedInput.claimReason, "confirmed");
  assert.equal(confirmedInput.mode, "confirmed");
  const retryInput = validateClaimActiveDeviceInput(
    devicePayload(DEVICE_A, { claimReason: "retry" })
  );
  assert.equal(retryInput.mode, "confirmed");
  const ignoredReason = validateClaimActiveDeviceInput(
    devicePayload(DEVICE_A, { claimReason: "hack" })
  );
  assert.equal(ignoredReason.claimReason, null);
  assert.equal(ignoredReason.mode, "auto");
  const explicitAuto = validateClaimActiveDeviceInput(
    devicePayload(DEVICE_A, { mode: "auto", claimReason: "confirmed" })
  );
  assert.equal(explicitAuto.mode, "auto");
  const explicitConfirmed = validateClaimActiveDeviceInput(
    devicePayload(DEVICE_A, { mode: "confirmed" })
  );
  assert.equal(explicitConfirmed.mode, "confirmed");
  const garbageMode = validateClaimActiveDeviceInput(
    devicePayload(DEVICE_A, { mode: "switch-please" })
  );
  assert.equal(garbageMode.mode, "auto");

  assert.throws(
    () => validateClaimActiveDeviceInput(devicePayload("not-a-uuid")),
    (error) => error instanceof HttpsError && error.code === "invalid-argument"
  );

  const logger = createTestLogger();

  const unauthAdmin = createMockAdmin();
  const unauth = await runHandler(
    createClaimActiveDeviceHandler({ admin: unauthAdmin, logger }),
    {
      auth: null,
      app: { appId: "1:test:ios:claim" },
      data: devicePayload(DEVICE_A),
    }
  );
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error.code, "unauthenticated");
  assert.equal(unauthAdmin.docs.size, 0);

  const noAppAdmin = createMockAdmin();
  const noApp = await runHandler(
    createClaimActiveDeviceHandler({ admin: noAppAdmin, logger }),
    {
      auth: { uid: OWNER_UID },
      data: devicePayload(DEVICE_A),
    }
  );
  assert.equal(noApp.ok, false);
  assert.equal(noApp.error.code, "failed-precondition");
  assert.equal(noAppAdmin.docs.size, 0);

  const invalidAdmin = createMockAdmin();
  const invalid = await runHandler(
    createClaimActiveDeviceHandler({ admin: invalidAdmin, logger }),
    authedRequest(OWNER_UID, devicePayload("bad-id"))
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "invalid-argument");
  assert.equal(invalidAdmin.docs.size, 0);

  const firstAdmin = createMockAdmin();
  const first = await runHandler(
    createClaimActiveDeviceHandler({ admin: firstAdmin, logger }),
    authedRequest(OWNER_UID, devicePayload(DEVICE_A))
  );
  assert.equal(first.ok, true);
  assert.equal(first.result.ok, true);
  assert.equal(first.result.created, true);
  assert.equal(first.result.switched, false);
  const firstUser = firstAdmin.docs.get(`users/${OWNER_UID}`);
  assert.equal(firstUser.activeDeviceId, DEVICE_A);
  assert.equal(firstUser.activeDeviceUpdatedAt.__type, "serverTimestamp");
  const firstDevice = firstAdmin.docs.get(
    `users/${OWNER_UID}/devices/${DEVICE_A}`
  );
  assert.equal(firstDevice.deviceId, DEVICE_A);
  assert.ok(firstDevice.firstUsedAt);
  assert.ok(firstDevice.lastUsedAt);

  const emptyAutoAdmin = createMockAdmin();
  const emptyAuto = await runHandler(
    createClaimActiveDeviceHandler({ admin: emptyAutoAdmin, logger }),
    authedRequest(
      OWNER_UID,
      devicePayload(DEVICE_A, { mode: "auto", claimReason: "auto" })
    )
  );
  assert.equal(emptyAuto.ok, true);
  assert.equal(emptyAuto.result.created, true);
  assert.equal(emptyAuto.result.switched, false);
  assert.equal(emptyAutoAdmin.docs.get(`users/${OWNER_UID}`).activeDeviceId, DEVICE_A);

  const sameAdmin = createMockAdmin({
    [`users/${OWNER_UID}`]: {
      email: "owner@example.com",
      accountId: "acc-001",
      subscriptionStatus: "active",
      activeDeviceId: DEVICE_A,
    },
    [`users/${OWNER_UID}/devices/${DEVICE_A}`]: {
      deviceId: DEVICE_A,
      platform: "ios",
      modelName: "iPhone14,6",
      appVersion: "6.0.0",
      buildNumber: "256",
      firstUsedAt: { __type: "existing" },
    },
  });
  const same = await runHandler(
    createClaimActiveDeviceHandler({ admin: sameAdmin, logger }),
    authedRequest(OWNER_UID, devicePayload(DEVICE_A, { buildNumber: "257" }))
  );
  assert.equal(same.ok, true);
  assert.equal(same.result.created, false);
  assert.equal(same.result.switched, false);
  const sameUser = sameAdmin.docs.get(`users/${OWNER_UID}`);
  assert.equal(sameUser.activeDeviceId, DEVICE_A);
  assert.equal(sameUser.email, "owner@example.com");
  assert.equal(sameUser.accountId, "acc-001");
  assert.equal(sameUser.subscriptionStatus, "active");
  const sameDevice = sameAdmin.docs.get(
    `users/${OWNER_UID}/devices/${DEVICE_A}`
  );
  assert.equal(sameDevice.buildNumber, "257");
  assert.deepEqual(sameDevice.firstUsedAt, { __type: "existing" });

  const sameAuto = await runHandler(
    createClaimActiveDeviceHandler({ admin: sameAdmin, logger }),
    authedRequest(
      OWNER_UID,
      devicePayload(DEVICE_A, { mode: "auto", buildNumber: "258" })
    )
  );
  assert.equal(sameAuto.ok, true);
  assert.equal(sameAuto.result.switched, false);
  assert.equal(sameAdmin.docs.get(`users/${OWNER_UID}`).activeDeviceId, DEVICE_A);

  const sameConfirmed = await runHandler(
    createClaimActiveDeviceHandler({ admin: sameAdmin, logger }),
    authedRequest(
      OWNER_UID,
      devicePayload(DEVICE_A, { mode: "confirmed", buildNumber: "259" })
    )
  );
  assert.equal(sameConfirmed.ok, true);
  assert.equal(sameConfirmed.result.switched, false);
  assert.equal(sameAdmin.docs.get(`users/${OWNER_UID}`).activeDeviceId, DEVICE_A);

  const switchAdmin = createMockAdmin({
    [`users/${OWNER_UID}`]: {
      email: "owner@example.com",
      activeDeviceId: DEVICE_A,
      dailyCount: 3,
    },
    [`users/${OWNER_UID}/devices/${DEVICE_A}`]: {
      deviceId: DEVICE_A,
      platform: "ios",
      fcmToken: "old-token",
      historyMarker: "keep-a",
    },
  });
  const switched = await runHandler(
    createClaimActiveDeviceHandler({ admin: switchAdmin, logger }),
    authedRequest(
      OWNER_UID,
      devicePayload(DEVICE_B, {
        platform: "android",
        modelName: "Google Pixel 8a",
        fcmToken: VALID_FCM_TOKEN,
        claimReason: "confirmed",
        mode: "confirmed",
      })
    )
  );
  assert.equal(switched.ok, true);
  assert.equal(switched.result.created, true);
  assert.equal(switched.result.switched, true);
  const switchedUser = switchAdmin.docs.get(`users/${OWNER_UID}`);
  assert.equal(switchedUser.activeDeviceId, DEVICE_B);
  assert.equal(switchedUser.fcmToken, VALID_FCM_TOKEN);
  assert.equal(switchedUser.email, "owner@example.com");
  assert.equal(switchedUser.dailyCount, 3);
  const keptA = switchAdmin.docs.get(`users/${OWNER_UID}/devices/${DEVICE_A}`);
  assert.equal(keptA.historyMarker, "keep-a");
  assert.equal(keptA.fcmToken, "old-token");
  const createdB = switchAdmin.docs.get(`users/${OWNER_UID}/devices/${DEVICE_B}`);
  assert.equal(createdB.deviceId, DEVICE_B);
  assert.equal(createdB.fcmToken, VALID_FCM_TOKEN);
  assert.equal(switchedUser.claimReason, undefined);
  const switchLogs = logger.entries.filter(
    (entry) =>
      entry.payload &&
      (entry.payload.event === "claim_active_device.start" ||
        entry.payload.event === "claim_active_device.success") &&
      entry.payload.newDeviceIdSuffix === DEVICE_B.slice(-6)
  );
  assert.equal(switchLogs[0].payload.event, "claim_active_device.start");
  assert.equal(switchLogs[0].payload.reason, "confirmed");
  assert.equal(switchLogs[0].payload.mode, "confirmed");
  assert.equal(switchLogs[0].payload.uidSuffix, OWNER_UID.slice(-6));
  assert.equal(switchLogs[1].payload.event, "claim_active_device.success");
  assert.equal(switchLogs[1].payload.reason, "confirmed");
  assert.equal(switchLogs[1].payload.mode, "confirmed");
  assert.equal(switchLogs[1].payload.previousDeviceIdSuffix, DEVICE_A.slice(-6));
  assert.equal(switchLogs[1].payload.newDeviceIdSuffix, DEVICE_B.slice(-6));

  const autoBlockedAdmin = createMockAdmin({
    [`users/${OWNER_UID}`]: {
      email: "owner@example.com",
      activeDeviceId: DEVICE_A,
    },
    [`users/${OWNER_UID}/devices/${DEVICE_A}`]: {
      deviceId: DEVICE_A,
      historyMarker: "keep-a",
    },
  });
  const autoBlocked = await runHandler(
    createClaimActiveDeviceHandler({ admin: autoBlockedAdmin, logger }),
    authedRequest(
      OWNER_UID,
      devicePayload(DEVICE_B, {
        platform: "android",
        mode: "auto",
        claimReason: "auto",
      })
    )
  );
  assert.equal(autoBlocked.ok, false);
  assert.equal(autoBlocked.error.code, "failed-precondition");
  assert.equal(autoBlocked.error.message, CLAIM_ACTIVE_DEVICE_NEEDS_CONFIRMATION);
  assert.equal(autoBlocked.error.details.code, CLAIM_ACTIVE_DEVICE_NEEDS_CONFIRMATION);
  assert.equal(
    autoBlockedAdmin.docs.get(`users/${OWNER_UID}`).activeDeviceId,
    DEVICE_A
  );
  assert.ok(!autoBlockedAdmin.docs.has(`users/${OWNER_UID}/devices/${DEVICE_B}`));
  assert.equal(
    autoBlockedAdmin.docs.get(`users/${OWNER_UID}/devices/${DEVICE_A}`).historyMarker,
    "keep-a"
  );

  const missingModeAdmin = createMockAdmin({
    [`users/${OWNER_UID}`]: { activeDeviceId: DEVICE_A },
  });
  const missingMode = await runHandler(
    createClaimActiveDeviceHandler({ admin: missingModeAdmin, logger }),
    authedRequest(OWNER_UID, devicePayload(DEVICE_B, { platform: "android" }))
  );
  assert.equal(missingMode.ok, false);
  assert.equal(missingMode.error.message, CLAIM_ACTIVE_DEVICE_NEEDS_CONFIRMATION);
  assert.equal(
    missingModeAdmin.docs.get(`users/${OWNER_UID}`).activeDeviceId,
    DEVICE_A
  );

  const failAdmin = createMockAdmin(
    {
      [`users/${OWNER_UID}`]: {
        email: "owner@example.com",
        activeDeviceId: DEVICE_A,
      },
      [`users/${OWNER_UID}/devices/${DEVICE_A}`]: {
        deviceId: DEVICE_A,
        historyMarker: "keep-a",
      },
    },
    { throwBeforeCommit: true }
  );
  const failed = await runHandler(
    createClaimActiveDeviceHandler({ admin: failAdmin, logger }),
    authedRequest(
      OWNER_UID,
      devicePayload(DEVICE_B, { platform: "android", mode: "confirmed" })
    )
  );
  assert.equal(failed.ok, false);
  const failedUser = failAdmin.docs.get(`users/${OWNER_UID}`);
  assert.equal(failedUser.activeDeviceId, DEVICE_A);
  assert.ok(
    !failAdmin.docs.has(`users/${OWNER_UID}/devices/${DEVICE_B}`)
  );
  assert.equal(
    failAdmin.docs.get(`users/${OWNER_UID}/devices/${DEVICE_A}`).historyMarker,
    "keep-a"
  );

  const otherAdmin = createMockAdmin({
    [`users/${OWNER_UID}`]: { activeDeviceId: DEVICE_A, email: "owner@example.com" },
  });
  const other = await runHandler(
    createClaimActiveDeviceHandler({ admin: otherAdmin, logger }),
    authedRequest(OTHER_UID, devicePayload(DEVICE_B, { platform: "android" }))
  );
  assert.equal(other.ok, true);
  assert.equal(
    otherAdmin.docs.get(`users/${OWNER_UID}`).activeDeviceId,
    DEVICE_A
  );
  assert.equal(
    otherAdmin.docs.get(`users/${OTHER_UID}`).activeDeviceId,
    DEVICE_B
  );
  assert.ok(!otherAdmin.docs.has(`users/${OWNER_UID}/devices/${DEVICE_B}`));

  const reserveAdmin = createMockAdmin({
    [`users/${OWNER_UID}`]: {
      email: "owner@example.com",
      activeDeviceId: DEVICE_A,
    },
    [`users/${OWNER_UID}/devices/${DEVICE_A}`]: {
      deviceId: DEVICE_A,
    },
  });
  const reserved = await runHandler(
    createClaimActiveDeviceHandler({ admin: reserveAdmin, logger }),
    authedRequest(
      OWNER_UID,
      devicePayload(DEVICE_B, {
        mode: "reserve",
        claimReason: "reserve",
      })
    )
  );
  assert.equal(reserved.ok, true);
  const reservedUser = reserveAdmin.docs.get(`users/${OWNER_UID}`);
  assert.equal(reservedUser.activeDeviceId, DEVICE_A);
  assert.equal(reservedUser.pendingActiveDeviceId, DEVICE_B);

  const promoted = await runHandler(
    createClaimActiveDeviceHandler({ admin: reserveAdmin, logger }),
    authedRequest(
      OWNER_UID,
      devicePayload(DEVICE_B, {
        mode: "confirmed",
        claimReason: "confirmed",
      })
    )
  );
  assert.equal(promoted.ok, true);
  const promotedUser = reserveAdmin.docs.get(`users/${OWNER_UID}`);
  assert.equal(promotedUser.activeDeviceId, DEVICE_B);
  assert.equal(promotedUser.pendingActiveDeviceId, "");

  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(
    indexSource,
    /exports\.claimActiveDevice = onCall\([\s\S]*enforceAppCheck: true/
  );
  assert.match(indexSource, /createClaimActiveDeviceHandler/);
  assert.match(indexSource, /exports\.registerDeviceUsage = onCall/);
  assert.match(indexSource, /exports\.registerDeviceFcmToken = onCall/);
  assert.notEqual(
    indexSource.indexOf("exports.claimActiveDevice"),
    indexSource.indexOf("exports.registerDeviceUsage")
  );
  assert.notEqual(
    indexSource.indexOf("exports.claimActiveDevice"),
    indexSource.indexOf("exports.registerDeviceFcmToken")
  );

  console.log("claimActiveDevice.test.js: ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
