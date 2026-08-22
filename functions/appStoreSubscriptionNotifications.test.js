const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  decideAppStoreNotificationApply,
  findUsersByAppAccountToken,
  findTargetUser,
  resolveAppStoreNotificationUser,
  applyUserSubscriptionUpdate,
} = require("./appStoreSubscriptionNotifications");
const {
  claimOwnershipDocument,
  buildIosOwnershipId,
  SUBSCRIPTION_ALREADY_LINKED_CODE,
  detachStaleAppleIdentifiersFromOtherUsers,
} = require("./subscriptionOwnership");

const NEW_OWNER_TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-111111111111";
const OLD_OWNER_TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-222222222222";
const UNKNOWN_TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-999999999999";

function createUsersQueryDb(docsByQuery) {
  return {
    collection(name) {
      assert.equal(name, "users");
      return {
        where(field, op, value) {
          const key = `${field}|${op}|${value}`;
          const docs = docsByQuery[key] || [];
          return {
            limit() {
              return {
                async get() {
                  return {
                    size: docs.length,
                    docs: docs.map((entry) => ({ id: entry.id })),
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function createOwnershipMockDb(ownershipDocs = {}, userDocs = {}) {
  return {
    collection(name) {
      if (name === "users") {
        return {
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
      await callback(tx);
    },
  };
}

const admin = {
  FieldValue: {
    serverTimestamp() {
      return "SERVER_TIMESTAMP";
    },
    delete() {
      return { __type: "delete" };
    },
  },
  Timestamp: {
    fromMillis(ms) {
      const date = new Date(ms);
      return {
        toDate: () => date,
        toMillis: () => ms,
      };
    },
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
    if (value && value.__type === "delete") {
      delete next[key];
      continue;
    }
    if (key.includes(".")) {
      const [head, tail] = key.split(".");
      next[head] = { ...(next[head] || {}), [tail]: value };
      continue;
    }
    next[key] = value;
  }
  return next;
}

function createAppleNotificationDb({ userDocs = {}, ownershipDocs = {} } = {}) {
  function matchesQuery(data, field, op, value) {
    if (op === "==") {
      return String(data?.[field] || "") === String(value);
    }
    if (op === "array-contains") {
      return Array.isArray(data?.[field]) && data[field].some((item) => item === value);
    }
    return false;
  }

  return {
    collection(name) {
      if (name === "users") {
        return {
          where(field, op, value) {
            const docs = Object.entries(userDocs)
              .filter(([, data]) => matchesQuery(data, field, op, value))
              .map(([id, data]) => ({ id, data }));
            return {
              limit() {
                return {
                  async get() {
                    return {
                      size: docs.length,
                      docs: docs.map((entry) => ({
                        id: entry.id,
                        data: () => userDocs[entry.id],
                        ref: {
                          id: entry.id,
                          async set(update) {
                            userDocs[entry.id] = applyMerge(
                              userDocs[entry.id],
                              update
                            );
                          },
                        },
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
                  id: uid,
                  data: () => data,
                  get(field) {
                    return data ? data[field] : undefined;
                  },
                };
              },
              async set(update) {
                userDocs[uid] = applyMerge(userDocs[uid], update);
              },
            };
          },
        };
      }
      if (name === "subscription_ownership") {
        return {
          doc(id) {
            return {
              id,
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
      }
      throw new Error(`Unexpected collection: ${name}`);
    },
    async runTransaction(callback) {
      const tx = {
        async get(ref) {
          const data = userDocs[ref.id];
          return {
            exists: data != null,
            data: () => data || {},
            get(field) {
              return data ? data[field] : undefined;
            },
          };
        },
        set(ref, data) {
          userDocs[ref.id] = applyMerge(userDocs[ref.id], data);
        },
      };
      return callback(tx);
    },
  };
}

function expiredIosUser() {
  return {
    entitlementUsable: false,
    entitlementSource: "ios",
    subscriptionStatus: "expired",
    subscriptionPlatform: "ios",
    subscriptionExpiryTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  };
}

function activeIosUser() {
  return {
    entitlementUsable: true,
    entitlementSource: "ios",
    entitlementExpiryTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    subscriptionStatus: "active",
    subscriptionPlatform: "ios",
    subscriptionExpiryTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

async function resolveApplyFromDb(db, { originalOwnerUid, appAccountToken }) {
  const tokenLookup = await findUsersByAppAccountToken(db, appAccountToken);
  return decideAppStoreNotificationApply({
    originalOwnerUid,
    appAccountToken,
    tokenOwnerUids: tokenLookup.uids || [],
  });
}

async function runTests() {
  const resubscribe = decideAppStoreNotificationApply({
    originalOwnerUid: "uid-4b",
    appAccountToken: NEW_OWNER_TOKEN,
    tokenOwnerUids: ["uid-1b"],
  });
  assert.equal(resubscribe.action, "defer");
  assert.equal(resubscribe.reason, "deferred_token_mismatch");
  assert.equal(resubscribe.tokenOwnerUid, "uid-1b");

  const dbResubscribe = createUsersQueryDb({
    [`appStoreAppAccountToken|==|${NEW_OWNER_TOKEN}`]: [{ id: "uid-1b" }],
  });
  const resubscribeFromDb = await resolveApplyFromDb(dbResubscribe, {
    originalOwnerUid: "uid-4b",
    appAccountToken: NEW_OWNER_TOKEN,
  });
  assert.equal(resubscribeFromDb.action, "defer");
  assert.equal(resubscribeFromDb.reason, "deferred_token_mismatch");

  const didRenew = decideAppStoreNotificationApply({
    originalOwnerUid: "uid-4b",
    appAccountToken: OLD_OWNER_TOKEN,
    tokenOwnerUids: ["uid-4b"],
  });
  assert.equal(didRenew.action, "apply");
  assert.equal(didRenew.reason, "token_matches_original_owner");

  const dbDidRenew = createUsersQueryDb({
    [`appStoreAppAccountToken|==|${OLD_OWNER_TOKEN}`]: [{ id: "uid-4b" }],
  });
  const didRenewFromDb = await resolveApplyFromDb(dbDidRenew, {
    originalOwnerUid: "uid-4b",
    appAccountToken: OLD_OWNER_TOKEN,
  });
  assert.equal(didRenewFromDb.action, "apply");
  assert.equal(didRenewFromDb.reason, "token_matches_original_owner");

  const legacyMissing = decideAppStoreNotificationApply({
    originalOwnerUid: "uid-4b",
    appAccountToken: "",
    tokenOwnerUids: [],
  });
  assert.equal(legacyMissing.action, "apply");
  assert.equal(legacyMissing.reason, "legacy_missing_token");

  const legacyNull = decideAppStoreNotificationApply({
    originalOwnerUid: "uid-4b",
    appAccountToken: null,
    tokenOwnerUids: [],
  });
  assert.equal(legacyNull.action, "apply");
  assert.equal(legacyNull.reason, "legacy_missing_token");

  const unlinked = decideAppStoreNotificationApply({
    originalOwnerUid: "uid-4b",
    appAccountToken: UNKNOWN_TOKEN,
    tokenOwnerUids: [],
  });
  assert.equal(unlinked.action, "apply");
  assert.equal(unlinked.reason, "legacy_token_unlinked");
  assert.equal(unlinked.tokenOwnerUid, undefined);

  const dbUnlinked = createUsersQueryDb({});
  const unlinkedFromDb = await resolveApplyFromDb(dbUnlinked, {
    originalOwnerUid: "uid-4b",
    appAccountToken: UNKNOWN_TOKEN,
  });
  assert.equal(unlinkedFromDb.action, "apply");
  assert.equal(unlinkedFromDb.reason, "legacy_token_unlinked");

  const ambiguous = decideAppStoreNotificationApply({
    originalOwnerUid: "uid-4b",
    appAccountToken: NEW_OWNER_TOKEN,
    tokenOwnerUids: ["uid-1b", "uid-other"],
  });
  assert.equal(ambiguous.action, "defer");
  assert.equal(ambiguous.reason, "deferred_token_ambiguous");
  assert.equal(ambiguous.tokenOwnerUid, undefined);

  const dbAmbiguous = createUsersQueryDb({
    [`appStoreAppAccountToken|==|${NEW_OWNER_TOKEN}`]: [
      { id: "uid-1b" },
      { id: "uid-other" },
    ],
  });
  const ambiguousFromDb = await resolveApplyFromDb(dbAmbiguous, {
    originalOwnerUid: "uid-4b",
    appAccountToken: NEW_OWNER_TOKEN,
  });
  assert.equal(ambiguousFromDb.action, "defer");
  assert.equal(ambiguousFromDb.reason, "deferred_token_ambiguous");

  const ownershipId = buildIosOwnershipId("2000001224021466");
  const ownershipDocs = { [ownershipId]: { ownerUid: "uid-4b" } };
  const dbTransfer = createOwnershipMockDb(ownershipDocs, {
    "uid-4b": expiredIosUser(),
  });
  await claimOwnershipDocument(dbTransfer, admin, {
    uid: "uid-1b",
    ownershipId,
    platform: "ios",
    ownershipFields: {
      productId: "ohayo_kamome_monthly",
      appStoreOriginalTransactionId: "2000001224021466",
    },
    log: { info() {}, warn() {} },
  });
  assert.equal(ownershipDocs[ownershipId].ownerUid, "uid-1b");

  const activeDocs = { [ownershipId]: { ownerUid: "uid-4b" } };
  const dbActive = createOwnershipMockDb(activeDocs, {
    "uid-4b": activeIosUser(),
  });
  await assert.rejects(
    () =>
      claimOwnershipDocument(dbActive, admin, {
        uid: "uid-1b",
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

  const originalTxn = "2000001000000001";
  const latestTxn = "2000001000000999";
  const ownershipIdForSeries = buildIosOwnershipId(originalTxn);
  const silentLog = { info() {}, warn() {}, error() {} };

  const legacyOnlyUsers = {
    "uid-legacy-one": {
      appStoreOriginalTransactionId: originalTxn,
      appStoreTransactionId: latestTxn,
    },
  };
  const legacyLookup = await resolveAppStoreNotificationUser(
    createAppleNotificationDb({ userDocs: legacyOnlyUsers }),
    originalTxn,
    latestTxn
  );
  assert.equal(legacyLookup.kind, "single");
  assert.equal(legacyLookup.uid, "uid-legacy-one");
  assert.equal(legacyLookup.resolution, "users_query");
  assert.equal(legacyLookup.match, "appStoreOriginalTransactionId");

  const ownerOnlyUsers = {
    "uid-current-owner": {
      appStoreOriginalTransactionId: originalTxn,
      appStoreAppAccountToken: NEW_OWNER_TOKEN,
    },
  };
  const ownerOnlyLookup = await resolveAppStoreNotificationUser(
    createAppleNotificationDb({
      userDocs: ownerOnlyUsers,
      ownershipDocs: {
        [ownershipIdForSeries]: {
          ownerUid: "uid-current-owner",
          status: "active",
        },
      },
    }),
    originalTxn,
    latestTxn
  );
  assert.equal(ownerOnlyLookup.kind, "single");
  assert.equal(ownerOnlyLookup.uid, "uid-current-owner");
  assert.equal(ownerOnlyLookup.resolution, "ownership_document");
  assert.equal(ownerOnlyLookup.legacyCandidateCount, 1);

  const dualBindUsers = {
    "uid-expired-previous": {
      email: "previous-owner@example.test",
      entitlementUsable: false,
      subscriptionStatus: "expired",
      appStoreOriginalTransactionId: originalTxn,
      appStoreTransactionId: "2000001000000111",
      activePurchaseTokens: ["2000001000000111"],
      googlePlayPurchaseToken: "keep-play-token",
      auditNote: "keep-history",
      subscriptions: {
        ios: { status: "expired" },
        android: { status: "expired" },
      },
    },
    "uid-current-owner": {
      email: "current-owner@example.test",
      entitlementUsable: true,
      subscriptionStatus: "active",
      appStoreOriginalTransactionId: originalTxn,
      appStoreTransactionId: latestTxn,
      appStoreAppAccountToken: NEW_OWNER_TOKEN,
      activePurchaseTokens: [latestTxn],
    },
  };
  const dualBindDb = createAppleNotificationDb({
    userDocs: dualBindUsers,
    ownershipDocs: {
      [ownershipIdForSeries]: {
        ownerUid: "uid-current-owner",
        previousOwnerUid: "uid-expired-previous",
        status: "active",
      },
    },
  });
  const usersHit = await findTargetUser(dualBindDb, originalTxn, latestTxn);
  assert.equal(usersHit.kind, "ambiguous");
  assert.equal(usersHit.uids.includes("uid-expired-previous"), true);
  assert.equal(usersHit.uids.includes("uid-current-owner"), true);

  const dualBindLookup = await resolveAppStoreNotificationUser(
    dualBindDb,
    originalTxn,
    latestTxn
  );
  assert.equal(dualBindLookup.kind, "single");
  assert.equal(dualBindLookup.uid, "uid-current-owner");
  assert.equal(dualBindLookup.resolution, "ownership_document");
  assert.equal(dualBindLookup.legacyCandidateCount, 2);
  assert.notEqual(dualBindLookup.kind, "ambiguous");

  const tokenDecision = decideAppStoreNotificationApply({
    originalOwnerUid: dualBindLookup.uid,
    appAccountToken: NEW_OWNER_TOKEN,
    tokenOwnerUids: ["uid-current-owner"],
  });
  assert.equal(tokenDecision.action, "apply");

  const mismatchedToken = decideAppStoreNotificationApply({
    originalOwnerUid: dualBindLookup.uid,
    appAccountToken: OLD_OWNER_TOKEN,
    tokenOwnerUids: ["uid-other-token-owner"],
  });
  assert.equal(mismatchedToken.action, "defer");
  assert.equal(mismatchedToken.reason, "deferred_token_mismatch");

  const futureMs = Date.now() + 60 * 60 * 1000;
  const pastMs = Date.now() - 60 * 60 * 1000;
  await applyUserSubscriptionUpdate(
    dualBindDb,
    admin,
    dualBindLookup.uid,
    {
      status: "active",
      originalTransactionId: originalTxn,
      latestTransactionId: latestTxn,
      environment: "Sandbox",
      validationCode: "OK",
      expiresDate: futureMs,
    },
    "app_store_notification_v2",
    { logger: silentLog, notificationUUID: "notice-did-renew" }
  );
  assert.equal(dualBindUsers["uid-current-owner"].subscriptionStatus, "active");
  assert.equal(
    dualBindUsers["uid-current-owner"].appStoreTransactionId,
    latestTxn
  );
  assert.equal(dualBindUsers["uid-expired-previous"].subscriptionStatus, "expired");

  await applyUserSubscriptionUpdate(
    dualBindDb,
    admin,
    dualBindLookup.uid,
    {
      status: "expired",
      originalTransactionId: originalTxn,
      latestTransactionId: latestTxn,
      environment: "Sandbox",
      validationCode: "OK",
      expiresDate: pastMs,
    },
    "app_store_notification_v2",
    { logger: silentLog, notificationUUID: "notice-expired" }
  );
  assert.equal(dualBindUsers["uid-current-owner"].subscriptionStatus, "expired");

  const leftover = await detachStaleAppleIdentifiersFromOtherUsers(
    dualBindDb,
    admin,
    {
      ownerUid: "uid-current-owner",
      originalTransactionId: originalTxn,
      transactionId: latestTxn,
      logger: silentLog,
    }
  );
  assert.equal(leftover.detachedCount, 1);
  assert.equal(
    dualBindUsers["uid-expired-previous"].appStoreOriginalTransactionId,
    undefined
  );
  assert.equal(
    dualBindUsers["uid-expired-previous"].appStoreTransactionId,
    undefined
  );
  assert.deepEqual(dualBindUsers["uid-expired-previous"].activePurchaseTokens, []);
  assert.equal(
    dualBindUsers["uid-expired-previous"].googlePlayPurchaseToken,
    "keep-play-token"
  );
  assert.equal(dualBindUsers["uid-expired-previous"].auditNote, "keep-history");
  assert.equal(
    dualBindUsers["uid-expired-previous"].subscriptions.android.status,
    "expired"
  );
  assert.equal(
    dualBindUsers["uid-current-owner"].appStoreOriginalTransactionId,
    originalTxn
  );

  const afterCleanup = await findTargetUser(dualBindDb, originalTxn, latestTxn);
  assert.equal(afterCleanup.kind, "single");
  assert.equal(afterCleanup.uid, "uid-current-owner");

  const missingOwnerUser = await resolveAppStoreNotificationUser(
    createAppleNotificationDb({
      userDocs: {
        "uid-expired-previous": {
          appStoreOriginalTransactionId: originalTxn,
        },
      },
      ownershipDocs: {
        [ownershipIdForSeries]: {
          ownerUid: "uid-missing-owner",
          status: "active",
        },
      },
    }),
    originalTxn,
    latestTxn
  );
  assert.equal(missingOwnerUser.resolution, "users_query");
  assert.equal(missingOwnerUser.resolutionReason, "ownership_owner_user_missing");
  assert.equal(missingOwnerUser.uid, "uid-expired-previous");
  assert.notEqual(missingOwnerUser.uid, "uid-missing-owner");

  const untrustedStatus = await resolveAppStoreNotificationUser(
    createAppleNotificationDb({
      userDocs: {
        "uid-current-owner": { appStoreOriginalTransactionId: originalTxn },
        "uid-expired-previous": { appStoreOriginalTransactionId: originalTxn },
      },
      ownershipDocs: {
        [ownershipIdForSeries]: {
          ownerUid: "uid-current-owner",
          status: "revoked",
        },
      },
    }),
    originalTxn,
    latestTxn
  );
  assert.equal(untrustedStatus.kind, "ambiguous");
  assert.equal(untrustedStatus.resolution, "users_query");
  assert.equal(untrustedStatus.resolutionReason, "ownership_status_untrusted");

  console.log("appStoreSubscriptionNotifications token-defer checks passed");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
