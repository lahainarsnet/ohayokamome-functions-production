"use strict";

const assert = require("node:assert/strict");
const {
  CHAT_CONTRACT_OUTCOME,
  isChatUnknownProvisionalActive,
  classifyChatContractDenyReason,
  classifyChatPlatformEntitlement,
  resolveChatEntitlementWithUnknownProvisional,
  parseChatUnknownProvisionalUntil,
} = require("./chatUnknownProvisional");

const now = new Date("2026-10-10T12:00:00.000Z");
const future = new Date("2026-10-11T12:00:00.000Z");
const past = new Date("2026-10-09T12:00:00.000Z");

assert.equal(
  classifyChatContractDenyReason("unusable_status:expired", "expired"),
  CHAT_CONTRACT_OUTCOME.expired,
);
assert.equal(
  classifyChatContractDenyReason("unusable_status:none", "none"),
  CHAT_CONTRACT_OUTCOME.noPurchase,
);
assert.equal(
  classifyChatContractDenyReason("legacy_other_platform", null),
  CHAT_CONTRACT_OUTCOME.dedicatedStop,
);
assert.equal(
  classifyChatContractDenyReason("data_missing", null),
  CHAT_CONTRACT_OUTCOME.unknown,
);
assert.equal(
  classifyChatContractDenyReason("empty_status", "active"),
  CHAT_CONTRACT_OUTCOME.unknown,
);
assert.equal(
  classifyChatContractDenyReason("missing_store_state", null),
  CHAT_CONTRACT_OUTCOME.unknown,
);
assert.equal(
  classifyChatContractDenyReason("status_inactive", "expired"),
  CHAT_CONTRACT_OUTCOME.expired,
);
assert.equal(
  classifyChatContractDenyReason("status_inactive", "none"),
  CHAT_CONTRACT_OUTCOME.noPurchase,
);
assert.equal(
  classifyChatContractDenyReason("totally_unexpected_reason", null),
  CHAT_CONTRACT_OUTCOME.dedicatedStop,
);
assert.equal(classifyChatContractDenyReason(null, null), CHAT_CONTRACT_OUTCOME.dedicatedStop);

const activeUser = {
  subscriptions: {
    ios: { status: "active", expiryTime: future },
  },
};
assert.equal(
  classifyChatPlatformEntitlement(activeUser, "ios", now).contractState,
  CHAT_CONTRACT_OUTCOME.active,
);

const expiredUser = {
  subscriptions: {
    ios: { status: "expired", expiryTime: past },
  },
};
assert.equal(
  classifyChatPlatformEntitlement(expiredUser, "ios", now).contractState,
  CHAT_CONTRACT_OUTCOME.expired,
);

const noPurchaseUser = {
  subscriptions: {
    ios: { status: "none", expiryTime: past },
  },
};
assert.equal(
  classifyChatPlatformEntitlement(noPurchaseUser, "ios", now).contractState,
  CHAT_CONTRACT_OUTCOME.noPurchase,
);

const expiredWithProvisional = resolveChatEntitlementWithUnknownProvisional(
  {
    ...expiredUser,
    chatUnknownProvisionalUntil: { seconds: Math.floor(future.getTime() / 1000) },
  },
  "ios",
  now,
);
assert.equal(expiredWithProvisional.allowed, false);
assert.equal(expiredWithProvisional.definitiveDeny, true);

const iosOnlyStore = {
  subscriptions: {
    ios: { status: "active", expiryTime: future },
  },
};
const crossPlatformWithProvisional = resolveChatEntitlementWithUnknownProvisional(
  {
    ...iosOnlyStore,
    chatUnknownProvisionalUntil: { seconds: Math.floor(future.getTime() / 1000) },
  },
  "android",
  now,
);
assert.equal(crossPlatformWithProvisional.allowed, false);
assert.equal(crossPlatformWithProvisional.dedicatedStop, true);

const unknownWithProvisional = resolveChatEntitlementWithUnknownProvisional(
  {
    subscriptions: {
      ios: { status: "", expiryTime: future },
    },
    chatUnknownProvisionalUntil: { seconds: Math.floor(future.getTime() / 1000) },
  },
  "ios",
  now,
);
assert.equal(unknownWithProvisional.allowed, true);
assert.equal(unknownWithProvisional.provisionalUsed, true);

assert.equal(
  isChatUnknownProvisionalActive(
    { chatUnknownProvisionalUntil: { seconds: Math.floor(future.getTime() / 1000) } },
    now,
  ).active,
  true,
);

assert.equal(
  parseChatUnknownProvisionalUntil({ seconds: Math.floor(future.getTime() / 1000) })
    .toISOString(),
  future.toISOString(),
);

console.log("chatUnknownProvisional.test.js: ok");
