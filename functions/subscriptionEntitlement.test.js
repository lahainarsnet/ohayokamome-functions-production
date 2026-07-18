const assert = require("assert");
const {
  computeAccountEntitlement,
  isStoreEntitlementUsable,
  inferAndroidAutoRenewing,
  mergeAndroidActiveTokens,
  buildIosStoreState,
  buildAndroidStoreState,
} = require("./subscriptionEntitlement");

function runTests() {
  const now = new Date("2026-07-18T12:00:00.000Z");
  const future = new Date("2026-08-01T00:00:00.000Z");
  const later = new Date("2026-09-01T00:00:00.000Z");
  const past = new Date("2026-06-01T00:00:00.000Z");

  assert.strictEqual(
    isStoreEntitlementUsable(
      { status: "active", expiryTime: future },
      now
    ).usable,
    true
  );
  assert.strictEqual(
    isStoreEntitlementUsable(
      { status: "trial", expiryTime: future },
      now
    ).usable,
    true
  );
  assert.strictEqual(
    isStoreEntitlementUsable(
      { status: "grace", expiryTime: future },
      now
    ).usable,
    true
  );
  assert.strictEqual(
    isStoreEntitlementUsable(
      { status: "canceled", expiryTime: future },
      now
    ).usable,
    true
  );
  assert.strictEqual(
    isStoreEntitlementUsable(
      { status: "active", expiryTime: past },
      now
    ).usable,
    false
  );
  assert.strictEqual(
    isStoreEntitlementUsable(
      { status: "paused", expiryTime: future },
      now
    ).usable,
    false
  );
  assert.strictEqual(
    isStoreEntitlementUsable(
      { status: "expired", expiryTime: past },
      now
    ).usable,
    false
  );
  assert.strictEqual(
    isStoreEntitlementUsable({ status: "none", expiryTime: future }, now)
      .usable,
    false
  );

  const iosOnly = computeAccountEntitlement(
    { status: "active", expiryTime: future },
    { status: "expired", expiryTime: past },
    now
  );
  assert.strictEqual(iosOnly.entitlementUsable, true);
  assert.strictEqual(iosOnly.entitlementSource, "ios");

  const androidOnly = computeAccountEntitlement(
    { status: "expired", expiryTime: past },
    { status: "active", expiryTime: later },
    now
  );
  assert.strictEqual(androidOnly.entitlementUsable, true);
  assert.strictEqual(androidOnly.entitlementSource, "android");

  const both = computeAccountEntitlement(
    { status: "active", expiryTime: future },
    { status: "active", expiryTime: later },
    now
  );
  assert.strictEqual(both.entitlementUsable, true);
  assert.strictEqual(both.entitlementSource, "both");
  assert.strictEqual(both.entitlementExpiryTime.toISOString(), later.toISOString());

  const neither = computeAccountEntitlement(
    { status: "paused", expiryTime: future },
    { status: "expired", expiryTime: past },
    now
  );
  assert.strictEqual(neither.entitlementUsable, false);
  assert.strictEqual(neither.entitlementSource, "none");

  // Order independence
  const a = computeAccountEntitlement(
    { status: "active", expiryTime: future },
    { status: "active", expiryTime: later },
    now
  );
  const b = computeAccountEntitlement(
    { status: "active", expiryTime: later },
    { status: "active", expiryTime: future },
    now
  );
  assert.strictEqual(a.entitlementUsable, b.entitlementUsable);
  assert.strictEqual(
    a.entitlementExpiryTime.toISOString(),
    b.entitlementExpiryTime.toISOString()
  );

  assert.strictEqual(
    inferAndroidAutoRenewing({
      status: "active",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    }),
    true
  );
  assert.strictEqual(
    inferAndroidAutoRenewing({
      status: "active",
      subscriptionState: "SUBSCRIPTION_STATE_CANCELED",
    }),
    false
  );
  assert.strictEqual(
    inferAndroidAutoRenewing({
      status: "paused",
      subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD",
    }),
    false
  );

  assert.deepStrictEqual(
    mergeAndroidActiveTokens(
      { activePurchaseTokens: ["token-a"] },
      "token-b"
    ),
    ["token-a", "token-b"]
  );
  assert.deepStrictEqual(
    mergeAndroidActiveTokens(
      { activePurchaseTokens: ["token-a"] },
      "token-a"
    ),
    ["token-a"]
  );

  const ios = buildIosStoreState({
    status: "active",
    expiryTime: future,
    autoRenewing: true,
    originalTransactionId: "orig",
    transactionId: "tx",
    environment: "Sandbox",
    source: "apple_verify",
    updatedAt: "server",
  });
  assert.strictEqual(ios.status, "active");
  assert.strictEqual(ios.autoRenewing, true);

  const android = buildAndroidStoreState({
    status: "active",
    expiryTime: future,
    autoRenewing: false,
    primaryPurchaseToken: "tok",
    activePurchaseTokens: ["tok"],
    subscriptionState: "SUBSCRIPTION_STATE_CANCELED",
    source: "google_rtdn",
    updatedAt: "server",
  });
  assert.strictEqual(android.status, "active");
  assert.strictEqual(android.autoRenewing, false);

  // Missing subscriptions must not throw
  const missing = computeAccountEntitlement(null, undefined, now);
  assert.strictEqual(missing.entitlementUsable, false);
  assert.strictEqual(missing.entitlementSource, "none");

  console.log("subscriptionEntitlement.test.js: all assertions passed");
}

runTests();
