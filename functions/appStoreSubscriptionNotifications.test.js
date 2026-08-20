const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  decideAppStoreNotificationApply,
  findUsersByAppAccountToken,
} = require("./appStoreSubscriptionNotifications");
const {
  claimOwnershipDocument,
  buildIosOwnershipId,
  SUBSCRIPTION_ALREADY_LINKED_CODE,
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
  },
};

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
  assert.equal(ownershipDocs[ownershipId].previousOwnerUid, "uid-4b");

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

  console.log("appStoreSubscriptionNotifications token-defer checks passed");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
