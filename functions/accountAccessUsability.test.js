"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseOptionalBool,
  describeAccountAccessUsability,
} = require("./accountAccessUsability");

const now = new Date("2026-07-18T12:00:00.000Z");
const future = new Date("2026-08-01T00:00:00.000Z");
const past = new Date("2026-06-01T00:00:00.000Z");

function assertUsability(userData, expected) {
  const result = describeAccountAccessUsability(userData, now);
  assert.equal(result.subscriptionUsable, expected.subscriptionUsable, JSON.stringify(userData));
  if (Object.prototype.hasOwnProperty.call(expected, "decisionSource")) {
    assert.equal(result.decisionSource, expected.decisionSource);
  }
  if (Object.prototype.hasOwnProperty.call(expected, "entitlementUsable")) {
    assert.equal(result.entitlementUsable, expected.entitlementUsable);
  }
  if (Object.prototype.hasOwnProperty.call(expected, "denyReason")) {
    assert.equal(result.denyReason, expected.denyReason);
  }
}

assert.equal(parseOptionalBool(true), true);
assert.equal(parseOptionalBool(false), false);
assert.equal(parseOptionalBool(null), null);
assert.equal(parseOptionalBool(undefined), null);
assert.equal(parseOptionalBool("true"), null);
assert.equal(parseOptionalBool(1), null);

assertUsability(
  {
    entitlementUsable: true,
    entitlementExpiryTime: future,
    subscriptionStatus: "grace",
    subscriptionExpiryTime: past,
  },
  {
    subscriptionUsable: true,
    decisionSource: "entitlement",
    entitlementUsable: true,
  }
);

assertUsability(
  {
    entitlementUsable: true,
    entitlementExpiryTime: past,
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
  },
  {
    subscriptionUsable: false,
    decisionSource: "entitlement",
    denyReason: "expiry_expired",
  }
);

assertUsability(
  {
    entitlementUsable: true,
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
  },
  {
    subscriptionUsable: false,
    decisionSource: "entitlement",
    denyReason: "expiry_missing",
  }
);

assertUsability(
  {
    entitlementUsable: false,
    entitlementExpiryTime: future,
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
  },
  {
    subscriptionUsable: false,
    decisionSource: "entitlement",
    entitlementUsable: false,
    denyReason: "entitlement_false",
  }
);

assertUsability(
  {
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
  },
  {
    subscriptionUsable: true,
    decisionSource: "legacyFallback",
    entitlementUsable: null,
  }
);

assertUsability(
  {
    subscriptionStatus: "trial",
    subscriptionExpiryTime: future,
  },
  {
    subscriptionUsable: true,
    decisionSource: "legacyFallback",
  }
);

assertUsability(
  {
    subscriptionStatus: "grace",
    subscriptionExpiryTime: future,
  },
  {
    subscriptionUsable: false,
    decisionSource: "legacyFallback",
    denyReason: "status_inactive",
  }
);

assertUsability(
  {
    subscriptionStatus: "active",
    subscriptionExpiryTime: past,
  },
  {
    subscriptionUsable: false,
    decisionSource: "legacyFallback",
    denyReason: "expiry_expired",
  }
);

assertUsability(
  {
    entitlementUsable: "true",
    subscriptionStatus: "active",
    subscriptionExpiryTime: future,
  },
  {
    subscriptionUsable: true,
    decisionSource: "legacyFallback",
    entitlementUsable: null,
  }
);

const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const describeCalls = indexSource.match(/describeAccountAccessUsability\(/g) || [];
assert.ok(
  describeCalls.length >= 2,
  `sendMessageWithLimit should call describeAccountAccessUsability at least twice (sender+recipient), found ${describeCalls.length}`
);

console.log("accountAccessUsability.test.js: ok");
