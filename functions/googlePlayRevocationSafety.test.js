const assert = require("assert");
const {
  collectTokensForRequery,
  resolveRevocationUserEntitlement,
  deriveGooglePlayEntitlement,
} = require("./googlePlaySubscriptionNotifications");

function expiredDerived(expiryTime = "2026-01-01T00:00:00.000Z") {
  return {
    status: "expired",
    expiryTime,
    expiryDate: new Date(expiryTime),
    subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
    latestOrderId: "GPA.old",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    testPurchase: false,
    linkedPurchaseToken: "",
  };
}

function activeDerived(expiryTime = "2026-12-01T00:00:00.000Z", purchaseToken) {
  return {
    status: "active",
    expiryTime,
    expiryDate: new Date(expiryTime),
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    latestOrderId: "GPA.new",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    testPurchase: false,
    linkedPurchaseToken: "",
    purchaseToken,
  };
}

function runTests() {
  const tokens = collectTokensForRequery(
    {
      googlePlayPrimaryPurchaseToken: "token-b",
      activePurchaseTokens: ["token-a", "token-b"],
    },
    "token-a",
  );
  assert.deepStrictEqual(tokens.sort(), ["token-a", "token-b"]);

  const soleRevoked = resolveRevocationUserEntitlement({
    existingData: {
      subscriptionStatus: "active",
      subscriptionExpiryTime: "2026-12-01T00:00:00.000Z",
      activePurchaseTokens: ["token-a"],
    },
    notificationPurchaseToken: "token-a",
    notificationDerived: expiredDerived(),
    notificationTokenConfirmed: true,
    tokenResults: [
      { ok: true, purchaseToken: "token-a", derived: expiredDerived() },
    ],
  });
  assert.strictEqual(soleRevoked.action, "expire");
  assert.strictEqual(soleRevoked.derived.status, "expired");

  const delayedRevoked = resolveRevocationUserEntitlement({
    existingData: {
      subscriptionStatus: "active",
      subscriptionExpiryTime: "2026-12-01T00:00:00.000Z",
      activePurchaseTokens: ["token-a", "token-b"],
      googlePlayPrimaryPurchaseToken: "token-b",
    },
    notificationPurchaseToken: "token-a",
    notificationDerived: expiredDerived(),
    notificationTokenConfirmed: true,
    tokenResults: [
      { ok: true, purchaseToken: "token-a", derived: expiredDerived() },
      {
        ok: true,
        purchaseToken: "token-b",
        derived: activeDerived(),
      },
    ],
  });
  assert.strictEqual(delayedRevoked.action, "keep_active");
  assert.strictEqual(delayedRevoked.derived.status, "active");
  assert.strictEqual(delayedRevoked.primaryPurchaseToken, "token-b");

  const bothInvalid = resolveRevocationUserEntitlement({
    existingData: {
      subscriptionStatus: "active",
      subscriptionExpiryTime: "2026-12-01T00:00:00.000Z",
      activePurchaseTokens: ["token-a", "token-b"],
    },
    notificationPurchaseToken: "token-a",
    notificationDerived: expiredDerived(),
    notificationTokenConfirmed: true,
    tokenResults: [
      { ok: true, purchaseToken: "token-a", derived: expiredDerived() },
      { ok: true, purchaseToken: "token-b", derived: expiredDerived("2026-02-01T00:00:00.000Z") },
    ],
  });
  assert.strictEqual(bothInvalid.action, "expire");

  const apiFailureKeepActive = resolveRevocationUserEntitlement({
    existingData: {
      subscriptionStatus: "active",
      subscriptionExpiryTime: "2026-12-01T00:00:00.000Z",
      activePurchaseTokens: ["token-a", "token-b"],
      googlePlayPrimaryPurchaseToken: "token-b",
      googlePlaySubscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      googlePlayLatestOrderId: "GPA.new",
    },
    notificationPurchaseToken: "token-a",
    notificationDerived: expiredDerived(),
    notificationTokenConfirmed: true,
    tokenResults: [
      { ok: true, purchaseToken: "token-a", derived: expiredDerived() },
      { ok: false, purchaseToken: "token-b", error: new Error("timeout") },
    ],
  });
  assert.strictEqual(apiFailureKeepActive.action, "keep_active_uncertain");
  assert.strictEqual(apiFailureKeepActive.derived.status, "active");

  const revokedFromApi = deriveGooglePlayEntitlement({
    subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" },
    matchedLineItem: {
      productId: "ohayo_kamome_monthly",
      expiryTime: "2026-01-01T00:00:00.000Z",
    },
    notificationType: 12,
    forceExpired: false,
  });
  assert.strictEqual(revokedFromApi.status, "expired");

  const renewedUnchanged = deriveGooglePlayEntitlement({
    subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" },
    matchedLineItem: {
      productId: "ohayo_kamome_monthly",
      expiryTime: "2026-12-01T00:00:00.000Z",
    },
    notificationType: 2,
    forceExpired: false,
  });
  assert.strictEqual(renewedUnchanged.status, "active");

  const noPrimary = resolveRevocationUserEntitlement({
    existingData: {
      subscriptionStatus: "active",
      subscriptionExpiryTime: "2026-12-01T00:00:00.000Z",
      activePurchaseTokens: ["token-a", "token-b"],
    },
    notificationPurchaseToken: "token-a",
    notificationDerived: expiredDerived(),
    notificationTokenConfirmed: true,
    tokenResults: [
      { ok: true, purchaseToken: "token-a", derived: expiredDerived() },
      { ok: true, purchaseToken: "token-b", derived: activeDerived() },
    ],
  });
  assert.strictEqual(noPrimary.action, "keep_active");

  console.log("googlePlayRevocationSafety.test.js: all tests passed");
}

runTests();
