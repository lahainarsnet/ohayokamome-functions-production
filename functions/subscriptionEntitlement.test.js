const assert = require("assert");
const {
  computeAccountEntitlement,
  isStoreEntitlementUsable,
  inferAndroidAutoRenewing,
  mergeAndroidActiveTokens,
  buildIosStoreState,
  buildAndroidStoreState,
  deriveLegacyAccountFields,
  resolveActivePurchaseTokens,
  pickPrimaryPlatformWhenBothUsable,
  commitUserSubscriptionDualWrite,
  APP_STORE_PRODUCT_ID,
  GOOGLE_PLAY_PRODUCT_ID,
} = require("./subscriptionEntitlement");

/*
 * Test case matrix (expected legacy derive behavior)
 *  1. Android active / iOS none        -> platform android
 *  2. iOS active / Android none        -> platform ios
 *  3. Android active / iOS expired     -> platform android
 *  4. iOS active / Android expired     -> platform ios
 *  5. Android active / iOS active      -> sticky existing usable primary
 *  6. Android expired / iOS expired    -> incoming platform snapshot
 *  7. Android active then Apple active -> keep android (sticky)
 *  8. iOS active then Google RTDN      -> keep ios (sticky)
 *  9. Android purchase + iOS expired   -> platform android
 * 10. iOS purchase + Android expired    -> platform ios
 * 11. grace / canceled / trial usable -> same rules as active
 * 12. Sandbox                         -> environment only; derive unchanged
 * 13. reversed notification order       -> store snapshots + sticky primary
 * 14. near-simultaneous race            -> dual-write txn sees both stores
 */

const admin = {
  FieldValue: {
    serverTimestamp() {
      return "SERVER_TIMESTAMP";
    },
    arrayUnion(...values) {
      return { __type: "arrayUnion", values };
    },
  },
  Timestamp: {
    fromDate(date) {
      const value = date instanceof Date ? date : new Date(date);
      return {
        toDate: () => value,
        toMillis: () => value.getTime(),
      };
    },
  },
};

function applyMerge(target, data) {
  const next = { ...(target || {}) };
  for (const [key, value] of Object.entries(data || {})) {
    if (key.includes(".")) {
      const [head, tail] = key.split(".");
      next[head] = { ...(next[head] || {}), [tail]: value };
      continue;
    }
    next[key] = value;
  }
  return next;
}

function createDualWriteDb(initialDocs = {}) {
  const userDocs = { ...initialDocs };
  return {
    userDocs,
    db: {
      collection(name) {
        assert.strictEqual(name, "users");
        return {
          doc(uid) {
            return { id: uid };
          },
        };
      },
      async runTransaction(callback) {
        const tx = {
          async get(ref) {
            const data = userDocs[ref.id];
            return {
              exists: data != null,
              data: () => data || {},
            };
          },
          set(ref, data) {
            userDocs[ref.id] = applyMerge(userDocs[ref.id], data);
          },
        };
        return callback(tx);
      },
    },
  };
}

function activeStore(platform, expiry, extras = {}) {
  const base = {
    status: extras.status || "active",
    expiryTime: expiry,
    source: extras.source || `${platform}_test`,
    updatedAt: extras.updatedAt || expiry,
  };
  if (platform === "ios") {
    return {
      ...base,
      originalTransactionId: extras.originalTransactionId || "orig-ios",
      transactionId: extras.transactionId || "txn-ios",
      environment: extras.environment || "Production",
    };
  }
  return {
    ...base,
    primaryPurchaseToken: extras.primaryPurchaseToken || "android-token",
    subscriptionState: extras.subscriptionState || "SUBSCRIPTION_STATE_ACTIVE",
  };
}

function expiredStore(platform, expiry, extras = {}) {
  return activeStore(platform, expiry, { ...extras, status: "expired" });
}

function runTests() {
  const now = new Date("2026-07-18T12:00:00.000Z");
  const future = new Date("2026-08-01T00:00:00.000Z");
  const later = new Date("2026-09-01T00:00:00.000Z");
  const past = new Date("2026-06-01T00:00:00.000Z");
  const androidFuture = new Date("2026-08-15T00:00:00.000Z");

  assert.strictEqual(
    isStoreEntitlementUsable({ status: "active", expiryTime: future }, now).usable,
    true
  );
  assert.strictEqual(
    isStoreEntitlementUsable({ status: "trial", expiryTime: future }, now).usable,
    true
  );
  assert.strictEqual(
    isStoreEntitlementUsable({ status: "grace", expiryTime: future }, now).usable,
    true
  );
  assert.strictEqual(
    isStoreEntitlementUsable({ status: "canceled", expiryTime: future }, now).usable,
    true
  );
  assert.strictEqual(
    isStoreEntitlementUsable({ status: "active", expiryTime: past }, now).usable,
    false
  );
  assert.strictEqual(
    isStoreEntitlementUsable({ status: "paused", expiryTime: future }, now).usable,
    false
  );
  assert.strictEqual(
    isStoreEntitlementUsable({ status: "expired", expiryTime: past }, now).usable,
    false
  );
  assert.strictEqual(
    isStoreEntitlementUsable({ status: "none", expiryTime: future }, now).usable,
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
    mergeAndroidActiveTokens({ activePurchaseTokens: ["token-a"] }, "token-b"),
    ["token-a", "token-b"]
  );
  assert.deepStrictEqual(
    mergeAndroidActiveTokens({ activePurchaseTokens: ["token-a"] }, "token-a"),
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

  const missing = computeAccountEntitlement(null, undefined, now);
  assert.strictEqual(missing.entitlementUsable, false);
  assert.strictEqual(missing.entitlementSource, "none");

  // --- deriveLegacyAccountFields matrix ---
  const case1 = deriveLegacyAccountFields(
    null,
    activeStore("android", androidFuture),
    {},
    "android",
    now
  );
  assert.strictEqual(case1.subscriptionPlatform, "android");
  assert.strictEqual(case1.subscriptionStatus, "active");
  assert.strictEqual(case1.subscriptionProductId, GOOGLE_PLAY_PRODUCT_ID);

  const case2 = deriveLegacyAccountFields(
    activeStore("ios", future),
    null,
    {},
    "ios",
    now
  );
  assert.strictEqual(case2.subscriptionPlatform, "ios");
  assert.strictEqual(case2.subscriptionProductId, APP_STORE_PRODUCT_ID);

  const case3 = deriveLegacyAccountFields(
    expiredStore("ios", past),
    activeStore("android", androidFuture),
    { subscriptionPlatform: "ios" },
    "android",
    now
  );
  assert.strictEqual(case3.subscriptionPlatform, "android");

  const case4 = deriveLegacyAccountFields(
    activeStore("ios", future),
    expiredStore("android", past),
    { subscriptionPlatform: "android" },
    "ios",
    now
  );
  assert.strictEqual(case4.subscriptionPlatform, "ios");

  const case6 = deriveLegacyAccountFields(
    expiredStore("ios", past),
    expiredStore("android", past),
    { subscriptionPlatform: "android" },
    "ios",
    now
  );
  assert.strictEqual(case6.subscriptionPlatform, "ios");
  assert.strictEqual(case6.subscriptionStatus, "expired");

  const case9 = deriveLegacyAccountFields(
    expiredStore("ios", past),
    activeStore("android", androidFuture),
    { subscriptionPlatform: "ios" },
    "ios",
    now
  );
  assert.strictEqual(case9.subscriptionPlatform, "android");

  const case10 = deriveLegacyAccountFields(
    activeStore("ios", future),
    expiredStore("android", past),
    { subscriptionPlatform: "android" },
    "android",
    now
  );
  assert.strictEqual(case10.subscriptionPlatform, "ios");

  const case11 = deriveLegacyAccountFields(
    activeStore("ios", future, { status: "grace" }),
    null,
    {},
    "ios",
    now
  );
  assert.strictEqual(case11.subscriptionPlatform, "ios");
  assert.strictEqual(case11.subscriptionStatus, "grace");

  const case12 = deriveLegacyAccountFields(
    activeStore("ios", future, { environment: "Sandbox" }),
    null,
    {},
    "ios",
    now
  );
  assert.strictEqual(case12.subscriptionPlatform, "ios");

  const case5 = deriveLegacyAccountFields(
    activeStore("ios", later, { source: "app_store_notification_v2" }),
    activeStore("android", androidFuture, { source: "google_play_purchase" }),
    { subscriptionPlatform: "ios" },
    "ios",
    now
  );
  assert.strictEqual(case5.subscriptionPlatform, "android");

  const case7 = deriveLegacyAccountFields(
    activeStore("ios", later, {
      source: "app_store_notification_v2",
      updatedAt: later,
    }),
    activeStore("android", androidFuture, {
      source: "google_play_purchase",
      updatedAt: androidFuture,
    }),
    { subscriptionPlatform: "android" },
    "ios",
    now
  );
  assert.strictEqual(case7.subscriptionPlatform, "android");

  const case8 = deriveLegacyAccountFields(
    activeStore("ios", later, {
      source: "app_store_server_api",
      updatedAt: later,
    }),
    activeStore("android", androidFuture, {
      source: "google_play_rtdn",
      updatedAt: androidFuture,
    }),
    { subscriptionPlatform: "ios" },
    "android",
    now
  );
  assert.strictEqual(case8.subscriptionPlatform, "ios");

  const case13 = deriveLegacyAccountFields(
    activeStore("ios", future, { source: "app_store_notification_v2" }),
    activeStore("android", androidFuture, { source: "google_play_purchase" }),
    { subscriptionPlatform: "android" },
    "ios",
    now
  );
  assert.strictEqual(case13.subscriptionPlatform, "android");

  assert.strictEqual(
    pickPrimaryPlatformWhenBothUsable(
      activeStore("ios", later, { source: "app_store_notification_v2" }),
      activeStore("android", androidFuture, { source: "google_play_purchase" }),
      { subscriptionPlatform: "ios" },
      now
    ),
    "android"
  );

  // --- activePurchaseTokens merge ---
  assert.deepStrictEqual(
    resolveActivePurchaseTokens({
      existingData: { activePurchaseTokens: ["android-token"] },
      legacyUpdate: { activePurchaseTokens: ["ios-txn"] },
      incomingPlatform: "ios",
      meta: { transactionId: "ios-txn" },
    }),
    ["android-token", "ios-txn"]
  );

  assert.deepStrictEqual(
    resolveActivePurchaseTokens({
      existingData: { activePurchaseTokens: ["android-token", "ios-old"] },
      legacyUpdate: { activePurchaseTokens: [] },
      incomingPlatform: "ios",
      meta: { transactionId: "ios-old" },
    }),
    ["android-token"]
  );

  assert.deepStrictEqual(
    resolveActivePurchaseTokens({
      existingData: { activePurchaseTokens: ["android-token"] },
      legacyUpdate: {
        activePurchaseTokens: admin.FieldValue.arrayUnion("new-android"),
      },
      incomingPlatform: "android",
      meta: { purchaseToken: "new-android" },
    }),
    ["android-token", "new-android"]
  );

  // --- dual-write race integration ---
  async function runDualWriteRaceTests() {
    const raceAndroidExpiry = new Date("2027-09-15T00:00:00.000Z");
    const raceIosExpiry = new Date("2027-10-01T00:00:00.000Z");
    const racePastExpiry = new Date("2026-06-01T00:00:00.000Z");
    const raceIosActiveExpiry = new Date("2027-08-01T00:00:00.000Z");
    const futureTs = admin.Timestamp.fromDate(raceAndroidExpiry);
    const iosFutureTs = admin.Timestamp.fromDate(raceIosExpiry);

    // Google verify -> Apple ASN (pxhgm2)
    {
      const { db, userDocs } = createDualWriteDb({
        "uid-race": {
          subscriptionPlatform: "ios",
          subscriptionStatus: "active",
          subscriptions: {
            ios: activeStore("ios", raceIosExpiry),
          },
          activePurchaseTokens: ["ios-txn-old"],
        },
      });

      await commitUserSubscriptionDualWrite({
        db,
        admin,
        uid: "uid-race",
        source: "google_verify",
        platform: "android",
        storeState: buildAndroidStoreState({
          status: "active",
          expiryTime: futureTs,
          primaryPurchaseToken: "android-token-new",
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          source: "google_play_purchase",
          updatedAt: admin.FieldValue.serverTimestamp(),
        }),
        legacyUpdate: {
          subscriptionStatus: "active",
          subscriptionProductId: GOOGLE_PLAY_PRODUCT_ID,
          subscriptionExpiryTime: futureTs,
          subscriptionPlatform: "android",
          activePurchaseTokens: admin.FieldValue.arrayUnion("android-token-new"),
          googlePlayPrimaryPurchaseToken: "android-token-new",
          lastSubscriptionSource: "google_play_purchase",
          lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
          updatedAt: admin.FieldValue.serverTimestamp(),
        },
        meta: { purchaseToken: "android-token-new" },
      });

      assert.strictEqual(userDocs["uid-race"].subscriptionPlatform, "android");
      assert.strictEqual(
        userDocs["uid-race"].subscriptions.android.status,
        "active"
      );

      await commitUserSubscriptionDualWrite({
        db,
        admin,
        uid: "uid-race",
        source: "apple_notification",
        platform: "ios",
        storeState: buildIosStoreState({
          status: "active",
          expiryTime: iosFutureTs,
          originalTransactionId: "orig-ios",
          transactionId: "ios-txn-old",
          environment: "Production",
          source: "app_store_notification_v2",
          updatedAt: admin.FieldValue.serverTimestamp(),
        }),
        legacyUpdate: {
          subscriptionStatus: "active",
          subscriptionProductId: APP_STORE_PRODUCT_ID,
          subscriptionPlatform: "ios",
          subscriptionExpiryTime: iosFutureTs,
          appStoreOriginalTransactionId: "orig-ios",
          appStoreTransactionId: "ios-txn-old",
          activePurchaseTokens: ["ios-txn-old"],
          lastSubscriptionSource: "app_store_notification_v2",
          lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
          updatedAt: admin.FieldValue.serverTimestamp(),
        },
        meta: { transactionId: "ios-txn-old" },
      });

      assert.strictEqual(
        userDocs["uid-race"].subscriptions.android.status,
        "active"
      );
      assert.strictEqual(userDocs["uid-race"].subscriptionPlatform, "android");
      assert.strictEqual(userDocs["uid-race"].entitlementSource, "both");
      assert.deepStrictEqual(userDocs["uid-race"].activePurchaseTokens, [
        "ios-txn-old",
        "android-token-new",
      ]);
    }

    // Apple verify -> Google RTDN
    {
      const { db, userDocs } = createDualWriteDb({
        "uid-reverse": {
          subscriptionPlatform: "android",
          subscriptions: {
            android: activeStore("android", raceAndroidExpiry),
          },
          activePurchaseTokens: ["android-token-old"],
        },
      });

      await commitUserSubscriptionDualWrite({
        db,
        admin,
        uid: "uid-reverse",
        source: "apple_verify",
        platform: "ios",
        storeState: buildIosStoreState({
          status: "active",
          expiryTime: admin.Timestamp.fromDate(raceIosActiveExpiry),
          originalTransactionId: "orig-ios-new",
          transactionId: "ios-txn-new",
          environment: "Production",
          source: "app_store_server_api",
          updatedAt: admin.FieldValue.serverTimestamp(),
        }),
        legacyUpdate: {
          subscriptionStatus: "active",
          subscriptionProductId: APP_STORE_PRODUCT_ID,
          subscriptionPlatform: "ios",
          subscriptionExpiryTime: admin.Timestamp.fromDate(raceIosActiveExpiry),
          appStoreOriginalTransactionId: "orig-ios-new",
          appStoreTransactionId: "ios-txn-new",
          activePurchaseTokens: ["ios-txn-new"],
          lastSubscriptionSource: "app_store_server_api",
          lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
        },
        meta: { transactionId: "ios-txn-new" },
      });

      assert.strictEqual(userDocs["uid-reverse"].subscriptionPlatform, "ios");

      await commitUserSubscriptionDualWrite({
        db,
        admin,
        uid: "uid-reverse",
        source: "google_rtdn",
        platform: "android",
        storeState: buildAndroidStoreState({
          status: "active",
          expiryTime: futureTs,
          primaryPurchaseToken: "android-token-old",
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          source: "google_play_rtdn",
          updatedAt: admin.FieldValue.serverTimestamp(),
        }),
        legacyUpdate: {
          subscriptionStatus: "active",
          subscriptionProductId: GOOGLE_PLAY_PRODUCT_ID,
          subscriptionPlatform: "android",
          subscriptionExpiryTime: futureTs,
          googlePlayPrimaryPurchaseToken: "android-token-old",
          activePurchaseTokens: admin.FieldValue.arrayUnion("android-token-old"),
          lastSubscriptionSource: "google_play_rtdn",
          lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
          updatedAt: admin.FieldValue.serverTimestamp(),
        },
        meta: { purchaseToken: "android-token-old" },
      });

      assert.strictEqual(
        userDocs["uid-reverse"].subscriptions.ios.status,
        "active"
      );
      assert.strictEqual(userDocs["uid-reverse"].subscriptionPlatform, "ios");
      assert.strictEqual(userDocs["uid-reverse"].entitlementSource, "both");
    }

    // iOS expired notification keeps Android active
    {
      const { db, userDocs } = createDualWriteDb({
        "uid-ios-expire": {
          subscriptionPlatform: "android",
          subscriptions: {
            ios: activeStore("ios", raceIosActiveExpiry),
            android: activeStore("android", raceAndroidExpiry),
          },
          activePurchaseTokens: ["ios-txn", "android-token"],
        },
      });

      await commitUserSubscriptionDualWrite({
        db,
        admin,
        uid: "uid-ios-expire",
        source: "apple_notification",
        platform: "ios",
        storeState: buildIosStoreState({
          status: "expired",
          expiryTime: admin.Timestamp.fromDate(racePastExpiry),
          originalTransactionId: "orig-ios",
          transactionId: "ios-txn",
          environment: "Production",
          source: "app_store_notification_v2",
          updatedAt: admin.FieldValue.serverTimestamp(),
        }),
        legacyUpdate: {
          subscriptionStatus: "expired",
          subscriptionProductId: APP_STORE_PRODUCT_ID,
          subscriptionPlatform: "ios",
          subscriptionExpiryTime: admin.Timestamp.fromDate(past),
          appStoreOriginalTransactionId: "orig-ios",
          appStoreTransactionId: "ios-txn",
          activePurchaseTokens: [],
          lastSubscriptionSource: "app_store_notification_v2",
          lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
          updatedAt: admin.FieldValue.serverTimestamp(),
        },
        meta: { transactionId: "ios-txn" },
      });

      assert.strictEqual(
        userDocs["uid-ios-expire"].subscriptions.ios.status,
        "expired"
      );
      assert.strictEqual(
        userDocs["uid-ios-expire"].subscriptions.android.status,
        "active"
      );
      assert.strictEqual(
        userDocs["uid-ios-expire"].subscriptionPlatform,
        "android"
      );
      assert.deepStrictEqual(userDocs["uid-ios-expire"].activePurchaseTokens, [
        "android-token",
      ]);
    }

    // Android expired notification keeps iOS active
    {
      const { db, userDocs } = createDualWriteDb({
        "uid-android-expire": {
          subscriptionPlatform: "ios",
          subscriptions: {
            ios: activeStore("ios", raceIosActiveExpiry),
            android: activeStore("android", raceAndroidExpiry),
          },
          activePurchaseTokens: ["ios-txn", "android-token"],
        },
      });

      await commitUserSubscriptionDualWrite({
        db,
        admin,
        uid: "uid-android-expire",
        source: "google_rtdn",
        platform: "android",
        storeState: buildAndroidStoreState({
          status: "expired",
          expiryTime: admin.Timestamp.fromDate(racePastExpiry),
          primaryPurchaseToken: "android-token",
          subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
          source: "google_play_rtdn",
          updatedAt: admin.FieldValue.serverTimestamp(),
        }),
        legacyUpdate: {
          subscriptionStatus: "expired",
          subscriptionProductId: GOOGLE_PLAY_PRODUCT_ID,
          subscriptionPlatform: "android",
          subscriptionExpiryTime: admin.Timestamp.fromDate(past),
          googlePlayPrimaryPurchaseToken: "",
          lastSubscriptionSource: "google_play_rtdn",
          lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
          updatedAt: admin.FieldValue.serverTimestamp(),
        },
        meta: { purchaseToken: "android-token" },
      });

      assert.strictEqual(
        userDocs["uid-android-expire"].subscriptions.android.status,
        "expired"
      );
      assert.strictEqual(
        userDocs["uid-android-expire"].subscriptions.ios.status,
        "active"
      );
      assert.strictEqual(
        userDocs["uid-android-expire"].subscriptionPlatform,
        "ios"
      );
    }
  }

  return runDualWriteRaceTests().then(() => {
    console.log("subscriptionEntitlement.test.js: all assertions passed");
  });
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
