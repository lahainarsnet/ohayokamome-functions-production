"use strict";

const assert = require("node:assert/strict");
const {
  CROSS_PLATFORM_SWITCH_NOTICE_VERSION,
  CROSS_PLATFORM_SWITCH_ACKS_COLLECTION,
  buildCrossPlatformSwitchAckPayload,
  createAcknowledgeCrossPlatformSwitchHandler,
} = require("./crossPlatformSwitchAck");

assert.equal(CROSS_PLATFORM_SWITCH_NOTICE_VERSION, "cross_platform_switch_v1");
assert.equal(CROSS_PLATFORM_SWITCH_ACKS_COLLECTION, "cross_platform_switch_acks");

const payload = buildCrossPlatformSwitchAckPayload({
  userId: "uid-1",
  fromPlatform: "ios",
  toPlatform: "android",
  noticeVersion: CROSS_PLATFORM_SWITCH_NOTICE_VERSION,
  appVersionName: "6.0.0",
  buildNumber: "255",
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
});
assert.equal(payload.userId, "uid-1");
assert.equal(payload.fromPlatform, "ios");
assert.equal(payload.toPlatform, "android");
assert.equal(payload.noticeVersion, "cross_platform_switch_v1");
assert.equal(payload.acknowledgedAt, "SERVER_TS");
assert.equal(payload.appVersionName, "6.0.0");
assert.equal(payload.buildNumber, "255");
assert.equal(payload.email, undefined);
assert.equal(payload.purchaseToken, undefined);
assert.equal(payload.transactionId, undefined);

const added = [];
const handler = createAcknowledgeCrossPlatformSwitchHandler({
  admin: {
    FieldValue: { serverTimestamp: () => "SERVER_TS" },
    getDb: () => ({
      collection: (name) => {
        assert.equal(name, "cross_platform_switch_acks");
        return {
          add: async (doc) => {
            added.push(doc);
            return { id: "ack-1" };
          },
        };
      },
    }),
  },
  logger: { info() {} },
});

(async () => {
  await handler({
    auth: { uid: "uid-1" },
    data: {
      fromPlatform: "ios",
      toPlatform: "android",
      noticeVersion: "cross_platform_switch_v1",
      appVersionName: "6.0.0",
      buildNumber: "255",
      email: "should-not-be-saved@example.com",
      purchaseToken: "token",
    },
  });
  assert.equal(added.length, 1);
  assert.equal(added[0].email, undefined);
  assert.equal(added[0].purchaseToken, undefined);
  assert.equal(added[0].userId, "uid-1");

  let threw = false;
  try {
    await handler({
      auth: { uid: "uid-1" },
      data: {
        fromPlatform: "ios",
        toPlatform: "ios",
        noticeVersion: "cross_platform_switch_v1",
      },
    });
  } catch (error) {
    threw = true;
    assert.equal(error.code, "invalid-argument");
  }
  assert.equal(threw, true);
  assert.equal(added.length, 1);

  console.log("crossPlatformSwitchAck.test.js: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
