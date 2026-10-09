const test = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluateReconcileWriteDecision,
  createReconcileWriteGuard,
} = require("./iosSubscriptionReconcile");

const nowMs = Date.UTC(2026, 9, 8, 8, 0, 0);

test("same transaction contradiction allows expired apply", () => {
  const decision = evaluateReconcileWriteDecision({
    userData: {
      billingRevision: 3,
      subscriptions: {
        ios: {
          transactionId: "500",
          status: "active",
          expiryTime: new Date(nowMs - 60_000),
        },
      },
    },
    derived: {
      latestTransactionId: "500",
      status: "expired",
      expiresDate: nowMs - 120_000,
      validationCode: "SUBSCRIPTION_EXPIRED",
    },
    transactionInfo: { purchaseDate: nowMs - 86_400_000 },
    beginSnapshot: { billingRevision: 3, beginExpiryMs: nowMs - 60_000 },
    nowMs,
  });
  assert.equal(decision.skip, false);
  assert.equal(decision.reason, "apply_same_txn_contradiction_expired");
});

test("different transaction: larger stored txn id does not skip when apple expiry is newer", () => {
  const decision = evaluateReconcileWriteDecision({
    userData: {
      billingRevision: 2,
      subscriptions: {
        ios: {
          transactionId: "999",
          status: "active",
          expiryTime: new Date(nowMs - 86_400_000),
        },
      },
    },
    derived: {
      latestTransactionId: "100",
      status: "active",
      expiresDate: nowMs + 86_400_000,
      validationCode: "ACTIVE",
    },
    transactionInfo: { purchaseDate: nowMs },
    beginSnapshot: { billingRevision: 2, beginExpiryMs: nowMs - 86_400_000 },
    nowMs,
  });
  assert.equal(decision.skip, false);
  assert.equal(decision.reason, "apply_newer_apple_expiry_different_txn");
});

test("stored newer expiry skips stale apple expired on different txn", () => {
  const decision = evaluateReconcileWriteDecision({
    userData: {
      billingRevision: 4,
      subscriptions: {
        ios: {
          transactionId: "200",
          status: "active",
          expiryTime: new Date(nowMs + 86_400_000),
        },
      },
    },
    derived: {
      latestTransactionId: "100",
      status: "expired",
      expiresDate: nowMs - 60_000,
      validationCode: "SUBSCRIPTION_EXPIRED",
    },
    transactionInfo: { purchaseDate: nowMs - 172_800_000 },
    beginSnapshot: { billingRevision: 3, beginExpiryMs: nowMs - 60_000 },
    nowMs,
  });
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "stored_contract_newer_by_expiry");
});

test("revoked apple older than stored usable contract is skipped", () => {
  const decision = evaluateReconcileWriteDecision({
    userData: {
      billingRevision: 2,
      subscriptions: {
        ios: {
          transactionId: "300",
          status: "active",
          expiryTime: new Date(nowMs + 86_400_000),
        },
      },
    },
    derived: {
      latestTransactionId: "100",
      status: "none",
      expiresDate: nowMs - 60_000,
      validationCode: "TRANSACTION_REVOKED",
    },
    transactionInfo: {
      purchaseDate: nowMs - 172_800_000,
      revocationDate: nowMs - 30_000,
    },
    beginSnapshot: { billingRevision: 2, beginExpiryMs: nowMs + 86_400_000 },
    nowMs,
  });
  assert.equal(decision.skip, true);
  assert.equal(decision.reason, "revoked_apple_older_than_stored_contract");
});

test("createReconcileWriteGuard delegates to evaluateReconcileWriteDecision", () => {
  const guard = createReconcileWriteGuard(
    {
      latestTransactionId: "500",
      status: "expired",
      expiresDate: nowMs - 120_000,
      validationCode: "SUBSCRIPTION_EXPIRED",
    },
    { purchaseDate: nowMs - 86_400_000 },
    { billingRevision: 1, beginExpiryMs: nowMs - 60_000 }
  );
  const decision = guard({
    billingRevision: 1,
    subscriptions: {
      ios: {
        transactionId: "500",
        status: "active",
        expiryTime: new Date(nowMs - 60_000),
      },
    },
  });
  assert.equal(decision.skip, false);
});
