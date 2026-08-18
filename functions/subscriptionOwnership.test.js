const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  assertSubscriptionNotLinkedToOtherUser,
  claimOwnershipDocument,
  buildIosOwnershipId,
  buildAndroidOwnershipId,
  normalizeUuid,
  isSubscriptionOwnerCurrentlyUsable,
  SUBSCRIPTION_ALREADY_LINKED_CODE,
  SUBSCRIPTION_TOKEN_MISMATCH_CODE,
} = require("./subscriptionOwnership");

const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function createMockDb(docsByQuery, ownershipDocs = {}, userDocs = {}) {
  return {
    collection(name) {
      if (name === "users") {
        return {
          where(field, op, value) {
            const key = `${field}|${op}|${value}`;
            const docs = docsByQuery[key] || [];
            return {
              limit() {
                return {
                  async get() {
                    return {
                      docs: docs.map((entry) => ({
                        id: entry.id,
                      })),
                    };
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
                  get(field) {
                    return data ? data[field] : undefined;
                  },
                  id: uid,
                };
              },
            };
          },
        };
      }

      if (name !== "subscription_ownership") {
        throw new Error(`Unexpected collection: ${name}`);
      }

      return {
        doc(id) {
          return { id };
        },
      };
    },
    async runTransaction(callback) {
      const tx = {
        async get(ref) {
          if (Object.prototype.hasOwnProperty.call(userDocs, ref.id)) {
            const data = userDocs[ref.id];
            return {
              exists: data != null,
              data: () => data,
              get(field) {
                return data ? data[field] : undefined;
              },
            };
          }
          const existing = ownershipDocs[ref.id];
          return {
            exists: Boolean(existing),
            get(field) {
              return existing ? existing[field] : undefined;
            },
          };
        },
        set(ref, data) {
          ownershipDocs[ref.id] = {
            ...(ownershipDocs[ref.id] || {}),
            ...data,
          };
        },
      };
      return callback(tx);
    },
  };
}

const admin = {
  FieldValue: {
    serverTimestamp() {
      return { __type: "serverTimestamp" };
    },
  },
};

function activeIosUser(overrides = {}) {
  return {
    entitlementUsable: true,
    entitlementExpiryTime: futureExpiry,
    entitlementSource: "ios",
    subscriptions: {
      ios: {
        status: "active",
        expiryTime: futureExpiry,
        source: "app_store_verify",
      },
    },
    appStoreOriginalTransactionId: "2000001194540581",
    ...overrides,
  };
}

function expiredIosUser(overrides = {}) {
  return {
    entitlementUsable: false,
    entitlementExpiryTime: pastExpiry,
    entitlementSource: "none",
    subscriptions: {
      ios: {
        status: "expired",
        expiryTime: pastExpiry,
        source: "app_store_verify",
      },
    },
    appStoreOriginalTransactionId: "2000001194540581",
    ...overrides,
  };
}

function activeAndroidUser(overrides = {}) {
  return {
    entitlementUsable: true,
    entitlementExpiryTime: futureExpiry,
    entitlementSource: "android",
    subscriptions: {
      android: {
        status: "active",
        expiryTime: futureExpiry,
        source: "google_play_verify",
      },
    },
    activePurchaseTokens: ["android-token-1"],
    ...overrides,
  };
}

function expiredAndroidUser(overrides = {}) {
  return {
    entitlementUsable: false,
    entitlementExpiryTime: pastExpiry,
    entitlementSource: "none",
    subscriptions: {
      android: {
        status: "expired",
        expiryTime: pastExpiry,
        source: "google_play_verify",
      },
    },
    activePurchaseTokens: ["android-token-1"],
    ...overrides,
  };
}

async function run() {
  const dbUnlinked = createMockDb({});
  await assertSubscriptionNotLinkedToOtherUser(dbUnlinked, {
    uid: "uid-a",
    platform: "ios",
    identifiers: {
      originalTransactionId: "2000001194540581",
      transactionId: "2000001203730221",
    },
    log: { info() {}, warn() {} },
  });

  const dbActiveOther = createMockDb(
    {
      "appStoreOriginalTransactionId|==|2000001194540581": [{ id: "uid-b" }],
    },
    {},
    {
      "uid-b": activeIosUser(),
    }
  );
  await assert.rejects(
    () =>
      assertSubscriptionNotLinkedToOtherUser(dbActiveOther, {
        uid: "uid-a",
        platform: "ios",
        identifiers: {
          originalTransactionId: "2000001194540581",
          transactionId: "2000001203730221",
        },
        log: { info() {}, warn() {} },
      }),
    (error) => error.details.code === SUBSCRIPTION_ALREADY_LINKED_CODE
  );

  const dbExpiredOther = createMockDb(
    {
      "appStoreOriginalTransactionId|==|2000001194540581": [{ id: "uid-b" }],
    },
    {},
    {
      "uid-b": expiredIosUser(),
    }
  );
  await assertSubscriptionNotLinkedToOtherUser(dbExpiredOther, {
    uid: "uid-a",
    platform: "ios",
    identifiers: {
      originalTransactionId: "2000001194540581",
      transactionId: "2000001203730221",
    },
    log: { info() {}, warn() {} },
  });

  const dbActiveAndroidOther = createMockDb(
    {
      "activePurchaseTokens|array-contains|android-token-1": [{ id: "uid-b" }],
    },
    {},
    {
      "uid-b": activeAndroidUser(),
    }
  );
  await assert.rejects(
    () =>
      assertSubscriptionNotLinkedToOtherUser(dbActiveAndroidOther, {
        uid: "uid-a",
        platform: "android",
        identifiers: {
          purchaseToken: "android-token-1",
        },
        log: { info() {}, warn() {} },
      }),
    (error) => error.details.code === SUBSCRIPTION_ALREADY_LINKED_CODE
  );

  const dbExpiredAndroidOther = createMockDb(
    {
      "activePurchaseTokens|array-contains|android-token-1": [{ id: "uid-b" }],
    },
    {},
    {
      "uid-b": expiredAndroidUser(),
    }
  );
  await assertSubscriptionNotLinkedToOtherUser(dbExpiredAndroidOther, {
    uid: "uid-a",
    platform: "android",
    identifiers: {
      purchaseToken: "android-token-1",
    },
    log: { info() {}, warn() {} },
  });

  const dbSameUid = createMockDb(
    {
      "appStoreOriginalTransactionId|==|2000001194540581": [{ id: "uid-a" }],
    },
    {},
    {
      "uid-a": activeIosUser(),
    }
  );
  await assertSubscriptionNotLinkedToOtherUser(dbSameUid, {
    uid: "uid-a",
    platform: "ios",
    identifiers: {
      originalTransactionId: "2000001194540581",
      transactionId: "2000001203730221",
    },
    log: { info() {}, warn() {} },
  });

  const dbBrokenOwner = createMockDb(
    {
      "appStoreOriginalTransactionId|==|2000001194540581": [{ id: "uid-b" }],
    },
    {},
    {
      "uid-b": {
        entitlementUsable: "not-a-boolean",
        subscriptionStatus: "active",
        subscriptionExpiryTime: futureExpiry,
        subscriptionPlatform: "ios",
      },
    }
  );
  await assert.rejects(
    () =>
      assertSubscriptionNotLinkedToOtherUser(dbBrokenOwner, {
        uid: "uid-a",
        platform: "ios",
        identifiers: {
          originalTransactionId: "2000001194540581",
          transactionId: "2000001203730221",
        },
        log: { info() {}, warn() {} },
      }),
    (error) => error.details.code === SUBSCRIPTION_ALREADY_LINKED_CODE
  );

  const dbLoadFail = {
    collection(name) {
      if (name !== "users") {
        throw new Error(`Unexpected collection: ${name}`);
      }
      return {
        where(field, op, value) {
          const key = `${field}|${op}|${value}`;
          const docs =
            {
              "appStoreOriginalTransactionId|==|2000001194540581": [{ id: "uid-b" }],
            }[key] || [];
          return {
            limit() {
              return {
                async get() {
                  return {
                    docs: docs.map((entry) => ({ id: entry.id })),
                  };
                },
              };
            },
          };
        },
        doc() {
          return {
            async get() {
              throw new Error("simulated owner load failure");
            },
          };
        },
      };
    },
  };
  await assert.rejects(
    () =>
      assertSubscriptionNotLinkedToOtherUser(dbLoadFail, {
        uid: "uid-a",
        platform: "ios",
        identifiers: {
          originalTransactionId: "2000001194540581",
          transactionId: "2000001203730221",
        },
        log: { info() {}, warn() {} },
      }),
    (error) => error.details.code === SUBSCRIPTION_ALREADY_LINKED_CODE
  );

  const crossPlatformOnly = isSubscriptionOwnerCurrentlyUsable(
    {
      entitlementUsable: true,
      entitlementExpiryTime: futureExpiry,
      entitlementSource: "android",
      subscriptions: {
        android: {
          status: "active",
          expiryTime: futureExpiry,
        },
      },
      appStoreOriginalTransactionId: "2000001194540581",
    },
    "ios"
  );
  assert.equal(crossPlatformOnly.ownerCurrentlyUsable, false);
  assert.equal(crossPlatformOnly.reason, "active_other_platform_only");

  const ownershipDocs = {};
  const dbOwnership = createMockDb({}, ownershipDocs);
  const ownershipId = buildIosOwnershipId("2000001194540581");
  await claimOwnershipDocument(dbOwnership, admin, {
    uid: "uid-a",
    ownershipId,
    platform: "ios",
    ownershipFields: {
      productId: "ohayo_kamome_monthly",
      appStoreOriginalTransactionId: "2000001194540581",
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(ownershipDocs[ownershipId].ownerUid, "uid-a");

  await claimOwnershipDocument(dbOwnership, admin, {
    uid: "uid-a",
    ownershipId,
    platform: "ios",
    ownershipFields: {
      productId: "ohayo_kamome_monthly",
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(ownershipDocs[ownershipId].ownerUid, "uid-a");

  const activeConflictDocs = { [ownershipId]: { ownerUid: "uid-b" } };
  const dbActiveConflict = createMockDb({}, activeConflictDocs, {
    "uid-b": activeIosUser(),
  });
  await assert.rejects(
    () =>
      claimOwnershipDocument(dbActiveConflict, admin, {
        uid: "uid-c",
        ownershipId,
        platform: "ios",
        ownershipFields: {
          productId: "ohayo_kamome_monthly",
        },
        log: { info() {}, warn() {} },
      }),
    (error) => {
      assert.equal(error instanceof HttpsError, true);
      assert.equal(error.details.code, SUBSCRIPTION_ALREADY_LINKED_CODE);
      return true;
    }
  );

  const inactiveConflictDocs = { [ownershipId]: { ownerUid: "uid-b" } };
  const dbInactiveConflict = createMockDb({}, inactiveConflictDocs, {
    "uid-b": expiredIosUser(),
  });
  await claimOwnershipDocument(dbInactiveConflict, admin, {
    uid: "uid-c",
    ownershipId,
    platform: "ios",
    ownershipFields: {
      productId: "ohayo_kamome_monthly",
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(inactiveConflictDocs[ownershipId].ownerUid, "uid-c");
  assert.equal(inactiveConflictDocs[ownershipId].previousOwnerUid, "uid-b");

  const raceDocs = {};
  const dbRace = createMockDb({}, raceDocs);
  const androidOwnershipId = buildAndroidOwnershipId("android-token-1");
  await Promise.allSettled([
    claimOwnershipDocument(dbRace, admin, {
      uid: "uid-a",
      ownershipId: androidOwnershipId,
      platform: "android",
      ownershipFields: { productId: "ohayo_kamome_monthly" },
      log: { info() {}, warn() {} },
    }),
    claimOwnershipDocument(dbRace, admin, {
      uid: "uid-b",
      ownershipId: androidOwnershipId,
      platform: "android",
      ownershipFields: { productId: "ohayo_kamome_monthly" },
      log: { info() {}, warn() {} },
    }),
  ]);
  const owners = new Set(
    Object.values(raceDocs).map((entry) => entry.ownerUid).filter(Boolean)
  );
  assert.equal(owners.size, 1);

  assert.equal(
    normalizeUuid("550E8400-E29B-41D4-A716-446655440000"),
    "550e8400-e29b-41d4-a716-446655440000"
  );
  assert.equal(normalizeUuid("not-a-uuid"), "");

  const mismatchError = new HttpsError(
    "failed-precondition",
    SUBSCRIPTION_TOKEN_MISMATCH_CODE,
    { code: SUBSCRIPTION_TOKEN_MISMATCH_CODE, platform: "ios" }
  );
  assert.equal(mismatchError.details.code, SUBSCRIPTION_TOKEN_MISMATCH_CODE);

  console.log("subscriptionOwnership logic checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
