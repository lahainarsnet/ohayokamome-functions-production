"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  shouldSkipStaleActiveUpdate,
  resolveAndroidStaleComparisonExpiry,
  applyGoogleSubscriptionUpdateToUser,
} = require("./googlePlaySubscriptionNotifications");
const {
  createGooglePlaySubscriptionProbeHandler,
} = require("./googlePlaySubscriptionProbe");

const IOS_11_1 = "2028-11-01T00:00:00.000Z";
const ANDROID_10_5 = "2028-10-05T00:00:00.000Z";
const ANDROID_10_20 = "2028-10-20T00:00:00.000Z";
const ANDROID_10_31 = "2028-10-31T00:00:00.000Z";
const ANDROID_TOKEN = "play-token-stale-cross-os";

function getNested(data, field) {
  return String(field || "")
    .split(".")
    .reduce((current, key) => {
      if (current == null || typeof current !== "object") {
        return undefined;
      }
      return current[key];
    }, data);
}

function applyMerge(target, payload) {
  const next = { ...(target || {}) };
  for (const [key, value] of Object.entries(payload || {})) {
    if (value && value.__type === "arrayUnion") {
      const existing = Array.isArray(next[key]) ? next[key] : [];
      next[key] = [...new Set(existing.concat(value.values || []))];
      continue;
    }
    if (
      value &&
      Object.getPrototypeOf(value) === Object.prototype &&
      !value.__type
    ) {
      next[key] = applyMerge(next[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function createQueryDb(userDocs) {
  return {
    collection(name) {
      if (name !== "users") {
        throw new Error(`Unexpected collection: ${name}`);
      }
      return {
        where(field, op, value) {
          const matches = Object.entries(userDocs)
            .filter(([, data]) => {
              const stored = getNested(data, field);
              if (op === "array-contains") {
                return Array.isArray(stored) && stored.includes(value);
              }
              if (op === "==") {
                return stored === value;
              }
              return false;
            })
            .map(([id]) => ({ id }));
          return {
            limit(n) {
              return {
                async get() {
                  const docs = matches.slice(0, n);
                  return { docs, size: docs.length };
                },
              };
            },
          };
        },
        doc(uid) {
          return {
            id: uid,
            async get() {
              const data = userDocs[uid];
              return {
                exists: data != null,
                data: () => data,
              };
            },
          };
        },
      };
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          const data = userDocs[ref.id];
          return {
            exists: data != null,
            data: () => data,
          };
        },
        set(ref, payload) {
          userDocs[ref.id] = applyMerge(userDocs[ref.id], payload);
        },
      };
      return fn(tx);
    },
  };
}

function createMockAdmin() {
  return {
    FieldValue: {
      serverTimestamp: () => ({ __type: "serverTimestamp" }),
      arrayUnion: (...values) => ({ __type: "arrayUnion", values }),
    },
    Timestamp: {
      fromDate: (date) => ({ __type: "timestamp", iso: date.toISOString() }),
    },
  };
}

function activeDerived(iso) {
  const expiryDate = new Date(iso);
  return {
    status: "active",
    expiryTime: iso,
    expiryDate,
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
  };
}

function expiredDerived(iso) {
  const expiryDate = new Date(iso);
  return {
    status: "expired",
    expiryTime: iso,
    expiryDate,
    subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
  };
}

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`ok ${passed}: ${name}`);
}

async function runTests() {
  const admin = createMockAdmin();

  await test("1 Android-only 10/5 -> 10/31 applies (not stale)", async () => {
    const existing = {
      subscriptionPlatform: "android",
      subscriptionExpiryTime: ANDROID_10_5,
      subscriptions: {
        android: { status: "active", expiryTime: ANDROID_10_5 },
      },
    };
    assert.equal(
      shouldSkipStaleActiveUpdate(existing, activeDerived(ANDROID_10_31)),
      false,
    );
    const users = { uid: existing };
    const result = await applyGoogleSubscriptionUpdateToUser(
      createQueryDb(users),
      admin,
      "uid",
      activeDerived(ANDROID_10_31),
      ANDROID_TOKEN,
      { logger: { info() {}, warn() {}, error() {} } },
    );
    assert.equal(result.applied, true);
    assert.equal(users.uid.subscriptions.android.expiryTime, ANDROID_10_31);
  });

  await test("2 Android-only 10/31 -> 10/20 stale skip", async () => {
    const existing = {
      subscriptionPlatform: "android",
      subscriptionExpiryTime: ANDROID_10_31,
      subscriptions: {
        android: { status: "active", expiryTime: ANDROID_10_31 },
      },
    };
    assert.equal(
      shouldSkipStaleActiveUpdate(existing, activeDerived(ANDROID_10_20)),
      true,
    );
    const users = { uid: structuredClone(existing) };
    const result = await applyGoogleSubscriptionUpdateToUser(
      createQueryDb(users),
      admin,
      "uid",
      activeDerived(ANDROID_10_20),
      ANDROID_TOKEN,
    );
    assert.equal(result.applied, false);
    assert.equal(result.reason, "stale_active_expiry");
    assert.equal(users.uid.subscriptions.android.expiryTime, ANDROID_10_31);
  });

  await test("3 cross-OS iOS 11/1 Android 10/5 incoming 10/31 applies", async () => {
    const existing = {
      subscriptionPlatform: "ios",
      subscriptionExpiryTime: IOS_11_1,
      subscriptions: {
        ios: { status: "active", expiryTime: IOS_11_1 },
        android: { status: "active", expiryTime: ANDROID_10_5 },
      },
    };
    assert.equal(
      resolveAndroidStaleComparisonExpiry(existing)?.toISOString(),
      new Date(ANDROID_10_5).toISOString(),
    );
    assert.equal(
      shouldSkipStaleActiveUpdate(existing, activeDerived(ANDROID_10_31)),
      false,
    );
    const users = { uid: structuredClone(existing) };
    const result = await applyGoogleSubscriptionUpdateToUser(
      createQueryDb(users),
      admin,
      "uid",
      activeDerived(ANDROID_10_31),
      ANDROID_TOKEN,
    );
    assert.equal(result.applied, true);
    assert.equal(users.uid.subscriptions.android.expiryTime, ANDROID_10_31);
    assert.equal(users.uid.subscriptions.ios.expiryTime, IOS_11_1);
  });

  await test("4 cross-OS Android 10/31 incoming 10/20 stale skip", async () => {
    const existing = {
      subscriptionPlatform: "ios",
      subscriptionExpiryTime: IOS_11_1,
      subscriptions: {
        ios: { status: "active", expiryTime: IOS_11_1 },
        android: { status: "active", expiryTime: ANDROID_10_31 },
      },
    };
    assert.equal(
      shouldSkipStaleActiveUpdate(existing, activeDerived(ANDROID_10_20)),
      true,
    );
  });

  await test("5 both OS active Android update does not break iOS store", async () => {
    const iosPrior = {
      status: "active",
      expiryTime: IOS_11_1,
      originalTransactionId: "ios-original",
      marker: "keep",
    };
    const users = {
      uid: {
        subscriptionPlatform: "ios",
        subscriptionExpiryTime: IOS_11_1,
        subscriptions: {
          ios: iosPrior,
          android: { status: "active", expiryTime: ANDROID_10_5 },
        },
        googlePlayPrimaryPurchaseToken: ANDROID_TOKEN,
      },
    };
    await applyGoogleSubscriptionUpdateToUser(
      createQueryDb(users),
      admin,
      "uid",
      activeDerived(ANDROID_10_31),
      ANDROID_TOKEN,
    );
    assert.deepEqual(users.uid.subscriptions.ios, {
      ...iosPrior,
      expiryTime: IOS_11_1,
    });
    assert.equal(users.uid.entitlementUsable, true);
  });

  await test("6 Android update retains subscriptions.ios", async () => {
    const users = {
      uid: {
        subscriptions: {
          ios: { status: "active", expiryTime: IOS_11_1, marker: "ios-retain" },
          android: { status: "active", expiryTime: ANDROID_10_5 },
        },
      },
    };
    await applyGoogleSubscriptionUpdateToUser(
      createQueryDb(users),
      admin,
      "uid",
      activeDerived(ANDROID_10_31),
      ANDROID_TOKEN,
    );
    assert.equal(users.uid.subscriptions.ios.marker, "ios-retain");
    assert.equal(users.uid.subscriptions.ios.expiryTime, IOS_11_1);
  });

  await test("7 legacy-only Android uses legacy expiry for stale compare", async () => {
    const existing = {
      subscriptionPlatform: "android",
      subscriptionExpiryTime: ANDROID_10_31,
    };
    assert.equal(
      resolveAndroidStaleComparisonExpiry(existing)?.toISOString(),
      new Date(ANDROID_10_31).toISOString(),
    );
    assert.equal(
      shouldSkipStaleActiveUpdate(existing, activeDerived(ANDROID_10_20)),
      true,
    );
    assert.equal(
      shouldSkipStaleActiveUpdate(existing, activeDerived(IOS_11_1)),
      false,
    );
  });

  await test("8 legacy common expiry with usable iOS not used for Android stale", async () => {
    const existing = {
      subscriptionPlatform: "android",
      subscriptionExpiryTime: IOS_11_1,
      subscriptions: {
        ios: { status: "active", expiryTime: IOS_11_1 },
      },
    };
    assert.equal(resolveAndroidStaleComparisonExpiry(existing), null);
    assert.equal(
      shouldSkipStaleActiveUpdate(existing, activeDerived(ANDROID_10_31)),
      false,
    );
  });

  await test("9 RTDN apply path cross-OS stale fix (applyGoogleSubscriptionUpdateToUser)", async () => {
    const users = {
      uid: {
        subscriptionExpiryTime: IOS_11_1,
        subscriptions: {
          ios: { status: "active", expiryTime: IOS_11_1 },
          android: { status: "active", expiryTime: ANDROID_10_5 },
        },
        activePurchaseTokens: [ANDROID_TOKEN],
        googlePlayPrimaryPurchaseToken: ANDROID_TOKEN,
      },
    };
    const result = await applyGoogleSubscriptionUpdateToUser(
      createQueryDb(users),
      admin,
      "uid",
      activeDerived(ANDROID_10_31),
      ANDROID_TOKEN,
      { subscriptionSource: "google_play_rtdn", dualWriteSource: "google_rtdn" },
    );
    assert.equal(result.applied, true);
    assert.equal(users.uid.subscriptions.android.expiryTime, ANDROID_10_31);
  });

  await test("10 googlePlaySubscriptionProbe uses apply without cross-OS stale skip", async () => {
    const userData = {
      googlePlayPrimaryPurchaseToken: ANDROID_TOKEN,
      subscriptionExpiryTime: IOS_11_1,
      subscriptions: {
        ios: { status: "active", expiryTime: IOS_11_1 },
        android: { status: "active", expiryTime: ANDROID_10_5 },
      },
    };
    const users = { uid: userData };
    const handler = createGooglePlaySubscriptionProbeHandler({
      getDb: () => createQueryDb(users),
      admin,
      logger: { info() {}, warn() {} },
      syncSubscriptionByPurchaseToken: async () => ({
        subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" },
        matchedLineItem: {
          productId: "ohayo_kamome_monthly",
          expiryTime: ANDROID_10_31,
        },
      }),
      deriveEntitlement: () => activeDerived(ANDROID_10_31),
      isUsableEntitlement: () => true,
    });
    const result = await handler({
      auth: { uid: "uid" },
      data: {},
    });
    assert.equal(result.outcome, "active");
    assert.equal(result.firestoreApplied, true);
    assert.equal(users.uid.subscriptions.android.expiryTime, ANDROID_10_31);
  });

  await test("11 verifyGooglePlaySubscriptionPurchase bypasses shouldSkipStaleActiveUpdate", async () => {
    const source = fs.readFileSync(require.resolve("./index"), "utf8");
    const verifyStart = source.indexOf("exports.verifyGooglePlaySubscriptionPurchase");
    const verifyEnd = source.indexOf("exports.", verifyStart + 1);
    const block = source.slice(verifyStart, verifyEnd);
    assert.equal(block.includes("shouldSkipStaleActiveUpdate"), false);
    assert.ok(block.includes("commitUserSubscriptionDualWrite"));
  });

  await test("12 non-active incoming does not stale-skip via shouldSkip", async () => {
    const existing = {
      subscriptionPlatform: "android",
      subscriptionExpiryTime: ANDROID_10_31,
      subscriptions: {
        android: { status: "active", expiryTime: ANDROID_10_31 },
      },
    };
    assert.equal(
      shouldSkipStaleActiveUpdate(existing, expiredDerived(ANDROID_10_20)),
      false,
    );
    const users = { uid: structuredClone(existing) };
    const result = await applyGoogleSubscriptionUpdateToUser(
      createQueryDb(users),
      admin,
      "uid",
      expiredDerived(ANDROID_10_20),
      ANDROID_TOKEN,
    );
    assert.equal(result.applied, true);
    assert.equal(users.uid.subscriptions.android.status, "expired");
  });

  console.log(
    `googlePlayStaleActiveCrossOs.test.js: ${passed} tests passed`,
  );
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
