"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { evaluateCrossPlatformPurchaseGuard } = require("./accountAccessUsability");

const now = new Date("2026-07-18T12:00:00.000Z");
const future = new Date("2026-08-01T00:00:00.000Z");

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
  { block: false, reason: "allow_x_policy" }
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
  { block: false, reason: "allow_x_policy" }
);

assertGuard(
  {
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
    subscriptionPlatform: "ios",
  },
  "android",
  { block: false, reason: "allow_x_policy" }
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
assert.match(indexSource, /platform_mismatch\.allow_x_policy/);

console.log("crossPlatformPurchaseGuard.test.js: ok");
