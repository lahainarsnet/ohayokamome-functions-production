"use strict";

const assert = require("node:assert/strict");
const {
  DEVICE_SWITCH_NOTICE_VERSION,
  DEVICE_SWITCH_NOTICE_ACKS_COLLECTION,
  buildDeviceSwitchNoticeAckPayload,
  createAcknowledgeDeviceSwitchNoticeHandler,
} = require("./deviceSwitchNoticeAck");

assert.equal(DEVICE_SWITCH_NOTICE_VERSION, "device_switch_notice_v1");
assert.equal(DEVICE_SWITCH_NOTICE_ACKS_COLLECTION, "device_switch_notice_acks");

const payload = buildDeviceSwitchNoticeAckPayload({
  userId: "uid-1",
  localDeviceId: "550e8400-e29b-41d4-a716-446655440000",
  noticeVersion: DEVICE_SWITCH_NOTICE_VERSION,
  appVersionName: "6.0.0",
  buildNumber: "307",
  FieldValue: { serverTimestamp: () => "SERVER_TS" },
});
assert.equal(payload.userId, "uid-1");
assert.equal(payload.localDeviceId, "550e8400-e29b-41d4-a716-446655440000");
assert.equal(payload.noticeVersion, "device_switch_notice_v1");
assert.equal(payload.acknowledgedAt, "SERVER_TS");
assert.equal(payload.appVersionName, "6.0.0");
assert.equal(payload.buildNumber, "307");
assert.equal(payload.email, undefined);

const added = [];
const handler = createAcknowledgeDeviceSwitchNoticeHandler({
  admin: {
    FieldValue: { serverTimestamp: () => "SERVER_TS" },
    getDb: () => ({
      collection: (name) => {
        assert.equal(name, "device_switch_notice_acks");
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
      localDeviceId: "550e8400-e29b-41d4-a716-446655440000",
      noticeVersion: "device_switch_notice_v1",
      appVersionName: "6.0.0",
      buildNumber: "307",
      email: "should-not-be-saved@example.com",
    },
  });
  assert.equal(added.length, 1);
  assert.equal(added[0].email, undefined);
  assert.equal(added[0].userId, "uid-1");

  let threw = false;
  try {
    await handler({
      auth: { uid: "uid-1" },
      data: {
        localDeviceId: "",
        noticeVersion: "device_switch_notice_v1",
      },
    });
  } catch (error) {
    threw = true;
    assert.equal(error.code, "invalid-argument");
  }
  assert.equal(threw, true);
  assert.equal(added.length, 1);

  console.log("deviceSwitchNoticeAck.test.js: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
