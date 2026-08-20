const assert = require("node:assert/strict");
const {
  MAX_CHAT_PUSH_TOKENS,
  collectDevicePushTokens,
  resolvePushTokenSet,
  isPermanentInvalidFcmTokenError,
  toMulticastMessage,
  dispatchChatPushNotification,
} = require("./pushNotificationDispatch");

const TOKEN_A = "token-galaxy-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "token-pixel-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN_C = "token-iphone-cccccccccccccccccccccccccccccccccccccccc";

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
  const one = collectDevicePushTokens([
    { deviceId: "dev-a", fcmToken: TOKEN_A },
  ]);
  assert.deepEqual(one.tokens, [TOKEN_A]);
  assert.equal(one.deviceTokenCount, 1);
  assert.equal(one.uniqueTokenCount, 1);

  const three = collectDevicePushTokens([
    { deviceId: "dev-a", fcmToken: TOKEN_A },
    { deviceId: "dev-b", fcmToken: TOKEN_B },
    { deviceId: "dev-c", fcmToken: TOKEN_C },
  ]);
  assert.deepEqual(three.tokens, [TOKEN_A, TOKEN_B, TOKEN_C]);
  assert.equal(three.uniqueTokenCount, 3);

  const dup = collectDevicePushTokens([
    { deviceId: "dev-a", fcmToken: TOKEN_A },
    { deviceId: "dev-b", fcmToken: TOKEN_A },
    { deviceId: "dev-c", fcmToken: ` ${TOKEN_A} ` },
  ]);
  assert.deepEqual(dup.tokens, [TOKEN_A]);
  assert.equal(dup.deviceTokenCount, 3);
  assert.equal(dup.uniqueTokenCount, 1);
  assert.deepEqual(dup.tokenToDeviceIds.get(TOKEN_A), [
    "dev-a",
    "dev-b",
    "dev-c",
  ]);

  const cappedEntries = Array.from({ length: MAX_CHAT_PUSH_TOKENS + 4 }, (_, i) => ({
    deviceId: `dev-${i}`,
    fcmToken: `token-${String(i).padStart(8, "0")}-${"x".repeat(40)}`,
  }));
  const capped = collectDevicePushTokens(cappedEntries);
  assert.equal(capped.tokens.length, MAX_CHAT_PUSH_TOKENS);

  const fromDevices = resolvePushTokenSet({
    deviceEntries: [
      { deviceId: "dev-a", fcmToken: TOKEN_A },
      { deviceId: "dev-b", fcmToken: TOKEN_B },
    ],
    userFcmToken: TOKEN_C,
    embeddedToken: "embedded-should-be-ignored",
  });
  assert.equal(fromDevices.source, "devices");
  assert.deepEqual(fromDevices.tokens, [TOKEN_A, TOKEN_B]);

  const fromUser = resolvePushTokenSet({
    deviceEntries: [{ deviceId: "dev-empty", fcmToken: "  " }],
    userFcmToken: TOKEN_C,
    embeddedToken: TOKEN_A,
  });
  assert.equal(fromUser.source, "user_fcmToken");
  assert.deepEqual(fromUser.tokens, [TOKEN_C]);

  const fromEmbedded = resolvePushTokenSet({
    deviceEntries: [],
    userFcmToken: "",
    embeddedToken: TOKEN_A,
  });
  assert.equal(fromEmbedded.source, "embedded");
  assert.deepEqual(fromEmbedded.tokens, [TOKEN_A]);

  const none = resolvePushTokenSet({
    deviceEntries: [],
    userFcmToken: "",
    embeddedToken: "",
  });
  assert.equal(none.source, "none");
  assert.deepEqual(none.tokens, []);

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
  assert.equal(
    isPermanentInvalidFcmTokenError({ code: "unavailable" }),
    false
  );

  const multicast = toMulticastMessage(
    { ...basePushMessage(), token: TOKEN_A },
    [TOKEN_A, TOKEN_B]
  );
  assert.equal(multicast.token, undefined);
  assert.deepEqual(multicast.tokens, [TOKEN_A, TOKEN_B]);
  assert.equal(
    multicast.android.notification.channelId,
    "com.lahainars.tonikaku.new_message_alerts"
  );
  assert.equal(multicast.apns.payload.aps.sound, "default");
  assert.equal(multicast.apns.payload.aps.badge, 2);
  assert.equal(multicast.notification.title, "新しいメッセージ");
  assert.equal(multicast.android.priority, "high");
  assert.equal(multicast.android.collapseKey, "chat");

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
    tokenToDeviceIds: new Map([[TOKEN_A, ["dev-a"]]]),
    message: basePushMessage(),
    uid: "recipient-uid",
  });
  assert.equal(oneSend.success, true);
  assert.equal(oneSend.successCount, 1);
  assert.equal(sentOne[0].tokens.length, 1);

  const sentThree = [];
  const threeSend = await dispatchChatPushNotification({
    messaging: {
      async sendEachForMulticast(payload) {
        sentThree.push(payload);
        return {
          successCount: 3,
          failureCount: 0,
          responses: [{ success: true }, { success: true }, { success: true }],
        };
      },
    },
    tokens: [TOKEN_A, TOKEN_B, TOKEN_C],
    tokenToDeviceIds: new Map([
      [TOKEN_A, ["dev-a"]],
      [TOKEN_B, ["dev-b"]],
      [TOKEN_C, ["dev-c"]],
    ]),
    message: basePushMessage(),
    uid: "recipient-uid",
  });
  assert.equal(threeSend.successCount, 3);
  assert.equal(threeSend.failureCount, 0);
  assert.deepEqual(sentThree[0].tokens, [TOKEN_A, TOKEN_B, TOKEN_C]);

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
  const partial = await dispatchChatPushNotification({
    messaging: {
      async sendEachForMulticast() {
        return {
          successCount: 2,
          failureCount: 1,
          responses: [
            { success: true },
            { success: true },
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
    tokens: [TOKEN_A, TOKEN_B, TOKEN_C],
    tokenToDeviceIds: new Map([
      [TOKEN_A, ["dev-a"]],
      [TOKEN_B, ["dev-b"]],
      [TOKEN_C, ["dev-c"]],
    ]),
    message: basePushMessage(),
  });
  assert.equal(partial.success, true);
  assert.equal(partial.successCount, 2);
  assert.equal(partial.failureCount, 1);
  assert.equal(partial.invalidTokenClearedCount, 1);
  assert.equal(
    db.docs.get("users/recipient-uid/devices/dev-a").fcmToken,
    TOKEN_A
  );
  assert.equal(
    db.docs.get("users/recipient-uid/devices/dev-b").fcmToken,
    TOKEN_B
  );
  assert.equal(
    db.docs.get("users/recipient-uid/devices/dev-c").fcmToken,
    undefined
  );
  assert.equal(
    db.docs.get("users/recipient-uid/devices/dev-c").platform,
    "ios"
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
    tokenToDeviceIds: new Map([[TOKEN_A, ["dev-a"]]]),
    message: basePushMessage(),
  });
  assert.equal(transient.success, false);
  assert.equal(transient.invalidTokenClearedCount, 0);
  assert.equal(
    transientDb.docs.get("users/recipient-uid/devices/dev-a").fcmToken,
    TOKEN_A
  );

  console.log("pushNotificationDispatch.test.js: ok");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
