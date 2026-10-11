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
      subscriptionPlatform: "android",
      activePurchaseTokens: ["", "  token-from-array  "],
    }),
    "token-from-array",
  );
  assert.strictEqual(
    resolveStoredPrimaryPurchaseToken({
      subscriptionPlatform: " Android ",
      activePurchaseTokens: ["token-from-array"],
    }),
    "token-from-array",
    "the platform marker is normalized",
  );
  // R1: the legacy array is shared with iPhone transaction ids. It is used only for an Android legacy record,
  // so an Apple transaction id is never sent to Google Play.
  for (const platform of ["ios", "", undefined, "web"]) {
    assert.strictEqual(
      resolveStoredPrimaryPurchaseToken({
        subscriptionPlatform: platform,
        activePurchaseTokens: ["2000001194999999"],
        appStoreTransactionId: "2000001194999999",
      }),
      "",
      `legacy array ignored for platform ${platform}`,
    );
  }
  // the Android-specific fields still win over everything, whatever the legacy platform marker says
  assert.strictEqual(
    resolveStoredPrimaryPurchaseToken({
      subscriptionPlatform: "ios",
      googlePlayPrimaryPurchaseToken: "android-primary",
      activePurchaseTokens: ["2000001194999999"],
    }),
    "android-primary",
  );
  assert.strictEqual(
    resolveStoredPrimaryPurchaseToken({
      subscriptionPlatform: "ios",
      subscriptions: { android: { primaryPurchaseToken: "android-nested" } },
      activePurchaseTokens: ["2000001194999999"],
    }),
    "android-nested",
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

  syncCalls = 0;
  applyCalls = 0;
  const reconcileExpiredHandler = createGooglePlaySubscriptionProbeHandler({
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
      expiryDate: new Date("2026-07-01T00:00:00.000Z"),
      subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
    }),
    isUsableEntitlement: () => false,
    applySubscriptionUpdateToUser: async () => {
      applyCalls++;
      return { applied: true };
    },
  });

  const reconcileExpiredResult = await reconcileExpiredHandler({
    auth: { uid: "user-abc123456789" },
    data: { purpose: "reconcile", phase: "pre_chat" },
  });
  assert.strictEqual(reconcileExpiredResult.outcome, "inactive");
  assert.strictEqual(reconcileExpiredResult.firestoreApplied, true);
  assert.strictEqual(syncCalls, 1);
  assert.strictEqual(applyCalls, 1);

  // ---- R1: an iPhone-only user never reaches Google Play with an Apple transaction id ----
  let queried = null;
  const iosOnlyHandler = createGooglePlaySubscriptionProbeHandler({
    getDb: () => createDbWithUser({
      subscriptionPlatform: "ios",
      activePurchaseTokens: ["2000001194999999"],
      subscriptions: { ios: { status: "expired", originalTransactionId: "2000001194540581" } },
    }),
    admin: createMockAdmin(),
    logger,
    syncSubscriptionByPurchaseToken: async (_pkg, token) => {
      queried = token;
      throw new Error("must not be called");
    },
  });
  const iosOnlyResult = await iosOnlyHandler({ auth: { uid: "user-abc123456789" }, data: { purpose: "reconcile", phase: "pre_chat" } });
  assert.deepStrictEqual({ outcome: iosOnlyResult.outcome, reason: iosOnlyResult.reason }, { outcome: "skipped", reason: "no_purchase_token" });
  assert.strictEqual(queried, null, "R1: nothing is sent to Google Play");

  // ---- R2: HTTP 410 with an official "token no longer usable" reason is inactive; everything else stays a failure ----
  const goneHandler = (error, extra = {}) => createGooglePlaySubscriptionProbeHandler({
    getDb: () => createDbWithUser({ googlePlayPrimaryPurchaseToken: "stored-token-123456" }),
    admin: createMockAdmin(),
    logger,
    syncSubscriptionByPurchaseToken: async () => { throw error; },
    applySubscriptionUpdateToUser: async () => { applyCalls++; return { applied: true }; },
    ...extra,
  });
  const gaxios = (status, reason, shape = "errors") => {
    const error = new Error("google error");
    error.code = String(status);
    const list = reason ? [{ domain: "androidpublisher", reason, message: "x" }] : [];
    if (shape === "errors") error.errors = list;
    else error.response = { status, data: { error: { code: status, errors: list } } };
    return error;
  };
  applyCalls = 0;
  for (const reason of ["subscriptionNoLongerAvailable", "purchaseTokenNoLongerValid"]) {
    for (const shape of ["errors", "response"]) {
      for (const data of [{}, { purpose: "reconcile", phase: "pre_chat" }]) {
        const result = await goneHandler(gaxios(410, reason, shape))({ auth: { uid: "user-abc123456789" }, data });
        assert.strictEqual(result.outcome, "inactive", `R2 ${reason}/${shape}`);
        assert.strictEqual(result.reason, "google_play_token_no_longer_available");
        assert.strictEqual(result.tokenGoneReason, reason);
        assert.strictEqual(result.firestoreApplied, undefined);
      }
    }
  }
  assert.strictEqual(applyCalls, 0, "R2: Firestore is never changed by a gone token");
  for (const [label, error] of [
    ["410 without a recognizable reason", gaxios(410, "")],
    ["410 with another reason", gaxios(410, "somethingElse")],
    ["404 with the gone reason", gaxios(404, "subscriptionNoLongerAvailable")],
    ["400 with the gone reason", gaxios(400, "purchaseTokenNoLongerValid")],
    ["500", gaxios(500, "")],
    ["429", gaxios(429, "")],
    ["plain error", new Error("network")],
    ["null error", null],
  ]) {
    const result = await goneHandler(error)({ auth: { uid: "user-abc123456789" }, data: { purpose: "reconcile" } });
    assert.strictEqual(result.outcome, "failed", `R2 stays a safe stop: ${label}`);
  }

  // ---- R6: ON_HOLD / PAUSED are reported as suspended (not as a plain "not active") ----
  const suspendedHandler = (state, status) => createGooglePlaySubscriptionProbeHandler({
    getDb: () => createDbWithUser({ googlePlayPrimaryPurchaseToken: "stored-token-123456" }),
    admin: createMockAdmin(),
    logger,
    syncSubscriptionByPurchaseToken: async () => ({
      subscription: { subscriptionState: state },
      matchedLineItem: { productId: "ohayo_kamome_monthly", expiryTime: "2026-09-01T00:00:00.000Z" },
    }),
    deriveEntitlement: () => ({ status, expiryTime: "2026-09-01T00:00:00.000Z", subscriptionState: state }),
    isUsableEntitlement: () => false,
    applySubscriptionUpdateToUser: async () => ({ applied: true }),
  });
  for (const [state, status] of [
    ["SUBSCRIPTION_STATE_ON_HOLD", "paused"],
    ["SUBSCRIPTION_STATE_PAUSED", "paused"],
    ["SUBSCRIPTION_STATE_ON_HOLD", "expired"],
  ]) {
    for (const data of [{}, { purpose: "reconcile", phase: "pre_chat" }]) {
      const result = await suspendedHandler(state, status)({ auth: { uid: "user-abc123456789" }, data });
      assert.strictEqual(result.outcome, "inactive", `R6 ${state}`);
      assert.strictEqual(result.reason, "google_play_suspended", `R6 ${state}/${status}`);
    }
  }
  // an expired subscription is still a plain "not active" (it can no longer come back by itself)
  for (const data of [{}, { purpose: "reconcile", phase: "pre_chat" }]) {
    const expired = await suspendedHandler("SUBSCRIPTION_STATE_EXPIRED", "expired")({ auth: { uid: "user-abc123456789" }, data });
    assert.strictEqual(expired.outcome, "inactive");
    assert.strictEqual(expired.reason, "google_play_not_active");
  }

  console.log("googlePlaySubscriptionProbe.test.js: all tests passed");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
