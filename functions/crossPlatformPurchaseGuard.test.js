"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { evaluateCrossPlatformPurchaseGuard } = require("./accountAccessUsability");

const now = new Date("2026-07-18T12:00:00.000Z");
const future = new Date("2026-08-01T00:00:00.000Z");
const past = new Date("2026-06-01T00:00:00.000Z");

function assertGuard(userData, purchasingPlatform, expected) {
  const result = evaluateCrossPlatformPurchaseGuard({
    userData,
    purchasingPlatform,
    now,
  });
  assert.equal(result.block, expected.block, JSON.stringify({ userData, purchasingPlatform }));
  if (Object.prototype.hasOwnProperty.call(expected, "reason")) {
    assert.equal(result.reason, expected.reason);
  }
  if (Object.prototype.hasOwnProperty.call(expected, "decisionSource")) {
    assert.equal(result.decisionSource, expected.decisionSource);
  }
  if (Object.prototype.hasOwnProperty.call(expected, "otherPlatformActive")) {
    assert.equal(result.otherPlatformActive, expected.otherPlatformActive);
  }
}

assertGuard(
  {
    entitlementUsable: true,
    entitlementExpiryTime: future,
    entitlementSource: "ios",
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "android",
  {
    block: true,
    reason: "block_other_platform_entitlement",
    decisionSource: "entitlement",
    otherPlatformActive: true,
  }
);

assertGuard(
  {
    entitlementUsable: true,
    entitlementExpiryTime: future,
    entitlementSource: "android",
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "android",
  },
  "ios",
  {
    block: true,
    reason: "block_other_platform_entitlement",
    decisionSource: "entitlement",
    otherPlatformActive: true,
  }
);

assertGuard(
  {
    entitlementUsable: true,
    entitlementExpiryTime: future,
    entitlementSource: "ios",
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "ios",
  {
    block: false,
    reason: "allow_same_platform",
    decisionSource: "entitlement",
  }
);

assertGuard(
  {
    entitlementUsable: true,
    entitlementExpiryTime: future,
    entitlementSource: "android",
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "android",
  },
  "android",
  {
    block: false,
    reason: "allow_same_platform",
    decisionSource: "entitlement",
  }
);

assertGuard(
  {
    entitlementUsable: false,
    entitlementExpiryTime: future,
    entitlementSource: "ios",
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "android",
  {
    block: false,
    reason: "allow_entitlement_false",
    decisionSource: "entitlement",
  }
);

assertGuard(
  {
    entitlementUsable: true,
    entitlementExpiryTime: past,
    entitlementSource: "ios",
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "android",
  {
    block: false,
    reason: "allow_entitlement_expired",
    decisionSource: "entitlement",
  }
);

assertGuard(
  {
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "android",
  {
    block: true,
    reason: "block_legacy_other_platform",
    decisionSource: "legacyFallback",
    otherPlatformActive: true,
  }
);

assertGuard(
  {
    subscriptionStatus: "active",
    subscriptionExpiryTime: past,
    subscriptionPlatform: "ios",
  },
  "android",
  {
    block: false,
    reason: "allow_legacy_or_missing",
    decisionSource: "legacyFallback",
  }
);

assertGuard(
  {
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "ios",
  {
    block: false,
    reason: "allow_legacy_or_missing",
    decisionSource: "legacyFallback",
  }
);

assertGuard(
  {
    entitlementUsable: true,
    entitlementExpiryTime: future,
    entitlementSource: null,
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "android",
  {
    block: true,
    reason: "block_legacy_other_platform",
    decisionSource: "legacyFallback",
    otherPlatformActive: true,
  }
);

assertGuard(
  {
    entitlementUsable: true,
    entitlementExpiryTime: future,
    entitlementSource: "unknown-store",
    subscriptionStatus: "none",
    subscriptionExpiryTime: null,
    subscriptionPlatform: "",
  },
  "ios",
  {
    block: false,
    reason: "allow_entitlement_source_unknown",
    decisionSource: "entitlement",
  }
);

const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
assert.match(
  indexSource,
  /verifyGooglePlaySubscriptionPurchase[\s\S]*?assertPurchasingPlatformAllowed\(uid, "android"\)/
);
assert.match(
  indexSource,
  /verifyAppStoreSubscriptionPurchase[\s\S]*?assertPurchasingPlatformAllowed\(uid, "ios", traceId\)/
);

console.log("crossPlatformPurchaseGuard.test.js: ok");
