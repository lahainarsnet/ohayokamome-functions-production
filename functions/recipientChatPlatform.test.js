"use strict";

const assert = require("node:assert/strict");
const {
  resolveRecipientPlatformForChatEntitlement,
} = require("./recipientChatPlatform");
const {
  resolveChatEntitlementWithUnknownProvisional,
  CHAT_CONTRACT_OUTCOME,
} = require("./chatUnknownProvisional");

const now = new Date("2026-10-10T12:00:00.000Z");
const future = new Date("2026-10-11T12:00:00.000Z");

assert.deepEqual(
  resolveRecipientPlatformForChatEntitlement({
    platform: "android",
    platformAppCheckVerified: true,
  }),
  { platform: "android", source: "activeDeviceVerified" },
);

assert.deepEqual(
  resolveRecipientPlatformForChatEntitlement({
    platform: "ios",
    platformAppCheckVerified: false,
  }),
  { platform: null, source: "activeDeviceUnverified" },
);

assert.deepEqual(
  resolveRecipientPlatformForChatEntitlement(
    { subscriptionPlatform: "ios" },
  ),
  { platform: null, source: "unresolved" },
);

assert.deepEqual(
  resolveRecipientPlatformForChatEntitlement({
    subscriptions: {
      android: { status: "active", expiryTime: future },
    },
  }),
  { platform: null, source: "unresolved" },
);

assert.deepEqual(
  resolveRecipientPlatformForChatEntitlement(null),
  { platform: null, source: "unresolved" },
);

const recipientAndroidActive = {
  subscriptions: {
    android: { status: "active", expiryTime: future },
  },
  activeDeviceId: "dev-android",
};

const resolvedAndroid = resolveRecipientPlatformForChatEntitlement({
  platform: "android",
  platformAppCheckVerified: true,
}).platform;

for (const senderPlatform of ["ios", "android"]) {
  const chat = resolveChatEntitlementWithUnknownProvisional(
    recipientAndroidActive,
    resolvedAndroid,
    now,
  );
  assert.equal(chat.allowed, true, `sender=${senderPlatform}`);
  assert.equal(chat.contractState, CHAT_CONTRACT_OUTCOME.active);
}

const expiredWithProvisional = {
  subscriptions: {
    ios: { status: "expired", expiryTime: now },
  },
  chatUnknownProvisionalUntil: { seconds: Math.floor(future.getTime() / 1000) },
};
const iosPlatform = resolveRecipientPlatformForChatEntitlement({
  platform: "ios",
  platformAppCheckVerified: true,
}).platform;
const expiredChat = resolveChatEntitlementWithUnknownProvisional(
  expiredWithProvisional,
  iosPlatform,
  now,
);
assert.equal(expiredChat.allowed, false);
assert.equal(expiredChat.definitiveDeny, true);

const unknownEmptyStatus = {
  subscriptions: {
    ios: { status: "", expiryTime: future },
  },
  chatUnknownProvisionalUntil: { seconds: Math.floor(future.getTime() / 1000) },
};
const unknownChat = resolveChatEntitlementWithUnknownProvisional(
  unknownEmptyStatus,
  "ios",
  now,
);
assert.equal(unknownChat.allowed, true);
assert.equal(unknownChat.provisionalUsed, true);

console.log("recipientChatPlatform.test.js: ok");

const { resolveRecipientChatEntitlement, readActiveDevicePlatformInfo } = require('./recipientChatPlatform');
async function receiverBehavior() {
  let cases = 0;
  for (const receiver of ['ios', 'android']) {
    const other = receiver === 'ios' ? 'android' : 'ios';
    const info = { platform: receiver, platformAppCheckVerified: true };
    for (const sender of ['ios', 'android']) {
      for (const [status, grace, allowed, state] of [
        ['active', true, true, 'active'], ['expired', true, false, 'expired'],
        ['none', true, false, 'noPurchase'], ['', true, true, 'unknown'],
        ['', false, false, 'unknown'], ['unrecognized', false, false, 'unknown'],
      ]) {
        const data = {
          // Aggregate Active from the other OS must not override current OS.
          entitlementUsable: true, entitlementExpiryTime: future,
          subscriptions: { [receiver]: { status, expiryTime: future }, [other]: { status: 'active', expiryTime: future } },
          chatUnknownProvisionalUntil: grace ? future : now,
        };
        const result = resolveRecipientChatEntitlement(data, info, now);
        assert.equal(result.allowed, allowed, `${sender}->${receiver}:${status}:${grace}`);
        assert.equal(result.contractState, state);
        assert.equal(result.platform, receiver); cases++;
      }
      const otherOsOnly = { subscriptionPlatform: other, subscriptionStatus: 'active', subscriptionExpiryTime: future, chatUnknownProvisionalUntil: future };
      const stop = resolveRecipientChatEntitlement(otherOsOnly, info, now);
      assert.equal(stop.allowed, false); assert.equal(stop.contractState, 'dedicatedStop'); cases++;
    }
  }
  const unresolvedUnknown = { subscriptionPlatform: 'ios', subscriptionStatus: '', chatUnknownProvisionalUntil: future };
  assert.equal(resolveRecipientChatEntitlement(unresolvedUnknown, null, now).allowed, false);
  // Old Flutter devices cannot establish current OS, but trusted legacy Active remains usable.
  const legacyActive = { subscriptionPlatform: 'ios', subscriptionStatus: 'active', subscriptionExpiryTime: future };
  const compatible = resolveRecipientChatEntitlement(legacyActive, { platform: 'android', platformAppCheckVerified: false }, now);
  assert.equal(compatible.allowed, true); assert.equal(compatible.provisionalUsed, false);
  assert.equal(compatible.platform, null); cases += 2;
  const paths = [];
  const fakeAdmin = { getDb: () => ({ collection: name => ({ doc: uid => ({ collection: sub => ({ doc: device => ({ path: `${name}/${uid}/${sub}/${device}` }) }) }) }) }) };
  for (const [stored, verified] of [
    [{ deviceId: 'new', platform: 'android', platformAppCheckVerified: true }, true],
    [{ deviceId: 'old', platform: 'ios', platformAppCheckVerified: true }, false],
    [{ deviceId: 'new', platform: 'ios', platformAppCheckVerified: false }, false],
  ]) {
    const result = await readActiveDevicePlatformInfo({ admin: fakeAdmin, recipientId: 'receiver',
      recipientData: { activeDeviceId: 'new', subscriptionPlatform: 'ios' },
      readDocument: async ref => { paths.push(ref.path); return { exists: true, data: () => stored }; },
    });
    assert.equal(result.platformAppCheckVerified, verified);
    if (stored.deviceId === 'old') {
      const inconsistent = resolveRecipientChatEntitlement(legacyActive, result, now);
      assert.equal(inconsistent.allowed, false);
      assert.equal(inconsistent.contractState, 'dedicatedStop');
    }
    cases++;
  }
  assert.deepEqual(paths, Array(3).fill('users/receiver/devices/new'));
  console.log(`recipientChatPlatform behavioral cases: ${cases} ok`);
}
receiverBehavior().catch(error => { console.error(error); process.exitCode = 1; });
