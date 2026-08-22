const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  assertSubscriptionNotLinkedToOtherUser,
  claimOwnershipDocument,
  claimAndroidSubscriptionOwnership,
  claimIosSubscriptionOwnership,
  inspectSubscriptionSeriesOwnership,
  buildIosOwnershipId,
  buildAndroidOwnershipId,
  normalizeUuid,
  isSubscriptionOwnerCurrentlyUsable,
  buildDetachedAppleIdentifierUpdate,
  SUBSCRIPTION_ALREADY_LINKED_CODE,
  SUBSCRIPTION_TOKEN_MISMATCH_CODE,
  SUBSCRIPTION_SERIES_AMBIGUOUS_CODE,
} = require("./subscriptionOwnership");

const futureExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function createMockDb(docsByQuery, ownershipDocs = {}, userDocs = {}) {
  function applyMerge(target, data) {
    const next = { ...(target || {}) };
    for (const [key, value] of Object.entries(data || {})) {
      if (value && value.__type === "delete") {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    return next;
  }

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
              __kind: "user",
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
          return {
            id,
            __kind: "ownership",
            async get() {
              const existing = ownershipDocs[id];
              return {
                exists: Boolean(existing),
                get(field) {
                  return existing ? existing[field] : undefined;
                },
              };
            },
          };
        },
      };
    },
    async runTransaction(callback) {
      const tx = {
        async get(ref) {
          if (ref.__kind === "user" || Object.prototype.hasOwnProperty.call(userDocs, ref.id)) {
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
          if (ref.__kind === "user") {
            userDocs[ref.id] = applyMerge(userDocs[ref.id], data);
            return;
          }
          ownershipDocs[ref.id] = applyMerge(ownershipDocs[ref.id], data);
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
    delete() {
      return { __type: "delete" };
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

  const previousOwnerUsers = {
    "uid-b": expiredIosUser({
      appStoreTransactionId: "txn-old-b",
      activePurchaseTokens: ["txn-old-b", "keep-other-token"],
      googlePlayPurchaseToken: "keep-play-token",
    }),
  };
  const inactiveConflictDocs = { [ownershipId]: { ownerUid: "uid-b" } };
  const dbInactiveConflict = createMockDb({}, inactiveConflictDocs, previousOwnerUsers);
  await claimOwnershipDocument(dbInactiveConflict, admin, {
    uid: "uid-c",
    ownershipId,
    platform: "ios",
    ownershipFields: {
      productId: "ohayo_kamome_monthly",
      appStoreOriginalTransactionId: "2000001194540581",
      appStoreTransactionId: "txn-old-b",
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(inactiveConflictDocs[ownershipId].ownerUid, "uid-c");

  const detachNone = buildDetachedAppleIdentifierUpdate(
    { appStoreOriginalTransactionId: "2000001999999999" },
    {
      originalTransactionId: "2000001194540581",
      transactionId: "txn-new",
      admin,
    }
  );
  assert.equal(detachNone, null);

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

  const androidUserDocs = { "uid-a": {} };
  const androidOwnDocs = {};
  const dbAndroidBind = createMockDb({}, androidOwnDocs, androidUserDocs);
  await claimAndroidSubscriptionOwnership(dbAndroidBind, admin, {
    uid: "uid-a",
    purchaseToken: "android-token-1",
    productId: "ohayo_kamome_monthly",
    log: { info() {}, warn() {} },
  });
  const androidId1 = buildAndroidOwnershipId("android-token-1");
  assert.equal(androidOwnDocs[androidId1].ownerUid, "uid-a");
  assert.equal(
    androidUserDocs["uid-a"].boundSubscriptionSeries.android.ownershipId,
    androidId1
  );

  await claimAndroidSubscriptionOwnership(dbAndroidBind, admin, {
    uid: "uid-a",
    purchaseToken: "android-token-2",
    linkedPurchaseToken: "android-token-1",
    productId: "ohayo_kamome_monthly",
    log: { info() {}, warn() {} },
  });
  const androidId2 = buildAndroidOwnershipId("android-token-2");
  assert.equal(androidOwnDocs[androidId2].ownerUid, "uid-a");

  await claimAndroidSubscriptionOwnership(
    createMockDb({}, {}, {
      "uid-a": {
        boundSubscriptionSeries: {
          android: { ownershipId: androidId1 },
        },
        subscriptions: {
          android: { status: "expired", expiryTime: pastExpiry },
        },
      },
    }),
    admin,
    {
      uid: "uid-a",
      purchaseToken: "android-token-other",
      productId: "ohayo_kamome_monthly",
      log: { info() {}, warn() {} },
    }
  );

  await assert.rejects(
    () =>
      claimAndroidSubscriptionOwnership(
        createMockDb({}, {}, {
          "uid-a": {
            boundSubscriptionSeries: {
              android: { ownershipId: androidId1 },
            },
            subscriptions: {
              android: { status: "active", expiryTime: futureExpiry },
            },
          },
        }),
        admin,
        {
          uid: "uid-a",
          purchaseToken: "android-token-other",
          productId: "ohayo_kamome_monthly",
          log: { info() {}, warn() {} },
        }
      ),
    (error) => error.details.code === SUBSCRIPTION_ALREADY_LINKED_CODE
  );

  await claimAndroidSubscriptionOwnership(
    createMockDb({}, {}, {
      "uid-a": {
        googlePlayPrimaryPurchaseToken: "android-token-old",
        subscriptions: {
          android: { status: "expired", expiryTime: pastExpiry },
        },
      },
    }),
    admin,
    {
      uid: "uid-a",
      purchaseToken: "android-token-new-unrelated",
      productId: "ohayo_kamome_monthly",
      log: { info() {}, warn() {} },
    }
  );

  await assert.rejects(
    () =>
      claimAndroidSubscriptionOwnership(
        createMockDb({}, {}, {
          "uid-a": {
            googlePlayPrimaryPurchaseToken: "android-token-old",
            subscriptions: {
              android: { status: "active", expiryTime: futureExpiry },
            },
          },
        }),
        admin,
        {
          uid: "uid-a",
          purchaseToken: "android-token-new-unrelated",
          productId: "ohayo_kamome_monthly",
          log: { info() {}, warn() {} },
        }
      ),
    (error) => error.details.code === SUBSCRIPTION_SERIES_AMBIGUOUS_CODE
  );

  const expiredAndroidOwn = {
    [androidId1]: { ownerUid: "uid-b" },
  };
  await claimAndroidSubscriptionOwnership(
    createMockDb({}, expiredAndroidOwn, {
      "uid-a": {},
      "uid-b": expiredAndroidUser(),
    }),
    admin,
    {
      uid: "uid-a",
      purchaseToken: "android-token-1",
      productId: "ohayo_kamome_monthly",
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(expiredAndroidOwn[androidId1].ownerUid, "uid-a");

  const iosUserDocs = { "uid-a": {} };
  const iosOwnDocs = {};
  const dbIosBind = createMockDb({}, iosOwnDocs, iosUserDocs);
  await claimIosSubscriptionOwnership(dbIosBind, admin, {
    uid: "uid-a",
    update: {
      appStoreOriginalTransactionId: "2000001194540581",
      appStoreTransactionId: "2000001203730221",
    },
    transactionInfo: {
      originalTransactionId: "2000001194540581",
      appAccountToken: "",
    },
    productId: "ohayo_kamome_monthly",
    log: { info() {}, warn() {} },
  });
  assert.equal(iosOwnDocs[ownershipId].ownerUid, "uid-a");
  assert.equal(
    iosUserDocs["uid-a"].boundSubscriptionSeries.ios.originalTransactionId,
    "2000001194540581"
  );

  await assert.rejects(
    () =>
      claimIosSubscriptionOwnership(
        createMockDb({}, {}, {
          "uid-a": {
            boundSubscriptionSeries: {
              ios: {
                ownershipId,
                originalTransactionId: "2000001194540581",
              },
            },
            subscriptions: {
              ios: { status: "active", expiryTime: futureExpiry },
            },
          },
        }),
        admin,
        {
          uid: "uid-a",
          update: { appStoreOriginalTransactionId: "2000001999999999" },
          transactionInfo: { originalTransactionId: "2000001999999999" },
          productId: "ohayo_kamome_monthly",
          log: { info() {}, warn() {} },
        }
      ),
    (error) => error.details.code === SUBSCRIPTION_ALREADY_LINKED_CODE
  );

  const bothPlatformsUsers = {
    "uid-a": {
      boundSubscriptionSeries: {
        android: { ownershipId: androidId1 },
      },
    },
  };
  const bothPlatformsOwn = {};
  await claimIosSubscriptionOwnership(
    createMockDb({}, bothPlatformsOwn, bothPlatformsUsers),
    admin,
    {
      uid: "uid-a",
      update: { appStoreOriginalTransactionId: "2000001194540581" },
      transactionInfo: { originalTransactionId: "2000001194540581" },
      productId: "ohayo_kamome_monthly",
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(
    bothPlatformsUsers["uid-a"].boundSubscriptionSeries.android.ownershipId,
    androidId1
  );
  assert.equal(
    bothPlatformsUsers["uid-a"].boundSubscriptionSeries.ios.originalTransactionId,
    "2000001194540581"
  );

  const inspectNone = await inspectSubscriptionSeriesOwnership(
    createMockDb({}, {}, { "uid-a": {} }),
    { uid: "uid-a", platform: "android", log: { info() {}, warn() {} } }
  );
  assert.equal(inspectNone.decision, "none");

  const inspectMatch = await inspectSubscriptionSeriesOwnership(
    createMockDb({}, { [androidId1]: { ownerUid: "uid-a" } }, { "uid-a": {} }),
    {
      uid: "uid-a",
      platform: "android",
      purchaseToken: "android-token-1",
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(inspectMatch.decision, "match");

  const inspectLinkedMatch = await inspectSubscriptionSeriesOwnership(
    createMockDb({}, { [androidId1]: { ownerUid: "uid-a" } }, {
      "uid-a": {
        boundSubscriptionSeries: {
          android: { ownershipId: androidId1 },
        },
      },
    }),
    {
      uid: "uid-a",
      platform: "android",
      purchaseToken: "android-token-2",
      linkedPurchaseToken: "android-token-1",
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(inspectLinkedMatch.decision, "match");

  const inspectOtherActive = await inspectSubscriptionSeriesOwnership(
    createMockDb({}, { [androidId1]: { ownerUid: "uid-b" } }, {
      "uid-a": {},
      "uid-b": activeAndroidUser(),
    }),
    {
      uid: "uid-a",
      platform: "android",
      purchaseToken: "android-token-1",
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(inspectOtherActive.decision, "mismatch");

  const inspectOtherExpired = await inspectSubscriptionSeriesOwnership(
    createMockDb({}, { [androidId1]: { ownerUid: "uid-b" } }, {
      "uid-a": {},
      "uid-b": expiredAndroidUser(),
    }),
    {
      uid: "uid-a",
      platform: "android",
      purchaseToken: "android-token-1",
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(inspectOtherExpired.decision, "mismatch");

  const inspectSameUidOtherSeries = await inspectSubscriptionSeriesOwnership(
    createMockDb({}, {}, {
      "uid-a": {
        boundSubscriptionSeries: {
          android: { ownershipId: androidId1 },
        },
      },
    }),
    {
      uid: "uid-a",
      platform: "android",
      purchaseToken: "android-token-other",
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(inspectSameUidOtherSeries.decision, "none");

  const inspectIosMatch = await inspectSubscriptionSeriesOwnership(
    createMockDb({}, { [ownershipId]: { ownerUid: "uid-a" } }, { "uid-a": {} }),
    {
      uid: "uid-a",
      platform: "ios",
      originalTransactionId: "2000001194540581",
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(inspectIosMatch.decision, "match");

  const inspectIosOther = await inspectSubscriptionSeriesOwnership(
    createMockDb({}, { [ownershipId]: { ownerUid: "uid-b" } }, {
      "uid-a": {},
      "uid-b": expiredIosUser(),
    }),
    {
      uid: "uid-a",
      platform: "ios",
      originalTransactionId: "2000001194540581",
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(inspectIosOther.decision, "mismatch");

  const inspectIosOtherSeries = await inspectSubscriptionSeriesOwnership(
    createMockDb({}, {}, {
      "uid-a": {
        boundSubscriptionSeries: {
          ios: {
            ownershipId,
            originalTransactionId: "2000001194540581",
          },
        },
      },
    }),
    {
      uid: "uid-a",
      platform: "ios",
      originalTransactionId: "2000001999999999",
      log: { info() {}, warn() {} },
    }
  );
  assert.equal(inspectIosOtherSeries.decision, "none");

  console.log("subscriptionOwnership logic checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
