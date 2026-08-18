const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  createRegisterDeviceUsageHandler,
  validateRegisterDeviceUsageInput,
} = require("./registerDeviceUsage");

const VALID_DEVICE_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_UID = "other-uid-001";
const OWNER_UID = "owner-uid-001";

function createMockAdmin(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs));

  function docPath(uid, deviceId) {
    return `users/${uid}/devices/${deviceId}`;
  }

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
              return {
                collection(subName) {
                  if (subName !== "devices") {
                    throw new Error(`Unexpected subcollection: ${subName}`);
                  }
                  return {
                    doc(deviceId) {
                      const key = docPath(uid, deviceId);
                      return {
                        key,
                        async get() {
                          const value = docs.get(key);
                          return {
                            exists: value != null,
                            data: () => value,
                            get(field) {
                              return value ? value[field] : undefined;
                            },
                          };
                        },
                        async set(data) {
                          docs.set(key, { ...data });
                        },
                        async update(data) {
                          const existing = docs.get(key) || {};
                          docs.set(key, { ...existing, ...data });
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
    const result = await handler(request);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

async function run() {
  const input = validateRegisterDeviceUsageInput({
    deviceId: VALID_DEVICE_ID,
    platform: "ios",
    modelName: "iPhone14,6",
    appVersion: "6.0.0",
    buildNumber: "251",
  });
  assert.equal(input.platform, "ios");
  assert.equal(input.modelName, "iPhone14,6");

  assert.throws(
    () =>
      validateRegisterDeviceUsageInput({
        deviceId: "not-a-uuid",
        platform: "ios",
        modelName: "iPhone14,6",
        appVersion: "6.0.0",
        buildNumber: "251",
      }),
    (error) => error instanceof HttpsError && error.code === "invalid-argument"
  );

  const admin = createMockAdmin();
  const logger = createTestLogger();
  const handler = createRegisterDeviceUsageHandler({ admin, logger });

  const unauth = await runHandler(handler, {
    auth: null,
    data: {
      deviceId: VALID_DEVICE_ID,
      platform: "android",
      modelName: "Google Pixel 8a",
      appVersion: "6.0.0",
      buildNumber: "251",
    },
  });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error.code, "unauthenticated");

  const created = await runHandler(handler, {
    auth: { uid: OWNER_UID },
    data: {
      deviceId: VALID_DEVICE_ID,
      platform: "android",
      modelName: "Google Pixel 8a",
      appVersion: "6.0.0",
      buildNumber: "251",
    },
  });
  assert.equal(created.ok, true);
  assert.equal(created.result.created, true);
  const createdDoc = admin.docs.get(`users/${OWNER_UID}/devices/${VALID_DEVICE_ID}`);
  assert.equal(createdDoc.deviceId, VALID_DEVICE_ID);
  assert.ok(createdDoc.firstUsedAt);
  assert.ok(createdDoc.lastUsedAt);

  const updated = await runHandler(handler, {
    auth: { uid: OWNER_UID },
    data: {
      deviceId: VALID_DEVICE_ID,
      platform: "android",
      modelName: "Google Pixel 8a",
      appVersion: "6.0.1",
      buildNumber: "252",
    },
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.result.created, false);
  const updatedDoc = admin.docs.get(`users/${OWNER_UID}/devices/${VALID_DEVICE_ID}`);
  assert.equal(updatedDoc.appVersion, "6.0.1");
  assert.equal(updatedDoc.buildNumber, "252");
  assert.deepEqual(updatedDoc.firstUsedAt, createdDoc.firstUsedAt);
  assert.equal(updatedDoc.lastUsedAt.__type, "serverTimestamp");

  const otherUserAdmin = createMockAdmin();
  const otherHandler = createRegisterDeviceUsageHandler({
    admin: otherUserAdmin,
    logger: createTestLogger(),
  });
  const otherUser = await runHandler(otherHandler, {
    auth: { uid: OTHER_UID },
    data: {
      deviceId: VALID_DEVICE_ID,
      platform: "ios",
      modelName: "iPad14,2",
      appVersion: "6.0.0",
      buildNumber: "251",
    },
  });
  assert.equal(otherUser.ok, true);
  assert.ok(otherUserAdmin.docs.has(`users/${OTHER_UID}/devices/${VALID_DEVICE_ID}`));
  assert.ok(!otherUserAdmin.docs.has(`users/${OWNER_UID}/devices/${VALID_DEVICE_ID}`));

  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(
    indexSource,
    /exports\.registerDeviceUsage = onCall\([\s\S]*enforceAppCheck: true/
  );

  console.log("registerDeviceUsage.test.js: ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
