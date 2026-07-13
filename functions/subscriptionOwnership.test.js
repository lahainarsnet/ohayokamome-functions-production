const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  assertSubscriptionNotLinkedToOtherUser,
  SUBSCRIPTION_ALREADY_LINKED_CODE,
} = require("./subscriptionOwnership");

function createMockDb(docsByQuery) {
  return {
    collection() {
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
      };
    },
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
    log: { warn() {} },
  });

  const dbSelf = createMockDb({
    "appStoreOriginalTransactionId|==|2000001194540581": [{ id: "uid-a" }],
  });
  await assertSubscriptionNotLinkedToOtherUser(dbSelf, {
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
    (error) => {
      assert.equal(error instanceof HttpsError, true);
      assert.equal(error.code, "failed-precondition");
      assert.equal(error.message, SUBSCRIPTION_ALREADY_LINKED_CODE);
      assert.equal(error.details.code, SUBSCRIPTION_ALREADY_LINKED_CODE);
      assert.equal(error.details.platform, "ios");
      return true;
    }
  );

  const dbAndroidOther = createMockDb({
    "activePurchaseTokens|array-contains|android-token-1": [{ id: "uid-b" }],
  });
  await assert.rejects(
    () =>
      assertSubscriptionNotLinkedToOtherUser(dbAndroidOther, {
        uid: "uid-a",
        platform: "android",
        identifiers: { purchaseToken: "android-token-1" },
        log: { warn() {} },
      }),
    (error) => {
      assert.equal(error.details.platform, "android");
      return true;
    }
  );

  console.log("subscriptionOwnership logic checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
