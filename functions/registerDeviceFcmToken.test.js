const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  createRegisterDeviceFcmTokenHandler,
  validateRegisterDeviceFcmTokenInput,
  MAX_FCM_TOKEN_LENGTH,
} = require("./registerDeviceFcmToken");

const VALID_DEVICE_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_UID = "other-uid-001";
const OWNER_UID = "owner-uid-001";
const VALID_FCM_TOKEN =
  "dK3exampleTokenSegment:APA91b" + "A".repeat(120);

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
                        async set(data, options = {}) {
                          if (options.merge) {
                            const existing = docs.get(key) || {};
                            docs.set(key, { ...existing, ...data });
                            return;
                          }
                          docs.set(key, { ...data });
                        },
                        async update(data) {
                          const existing = docs.get(key);
                          if (!existing) {
                            throw new Error(`Missing document: ${key}`);
                          }
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
  const valid = validateRegisterDeviceFcmTokenInput({
    deviceId: VALID_DEVICE_ID,
    fcmToken: VALID_FCM_TOKEN,
  });
  assert.equal(valid.deviceId, VALID_DEVICE_ID);
  assert.equal(valid.fcmToken, VALID_FCM_TOKEN);

  assert.throws(
    () =>
      validateRegisterDeviceFcmTokenInput({
        deviceId: "not-a-uuid",
        fcmToken: VALID_FCM_TOKEN,
      }),
    (error) => error instanceof HttpsError && error.code === "invalid-argument"
  );

  assert.throws(
    () =>
      validateRegisterDeviceFcmTokenInput({
        deviceId: VALID_DEVICE_ID,
        fcmToken: "",
      }),
    (error) => error instanceof HttpsError && error.code === "invalid-argument"
  );

  assert.throws(
    () =>
      validateRegisterDeviceFcmTokenInput({
        deviceId: VALID_DEVICE_ID,
        fcmToken: "short-token",
      }),
    (error) => error instanceof HttpsError && error.code === "invalid-argument"
  );

  assert.throws(
    () =>
      validateRegisterDeviceFcmTokenInput({
        deviceId: VALID_DEVICE_ID,
        fcmToken: `${VALID_FCM_TOKEN} has space`,
      }),
    (error) => error instanceof HttpsError && error.code === "invalid-argument"
  );

  assert.throws(
    () =>
      validateRegisterDeviceFcmTokenInput({
        deviceId: VALID_DEVICE_ID,
        fcmToken: "x".repeat(MAX_FCM_TOKEN_LENGTH + 1),
      }),
    (error) => error instanceof HttpsError && error.code === "invalid-argument"
  );

  const admin = createMockAdmin();
  const logger = createTestLogger();
  const handler = createRegisterDeviceFcmTokenHandler({ admin, logger });

  const unauth = await runHandler(handler, {
    auth: null,
    data: {
      deviceId: VALID_DEVICE_ID,
      fcmToken: VALID_FCM_TOKEN,
    },
  });
  assert.equal(unauth.ok, false);
  assert.equal(unauth.error.code, "unauthenticated");

  const created = await runHandler(handler, {
    auth: { uid: OWNER_UID },
    data: {
      deviceId: VALID_DEVICE_ID,
      fcmToken: VALID_FCM_TOKEN,
    },
  });
  assert.equal(created.ok, true);
  assert.equal(created.result.ok, true);
  assert.equal(created.result.created, true);
  const createdDoc = admin.docs.get(
    `users/${OWNER_UID}/devices/${VALID_DEVICE_ID}`
  );
  assert.equal(createdDoc.fcmToken, VALID_FCM_TOKEN);
  assert.equal(createdDoc.fcmUpdatedAt.__type, "serverTimestamp");
  assert.equal(createdDoc.platform, undefined);

  const existingKey = `users/${OWNER_UID}/devices/${VALID_DEVICE_ID}`;
  const existingStamp = { __type: "serverTimestamp", label: "firstUsedAt" };
  admin.docs.set(existingKey, {
    deviceId: VALID_DEVICE_ID,
    platform: "android",
    modelName: "Google Pixel 8a",
    appVersion: "6.0.0",
    buildNumber: "252",
    firstUsedAt: existingStamp,
    lastUsedAt: existingStamp,
    fcmToken: "old-token-should-be-replaced-but-keep-other-fields-here-xxxxx",
    fcmUpdatedAt: { __type: "serverTimestamp", label: "old" },
  });

  const merged = await runHandler(handler, {
    auth: { uid: OWNER_UID },
    data: {
      deviceId: VALID_DEVICE_ID,
      fcmToken: VALID_FCM_TOKEN,
    },
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.result.created, false);
  const mergedDoc = admin.docs.get(existingKey);
  assert.equal(mergedDoc.fcmToken, VALID_FCM_TOKEN);
  assert.equal(mergedDoc.fcmUpdatedAt.__type, "serverTimestamp");
  assert.notEqual(mergedDoc.fcmUpdatedAt.label, "old");
  assert.equal(mergedDoc.platform, "android");
  assert.equal(mergedDoc.modelName, "Google Pixel 8a");
  assert.equal(mergedDoc.appVersion, "6.0.0");
  assert.equal(mergedDoc.buildNumber, "252");
  assert.deepEqual(mergedDoc.firstUsedAt, existingStamp);
  assert.deepEqual(mergedDoc.lastUsedAt, existingStamp);

  const otherUserAdmin = createMockAdmin({
    [`users/${OWNER_UID}/devices/${VALID_DEVICE_ID}`]: {
      platform: "ios",
      fcmToken: VALID_FCM_TOKEN,
    },
  });
  const otherHandler = createRegisterDeviceFcmTokenHandler({
    admin: otherUserAdmin,
    logger: createTestLogger(),
  });
  const otherUser = await runHandler(otherHandler, {
    auth: { uid: OTHER_UID },
    data: {
      deviceId: VALID_DEVICE_ID,
      fcmToken: VALID_FCM_TOKEN,
    },
  });
  assert.equal(otherUser.ok, true);
  assert.ok(
    otherUserAdmin.docs.has(`users/${OTHER_UID}/devices/${VALID_DEVICE_ID}`)
  );
  assert.equal(
    otherUserAdmin.docs.get(`users/${OWNER_UID}/devices/${VALID_DEVICE_ID}`)
      .platform,
    "ios"
  );
  assert.equal(
    otherUserAdmin.docs.get(`users/${OTHER_UID}/devices/${VALID_DEVICE_ID}`)
      .fcmToken,
    VALID_FCM_TOKEN
  );

  const invalidDevice = await runHandler(handler, {
    auth: { uid: OWNER_UID },
    data: {
      deviceId: "bad-id",
      fcmToken: VALID_FCM_TOKEN,
    },
  });
  assert.equal(invalidDevice.ok, false);
  assert.equal(invalidDevice.error.code, "invalid-argument");

  const emptyToken = await runHandler(handler, {
    auth: { uid: OWNER_UID },
    data: {
      deviceId: VALID_DEVICE_ID,
      fcmToken: "   ",
    },
  });
  assert.equal(emptyToken.ok, false);
  assert.equal(emptyToken.error.code, "invalid-argument");

  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(
    indexSource,
    /exports\.registerDeviceFcmToken = onCall\([\s\S]*enforceAppCheck: true/
  );
  assert.match(
    indexSource,
    /createRegisterDeviceFcmTokenHandler\(\{\s*admin,\s*logger\s*\}\)/
  );

  console.log("registerDeviceFcmToken.test.js: ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
