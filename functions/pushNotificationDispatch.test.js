const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  resolveActiveDevicePushToken,
  resolvePushTokenSet,
  isPermanentInvalidFcmTokenError,
  toMulticastMessage,
  dispatchChatPushNotification,
} = require("./pushNotificationDispatch");

const TOKEN_A = "token-galaxy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "token-pixel-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN_C = "token-iphone-cccccccccccccccccccccccccccccccccccccccc";
const DEVICE_A = "dev-a";
const DEVICE_B = "dev-b";
const DEVICE_C = "dev-c";

function createMockDb(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs));
  return {
    docs,
    collection(name) {
      assert.equal(name, "users");
      return {
        doc(uid) {
          return {
            collection(subName) {
              assert.equal(subName, "devices");
              return {
                doc(deviceId) {
                  const key = `users/${uid}/devices/${deviceId}`;
                  return {
                    async set(data, options = {}) {
                      const existing = docs.get(key) || {};
                      const next = options.merge ? { ...existing } : {};
                      for (const [field, value] of Object.entries(data)) {
                        if (value && value.__type === "delete") {
                          delete next[field];
                        } else {
                          next[field] = value;
                        }
                      }
                      docs.set(key, next);
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
}

function createAdmin() {
  return {
    FieldValue: {
      delete() {
        return { __type: "delete" };
      },
    },
  };
}

function basePushMessage() {
  return {
    notification: {
      title: "新しいメッセージ",
      body: "新しいメッセージがあります",
    },
    android: {
      priority: "high",
      ttl: 6 * 3600 * 1000,
      collapseKey: "chat",
      notification: {
        channelId: "com.lahainars.tonikaku.new_message_alerts",
        title: "新しいメッセージ",
        body: "新しいメッセージがあります",
        tag: "chat_unread_summary",
        notificationCount: 2,
      },
    },
    apns: {
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert",
      },
      payload: {
        aps: {
          alert: {
            title: "新しいメッセージ",
            body: "新しいメッセージがあります",
          },
          sound: "default",
          badge: 2,
        },
      },
    },
    data: {
      senderId: "sender",
      text: "secret-should-not-be-logged-by-helper",
      unreadTotal: "2",
    },
  };
}

async function run() {
  const matchA = resolveActiveDevicePushToken({
    activeDeviceId: DEVICE_A,
    activeDeviceFcmToken: TOKEN_A,
    userFcmToken: TOKEN_C,
  });
  assert.equal(matchA.source, "active_device");
  assert.deepEqual(matchA.tokens, [TOKEN_A]);
  assert.equal(matchA.uniqueTokenCount, 1);
  assert.deepEqual(matchA.tokenToDeviceIds.get(TOKEN_A), [DEVICE_A]);

  const ignoreOthers = resolveActiveDevicePushToken({
    activeDeviceId: DEVICE_A,
    activeDeviceFcmToken: TOKEN_A,
    userFcmToken: TOKEN_B,
  });
  assert.deepEqual(ignoreOthers.tokens, [TOKEN_A]);
  assert.equal(ignoreOthers.tokens.includes(TOKEN_B), false);
  assert.equal(ignoreOthers.tokens.includes(TOKEN_C), false);

  const afterSwitch = resolveActiveDevicePushToken({
    activeDeviceId: DEVICE_B,
    activeDeviceFcmToken: TOKEN_B,
    userFcmToken: TOKEN_A,
  });
  assert.deepEqual(afterSwitch.tokens, [TOKEN_B]);
  assert.equal(afterSwitch.tokens.includes(TOKEN_A), false);

  const noToken = resolveActiveDevicePushToken({
    activeDeviceId: DEVICE_A,
    activeDeviceFcmToken: "",
    userFcmToken: TOKEN_B,
  });
  assert.equal(noToken.source, "active_device_no_token");
  assert.deepEqual(noToken.tokens, []);

  const noActive = resolveActiveDevicePushToken({
    activeDeviceId: "",
    activeDeviceFcmToken: TOKEN_A,
    userFcmToken: TOKEN_A,
  });
  assert.equal(noActive.source, "no_active_device");
  assert.deepEqual(noActive.tokens, []);

  const aliased = resolvePushTokenSet({
    activeDeviceId: DEVICE_A,
    activeDeviceFcmToken: TOKEN_A,
  });
  assert.deepEqual(aliased.tokens, [TOKEN_A]);

  assert.equal(
    isPermanentInvalidFcmTokenError({
      code: "messaging/registration-token-not-registered",
    }),
    true
  );
  assert.equal(
    isPermanentInvalidFcmTokenError({
      code: "messaging/invalid-registration-token",
    }),
    true
  );
  assert.equal(
    isPermanentInvalidFcmTokenError({ code: "messaging/internal-error" }),
    false
  );

  const multicast = toMulticastMessage(
    { ...basePushMessage(), token: TOKEN_A },
    [TOKEN_A]
  );
  assert.equal(multicast.token, undefined);
  assert.deepEqual(multicast.tokens, [TOKEN_A]);
  assert.equal(multicast.apns.payload.aps.sound, "default");
  assert.equal(multicast.android.notification.channelId,
    "com.lahainars.tonikaku.new_message_alerts");

  const sentOne = [];
  const oneSend = await dispatchChatPushNotification({
    messaging: {
      async sendEachForMulticast(payload) {
        sentOne.push(payload);
        return {
          successCount: 1,
          failureCount: 0,
          responses: [{ success: true }],
        };
      },
    },
    tokens: [TOKEN_A],
    tokenToDeviceIds: new Map([[TOKEN_A, [DEVICE_A]]]),
    message: basePushMessage(),
    uid: "recipient-uid",
  });
  assert.equal(oneSend.success, true);
  assert.equal(oneSend.successCount, 1);
  assert.deepEqual(sentOne[0].tokens, [TOKEN_A]);

  const db = createMockDb({
    "users/recipient-uid/devices/dev-a": {
      platform: "android",
      fcmToken: TOKEN_A,
      modelName: "Galaxy",
    },
    "users/recipient-uid/devices/dev-b": {
      platform: "android",
      fcmToken: TOKEN_B,
      modelName: "Pixel",
    },
    "users/recipient-uid/devices/dev-c": {
      platform: "ios",
      fcmToken: TOKEN_C,
      modelName: "iPhone",
    },
  });
  const invalidActive = await dispatchChatPushNotification({
    messaging: {
      async sendEachForMulticast() {
        return {
          successCount: 0,
          failureCount: 1,
          responses: [
            {
              success: false,
              error: { code: "messaging/registration-token-not-registered" },
            },
          ],
        };
      },
    },
    db,
    admin: createAdmin(),
    uid: "recipient-uid",
    tokens: [TOKEN_A],
    tokenToDeviceIds: new Map([[TOKEN_A, [DEVICE_A]]]),
    message: basePushMessage(),
  });
  assert.equal(invalidActive.success, false);
  assert.equal(invalidActive.invalidTokenClearedCount, 1);
  assert.equal(
    db.docs.get("users/recipient-uid/devices/dev-a").fcmToken,
    undefined
  );
  assert.equal(
    db.docs.get("users/recipient-uid/devices/dev-a").platform,
    "android"
  );
  assert.equal(
    db.docs.get("users/recipient-uid/devices/dev-b").fcmToken,
    TOKEN_B
  );
  assert.equal(
    db.docs.get("users/recipient-uid/devices/dev-c").fcmToken,
    TOKEN_C
  );
  assert.equal(
    db.docs.get("users/recipient-uid/devices/dev-c").modelName,
    "iPhone"
  );

  const transientDb = createMockDb({
    "users/recipient-uid/devices/dev-a": { fcmToken: TOKEN_A, platform: "android" },
  });
  const transient = await dispatchChatPushNotification({
    messaging: {
      async sendEachForMulticast() {
        return {
          successCount: 0,
          failureCount: 1,
          responses: [
            {
              success: false,
              error: { code: "messaging/internal-error" },
            },
          ],
        };
      },
    },
    db: transientDb,
    admin: createAdmin(),
    uid: "recipient-uid",
    tokens: [TOKEN_A],
    tokenToDeviceIds: new Map([[TOKEN_A, [DEVICE_A]]]),
    message: basePushMessage(),
  });
  assert.equal(transient.invalidTokenClearedCount, 0);
  assert.equal(
    transientDb.docs.get("users/recipient-uid/devices/dev-a").fcmToken,
    TOKEN_A
  );

  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const sendStart = indexSource.indexOf("exports.sendPushNotification");
  const sendEnd = indexSource.indexOf("exports.deleteOldMessages");
  assert.ok(sendStart >= 0 && sendEnd > sendStart);
  const sendSource = indexSource.slice(sendStart, sendEnd);
  assert.match(sendSource, /resolveActiveDevicePushToken/);
  assert.match(sendSource, /activeDeviceId/);
  assert.doesNotMatch(sendSource, /collection\("devices"\)\.get\(\)/);
  assert.doesNotMatch(sendSource, /deviceEntries/);
  assert.doesNotMatch(sendSource, /embeddedToken\)/);

  const asnSource = fs.readFileSync(
    path.join(__dirname, "appStoreSubscriptionNotifications.js"),
    "utf8"
  );
  const rtdnSource = fs.readFileSync(
    path.join(__dirname, "googlePlaySubscriptionNotifications.js"),
    "utf8"
  );
  assert.doesNotMatch(asnSource, /resolveActiveDevicePushToken|sendEachForMulticast/);
  assert.doesNotMatch(rtdnSource, /resolveActiveDevicePushToken|sendEachForMulticast/);

  console.log("pushNotificationDispatch.test.js: ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
