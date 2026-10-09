"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  createClaimActiveDeviceHandler,
  validateClaimActiveDeviceInput,
  CLAIM_ACTIVE_DEVICE_NEEDS_CONFIRMATION,
  CLAIM_ACTIVE_DEVICE_STALE_CLAIM,
} = require("./claimActiveDevice");
const {
  IOS_FIREBASE_APP_ID,
  ANDROID_FIREBASE_APP_ID,
} = require("./appCheckPlatform");

const DEVICE_A = "550e8400-e29b-41d4-a716-446655440000";
const DEVICE_B = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const DEVICE_C = "123e4567-e89b-12d3-a456-426614174000";
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
    info: (tag, payload) => entries.push({ tag, payload, level: "info" }),
    warn: (tag, payload) => entries.push({ tag, payload, level: "warn" }),
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

function authedRequest(uid, data, options = {}) {
  const declaredPlatform = String(data?.platform ?? "ios").toLowerCase();
  const appId =
    options.appId ??
    (declaredPlatform === "android"
      ? ANDROID_FIREBASE_APP_ID
      : IOS_FIREBASE_APP_ID);
  return {
    auth: { uid },
    app: { appId },
    data,
  };
}


async function stage5() {
  const logger = createTestLogger();
  let cases = 0;
  for (const from of ["ios", "android"]) for (const to of ["ios", "android"]) {
    for (const state of ["active", "expired", "none", "unknown", "missing", "revoked"]) {
      const user = { activeDeviceId: DEVICE_A, pendingActiveDeviceId: DEVICE_B,
        pendingActiveClaimGeneration: 1,
        chatUnknownProvisionalUntil: new Date(Date.now() + 86400000),
        subscriptions: { [to]: {status: state, expiryTime: new Date(Date.now() + 86400000)} } };
      if (state === "missing") { user.subscriptions = { [from]: { status: "active", expiryTime: new Date(Date.now()+86400000) } }; if(from === to) delete user.subscriptions[to]; }
      const admin = createMockAdmin({ [`users/${OWNER_UID}`]: user,
        [`users/${OWNER_UID}/devices/${DEVICE_A}`]: { platform: from } });
      const handler = createClaimActiveDeviceHandler({ admin, logger });
      const result = await runHandler(handler, authedRequest(OWNER_UID,
        devicePayload(DEVICE_B, { platform: to, mode: "confirmed", claimGeneration: 1 })));
      const allowed = state === "active";
      assert.equal(result.ok, allowed, `${from}->${to} ${state}`);
      assert.equal(admin.docs.get(`users/${OWNER_UID}`).activeDeviceId, allowed ? DEVICE_B : DEVICE_A);
      assert.equal(admin.docs.get(`users/${OWNER_UID}`).chatUnknownProvisionalUntil, user.chatUnknownProvisionalUntil);
      if (!allowed) assert.equal(result.error.message, "DEVICE_SWITCH_CONTRACT_NOT_ACTIVE");
      cases++;
    }
  }
  // A client's UID field never grants another account's Active contract.
  const admin = createMockAdmin({ [`users/${OWNER_UID}`]: { activeDeviceId: DEVICE_A,
    pendingActiveDeviceId: DEVICE_B, pendingActiveClaimGeneration: 1, subscriptions: { ios: {status:"unknown"} } },
    [`users/${OTHER_UID}`]: { subscriptions: {ios:{status:"active",expiryTime:new Date(Date.now()+86400000)}} } });
  const handler = createClaimActiveDeviceHandler({admin,logger});
  const result = await runHandler(handler, authedRequest(OWNER_UID, devicePayload(DEVICE_B,
    {mode:"confirmed", claimGeneration:1, uid:OTHER_UID})));
  assert.equal(result.ok,false);
  assert.equal(admin.docs.get(`users/${OWNER_UID}`).activeDeviceId, DEVICE_A);
  const spoof = await runHandler(handler, { ...authedRequest(OWNER_UID, devicePayload(DEVICE_B,
    {mode:"confirmed",claimGeneration:1,platform:"android"})), app:{appId:IOS_FIREBASE_APP_ID} });
  assert.equal(spoof.ok,false);
  assert.equal(spoof.error.message,"PLATFORM_APP_CHECK_MISMATCH");
  const changedUid = await runHandler(handler, authedRequest(OTHER_UID,
    devicePayload(DEVICE_B, {mode:"confirmed",claimGeneration:1,expectedUid:OWNER_UID})));
  assert.equal(changedUid.ok,false);
  assert.equal(changedUid.error.message,"DEVICE_SWITCH_UID_CHANGED");
  assert.equal(admin.docs.get(`users/${OTHER_UID}`).activeDeviceId,undefined);
  console.log(`Stage5 device transfer contract safety: ${cases + 3} cases passed`);
}
stage5().catch(error => { console.error(error); process.exitCode=1; });
