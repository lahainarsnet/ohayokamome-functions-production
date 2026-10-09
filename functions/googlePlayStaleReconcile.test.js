const assert = require("assert");
const {
  evaluateAndroidStaleReconcileApply,
  buildGoogleProbeReconcileWriteGuard,
  GOOGLE_PROBE_RECONCILE_DUAL_WRITE_SOURCE,
} = require("./googlePlaySubscriptionNotifications");

function runTests() {
  const baselineToken = "token-a";
  const incomingExpired = {
    status: "expired",
    expiryDate: new Date("2026-07-01T00:00:00.000Z"),
  };

  const applyOk = evaluateAndroidStaleReconcileApply(
    {
      googlePlayPrimaryPurchaseToken: baselineToken,
      subscriptions: {
        android: {
          status: "active",
          expiryTime: "2026-06-01T00:00:00.000Z",
        },
      },
    },
    incomingExpired,
    { baselinePrimaryToken: baselineToken },
  );
  assert.strictEqual(applyOk.skipped, false);

  const tokenChanged = evaluateAndroidStaleReconcileApply(
    {
      googlePlayPrimaryPurchaseToken: "token-b",
      subscriptions: {
        android: {
          status: "active",
          expiryTime: "2026-12-01T00:00:00.000Z",
        },
      },
    },
    incomingExpired,
    { baselinePrimaryToken: baselineToken },
  );
  assert.strictEqual(tokenChanged.skipped, true);
  assert.strictEqual(tokenChanged.reason, "primary_token_changed_during_probe");

  const newerStored = evaluateAndroidStaleReconcileApply(
    {
      googlePlayPrimaryPurchaseToken: baselineToken,
      subscriptions: {
        android: {
          status: "active",
          expiryTime: "2026-08-01T00:00:00.000Z",
        },
      },
    },
    incomingExpired,
    { baselinePrimaryToken: baselineToken },
  );
  assert.strictEqual(newerStored.skipped, true);
  assert.strictEqual(newerStored.reason, "stored_expiry_newer_than_google_incoming");

  const expiredDerived = {
    status: "expired",
    expiryDate: new Date("2026-07-01T00:00:00.000Z"),
  };
  const txGuard = buildGoogleProbeReconcileWriteGuard(expiredDerived, {
    dualWriteSource: GOOGLE_PROBE_RECONCILE_DUAL_WRITE_SOURCE,
    baselinePrimaryToken: baselineToken,
  });
  assert.strictEqual(typeof txGuard, "function");

  const txAllow = txGuard({
    googlePlayPrimaryPurchaseToken: baselineToken,
    subscriptions: {
      android: {
        status: "active",
        expiryTime: "2026-06-01T00:00:00.000Z",
      },
    },
  });
  assert.strictEqual(txAllow, null);

  const txSkipUsable = txGuard({
    googlePlayPrimaryPurchaseToken: baselineToken,
    subscriptions: {
      android: {
        status: "active",
        expiryTime: "2027-01-01T00:00:00.000Z",
      },
    },
  });
  assert.strictEqual(txSkipUsable?.skip, true);
  assert.strictEqual(txSkipUsable.reason, "stored_android_usable_after_refresh");

  const txSkipToken = txGuard({
    googlePlayPrimaryPurchaseToken: "token-b",
    subscriptions: {
      android: {
        status: "active",
        expiryTime: "2026-06-01T00:00:00.000Z",
      },
    },
  });
  assert.strictEqual(txSkipToken?.skip, true);
  assert.strictEqual(txSkipToken.reason, "primary_token_changed_during_probe");

  const noGuard = buildGoogleProbeReconcileWriteGuard(expiredDerived, {
    dualWriteSource: "google_rtdn",
    baselinePrimaryToken: baselineToken,
  });
  assert.strictEqual(noGuard, undefined);

  console.log("googlePlayStaleReconcile.test.js: all tests passed");
}

runTests();
