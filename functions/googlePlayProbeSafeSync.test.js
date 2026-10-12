"use strict";

// Firebaseフレッシュ化Function B（サーバー側）: 更新番号による競合防止、所有権の確認、
// 不明な状態では Firebase を変更しない、Expired を慎重に扱う、結果（更新番号）をA・C1へ返す。

const assert = require("node:assert/strict");
const {
  createGooglePlaySubscriptionProbeHandler,
} = require("./googlePlaySubscriptionProbe");

const TOKEN = "play-token-b-test";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

function applyMerge(target, payload) {
  const next = { ...(target || {}) };
  for (const [key, value] of Object.entries(payload || {})) {
    if (value && value.__type === "arrayUnion") {
      const existing = Array.isArray(next[key]) ? next[key] : [];
      next[key] = [...new Set(existing.concat(value.values || []))];
    } else if (value && Object.getPrototypeOf(value) === Object.prototype && !value.__type) {
      next[key] = applyMerge(next[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function createDb(users, ownership = {}) {
  const snap = (data) => ({
    exists: data != null,
    data: () => data,
    get: (field) => (data == null ? undefined : data[field]),
  });
  return {
    collection(name) {
      if (name === "subscription_ownership") {
        return { doc: (id) => ({ id, get: async () => snap(ownership[id]) }) };
      }
      assert.equal(name, "users");
      return { doc: (id) => ({ id, get: async () => snap(users[id]) }) };
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          return snap(users[ref.id]);
        },
        set(ref, payload) {
          users[ref.id] = applyMerge(users[ref.id], payload);
        },
      });
    },
  };
}

const admin = {
  FieldValue: {
    serverTimestamp: () => ({ __type: "serverTimestamp" }),
    arrayUnion: (...values) => ({ __type: "arrayUnion", values }),
    delete: () => ({ __type: "delete" }),
  },
  Timestamp: {
    fromDate: (date) => ({ __type: "timestamp", iso: date.toISOString() }),
  },
};

const logger = { info() {}, warn() {}, error() {} };

function derivedOf(status, iso, state) {
  return {
    status,
    expiryTime: iso,
    expiryDate: new Date(iso),
    subscriptionState: state,
  };
}

function makeHandler({ users, ownership, derived, usable, beforeApi, onSync }) {
  return createGooglePlaySubscriptionProbeHandler({
    getDb: () => createDb(users, ownership),
    admin,
    logger,
    syncSubscriptionByPurchaseToken: async () => {
      if (onSync) onSync();
      if (beforeApi) beforeApi();
      return {
        subscription: { subscriptionState: derived.subscriptionState },
        matchedLineItem: { productId: "ohayo_kamome_monthly", expiryTime: derived.expiryTime },
        storeObservedAtMs: Date.now(),
      };
    },
    deriveEntitlement: () => derived,
    isUsableEntitlement: () => usable,
  });
}

const call = (handler, data = { purpose: "reconcile" }) => handler({ auth: { uid: "uid" }, data });

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`ok ${passed}: ${name}`);
}

async function main() {
  await test("Active on the store, Firebase Expired -> synced to Active and the new revision is returned", async () => {
    const users = {
      uid: {
        billingRevision: 5,
        googlePlayPrimaryPurchaseToken: TOKEN,
        subscriptionPlatform: "android",
        subscriptions: { android: { status: "expired", expiryTime: PAST, primaryPurchaseToken: TOKEN } },
      },
    };
    const result = await call(
      makeHandler({ users, derived: derivedOf("active", FUTURE, "SUBSCRIPTION_STATE_ACTIVE"), usable: true }),
    );
    assert.equal(result.outcome, "active");
    assert.equal(result.firestoreApplied, true);
    assert.equal(result.storeState, "active");
    assert.equal(result.billingRevisionBefore, 5);
    assert.equal(result.billingRevisionAfter, 6);
    assert.equal(users.uid.subscriptions.android.status, "active");
    assert.equal(users.uid.billingRevision, 6);
  });

  await test("a write that finished first wins: the older query result is not written (revision_changed)", async () => {
    const users = {
      uid: {
        billingRevision: 5,
        googlePlayPrimaryPurchaseToken: TOKEN,
        subscriptionPlatform: "android",
        subscriptions: { android: { status: "expired", expiryTime: PAST, primaryPurchaseToken: TOKEN } },
      },
    };
    const handler = makeHandler({
      users,
      derived: derivedOf("active", FUTURE, "SUBSCRIPTION_STATE_ACTIVE"),
      usable: true,
      // Another process finishes its update while this query is waiting for the store.
      beforeApi: () => {
        users.uid.billingRevision = 6;
        users.uid.subscriptions.android.status = "expired";
        users.uid.marker = "other-writer";
      },
    });
    const result = await call(handler);
    assert.equal(result.firestoreApplied, false);
    assert.equal(result.skipReason, "revision_changed");
    assert.equal(result.billingRevisionBefore, 5);
    assert.equal(result.billingRevisionAfter, 6);
    assert.equal(users.uid.billingRevision, 6, "no write happened");
    assert.equal(users.uid.marker, "other-writer");
  });

  await test("Expired on the store while Firebase is Active with a future expiry -> Active is kept", async () => {
    const users = {
      uid: {
        billingRevision: 3,
        googlePlayPrimaryPurchaseToken: TOKEN,
        subscriptionPlatform: "android",
        subscriptions: { android: { status: "active", expiryTime: FUTURE, primaryPurchaseToken: TOKEN } },
      },
    };
    const before = JSON.stringify(users.uid);
    const result = await call(
      makeHandler({ users, derived: derivedOf("expired", PAST, "SUBSCRIPTION_STATE_EXPIRED"), usable: false }),
    );
    assert.equal(result.outcome, "inactive");
    assert.equal(result.storeState, "expired");
    assert.equal(result.firestoreApplied, false);
    assert.equal(result.skipReason, "stored_android_usable_after_refresh");
    assert.equal(JSON.stringify(users.uid), before, "Firebase is unchanged");
    assert.equal(result.billingRevisionAfter, 3);
  });

  await test("Expired on the store and Firebase expiry already passed -> synced to Expired", async () => {
    const users = {
      uid: {
        billingRevision: 2,
        googlePlayPrimaryPurchaseToken: TOKEN,
        subscriptionPlatform: "android",
        subscriptions: { android: { status: "active", expiryTime: PAST, primaryPurchaseToken: TOKEN } },
      },
    };
    const result = await call(
      makeHandler({ users, derived: derivedOf("expired", PAST, "SUBSCRIPTION_STATE_EXPIRED"), usable: false }),
    );
    assert.equal(result.storeState, "expired");
    assert.equal(result.firestoreApplied, true);
    assert.equal(users.uid.subscriptions.android.status, "expired");
    assert.equal(result.billingRevisionAfter, 3);
  });

  for (const [label, androidState] of [
    ["Firebase Active", { status: "active", expiryTime: FUTURE, primaryPurchaseToken: TOKEN }],
    ["Firebase without a store record", { status: "none", expiryTime: null, primaryPurchaseToken: TOKEN }],
  ]) {
    await test(`unknown store state never changes Firebase (${label})`, async () => {
      const users = {
        uid: {
          billingRevision: 4,
          googlePlayPrimaryPurchaseToken: TOKEN,
          subscriptionPlatform: "android",
          subscriptions: { android: androidState },
        },
      };
      const before = JSON.stringify(users.uid);
      const result = await call(
        makeHandler({ users, derived: derivedOf("unknown", PAST, "SUBSCRIPTION_STATE_ACTIVE"), usable: false }),
      );
      assert.equal(result.outcome, "inactive");
      assert.equal(result.reason, "google_play_unknown_state");
      assert.equal(result.storeState, "unknown");
      assert.equal(result.firestoreApplied, false);
      assert.equal(JSON.stringify(users.uid), before);
    });
  }

  await test("a contract owned by another UID is never synced to this UID", async () => {
    const users = {
      uid: {
        billingRevision: 1,
        googlePlayPrimaryPurchaseToken: TOKEN,
        subscriptionPlatform: "android",
        subscriptions: { android: { status: "expired", expiryTime: PAST, primaryPurchaseToken: TOKEN } },
      },
    };
    const { buildAndroidOwnershipId } = require("./subscriptionOwnership");
    let storeCalled = false;
    const before = JSON.stringify(users.uid);
    const result = await call(
      makeHandler({
        users,
        ownership: { [buildAndroidOwnershipId(TOKEN)]: { ownerUid: "other-uid" } },
        derived: derivedOf("active", FUTURE, "SUBSCRIPTION_STATE_ACTIVE"),
        usable: true,
        onSync: () => {
          storeCalled = true;
        },
      }),
    );
    assert.equal(result.outcome, "failed");
    assert.equal(result.reason, "ownership_mismatch");
    assert.equal(storeCalled, false, "the store is not queried");
    assert.equal(JSON.stringify(users.uid), before);
  });

  await test("a contract owned by this UID (or with no ownership record) is synced", async () => {
    const { buildAndroidOwnershipId } = require("./subscriptionOwnership");
    for (const ownership of [{ [buildAndroidOwnershipId(TOKEN)]: { ownerUid: "uid" } }, {}]) {
      const users = {
        uid: {
          billingRevision: 1,
          googlePlayPrimaryPurchaseToken: TOKEN,
          subscriptionPlatform: "android",
          subscriptions: { android: { status: "expired", expiryTime: PAST, primaryPurchaseToken: TOKEN } },
        },
      };
      const result = await call(
        makeHandler({ users, ownership, derived: derivedOf("active", FUTURE, "SUBSCRIPTION_STATE_ACTIVE"), usable: true }),
      );
      assert.equal(result.firestoreApplied, true);
      assert.equal(users.uid.subscriptions.android.status, "active");
    }
  });

  console.log(`googlePlayProbeSafeSync.test.js: ${passed} tests passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
