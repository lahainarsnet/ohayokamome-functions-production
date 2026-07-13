const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  assertSubscriptionNotLinkedToOtherUser,
  claimOwnershipDocument,
  buildIosOwnershipId,
  buildAndroidOwnershipId,
  normalizeUuid,
  SUBSCRIPTION_ALREADY_LINKED_CODE,
  SUBSCRIPTION_TOKEN_MISMATCH_CODE,
} = require("./subscriptionOwnership");

function createMockDb(docsByQuery, ownershipDocs = {}) {
  return {
    collection(name) {
      if (name !== "subscription_ownership") {
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
              async get() {
                return {
                  exists: false,
                  get() {
                    return "";
                  },
                };
              },
            };
          },
        };
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

async function run() {
  const dbUnlinked = createMockDb({});
  await assertSubscriptionNotLinkedToOtherUser(dbUnlinked, {
    uid: "uid-a",
    platform: "ios",
    identifiers: {
      originalTransactionId: "2000001194540581",
      transactionId: "2000001203730221",
    },
    log: { warn() {} },
  });

  const dbOther = createMockDb({
    "appStoreOriginalTransactionId|==|2000001194540581": [{ id: "uid-b" }],
  });
  await assert.rejects(
    () =>
      assertSubscriptionNotLinkedToOtherUser(dbOther, {
        uid: "uid-a",
        platform: "ios",
        identifiers: {
          originalTransactionId: "2000001194540581",
          transactionId: "2000001203730221",
        },
        log: { warn() {} },
      }),
    (error) => error.details.code === SUBSCRIPTION_ALREADY_LINKED_CODE
  );

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

  await assert.rejects(
    () =>
      claimOwnershipDocument(dbOwnership, admin, {
        uid: "uid-b",
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
