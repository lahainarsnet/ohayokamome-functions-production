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
  true,
  { decisionSource: "cross_platform" }
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
  true,
  { decisionSource: "cross_platform" } // Case 14: an Active iPhone contract is usable on the Android device
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
  true,
  { decisionSource: "cross_platform" }
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
  true,
  { decisionSource: "cross_platform" }
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
  true,
  { decisionSource: "cross_platform" }
);

// ---- Case 13 (Android -> iPhone): an iPhone uses the same UID's Android contract only when it is usable now ----
const { CROSS_PLATFORM_CARRY } = require("./platformEntitlement");
assert.deepEqual({ ...CROSS_PLATFORM_CARRY }, { ios: "android", android: "ios" }, "each OS carries the other OS contract (cases 13 and 14)");
const carried = evaluatePlatformEntitlement({ subscriptions: { android: { status: "active", expiryTime: future } } }, "ios", now);
assert.equal(carried.usable, true);
assert.equal(carried.decisionSource, "cross_platform");
assert.equal(carried.platform, "ios", "the answer is for the iPhone");
assert.equal(carried.sourcePlatform, "android", "the source is identifiable");
assert.equal(carried.denyReason, null);
assert.equal(carried.status, "active");
assert.equal(carried.expiryDate.getTime(), future.getTime(), "the Android period end is used (no copy, no extension)");
// own contract Active: the iPhone's own contract is used, nothing is carried
assert.equal(evaluatePlatformEntitlement({ subscriptions: { ios: { status: "active", expiryTime: future }, android: { status: "active", expiryTime: future } } }, "ios", now).decisionSource, "store");
// cancelled but still inside the paid period is usable on Android, so it is carried
assertUsable({ subscriptions: { android: { status: "canceled", expiryTime: future } } }, "ios", true, { decisionSource: "cross_platform" });
// the iPhone's own expired contract + an Active Android contract: usable (carried); both ended: not usable
assertUsable({ subscriptions: { ios: { status: "expired", expiryTime: past }, android: { status: "active", expiryTime: future } } }, "ios", true, { decisionSource: "cross_platform" });
assertUsable({ subscriptions: { ios: { status: "expired", expiryTime: past }, android: { status: "expired", expiryTime: past } } }, "ios", false);
assertUsable({ subscriptions: { android: { status: "active", expiryTime: past } } }, "ios", false, {});
for (const bad of ["unknown_value", "", "paused", "refunded", "revoked", "none"]) {
  assertUsable({ subscriptions: { android: { status: bad, expiryTime: future } } }, "ios", false);
}
// an unknown / unusable Android record never makes the iPhone usable, and the iPhone's own reason is kept
assert.notEqual(evaluatePlatformEntitlement({ subscriptions: { android: { status: "unknown_value", expiryTime: future } } }, "ios", now).decisionSource, "cross_platform");
// case 14 (iPhone -> Android): an Active iPhone contract of the same UID makes the Android device usable (carried)
const carriedToAndroid = evaluatePlatformEntitlement({ subscriptions: { ios: { status: "active", expiryTime: future } } }, "android", now);
assert.equal(carriedToAndroid.usable, true);
assert.equal(carriedToAndroid.decisionSource, "cross_platform");
assert.equal(carriedToAndroid.platform, "android");
assert.equal(carriedToAndroid.sourcePlatform, "ios");
assertUsable({ subscriptionPlatform: "ios", subscriptionStatus: "active", subscriptionExpiryTime: future }, "android", true, { decisionSource: "cross_platform" });
// an ended / unknown iPhone contract never makes the Android device usable
assertUsable({ subscriptions: { ios: { status: "expired", expiryTime: past } } }, "android", false);
assertUsable({ subscriptions: { ios: { status: "paused", expiryTime: future } } }, "android", false);
assertUsable({ subscriptions: { ios: { status: "active", expiryTime: past } } }, "android", false);
// the Android decision for an Android device is untouched by the carry rule
assert.equal(evaluatePlatformEntitlement({ subscriptions: { android: { status: "active", expiryTime: future } } }, "android", now).decisionSource, "store");
// the carry rule can be switched off per call (the strict, same-OS-only answer)
assert.equal(evaluatePlatformEntitlement({ subscriptions: { android: { status: "active", expiryTime: future } } }, "ios", now, { crossPlatform: false }).usable, false);
// an invalid platform never carries
assert.equal(evaluatePlatformEntitlement({ subscriptions: { android: { status: "active", expiryTime: future } } }, "web", now).usable, false);
// the carry never depends on aggregate fields that belong to the other OS' own state
assertUsable({ entitlementUsable: true, entitlementExpiryTime: future, entitlementSource: "ios" }, "ios", false);

console.log("platformEntitlement.test.js: ok");
