const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  createClearDeviceFcmTokenHandler,
  validateClearDeviceFcmTokenInput,
} = require("./clearDeviceFcmToken");

const DEVICE_A = "550e8400-e29b-41d4-a716-446655440000";
const DEVICE_B = "550e8400-e29b-41d4-a716-446655440001";
const DEVICE_C = "550e8400-e29b-41d4-a716-446655440002";
const OWNER_UID = "owner-uid-001";
const OTHER_UID = "other-uid-001";
const TOKEN_A = "token-a";
const TOKEN_B = "token-b";
const TOKEN_C = "token-c";

function applyMerge(existing, data) {
  const next = { ...existing };
  for (const [field, value] of Object.entries(data)) {
    if (value && value.__type === "delete") {
      delete next[field];
    } else {
      next[field] = value;
    }
  }
  return next;
}

function createMockAdmin(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs));
  function docPath(uid, deviceId) {
    return `users/${uid}/devices/${deviceId}`;
  }
  return {
    FieldValue: {
      delete() {
        return { __type: "delete" };
      },
    },
    getDb() {
      return {
        collection(name) {
          assert.equal(name, "users");
          return {
            doc(uid) {
              return {
                collection(subName) {
                  assert.equal(subName, "devices");
                  return {
                    doc(deviceId) {
                      const key = docPath(uid, deviceId);
                      return {
                        async get() {
                          const value = docs.get(key);
                          return {
                            exists: value != null,
                            data: () => value,
                          };
                        },
                        async set(data, options = {}) {
                          if (!options.merge) {
                            docs.set(key, { ...data });
                            return;
                          }
                          docs.set(key, applyMerge(docs.get(key) || {}, data));
                        },
                      };
                    },
                  };
                },
              };
            },
          };
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
    return { ok: true, result: await handler(request) };
  } catch (error) {
    return { ok: false, error };
  }
}

function seedThreeDevices(admin) {
  const analytics = {
    platform: "android",
    modelName: "keep-me",
    appVersion: "6.0.0",
    buildNumber: "252",
    firstUsedAt: { t: 1 },
    lastUsedAt: { t: 2 },
  };
  admin.docs.set(`users/${OWNER_UID}/devices/${DEVICE_A}`, {
    ...analytics,
    deviceId: DEVICE_A,
    fcmToken: TOKEN_A,
    fcmUpdatedAt: { t: 3 },
  });
  admin.docs.set(`users/${OWNER_UID}/devices/${DEVICE_B}`, {
    ...analytics,
    deviceId: DEVICE_B,
    platform: "android",
    modelName: "Pixel",
    fcmToken: TOKEN_B,
    fcmUpdatedAt: { t: 3 },
  });
  admin.docs.set(`users/${OWNER_UID}/devices/${DEVICE_C}`, {
    ...analytics,
    deviceId: DEVICE_C,
    platform: "ios",
    modelName: "iPhone",
    fcmToken: TOKEN_C,
    fcmUpdatedAt: { t: 3 },
  });
}

async function run() {
  assert.throws(
    () => validateClearDeviceFcmTokenInput({ deviceId: "bad" }),
    (error) => error instanceof HttpsError && error.code === "invalid-argument"
  );

  const admin = createMockAdmin();
  seedThreeDevices(admin);
  const handler = createClearDeviceFcmTokenHandler({
    admin,
    logger: createTestLogger(),
  });

  const unauth = await runHandler(handler, {
    auth: null,
    data: { deviceId: DEVICE_A },
  });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error.code, "unauthenticated");

  const clearedA = await runHandler(handler, {
    auth: { uid: OWNER_UID },
    data: { deviceId: DEVICE_A },
  });
  assert.equal(clearedA.ok, true);
  assert.equal(clearedA.result.cleared, true);
  const docA = admin.docs.get(`users/${OWNER_UID}/devices/${DEVICE_A}`);
  const docB = admin.docs.get(`users/${OWNER_UID}/devices/${DEVICE_B}`);
  const docC = admin.docs.get(`users/${OWNER_UID}/devices/${DEVICE_C}`);
  assert.equal(docA.fcmToken, undefined);
  assert.equal(docA.fcmUpdatedAt, undefined);
  assert.equal(docA.platform, "android");
  assert.equal(docA.modelName, "keep-me");
  assert.equal(docA.appVersion, "6.0.0");
  assert.equal(docA.buildNumber, "252");
  assert.deepEqual(docA.firstUsedAt, { t: 1 });
  assert.deepEqual(docA.lastUsedAt, { t: 2 });
  assert.equal(docB.fcmToken, TOKEN_B);
  assert.equal(docC.fcmToken, TOKEN_C);

  const otherAdmin = createMockAdmin();
  seedThreeDevices(otherAdmin);
  const otherHandler = createClearDeviceFcmTokenHandler({
    admin: otherAdmin,
    logger: createTestLogger(),
  });
  const otherUser = await runHandler(otherHandler, {
    auth: { uid: OTHER_UID },
    data: { deviceId: DEVICE_A },
  });
  assert.equal(otherUser.ok, true);
  assert.equal(otherUser.result.cleared, false);
  assert.equal(
    otherAdmin.docs.get(`users/${OWNER_UID}/devices/${DEVICE_A}`).fcmToken,
    TOKEN_A
  );
  assert.equal(
    otherAdmin.docs.has(`users/${OTHER_UID}/devices/${DEVICE_A}`),
    false
  );

  const missing = await runHandler(handler, {
    auth: { uid: OWNER_UID },
    data: { deviceId: "550e8400-e29b-41d4-a716-446655440099" },
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.result.cleared, false);

  const invalidId = await runHandler(handler, {
    auth: { uid: OWNER_UID },
    data: { deviceId: "not-a-uuid" },
  });
  assert.equal(invalidId.ok, false);
  assert.equal(invalidId.error.code, "invalid-argument");

  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(
    indexSource,
    /exports\.clearDeviceFcmToken = onCall\([\s\S]*enforceAppCheck: true/
  );

  console.log("clearDeviceFcmToken.test.js: ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
