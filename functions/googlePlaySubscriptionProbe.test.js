const assert = require("assert");
const {
  createGooglePlaySubscriptionProbeHandler,
  resolveStoredPrimaryPurchaseToken,
  PROBE_TRACE,
} = require("./googlePlaySubscriptionProbe");

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

function createUserDoc(data) {
  return {
    exists: true,
    data: () => data,
  };
}

function createDbWithUser(data) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => createUserDoc(data),
      }),
    }),
  };
}

async function runTests() {
  assert.strictEqual(
    resolveStoredPrimaryPurchaseToken({
      googlePlayPrimaryPurchaseToken: "primary-token",
      activePurchaseTokens: ["fallback"],
    }),
    "primary-token",
  );
  assert.strictEqual(
    resolveStoredPrimaryPurchaseToken({
      subscriptions: { android: { primaryPurchaseToken: "nested-token" } },
    }),
    "nested-token",
  );
  assert.strictEqual(
    resolveStoredPrimaryPurchaseToken({
      activePurchaseTokens: ["", "  token-from-array  "],
    }),
    "token-from-array",
  );
  assert.strictEqual(resolveStoredPrimaryPurchaseToken({}), "");

  const logs = [];
  const logger = {
    info: (message, extra) => logs.push({ level: "info", message, extra }),
    warn: (message, extra) => logs.push({ level: "warn", message, extra }),
  };

  const unauthenticatedHandler = createGooglePlaySubscriptionProbeHandler({
    getDb: () => ({}),
    admin: createMockAdmin(),
    logger,
  });
  await assert.rejects(
    () => unauthenticatedHandler({ auth: null, data: {} }),
    (error) => error.code === "unauthenticated",
  );

  const forbiddenHandler = createGooglePlaySubscriptionProbeHandler({
    getDb: () => ({}),
    admin: createMockAdmin(),
    logger,
  });
  await assert.rejects(
    () =>
      forbiddenHandler({
        auth: { uid: "user-abc123456789" },
        data: { purchaseToken: "evil-token" },
      }),
    (error) => error.code === "invalid-argument",
  );

  let syncCalls = 0;
  let applyCalls = 0;

  const activeHandler = createGooglePlaySubscriptionProbeHandler({
    getDb: () =>
      createDbWithUser({
        googlePlayPrimaryPurchaseToken: "stored-token-123456",
      }),
    admin: createMockAdmin(),
    logger,
    syncSubscriptionByPurchaseToken: async () => {
      syncCalls++;
      return {
        subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" },
        matchedLineItem: {
          productId: "ohayo_kamome_monthly",
          expiryTime: "2026-08-20T00:00:00.000Z",
        },
      };
    },
    deriveEntitlement: () => ({
      status: "active",
      expiryTime: "2026-08-20T00:00:00.000Z",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    }),
    isUsableEntitlement: () => true,
    applySubscriptionUpdateToUser: async (
      db,
      admin,
      uid,
      derived,
      purchaseToken,
      options,
    ) => {
      applyCalls++;
      assert.strictEqual(options.subscriptionSource, "google_play_probe");
      assert.strictEqual(options.dualWriteSource, "google_probe");
      return { applied: true };
    },
  });

  const activeResult = await activeHandler({
    auth: { uid: "user-abc123456789" },
    data: {},
  });
  assert.strictEqual(activeResult.outcome, "active");
  assert.strictEqual(syncCalls, 1);
  assert.strictEqual(applyCalls, 1);
  assert.ok(
    logs.some(
      (entry) =>
        entry.message === `${PROBE_TRACE} active` &&
        entry.extra.firestoreApplied === true,
    ),
  );

  syncCalls = 0;
  applyCalls = 0;
  const inactiveHandler = createGooglePlaySubscriptionProbeHandler({
    getDb: () =>
      createDbWithUser({
        googlePlayPrimaryPurchaseToken: "stored-token-123456",
      }),
    admin: createMockAdmin(),
    logger,
    syncSubscriptionByPurchaseToken: async () => {
      syncCalls++;
      return {
        subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" },
        matchedLineItem: {
          productId: "ohayo_kamome_monthly",
          expiryTime: "2026-07-01T00:00:00.000Z",
        },
      };
    },
    deriveEntitlement: () => ({
      status: "expired",
      expiryTime: "2026-07-01T00:00:00.000Z",
      subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
    }),
    isUsableEntitlement: () => false,
    applySubscriptionUpdateToUser: async () => {
      applyCalls++;
      return { applied: false };
    },
  });

  const inactiveResult = await inactiveHandler({
    auth: { uid: "user-abc123456789" },
    data: {},
  });
  assert.strictEqual(inactiveResult.outcome, "inactive");
  assert.strictEqual(syncCalls, 1);
  assert.strictEqual(applyCalls, 0);

  syncCalls = 0;
  const failedHandler = createGooglePlaySubscriptionProbeHandler({
    getDb: () =>
      createDbWithUser({
        googlePlayPrimaryPurchaseToken: "stored-token-123456",
      }),
    admin: createMockAdmin(),
    logger,
    syncSubscriptionByPurchaseToken: async () => {
      syncCalls++;
      throw new Error("google api down");
    },
  });

  const failedResult = await failedHandler({
    auth: { uid: "user-abc123456789" },
    data: {},
  });
  assert.strictEqual(failedResult.outcome, "failed");
  assert.strictEqual(failedResult.reason, "google_api_error");
  assert.strictEqual(syncCalls, 1);

  const skippedHandler = createGooglePlaySubscriptionProbeHandler({
    getDb: () => createDbWithUser({}),
    admin: createMockAdmin(),
    logger,
  });
  const skippedResult = await skippedHandler({
    auth: { uid: "user-abc123456789" },
    data: {},
  });
  assert.strictEqual(skippedResult.outcome, "skipped");
  assert.strictEqual(skippedResult.reason, "no_purchase_token");

  console.log("googlePlaySubscriptionProbe.test.js: all tests passed");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
