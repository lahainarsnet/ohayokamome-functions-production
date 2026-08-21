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
const OTHER_DEVICE_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const OTHER_UID = "other-uid-001";
const OWNER_UID = "owner-uid-001";
const VALID_FCM_TOKEN =
  "dK3exampleTokenSegment:APA91b" + "A".repeat(120);

function createMockAdmin(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs));

  function applyMerge(existing, data) {
    const next = { ...(existing || {}) };
    for (const [field, value] of Object.entries(data)) {
      next[field] = value;
    }
    return next;
  }

  function makeSnap(value) {
    return {
      exists: value != null,
      data: () => value,
      get(field) {
        return value ? value[field] : undefined;
      },
    };
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
              const userPath = `users/${uid}`;
              return {
                async get() {
                  return makeSnap(docs.get(userPath));
                },
                async set(data, options = {}) {
                  if (options.merge) {
                    docs.set(userPath, applyMerge(docs.get(userPath), data));
                    return;
                  }
                  docs.set(userPath, { ...data });
                },
                collection(subName) {
                  if (subName !== "devices") {
                    throw new Error(`Unexpected subcollection: ${subName}`);
                  }
                  return {
                    doc(deviceId) {
                      const key = `${userPath}/devices/${deviceId}`;
                      return {
                        key,
                        async get() {
                          return makeSnap(docs.get(key));
                        },
                        async set(data, options = {}) {
                          if (options.merge) {
                            docs.set(key, applyMerge(docs.get(key), data));
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

  const admin = createMockAdmin({
    [`users/${OWNER_UID}`]: {
      activeDeviceId: VALID_DEVICE_ID,
    },
  });
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
  assert.equal(
    admin.docs.get(`users/${OWNER_UID}`).fcmToken,
    VALID_FCM_TOKEN
  );

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
  admin.docs.set(`users/${OWNER_UID}`, {
    activeDeviceId: VALID_DEVICE_ID,
    fcmToken: "old-token-should-be-replaced-but-keep-other-fields-here-xxxxx",
    email: "owner@example.com",
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
  assert.equal(
    admin.docs.get(`users/${OWNER_UID}`).fcmToken,
    VALID_FCM_TOKEN
  );
  assert.equal(admin.docs.get(`users/${OWNER_UID}`).email, "owner@example.com");

  const otherUserAdmin = createMockAdmin({
    [`users/${OWNER_UID}`]: {
      activeDeviceId: VALID_DEVICE_ID,
    },
    [`users/${OWNER_UID}/devices/${VALID_DEVICE_ID}`]: {
      platform: "ios",
      fcmToken: VALID_FCM_TOKEN,
    },
    [`users/${OTHER_UID}`]: {
      activeDeviceId: VALID_DEVICE_ID,
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

  const mismatchAdmin = createMockAdmin({
    [`users/${OWNER_UID}`]: {
      activeDeviceId: VALID_DEVICE_ID,
      fcmToken: VALID_FCM_TOKEN,
    },
    [`users/${OWNER_UID}/devices/${VALID_DEVICE_ID}`]: {
      fcmToken: VALID_FCM_TOKEN,
      platform: "ios",
    },
    [`users/${OWNER_UID}/devices/${OTHER_DEVICE_ID}`]: {
      fcmToken: "old-other-device-token-should-not-be-replaced-here-xxxxx",
      platform: "android",
    },
  });
  const mismatchHandler = createRegisterDeviceFcmTokenHandler({
    admin: mismatchAdmin,
    logger: createTestLogger(),
  });
  const mismatch = await runHandler(mismatchHandler, {
    auth: { uid: OWNER_UID },
    data: {
      deviceId: OTHER_DEVICE_ID,
      fcmToken: VALID_FCM_TOKEN,
    },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "failed-precondition");
  assert.equal(mismatch.error.details.code, "ACTIVE_DEVICE_MISMATCH");
  assert.equal(
    mismatchAdmin.docs.get(`users/${OWNER_UID}/devices/${OTHER_DEVICE_ID}`)
      .fcmToken,
    "old-other-device-token-should-not-be-replaced-here-xxxxx"
  );
  assert.equal(
    mismatchAdmin.docs.get(`users/${OWNER_UID}`).fcmToken,
    VALID_FCM_TOKEN
  );

  const unsetAdmin = createMockAdmin({
    [`users/${OWNER_UID}`]: {
      email: "owner@example.com",
    },
  });
  const unsetHandler = createRegisterDeviceFcmTokenHandler({
    admin: unsetAdmin,
    logger: createTestLogger(),
  });
  const unset = await runHandler(unsetHandler, {
    auth: { uid: OWNER_UID },
    data: {
      deviceId: VALID_DEVICE_ID,
      fcmToken: VALID_FCM_TOKEN,
    },
  });
  assert.equal(unset.ok, false);
  assert.equal(unset.error.details.code, "ACTIVE_DEVICE_MISMATCH");

  const source = fs.readFileSync(path.join(__dirname, "registerDeviceFcmToken.js"), "utf8");
  assert.match(source, /assertActiveDeviceAllowed/);

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
