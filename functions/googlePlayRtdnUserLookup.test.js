const assert = require("node:assert/strict");
const {
  findUserByPurchaseToken,
  applyGoogleSubscriptionUpdateToUser,
  deriveGooglePlayEntitlement,
} = require("./googlePlaySubscriptionNotifications");
const { inferAndroidAutoRenewing } = require("./subscriptionEntitlement");

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
    if (key.includes(".")) {
      const parts = key.split(".");
      let cursor = next;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i];
        cursor[part] =
          cursor[part] && typeof cursor[part] === "object" ? { ...cursor[part] } : {};
        cursor = cursor[part];
      }
      cursor[parts[parts.length - 1]] = value;
      continue;
    }
    if (value && value.__type === "arrayUnion") {
      const existing = Array.isArray(next[key]) ? next[key] : [];
      next[key] = [...new Set(existing.concat(value.values || []))];
      continue;
    }
    next[key] = value;
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

async function runTests() {
  const androidToken = "play-token-Fs2nGk";
  const appleTxn = "2000001226226758";
  const linkedToken = "play-token-linked";

  const topLevel = await findUserByPurchaseToken(
    createQueryDb({
      "uid-a": { activePurchaseTokens: [androidToken] },
    }),
    androidToken,
    "",
  );
  assert.equal(topLevel.kind, "single");
  assert.equal(topLevel.uid, "uid-a");
  assert.equal(topLevel.match, "activePurchaseTokens");

  const primaryOnly = await findUserByPurchaseToken(
    createQueryDb({
      "uid-a": {
        activePurchaseTokens: [appleTxn],
        googlePlayPrimaryPurchaseToken: androidToken,
      },
    }),
    androidToken,
    "",
  );
  assert.equal(primaryOnly.kind, "single");
  assert.equal(primaryOnly.uid, "uid-a");
  assert.equal(primaryOnly.match, "googlePlayPrimaryPurchaseToken");

  const nestedPrimaryOnly = await findUserByPurchaseToken(
    createQueryDb({
      "uid-a": {
        activePurchaseTokens: [appleTxn],
        subscriptions: {
          android: { primaryPurchaseToken: androidToken },
        },
      },
    }),
    androidToken,
    "",
  );
  assert.equal(nestedPrimaryOnly.kind, "single");
  assert.equal(nestedPrimaryOnly.uid, "uid-a");
  assert.equal(nestedPrimaryOnly.match, "subscriptions.android.primaryPurchaseToken");

  const nestedArrayOnly = await findUserByPurchaseToken(
    createQueryDb({
      "uid-a": {
        activePurchaseTokens: [appleTxn],
        subscriptions: {
          android: { activePurchaseTokens: [androidToken] },
        },
      },
    }),
    androidToken,
    "",
  );
  assert.equal(nestedArrayOnly.kind, "single");
  assert.equal(nestedArrayOnly.uid, "uid-a");
  assert.equal(nestedArrayOnly.match, "subscriptions.android.activePurchaseTokens");

  const linkedOnly = await findUserByPurchaseToken(
    createQueryDb({
      "uid-a": { googlePlayPrimaryPurchaseToken: linkedToken },
    }),
    androidToken,
    linkedToken,
  );
  assert.equal(linkedOnly.kind, "single");
  assert.equal(linkedOnly.uid, "uid-a");
  assert.equal(linkedOnly.matchedToken, linkedToken);

  const afterIosReplace = await findUserByPurchaseToken(
    createQueryDb({
      "uid-xSnxE3": {
        activePurchaseTokens: [appleTxn],
        googlePlayPrimaryPurchaseToken: androidToken,
        subscriptions: {
          ios: { status: "active" },
          android: {
            status: "active",
            primaryPurchaseToken: androidToken,
            activePurchaseTokens: [androidToken],
          },
        },
      },
    }),
    androidToken,
    "",
  );
  assert.equal(afterIosReplace.kind, "single");
  assert.equal(afterIosReplace.uid, "uid-xSnxE3");

  const unlinked = await findUserByPurchaseToken(createQueryDb({}), androidToken, "");
  assert.equal(unlinked.kind, "unlinked");
  assert.equal(unlinked.uid, undefined);

  const ambiguous = await findUserByPurchaseToken(
    createQueryDb({
      "uid-a": { googlePlayPrimaryPurchaseToken: androidToken },
      "uid-b": {
        subscriptions: { android: { primaryPurchaseToken: androidToken } },
      },
    }),
    androidToken,
    "",
  );
  assert.equal(ambiguous.kind, "ambiguous");
  assert.deepEqual(new Set(ambiguous.uids), new Set(["uid-a", "uid-b"]));

  const sameUidTwoFields = await findUserByPurchaseToken(
    createQueryDb({
      "uid-a": {
        googlePlayPrimaryPurchaseToken: androidToken,
        subscriptions: {
          android: { primaryPurchaseToken: androidToken },
        },
      },
    }),
    androidToken,
    "",
  );
  assert.equal(sameUidTwoFields.kind, "single");
  assert.equal(sameUidTwoFields.uid, "uid-a");

  const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const canceledDerived = deriveGooglePlayEntitlement({
    subscription: { subscriptionState: "SUBSCRIPTION_STATE_CANCELED" },
    matchedLineItem: { expiryTime: futureExpiry },
  });
  assert.equal(canceledDerived.status, "active");
  assert.equal(
    inferAndroidAutoRenewing({
      status: canceledDerived.status,
      subscriptionState: canceledDerived.subscriptionState,
    }),
    false,
  );

  const expiredDerived = deriveGooglePlayEntitlement({
    subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" },
    matchedLineItem: { expiryTime: "2026-08-22T03:40:31.168Z" },
  });
  assert.equal(expiredDerived.status, "expired");
  assert.equal(
    inferAndroidAutoRenewing({
      status: expiredDerived.status,
      subscriptionState: expiredDerived.subscriptionState,
    }),
    false,
  );

  const canceledUsers = {
    "uid-a": {
      activePurchaseTokens: [appleTxn],
      googlePlayPrimaryPurchaseToken: androidToken,
      subscriptions: {
        android: {
          status: "active",
          autoRenewing: true,
          primaryPurchaseToken: androidToken,
          activePurchaseTokens: [androidToken],
        },
      },
    },
  };
  const canceledLookup = await findUserByPurchaseToken(
    createQueryDb(canceledUsers),
    androidToken,
    "",
  );
  assert.equal(canceledLookup.kind, "single");
  await applyGoogleSubscriptionUpdateToUser(
    createQueryDb(canceledUsers),
    createMockAdmin(),
    canceledLookup.uid,
    canceledDerived,
    androidToken,
  );
  assert.equal(canceledUsers["uid-a"].subscriptionStatus, "active");
  assert.equal(canceledUsers["uid-a"].subscriptions.android.status, "active");
  assert.equal(canceledUsers["uid-a"].subscriptions.android.autoRenewing, false);

  const expiredUsers = {
    "uid-a": {
      activePurchaseTokens: [appleTxn],
      googlePlayPrimaryPurchaseToken: androidToken,
      subscriptions: {
        android: {
          status: "active",
          autoRenewing: true,
          primaryPurchaseToken: androidToken,
          activePurchaseTokens: [androidToken],
        },
      },
    },
  };
  const expiredLookup = await findUserByPurchaseToken(
    createQueryDb(expiredUsers),
    androidToken,
    "",
  );
  assert.equal(expiredLookup.kind, "single");
  await applyGoogleSubscriptionUpdateToUser(
    createQueryDb(expiredUsers),
    createMockAdmin(),
    expiredLookup.uid,
    expiredDerived,
    androidToken,
  );
  assert.equal(expiredUsers["uid-a"].subscriptionStatus, "expired");
  assert.equal(expiredUsers["uid-a"].subscriptions.android.status, "expired");
  assert.equal(expiredUsers["uid-a"].subscriptions.android.autoRenewing, false);

  const unlinkedUsers = {
    "uid-a": { activePurchaseTokens: [appleTxn] },
  };
  const before = JSON.stringify(unlinkedUsers);
  const missing = await findUserByPurchaseToken(
    createQueryDb(unlinkedUsers),
    androidToken,
    "",
  );
  assert.equal(missing.kind, "unlinked");
  assert.equal(JSON.stringify(unlinkedUsers), before);

  console.log("googlePlayRtdnUserLookup.test.js: ok");
}

runTests();
