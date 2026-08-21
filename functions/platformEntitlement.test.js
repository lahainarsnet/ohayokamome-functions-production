"use strict";

const assert = require("node:assert/strict");
const { evaluatePlatformEntitlement } = require("./platformEntitlement");

const now = new Date("2026-08-21T12:00:00.000Z");
const future = new Date("2026-09-01T00:00:00.000Z");
const past = new Date("2026-08-01T00:00:00.000Z");

function assertUsable(userData, platform, expectedUsable, extras = {}) {
  const result = evaluatePlatformEntitlement(userData, platform, now);
  assert.equal(
    result.usable,
    expectedUsable,
    JSON.stringify({ userData, platform, result })
  );
  if (extras.decisionSource) {
    assert.equal(result.decisionSource, extras.decisionSource);
  }
  if (extras.denyReason) {
    assert.equal(result.denyReason, extras.denyReason);
  }
}

assertUsable(
  {
    subscriptions: {
      ios: { status: "active", expiryTime: future },
    },
  },
  "ios",
  true,
  { decisionSource: "store" }
);

assertUsable(
  {
    entitlementUsable: true,
    entitlementExpiryTime: future,
    entitlementSource: "android",
    subscriptions: {
      android: { status: "active", expiryTime: future },
    },
  },
  "ios",
  false,
  { decisionSource: "legacyFallback", denyReason: "legacy_platform_mismatch" }
);

assertUsable(
  {
    subscriptions: {
      android: { status: "active", expiryTime: future },
    },
  },
  "android",
  true,
  { decisionSource: "store" }
);

assertUsable(
  {
    entitlementUsable: true,
    entitlementExpiryTime: future,
    entitlementSource: "ios",
    subscriptions: {
      ios: { status: "active", expiryTime: future },
    },
  },
  "android",
  false
);

assertUsable(
  {
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "ios",
  true,
  { decisionSource: "legacyFallback" }
);

assertUsable(
  {
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "android",
  },
  "ios",
  false,
  { decisionSource: "legacyFallback", denyReason: "legacy_other_platform" }
);

assertUsable(
  {
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "android",
  },
  "android",
  true,
  { decisionSource: "legacyFallback" }
);

assertUsable(
  {
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "android",
  false,
  { decisionSource: "legacyFallback", denyReason: "legacy_other_platform" }
);

assertUsable(
  {
    subscriptions: {
      ios: { status: "expired", expiryTime: past },
    },
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "ios",
  false,
  { decisionSource: "store" }
);

assertUsable(
  {
    entitlementUsable: true,
    entitlementExpiryTime: future,
    entitlementSource: "ios",
    subscriptions: {
      android: { status: "active", expiryTime: future },
    },
  },
  "ios",
  false
);

console.log("platformEntitlement.test.js: ok");
