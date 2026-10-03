"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { COVERAGE, seriesIdentity, billingRevision, candidatesFor, googleState, appleState,
  resultFor, activeSeriesRepresentatives, createPreChatBillingHandlers,
  seedInitializedAccount, recordNewAuthCreation } = require("./preChatBillingConfirmation");
const { buildAndroidOwnershipId, buildIosOwnershipId } = require("./subscriptionOwnership");
const { GOOGLE_PLAY_MONTHLY_PRODUCT_ID } = require("./googlePlaySubscriptionNotifications");
const { APP_STORE_PRODUCT_ID, APP_STORE_BUNDLE_ID } = require("./appStoreServerCommon");
const now = 1800000000000;
const future = now + 86400000;
const past = now - 86400000;
const getPath = (data, key) => key.split(".").reduce((obj, part) => obj?.[part], data);
function merge(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value?.__deleted === true) { delete result[key]; continue; }
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      result[key] = merge(result[key] || {}, value);
    } else result[key] = value;
  }
  return result;
}
function mockDb(initial) {
  const docs = new Map(Object.entries(initial));
  const writes = [];
  const db = { docs, writes, beforeGet: null, beforeQuery: null, beforeTransaction: null };
  function ref(p) {
    return { path: p, id: p.split("/").at(-1),
      get: async () => { if (db.beforeGet) await db.beforeGet(p); return snap(p); },
      set: async (value, options) => write("set", p, value, options),
      update: async (value) => write("update", p, value, { merge: true }) };
  }
  function snap(p) {
    const data = docs.get(p);
    return { id: p.split("/").at(-1), ref: ref(p), exists: docs.has(p),
      data: () => data, get: (key) => getPath(data, key) };
  }
  function write(kind, p, value, options) {
    if (kind === "create" && docs.has(p)) throw new Error("already_exists");
    if (kind === "update" && !docs.has(p)) throw new Error("not_found");
    let input = value;
    if (kind === "update") {
      input = {};
      for (const [key, item] of Object.entries(value)) {
        const parts = key.split(".");
        let cursor = input;
        for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
        cursor[parts.at(-1)] = item;
      }
    }
    docs.set(p, options?.merge || kind === "update" ? merge(docs.get(p) || {}, input) : input);
    writes.push({ kind, path: p, value: input, options });
  }
  function query(name, filters = [], limit = Infinity) {
    return { where: (field, op, value) => query(name, [...filters, { field, op, value }], limit),
      limit: (n) => query(name, filters, n),
      get: async () => {
        if (db.beforeQuery) await db.beforeQuery(name);
        const found = [...docs.keys()].filter((p) => p.startsWith(`${name}/`) && p.split("/").length === 2)
          .filter((p) => filters.every(({ field, op, value }) => op === "array-contains" ? Array.isArray(getPath(docs.get(p), field)) && getPath(docs.get(p), field).includes(value) : getPath(docs.get(p), field) === value)).sort().slice(0, limit).map(snap);
        return { docs: found, empty: !found.length, size: found.length };
      } };
  }
  db.collection = (name) => ({ ...query(name), doc: (id) => ref(`${name}/${id}`) });
  let tail = Promise.resolve();
  db.runTransaction = (run) => {
    const result = tail.then(async () => {
  await test("fake set preserves literal dotted keys, while update expands field paths", async () => {
    const db = mockDb({ "users/user": {} });
    const ref = db.collection("users").doc("user");
    await ref.set({ "subscriptions.android": { status: "active" } }, { merge: true });
    assert.equal(db.docs.get("users/user").subscriptions, undefined);
    assert.equal(db.docs.get("users/user")["subscriptions.android"].status, "active");
    await ref.update({ "subscriptions.ios": { status: "expired" } });
    assert.equal(db.docs.get("users/user").subscriptions.ios.status, "expired");
  });
      if (db.beforeTransaction) await db.beforeTransaction();
      const pending = [];
      const tx = { get: (value) => value.get(),
        set: (r, v, o) => pending.push(["set", r.path, v, o]),
        create: (r, v) => pending.push(["create", r.path, v]),
        update: (r, v) => pending.push(["update", r.path, v]) };
      const result = await run(tx);
      for (const entry of pending) write(...entry);
      return result;
    });
    tail = result.catch(() => {});
    return result;
  };
  return db;
}
const admin = { FieldValue: { serverTimestamp: () => new Date(now) },
  Timestamp: { fromMillis: (m) => { if (!Number.isFinite(m)) throw new Error("invalid_timestamp"); return new Date(m); }, fromDate: (d) => d } };
const managed = (extra = {}) => ({ email: "test@example.invalid", accountId: "account",
  billingRevision: 1, billingConfirmation: {
    android: { state: "eligible", schemaVersion: 1, coverage: COVERAGE },
    ios: { state: "eligible", schemaVersion: 1, coverage: COVERAGE } }, ...extra });
const item = (expiry) => ({ productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID, expiryTime: new Date(expiry).toISOString() });
const apple = (expiry, extra = {}) => ({ bundleId: APP_STORE_BUNDLE_ID, productId: APP_STORE_PRODUCT_ID,
  transactionId: "transaction", originalTransactionId: "original", expiresDate: expiry, ...extra });
function payload(platform, extra = {}) {
  return { auth: { uid: "user" }, data: { platform, productId: APP_STORE_PRODUCT_ID,
    attemptId: "attempt_1", remainingMs: 10000, storeCandidates: [], ...extra } };
}
function handlers(db, overrides = {}) {
  return createPreChatBillingHandlers({ getDb: () => db, admin, logger: { info() {} },
    verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" }, matchedLineItem: item(Date.now() + 86400000) }),
    verifyApple: async () => [{ state: "active", transaction: apple(Date.now() + 86400000),
      originalTransactionId: "original", expiryMs: Date.now() + 86400000 }],
    inspectOwner: async () => ({ decision: "match" }), ...overrides });
}
let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`ok ${passed}: ${name}`); }
(async () => {
  for (const platform of ["android", "ios"]) {
    await test(`${platform}: legacy empty/historyless is unknown`, () => {
      assert.equal(resultFor({ data: {}, platform, entries: [] }).state, "unknown");
      assert.equal(resultFor({ data: { subscriptionStatus: "expired" }, platform, entries: [] }).state, "unknown");
    });
    await test(`${platform}: initialized fresh managed account is eligible`, () => {
      assert.equal(resultFor({ data: managed(), platform, entries: [] }).state, "eligible");
    });
    await test(`${platform}: missing owner, unknown, pending and deleted never eligible`, () => {
      for (const entry of [{ state: "active", owner: "none" }, { state: "unknown", owner: "match" }, { state: "blocked", owner: "match" }]) {
        assert.notEqual(resultFor({ data: managed(), platform, entries: [entry] }).state, "eligible");
      }
      assert.equal(resultFor({ data: managed({ accountDeletionState: "deleted" }), platform, entries: [] }).state, "blocked");
      assert.equal(resultFor({ data: managed(), platform, entries: [], overflow: true }).state, "unknown");
      assert.equal(resultFor({ data: managed(), platform, entries: [], unresolvedHistory: true }).state, "unknown");
    });
    await test(`${platform}: owner mismatch blocks, verified current ended does not need legacy coverage`, () => {
      assert.equal(resultFor({ data: managed(), platform, entries: [{ state: "ended", owner: "mismatch" }] }).state, "blocked");
      assert.equal(resultFor({ data: {}, platform, entries: [{ state: "ended", owner: "match", expiryMs: past }] }).state, "eligible");
      assert.equal(resultFor({ data: managed(), platform, entries: [{ state: "ended", owner: "match", expiryMs: past }] }).state, "eligible");
    });
    await test(`${platform}: READ is write-free, latest pair carries operation state`, async () => {
      const db = mockDb({ "users/user": managed() });
      const result = await handlers(db).read(payload(platform));
      assert.equal(result.state, "eligible"); assert.equal(result.syncOperation, "none");
      assert.equal(db.writes.length, 0);
    });
    await test(`${platform}: API error and stuck READ are unknown without writes`, async () => {
      const candidate = platform === "android" ? { purchaseToken: "token" } : { originalTransactionId: "original" };
      const db = mockDb({ "users/user": managed() });
      const fail = async () => { throw new Error("secret token must never escape"); };
      const result = await handlers(db, { verifyGoogle: fail, verifyApple: fail }).read(payload(platform, { storeCandidates: [candidate] }));
      assert.equal(result.state, "unknown"); assert.equal(result.reason, "server_read_unavailable");
      const hang = async () => new Promise(() => {});
      const stuck = await handlers(db, { verifyGoogle: hang, verifyApple: hang }).read(payload(platform, { storeCandidates: [candidate], remainingMs: 5 }));
      assert.equal(stuck.state, "unknown"); assert.equal(db.writes.length, 0);
    });
  }
  await test("Google purchase states: pending/hold/paused block, stale active is unknown", () => {
    for (const state of ["PENDING", "ON_HOLD", "PAUSED"]) assert.equal(googleState({ subscriptionState: `SUBSCRIPTION_STATE_${state}` }, item(future), now), "blocked");
    assert.equal(googleState({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" }, item(past), now), "unknown");
    assert.equal(googleState({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" }, item(past), now), "ended");
    assert.equal(googleState({ subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" }, item(future), now), "active");
    assert.equal(googleState({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" }, null, now), "unknown");
  });
  await test("Apple grace/billing retry/revoked/refunded/expired verification", () => {
    assert.equal(appleState(4, apple(past), { gracePeriodExpiresDate: future }, now), "active");
    assert.equal(appleState(3, apple(past), null, now), "blocked");
    assert.equal(appleState(5, apple(past, { revocationDate: past }), null, now), "ended");
    assert.equal(appleState(2, apple(past), null, now), "ended");
    assert.equal(appleState(1, apple(future, { bundleId: "wrong" }), null, now), "unknown");
    assert.equal(appleState(4, apple(past), null, now), "unknown");
  });
  await test("linked Android token uses one observed owned-series representative", () => {
    const old = seriesIdentity("android", "old"), current = seriesIdentity("android", "current");
    assert.deepEqual(activeSeriesRepresentatives([{ identities: [old] }, { identities: [current, old] }], [current]), [current]);
    assert.equal(activeSeriesRepresentatives([{ identities: [old] }, { identities: [current] }], [current]).length, 2);
  });
  await test("candidate extraction preserves Android nested token arrays and Apple originals", () => {
    assert.deepEqual(candidatesFor("android", { subscriptions: { android: { primaryPurchaseToken: "a", activePurchaseTokens: ["b"] } }, activePurchaseTokens: ["c"] }, [{ purchaseToken: "d" }]), ["a", "b", "c", "d"]);
    assert.deepEqual(candidatesFor("ios", { appStoreOriginalTransactionId: "original", appStoreTransactionId: "transaction" }), ["original"]);
  });
  await test("verified active pointer omits persisted history but uses the current Store snapshot", async () => {
    const expiry = Date.now() + 86400000;
    const token = "verified-current-token";
    const ownerId = buildAndroidOwnershipId(token);
    const db = mockDb({ "users/user": managed({
      subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        expiryTime: new Date(expiry), primaryPurchaseToken: token, activePurchaseTokens: [token, "historical-invalid"],
        packageId: "com.lahainarsnet.ohayokamome.live", linkedPurchaseToken: "", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
        verifiedAt: new Date(), verificationSource: "google_play_subscriptions_v2" } },
      billingConfirmation: { android: { state: "active", schemaVersion: 1, coverage: "verified_current_series_v1" } },
      activePurchaseTokens: [token, "historical-invalid"],
    }), [`subscription_ownership/${ownerId}`]: { ownerUid: "user", platform: "android", status: "active" },
    [`subscription_ownership/${buildAndroidOwnershipId("historical-invalid")}`]: { ownerUid: "user", platform: "android", status: "expired" },
    "subscription_events/old-event": { uid: "user", platform: "google_play", purchaseTokenHash: "old-hash" } });
    const calls = [];
    const messages = [];
    const api = handlers(db, { logger: { info: (message, fields) => messages.push({ message, fields }) },
      verifyGoogle: async (_pkg, value) => { calls.push(value); if (value !== token) throw new Error("historical invalid");
        return { subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" },
          matchedLineItem: item(expiry) }; } });
    const result = await api.read(payload("android", { storeCandidates: [{ purchaseToken: token }] }));
    assert.equal(result.state, "active");
    assert.deepEqual(calls, [token]);
    const diagnostic = JSON.stringify(messages);
    assert.match(diagnostic, /historical_candidate_omitted_after_verified_active_pointer/);
    assert.match(diagnostic, /platform_token_history/);
    assert.doesNotMatch(diagnostic, /verified-current-token|historical-invalid/);
  });
  await test("invalid verified active primary remains unknown", async () => {
    const token = "invalid-current-token";
    const db = mockDb({ "users/user": managed({
      subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        expiryTime: new Date(Date.now() + 86400000), primaryPurchaseToken: token, packageId: "com.lahainarsnet.ohayokamome.live",
        linkedPurchaseToken: "", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
        verificationSource: "google_play_subscriptions_v2" } },
      billingConfirmation: { android: { state: "active", schemaVersion: 1, coverage: "verified_current_series_v1" } },
    }), [`subscription_ownership/${buildAndroidOwnershipId(token)}`]: { ownerUid: "user", platform: "android" } });
    const result = await handlers(db, { verifyGoogle: async () => { throw new Error("Invalid Value"); } }).read(payload("android"));
    assert.equal(result.state, "unknown");
    assert.equal(result.reason, "server_read_unavailable");
  });
  await test("both explicit managed-creation and verified-series coverage permit active pointer optimization", async () => {
    const token = "managed-active-token";
    const expiry = Date.now() + 86400000;
    const ownerId = buildAndroidOwnershipId(token);
    for (const coverage of [COVERAGE, "verified_current_series_v1"]) {
      const db = mockDb({ "users/user": managed({
        subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
          expiryTime: new Date(expiry), primaryPurchaseToken: token, activePurchaseTokens: ["historical-invalid"],
          packageId: "com.lahainarsnet.ohayokamome.live", linkedPurchaseToken: "",
          acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
          verificationSource: "google_play_subscriptions_v2" } },
        billingConfirmation: { android: { state: "active", schemaVersion: 1, coverage } },
      }), [`subscription_ownership/${ownerId}`]: { ownerUid: "user", platform: "android", status: "active" } });
      const calls = [];
      const result = await handlers(db, { verifyGoogle: async (_pkg, value) => { calls.push(value);
        return { subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" },
          matchedLineItem: item(expiry) }; } }).read(payload("android"));
      assert.equal(result.state, "active");
      assert.deepEqual(calls, [token]);
    }
  });
  await test("missing or unknown coverage does not optimize active-pointer candidate selection", async () => {
    const token = "coverage-unknown-primary";
    const extra = "history-extra";
    const expiry = Date.now() + 86400000;
    for (const confirmation of [undefined, { state: "active", schemaVersion: 1, coverage: "unknown" }]) {
      const db = mockDb({ "users/user": managed({
        subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
          expiryTime: new Date(expiry), primaryPurchaseToken: token, activePurchaseTokens: [token, extra],
          packageId: "com.lahainarsnet.ohayokamome.live", linkedPurchaseToken: "",
          acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
          verificationSource: "google_play_subscriptions_v2" } },
        billingConfirmation: confirmation ? { android: confirmation } : {},
      }) });
      const calls = [];
      const result = await handlers(db, { verifyGoogle: async (_pkg, value) => { calls.push(value);
        if (value === extra) throw new Error("history token unverified");
        return { subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" },
          matchedLineItem: item(expiry) }; } }).read(payload("android", { storeCandidates: [{ purchaseToken: extra }] }));
      assert.equal(result.state, "unknown");
      assert.deepEqual(calls, [token, extra]);
    }
  });
  await test("active pointer is not trusted without same-UID exact ownership", async () => {
    const token = "unowned-current-token";
    const db = mockDb({ "users/user": managed({
      subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        expiryTime: new Date(Date.now() + 86400000), primaryPurchaseToken: token, packageId: "com.lahainarsnet.ohayokamome.live",
        linkedPurchaseToken: "", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
        verificationSource: "google_play_subscriptions_v2" } },
      billingConfirmation: { android: { state: "active", schemaVersion: 1, coverage: "verified_current_series_v1" } },
    }) });
    const result = await handlers(db, { inspectOwner: async () => ({ decision: "none" }) }).read(payload("android"));
    assert.equal(result.state, "unknown");
    assert.equal(result.reason, "unverified_series_or_owner");
  });
  await test("legacy-only, expired pointer plus invalid extra candidate, and coverage-unknown stay fail-closed", async () => {
    const token = "legacy-primary";
    const invalid = "extra-invalid";
    const db = mockDb({ "users/user": managed({ googlePlayPrimaryPurchaseToken: token,
      activePurchaseTokens: [token, invalid],
      subscriptions: { android: { status: "expired", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        expiryTime: new Date(Date.now() - 1000), primaryPurchaseToken: token, activePurchaseTokens: [token, invalid] } },
      billingConfirmation: { android: { state: "unknown", schemaVersion: 1, coverage: "unknown" } },
    }) });
    const calls = [];
    const result = await handlers(db, { verifyGoogle: async (_pkg, value) => { calls.push(value); if (value === invalid) throw new Error("old invalid");
      return { subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" }, matchedLineItem: item(Date.now() - 1000) }; },
      inspectOwner: async () => ({ decision: "match" }) }).read(payload("android"));
    assert.equal(result.state, "unknown");
    assert.deepEqual(calls, [token, invalid]);
  });
  await test("new active purchase promotes only its platform pointer after server verification and preserves other OS", async () => {
    const token = "new-android-token";
    const expiry = Date.now() + 86400000;
    const ownerId = buildAndroidOwnershipId(token);
    const db = mockDb({ "users/user": managed({ subscriptions: { ios: { status: "active", productId: APP_STORE_PRODUCT_ID,
      expiryTime: new Date(expiry), originalTransactionId: "ios-current", verifiedAt: new Date(),
      verificationSource: "app_store_signed_status" } },
      billingConfirmation: { ios: { state: "active", schemaVersion: 1, coverage: "verified_current_series_v1" } } }),
      [`subscription_ownership/${ownerId}`]: { ownerUid: "user", platform: "android", status: "active" } });
    const api = handlers(db, { verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(expiry) }) });
    const req = payload("android", { attemptId: "promote_new_android", storeCandidates: [{ purchaseToken: token }] });
    const read = await api.read(req);
    assert.equal(read.state, "active");
    const response = await api.sync({ ...req, data: { ...req.data, expectedRevision: read.revision } });
    assert.equal(response.state, "completed");
    const saved = db.docs.get("users/user");
    assert.equal(saved.subscriptions.android.primaryPurchaseToken, token);
    assert.equal(saved.subscriptions.ios.originalTransactionId, "ios-current");
    assert.equal(saved.billingConfirmation.android.coverage, "verified_current_series_v1");
  });
  await test("verified active pointer is platform-isolated and linked lookup remains mandatory", async () => {
    const token = "android-current";
    const expiry = Date.now() + 86400000;
    const db = mockDb({ "users/user": managed({
      subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID, expiryTime: new Date(expiry),
        primaryPurchaseToken: token, packageId: "com.lahainarsnet.ohayokamome.live", linkedPurchaseToken: "",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(), verificationSource: "google_play_subscriptions_v2" },
        ios: { status: "active", productId: APP_STORE_PRODUCT_ID, expiryTime: new Date(expiry), originalTransactionId: "ios-current" } },
      billingConfirmation: { android: { state: "active", schemaVersion: 1, coverage: "verified_current_series_v1" } },
    }), [`subscription_ownership/${buildAndroidOwnershipId(token)}`]: { ownerUid: "user", platform: "android" } });
    const calls = [];
    const api = handlers(db, { verifyGoogle: async (_pkg, value) => { calls.push(value);
      if (value === "linked-old") throw new Error("linked state unavailable");
      return { subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", linkedPurchaseToken: "linked-old",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(expiry) }; } });
    const result = await api.read(payload("android", { storeCandidates: [{ purchaseToken: "other-platform-history" }] }));
    assert.equal(result.state, "unknown");
    assert.deepEqual(calls, [token, "linked-old"]);
  });
  await test("iOS verified active primary ignores Android contract and uses only iOS owner-bound series", async () => {
    const expiry = Date.now() + 86400000;
    const original = "ios-current-original";
    const ownerId = buildIosOwnershipId(original);
    const db = mockDb({ "users/user": managed({
      subscriptions: {
        android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID, primaryPurchaseToken: "android-other", packageId: "com.lahainarsnet.ohayokamome.live" },
        ios: { status: "active", productId: APP_STORE_PRODUCT_ID, expiryTime: new Date(expiry), originalTransactionId: original,
          transactionId: "ios-tx", bundleId: APP_STORE_BUNDLE_ID, appAccountToken: "app-account", environment: "Production",
          revocationDate: null, verifiedAt: new Date(), verificationSource: "app_store_signed_status" },
      },
      billingConfirmation: { ios: { state: "active", schemaVersion: 1, coverage: "verified_current_series_v1" } },
      appStoreAppAccountToken: "app-account",
    }), [`subscription_ownership/${ownerId}`]: { ownerUid: "user", platform: "ios", status: "active" },
    "subscription_ownership/android-history": { ownerUid: "user", platform: "android" } });
    const result = await handlers(db, { verifyApple: async (identity) => {
      assert.equal(identity, original);
      return [{ state: "active", transaction: apple(expiry, { originalTransactionId: original, appAccountToken: "app-account" }), originalTransactionId: original, expiryMs: expiry }];
    } }).read(payload("ios"));
    assert.equal(result.state, "active");
  });
  await test("different-UID active pointer is rejected and never used as current ownership", async () => {
    const token = "other-user-active";
    const db = mockDb({ "users/user": managed({
      subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        expiryTime: new Date(Date.now() + 86400000), primaryPurchaseToken: token, packageId: "com.lahainarsnet.ohayokamome.live",
        linkedPurchaseToken: "", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
        verificationSource: "google_play_subscriptions_v2" } },
      billingConfirmation: { android: { state: "active", schemaVersion: 1, coverage: "verified_current_series_v1" } },
    }), [`subscription_ownership/${buildAndroidOwnershipId(token)}`]: { ownerUid: "other", platform: "android", status: "active" } });
    const result = await handlers(db, { inspectOwner: async () => ({ decision: "mismatch" }) }).read(payload("android"));
    assert.equal(result.state, "blocked");
    assert.equal(result.reason, "owner_mismatch");
  });
  await test("separate foreign active Store series remains blocked while current primary is valid", async () => {
    const current = "current-owned-token";
    const foreign = "foreign-active-token";
    const expiry = Date.now() + 86400000;
    const db = mockDb({ "users/user": managed({
      subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        expiryTime: new Date(expiry), primaryPurchaseToken: current, activePurchaseTokens: [current],
        packageId: "com.lahainarsnet.ohayokamome.live", linkedPurchaseToken: "",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
        verificationSource: "google_play_subscriptions_v2" } },
      billingConfirmation: { android: { state: "active", schemaVersion: 1, coverage: "verified_current_series_v1" } },
    }), [`subscription_ownership/${buildAndroidOwnershipId(current)}`]: { ownerUid: "user", platform: "android" },
      [`subscription_ownership/${buildAndroidOwnershipId(foreign)}`]: { ownerUid: "other", platform: "android" } });
    const api = handlers(db, {
      verifyGoogle: async (_pkg, token) => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(expiry) }),
      inspectOwner: async (_db, { uid, purchaseToken }) => purchaseToken === foreign
        ? { decision: "mismatch", reason: "other_owner_active", storeStatus: "active" }
        : { decision: "match", reason: "same_uid_series", storeStatus: "active" },
    });
    const result = await api.read(payload("android", { storeCandidates: [{ purchaseToken: current }, { purchaseToken: foreign }] }));
    assert.equal(result.state, "blocked");
    assert.equal(result.reason, "owner_mismatch");
  });
  await test("independent same-UID active Store series cannot be silently treated as history", async () => {
    const current = "current-owned-token", extra = "second-active-token", expiry = Date.now() + 86400000;
    const db = mockDb({ "users/user": managed({
      subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        expiryTime: new Date(expiry), primaryPurchaseToken: current, packageId: "com.lahainarsnet.ohayokamome.live",
        linkedPurchaseToken: "", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
        verificationSource: "google_play_subscriptions_v2" } },
      billingConfirmation: { android: { state: "active", schemaVersion: 1, coverage: "verified_current_series_v1" } },
    }), [`subscription_ownership/${buildAndroidOwnershipId(current)}`]: { ownerUid: "user", platform: "android" },
      [`subscription_ownership/${buildAndroidOwnershipId(extra)}`]: { ownerUid: "user", platform: "android" } });
    const calls = [];
    const api = handlers(db, { verifyGoogle: async (_pkg, token) => { calls.push(token); return {
      subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" },
      matchedLineItem: item(expiry) }; } });
    const result = await api.read(payload("android", { storeCandidates: [{ purchaseToken: current }, { purchaseToken: extra }] }));
    assert.equal(result.state, "unknown");
    assert.deepEqual(calls, [current, extra]);
  });
  await test("ended additional Store candidate is ignorable, but an unverified candidate is unknown", async () => {
    const current = "current-owned-token", extra = "additional-token", expiry = Date.now() + 86400000;
    const db = mockDb({ "users/user": managed({
      subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        expiryTime: new Date(expiry), primaryPurchaseToken: current, packageId: "com.lahainarsnet.ohayokamome.live",
        linkedPurchaseToken: "", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
        verificationSource: "google_play_subscriptions_v2" } },
      billingConfirmation: { android: { state: "active", schemaVersion: 1, coverage: "verified_current_series_v1" } },
    }), [`subscription_ownership/${buildAndroidOwnershipId(current)}`]: { ownerUid: "user", platform: "android" },
      [`subscription_ownership/${buildAndroidOwnershipId(extra)}`]: { ownerUid: "user", platform: "android" } });
    const input = payload("android", { storeCandidates: [{ purchaseToken: current }, { purchaseToken: extra }] });
    const ended = await handlers(db, { verifyGoogle: async (_pkg, token) => ({ subscription: {
      subscriptionState: token === current ? "SUBSCRIPTION_STATE_ACTIVE" : "SUBSCRIPTION_STATE_EXPIRED",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(token === current ? expiry : Date.now() - 1000) }) }).read(input);
    assert.equal(ended.state, "active");
    const unknown = await handlers(db, { verifyGoogle: async (_pkg, token) => {
      if (token === extra) throw new Error("candidate status unavailable");
      return { subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(expiry) };
    } }).read(input);
    assert.equal(unknown.state, "unknown");
  });
  await test("unknown linked history cannot promote or complete a purchase sync", async () => {
    const token = "new-with-unknown-link";
    const db = mockDb({ "users/user": managed() });
    const api = handlers(db, { verifyGoogle: async (_pkg, value) => {
      if (value === "linked-unavailable") throw new Error("linked lookup unavailable");
      return { subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", linkedPurchaseToken: "linked-unavailable" },
        matchedLineItem: item(Date.now() + 86400000) };
    } });
    const req = payload("android", { attemptId: "unknown_link", storeCandidates: [{ purchaseToken: token }] });
    const read = await api.read(req);
    assert.equal(read.state, "unknown");
    const sync = await api.sync({ ...req, data: { ...req.data, expectedRevision: read.revision || "a".repeat(64) } });
    assert.notEqual(sync.state, "completed");
    assert.equal(db.docs.get("users/user").subscriptions, undefined);
  });
  await test("ownership.none never auto-claims a valid transaction", async () => {
    const db = mockDb({ "users/user": managed() });
    const result = await handlers(db, { inspectOwner: async () => ({ decision: "none" }) }).read(payload("android", { storeCandidates: [{ purchaseToken: "token" }] }));
    assert.equal(result.state, "unknown"); assert.equal(db.writes.length, 0);
  });
  await test("Apple AppAccountToken mismatch blocks a persisted original owner", async () => {
    const db = mockDb({ "users/user": managed({ appStoreAppAccountToken: "expected" }),
      [`subscription_ownership/${buildIosOwnershipId("original")}`]: { ownerUid: "user", platform: "ios", originalTransactionId: "original" } });
    const result = await handlers(db, { verifyApple: async () => [{ state: "active", transaction: apple(Date.now() + 100000, { appAccountToken: "wrong" }), originalTransactionId: "original", expiryMs: Date.now() + 100000 }] }).read(payload("ios", { storeCandidates: [{ originalTransactionId: "original" }] }));
    assert.equal(result.state, "blocked"); assert.equal(result.reason, "owner_mismatch");
  });
  await test("unresolved hashed ownership and legacy RTDN suffix keep unknown", async () => {
    const db = mockDb({ "users/user": managed(), "subscription_ownership/android_hidden": { ownerUid: "user", platform: "android" } });
    assert.equal((await handlers(db).read(payload("android"))).state, "unknown");
    db.docs.delete("subscription_ownership/android_hidden");
    db.docs.set("subscription_events/legacy", { uid: "user", platform: "google_play", purchaseTokenSuffix: "suffix" });
    assert.equal((await handlers(db).read(payload("android"))).state, "unknown");
  });
  await test("user and history changes during READ discard the assembled observation", async () => {
    const db = mockDb({ "users/user": managed() });
    let reads = 0;
    db.beforeGet = async (p) => { if (p === "users/user" && ++reads === 2) db.docs.set(p, managed({ subscriptions: { android: { status: "active", expiryTime: new Date(Date.now() + 86400000) } } })); };
    assert.equal((await handlers(db).read(payload("android"))).reason, "revision_changed");
    db.beforeGet = null;
    let queries = 0;
    db.beforeQuery = async (name) => { if (name === "subscription_events" && ++queries === 2) db.docs.set("subscription_events/new", { uid: "user", platform: "google_play" }); };
    assert.equal((await handlers(db).read(payload("android"))).reason, "revision_changed");
  });
  await test("cross-platform Android target ignores preserved iOS source entitlement", async () => {
    const db = mockDb({ "users/user": managed() });
    let reads = 0;
    db.beforeGet = async (path) => {
      if (path === "users/user" && ++reads === 2) {
        db.docs.set(path, managed({
          subscriptions: {
            android: null,
            ios: { status: "active", expiryTime: new Date(now + 86400000), originalTransactionId: "source-original" },
          },
          billingConfirmation: {
            android: { state: "eligible", schemaVersion: 1, coverage: COVERAGE },
            ios: { state: "active", schemaVersion: 1, coverage: COVERAGE },
          },
          subscriptionPlatform: "ios", subscriptionStatus: "active",
          appStoreOriginalTransactionId: "source-original", appStoreTransactionId: "source-tx",
          appStoreAppAccountToken: "source-account-token", billingRevision: 99,
        }));
      }
    };
    const result = await handlers(db).read(payload("android"));
    assert.equal(result.state, "eligible");
    assert.equal(result.storeStatus, "expired");
    assert.notEqual(result.reason, "revision_changed");
  });
  await test("sync consumes operation once and READ resolves its result", async () => {
    const db = mockDb({ "users/user": managed() });
    const api = handlers(db);
    const read = await api.read(payload("android"));
    const request = payload("android", { expectedRevision: read.revision });
    const results = await Promise.all([api.sync(request), api.sync(request)]);
    assert.equal(results.filter((r) => r.state === "completed").length >= 1, true);
    assert.equal(db.writes.filter((w) => w.path === "users/user").length, 1);
    assert.equal((await api.read(payload("android"))).syncOperation, "completed");
    await assert.rejects(api.sync(payload("ios", { expectedRevision: read.revision })), /Operation identity/);
  });
  await test("target platform contract change invalidates the read before sync", async () => {
    const db = mockDb({ "users/user": managed() });
    const api = handlers(db);
    const read = await api.read(payload("android"));
    db.docs.set("users/user", managed({ subscriptions: { android: { status: "expired", expiryTime: new Date(now) } } }));
    assert.equal((await api.sync(payload("android", { expectedRevision: read.revision }))).state, "not_applied");
    assert.equal(db.writes.filter((w) => w.path === "users/user").length, 0);
  });
  await test("cross-platform source entitlement changes do not invalidate target PRE-CHAT", async () => {
    const db = mockDb({ "users/user": managed() });
    let reads = 0;
    db.beforeGet = async (path) => {
      if (path === "users/user" && ++reads === 2) {
        db.docs.set(path, managed({
          subscriptions: { android: { status: "active", expiryTime: new Date(now + 86400000), primaryPurchaseToken: "source-token" } },
          billingConfirmation: {
            android: { state: "active", schemaVersion: 1, coverage: COVERAGE },
            ios: { state: "eligible", schemaVersion: 1, coverage: COVERAGE },
          },
          subscriptionPlatform: "android", subscriptionStatus: "active",
          googlePlayPrimaryPurchaseToken: "source-token", billingRevision: 99,
        }));
      }
    };
    const result = await handlers(db).read(payload("ios"));
    assert.equal(result.state, "eligible", result.reason);
    assert.equal(result.storeStatus, "expired");
    assert.notEqual(result.reason, "revision_changed");
  });
  await test("ownership transfer during sync CAS prevents contract write", async () => {
    const expiry = Date.now() + 100000;
    const id = buildAndroidOwnershipId("token");
    const db = mockDb({ "users/user": managed(), [`subscription_ownership/${id}`]: { ownerUid: "user", platform: "android" } });
    const api = handlers(db, { verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" }, matchedLineItem: item(expiry) }) });
    const request = payload("android", { storeCandidates: [{ purchaseToken: "token" }] });
    const read = await api.read(request);
    let transactions = 0;
    db.beforeTransaction = async () => { if (++transactions === 2) db.docs.set(`subscription_ownership/${id}`, { ownerUid: "other", platform: "android" }); };
    assert.equal((await api.sync({ ...request, data: { ...request.data, expectedRevision: read.revision } })).state, "not_applied");
    assert.equal(db.writes.filter((w) => w.path === "users/user").length, 0);
  });
  await test("history insertion during sync CAS prevents permission write", async () => {
    const db = mockDb({ "users/user": managed() });
    const api = handlers(db);
    const read = await api.read(payload("ios"));
    let transactions = 0;
    db.beforeTransaction = async () => { if (++transactions === 2) db.docs.set("subscription_events/new", { uid: "user", notificationUUID: "new", originalTransactionId: "missing" }); };
    assert.equal((await api.sync(payload("ios", { expectedRevision: read.revision }))).state, "not_applied");
    assert.equal(db.writes.filter((w) => w.path === "users/user").length, 0);
  });
  await test("new Auth proof plus initialized doc seeds both OS once; existing doc alone cannot", async () => {
    const creationTime = new Date(now).toISOString();
    const db = mockDb({ "users/user": { email: "test@example.invalid", accountId: "account" } });
    assert.equal(await seedInitializedAccount({ db, admin, uid: "user", creationTime }), false);
    assert.equal(await recordNewAuthCreation({ db, admin, user: { uid: "user", metadata: { creationTime } }, now }), true);
    const data = db.docs.get("users/user");
    assert.equal(data.billingConfirmation.android.coverage, COVERAGE);
    assert.equal(data.billingConfirmation.ios.state, "eligible");
    assert.equal(await recordNewAuthCreation({ db, admin, user: { uid: "user", metadata: { creationTime } }, now }), false);
  });
  await test("old Auth replay and existing purchase before initialization never seed", async () => {
    const creationTime = new Date(now - 11 * 60000).toISOString();
    const db = mockDb({ "users/user": { email: "test@example.invalid", accountId: "account" } });
    assert.equal(await recordNewAuthCreation({ db, admin, user: { uid: "user", metadata: { creationTime } }, now }), false);
    assert.equal(db.writes.length, 0);
    db.docs.set("users/user", { email: "test@example.invalid", accountId: "account", subscriptionStatus: "active" });
    assert.equal(await recordNewAuthCreation({ db, admin, user: { uid: "user", metadata: { creationTime: new Date(now).toISOString() } }, now }), false);
    assert.equal(db.docs.get("users/user").billingConfirmation, undefined);
  });
  await test("Auth event before account initialization safely waits for successful initializer", async () => {
    const creationTime = new Date(now).toISOString();
    const db = mockDb({});
    assert.equal(await recordNewAuthCreation({ db, admin, user: { uid: "user", metadata: { creationTime } }, now }), false);
    db.docs.set("users/user", { email: "test@example.invalid", accountId: "account" });
    assert.equal(await seedInitializedAccount({ db, admin, uid: "user", creationTime }), true);
  });
  await test("Auth creation proof accepts ISO and Admin UTC strings for the exact same instant", async () => {
    const iso = "2026-10-01T05:35:21Z";
    const utc = "Thu, 01 Oct 2026 05:35:21 GMT";
    for (const [proofTime, creationTime] of [[iso, utc], [utc, iso]]) {
      const db = mockDb({ "users/user": { email: "test@example.invalid", accountId: "account" },
        "preChatBillingCreationProof/user": { creationTime: proofTime } });
      assert.equal(await seedInitializedAccount({ db, admin, uid: "user", creationTime }), true);
      assert.equal(db.docs.get("users/user").billingConfirmation.android.state, "eligible");
      assert.equal(db.docs.get("users/user").billingConfirmation.ios.state, "eligible");
    }
  });
  await test("Auth creation proof rejects different, invalid and millisecond-different instants", async () => {
    const iso = "2026-10-01T05:35:21Z";
    for (const [proofTime, creationTime] of [
      [iso, "Thu, 01 Oct 2026 05:35:22 GMT"],
      ["2026-10-01T05:35:21.001Z", "Thu, 01 Oct 2026 05:35:21 GMT"],
      ["", ""], ["   ", iso], [iso, ""], ["invalid", "invalid"], [iso, "invalid"], ["invalid", iso], [null, iso], [iso, null],
    ]) {
      const db = mockDb({ "users/user": { email: "test@example.invalid", accountId: "account" },
        "preChatBillingCreationProof/user": { creationTime: proofTime } });
      assert.equal(await seedInitializedAccount({ db, admin, uid: "user", creationTime }), false);
      assert.equal(db.writes.length, 0);
    }
  });
  await test("normalized creation time cannot use another UID proof or override purchase evidence", async () => {
    const iso = "2026-10-01T05:35:21Z";
    const creationTime = "Thu, 01 Oct 2026 05:35:21 GMT";
    const initialized = { email: "test@example.invalid", accountId: "account" };
    const otherUid = mockDb({ "users/user": initialized,
      "preChatBillingCreationProof/other": { creationTime: iso } });
    assert.equal(await seedInitializedAccount({ db: otherUid, admin, uid: "user", creationTime }), false);
    const purchased = mockDb({ "users/user": { ...initialized, subscriptionStatus: "active" },
      "preChatBillingCreationProof/user": { creationTime: iso } });
    assert.equal(await seedInitializedAccount({ db: purchased, admin, uid: "user", creationTime }), false);
    assert.equal(otherUid.writes.length + purchased.writes.length, 0);
  });
  await test("revision is stable for object order but changes on contract updates", () => {
    assert.equal(billingRevision({ subscriptionStatus: "active", subscriptionPlatform: "ios" }), billingRevision({ subscriptionPlatform: "ios", subscriptionStatus: "active" }));
    assert.notEqual(billingRevision(managed()), billingRevision(managed({ billingRevision: 2 })));
    assert.match(seriesIdentity("ios", "original"), /^[a-f0-9]{64}$/);
  });
  await test("new callable declarations enforce App Check and existing device guard", () => {
    const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
    assert.match(source, /preChatBillingOptions = \{ region: "us-central1", enforceAppCheck: true/);
    assert.match(source, /assertRequestAllowed:[\s\S]*assertActiveDeviceAllowed/);
    const module = fs.readFileSync(path.join(__dirname, "preChatBillingConfirmation.js"), "utf8");
    assert.match(module, /verifyAndDecodeTransaction/);
    assert.match(module, /verifyAndDecodeRenewalInfo/);
    assert.doesNotMatch(module, /claimIosSubscriptionOwnership\(|claimAndroidSubscriptionOwnership\(|acknowledgePurchase\(|AppStore\.sync/);
  });
  await test("READ works before device claim; sync keeps device safety", async () => {
    const db = mockDb({ "users/user": managed() });
    let syncChecks = 0;
    const api = handlers(db, { assertSyncAllowed: async () => {
      syncChecks++; throw new Error("device_not_claimed");
    } });
    const read = await api.read(payload("android"));
    assert.equal(read.state, "eligible", read.reason);
    assert.equal(syncChecks, 0);
    await assert.rejects(api.sync(payload("android", { expectedRevision: read.revision })), /device_not_claimed/);
    assert.equal(syncChecks, 1);
    assert.equal(db.writes.length, 0);
  });
  await test("READ diagnostics correlate stages without exposing UID or store tokens", async () => {
    const db = mockDb({ "users/user": managed() });
    const messages = [];
    const logger = {
      info: (message, fields) => messages.push({ message, fields }),
      warn: (message, fields) => messages.push({ message, fields }),
    };
    const api = handlers(db, { logger });
    const req = payload("android", {
      attemptId: "attempt_diag_1",
      diagnosticOperationId: "prechat-op-safe-1",
      storeCandidates: [{ purchaseToken: "must-not-appear-in-logs" }],
    });
    await api.read(req);
    const serialized = JSON.stringify(messages);
    assert.match(serialized, /prechat-op-safe-1/);
    assert.match(serialized, /attempt_diag_1/);
    assert.match(serialized, /google_play\.developer_api\.verify/);
    assert.match(serialized, /firestore\.user\.read/);
    assert.doesNotMatch(serialized, /must-not-appear-in-logs/);
    assert.doesNotMatch(serialized, /"uid"\s*:/);
    const stages = messages.filter((item) => item.fields?.stage === "firestore.user.read");
    assert.deepEqual(stages.map((item) => item.message.split(" ").at(-1)), ["await.begin", "await.end"]);
  });
  await test("history overflow cannot permit purchase but verified active remains blocking", () => {
    const entry = { state: "active", owner: "match", expiryMs: future,
      identities: [seriesIdentity("android", "token")] };
    assert.equal(resultFor({ data: managed(), platform: "android", entries: [entry], overflow: true }).state, "active");
    assert.equal(resultFor({ data: managed(), platform: "android", entries: [], overflow: true }).state, "unknown");
  });
  for (const platform of ["android", "ios"]) {
    for (const state of ["active", "ended"]) {
      await test(`${platform}: Store ${state} corrects opposite stale FS via one sync and reread`, async () => {
        const expiry = state === "active" ? Date.now() + 100000 : Date.now() - 100000;
        const identity = platform === "android" ? "token" : "original";
        const ownerId = platform === "android" ? buildAndroidOwnershipId(identity) : buildIosOwnershipId(identity);
        const opposite = state === "active" ? "expired" : "active";
        const old = { status: opposite, expiryTime: new Date(expiry), primaryPurchaseToken: identity,
          originalTransactionId: identity };
        const db = mockDb({ "users/user": { subscriptions: { [platform]: old },
          ...(platform === "android" ? { googlePlayPrimaryPurchaseToken: identity } : { appStoreOriginalTransactionId: identity }) },
          [`subscription_ownership/${ownerId}`]: { ownerUid: "user", platform } });
        const api = handlers(db, { verifyGoogle: async () => ({ subscription: {
          subscriptionState: state === "active" ? "SUBSCRIPTION_STATE_ACTIVE" : "SUBSCRIPTION_STATE_EXPIRED",
          acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(expiry) }),
          verifyApple: async () => [{ state, transaction: apple(expiry, { environment: "Sandbox" }),
            originalTransactionId: "original", expiryMs: expiry }] });
        const req = payload(platform, { storeCandidates: [platform === "android" ? { purchaseToken: identity } : { originalTransactionId: identity }] });
        const initial = await api.read(req);
        assert.equal(initial.state, state === "active" ? "active" : "eligible");
        assert.equal(initial.storeVerified, true); assert.equal(initial.syncRequired, true);
        assert.equal((await api.sync({ ...req, data: { ...req.data, expectedRevision: initial.revision } })).state, "completed");
        const final = await api.read(req);
        assert.equal(final.state, initial.state); assert.equal(final.syncRequired, false);
        assert.equal(final.firestoreRevision, 1);
        const document = db.docs.get("users/user");
        assert.equal(Object.hasOwn(document, `subscriptions.${platform}`), false);
        // Serialize the actual safe-sync transaction payload with the same real SDK
        // used by the dedicated dual-write shape test; no transport is invoked.
        const { Firestore } = require("@google-cloud/firestore");
        const sdk = new Firestore({ projectId: "local-shape-test" });
        const payloadWrite = db.writes.filter((w) => w.path === "users/user").at(-1);
        const batch = sdk.batch().set(sdk.doc("users/user"), payloadWrite.value, payloadWrite.options);
        const wire = batch._ops[0].op();
        assert.ok(wire.update.fields.subscriptions.mapValue.fields[platform].mapValue);
        assert.equal(Object.hasOwn(wire.update.fields, `subscriptions.${platform}`), false);
        const sdkRead = sdk.snapshot_({ name: wire.update.name, fields: wire.update.fields,
          createTime: { seconds: 1, nanos: 0 }, updateTime: { seconds: 1, nanos: 0 } }).data();
        assert.equal(sdkRead.subscriptions[platform].status, state === "active" ? "active" : "expired");
        const saved = db.docs.get("users/user").subscriptions[platform];
        assert.ok(saved.verifiedAt); assert.equal(saved.productId, APP_STORE_PRODUCT_ID);
        assert.equal(saved.status, state === "active" ? "active" : "expired");
        if (platform === "android") {
          assert.equal(saved.primaryPurchaseToken, identity);
          assert.equal(saved.packageId, "com.lahainarsnet.ohayokamome.live");
          assert.equal(saved.acknowledgementState, "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED");
        } else {
          assert.equal(saved.originalTransactionId, identity);
          assert.deepEqual(saved.transactionIds, ["transaction"]);
          assert.equal(saved.finishState, "unknown"); assert.equal(saved.environment, "Sandbox");
        }
        assert.equal(db.writes.filter((write) => write.path === "users/user").length, 1);
      });
    }
    await test(`${platform}: failed first purchase save recovers verified UID binding atomically without purchase`, async () => {
      const expiry = Date.now() + 100000;
      const token = "new-token";
      const accountHash = crypto.createHash("sha256").update("kamome-account:user").digest("hex");
      const db = mockDb({ "users/user": { appStoreAppAccountToken: "server-uuid" } });
      const api = handlers(db, { inspectOwner: async () => ({ decision: "none" }),
        verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          externalAccountIdentifiers: { obfuscatedExternalAccountId: accountHash },
          acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING" }, matchedLineItem: item(expiry) }),
        verifyApple: async () => [{ state: "active", transaction: apple(expiry, { appAccountToken: "server-uuid", environment: "Sandbox" }),
          originalTransactionId: "original", expiryMs: expiry }] });
      const req = payload(platform, { storeCandidates: [platform === "android" ? { purchaseToken: token } : { originalTransactionId: "original" }] });
      const first = await api.read(req);
      assert.equal(first.state, "active"); assert.equal(first.syncRequired, true); assert.equal(db.writes.length, 0);
      assert.equal((await api.sync({ ...req, data: { ...req.data, expectedRevision: first.revision } })).state, "completed");
      const ownerId = platform === "android" ? buildAndroidOwnershipId(token) : buildIosOwnershipId("original");
      assert.equal(db.docs.get(`subscription_ownership/${ownerId}`).ownerUid, "user");
      const next = handlers(db, { ...{}, verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        externalAccountIdentifiers: { obfuscatedExternalAccountId: accountHash },
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING" }, matchedLineItem: item(expiry) }),
        verifyApple: async () => [{ state: "active", transaction: apple(expiry, { appAccountToken: "server-uuid", environment: "Sandbox" }), originalTransactionId: "original", expiryMs: expiry }] });
      assert.equal((await next.read(req)).syncRequired, false);
      const repeat = await api.sync({ ...req, data: { ...req.data, expectedRevision: first.revision } });
      assert.equal(repeat.repeated, true);
      assert.equal(db.writes.filter((write) => write.path === "users/user").length, 1);
    });
    await test(`${platform}: absent or wrong UID binding cannot recover unowned series`, async () => {
      const db = mockDb({ "users/user": { appStoreAppAccountToken: "server-uuid" } });
      const expiry = Date.now() + 100000;
      const api = handlers(db, { inspectOwner: async () => ({ decision: "none" }),
        verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          externalAccountIdentifiers: { obfuscatedExternalAccountId: "other-account" } }, matchedLineItem: item(expiry) }),
        verifyApple: async () => [{ state: "active", transaction: apple(expiry, { appAccountToken: "wrong-uuid" }), originalTransactionId: "original", expiryMs: expiry }] });
      const result = await api.read(payload(platform, { storeCandidates: [platform === "android" ? { purchaseToken: "token" } : { originalTransactionId: "original" }] }));
      assert.ok(["unknown", "blocked"].includes(result.state)); assert.equal(db.writes.length, 0);
    });
  }
  await test("managed empty proves initial state, but legacy Store none or revoked unresolved cannot prove eligible", () => {
    assert.equal(resultFor({ data: managed(), platform: "android", entries: [] }).storeVerified, true);
    assert.equal(resultFor({ data: {}, platform: "android", entries: [] }).state, "unknown");
    assert.equal(appleState(5, apple(future), null, now), "unknown");
  });
  await test("explicit unresolved current series stops expired eligibility, known RTDN hash remains valid", async () => {
    const expiry = Date.now() - 100000;
    const ownerId = buildAndroidOwnershipId("token");
    const db = mockDb({ "users/user": { googlePlayPrimaryPurchaseToken: "token" },
      [`subscription_ownership/${ownerId}`]: { ownerUid: "user", platform: "android" },
      "subscription_events/known": { uid: "user", platform: "google_play",
        purchaseTokenHash: crypto.createHash("sha256").update("token").digest("hex") } });
    const api = handlers(db, { verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" }, matchedLineItem: item(expiry) }) });
    assert.equal((await api.read(payload("android"))).state, "eligible");
    db.docs.set("subscription_events/other", { uid: "user", platform: "google_play", purchaseTokenHash: "unresolved" });
    assert.equal((await api.read(payload("android"))).reason, "unresolved_current_series");
  });
  await test("valid signed UID proof never overwrites an existing different owner", async () => {
    const expiry = Date.now() + 100000;
    const ownerId = buildAndroidOwnershipId("token");
    const db = mockDb({ "users/user": {}, [`subscription_ownership/${ownerId}`]: { ownerUid: "other", platform: "android" } });
    const api = handlers(db, { inspectOwner: require("./subscriptionOwnership").inspectSubscriptionSeriesOwnership, verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      externalAccountIdentifiers: { obfuscatedExternalAccountId: crypto.createHash("sha256").update("kamome-account:user").digest("hex") } }, matchedLineItem: item(expiry) }) });
    const first = await api.read(payload("android", { storeCandidates: [{ purchaseToken: "token" }] }));
    assert.equal(first.state, "blocked"); assert.equal(db.writes.length, 0);
    assert.equal(db.docs.get(`subscription_ownership/${ownerId}`).ownerUid, "other");
  });
  await test("dual-write notifications preserve verification metadata and complete token/transaction lineage", async () => {
    const { commitUserSubscriptionDualWrite } = require("./subscriptionEntitlement");
    const expiry = new Date(Date.now() + 100000);
    const db = mockDb({ "users/user": { subscriptions: {
      android: { status: "active", expiryTime: expiry, primaryPurchaseToken: "old",
        activePurchaseTokens: ["old"], verifiedAt: new Date(now), packageId: "package", acknowledgementState: "ack" },
      ios: { status: "expired", expiryTime: new Date(past), originalTransactionId: "original", transactionId: "previous", transactionIds: ["previous"], verifiedAt: new Date(now), finishState: "unknown" },
    } } });
    const common = { db, admin, uid: "user", source: "notification", legacyUpdate: {}, log: { info() {} } };
    await commitUserSubscriptionDualWrite({ ...common, platform: "android", storeState: {
      status: "active", expiryTime: expiry, primaryPurchaseToken: "new" }, meta: { purchaseToken: "new" } });
    const android = db.docs.get("users/user").subscriptions.android;
    assert.deepEqual(android.activePurchaseTokens, ["old", "new"]);
    assert.equal(android.packageId, "package"); assert.equal(android.acknowledgementState, "ack");
    await commitUserSubscriptionDualWrite({ ...common, platform: "ios", storeState: {
      status: "active", expiryTime: expiry, originalTransactionId: "original", transactionId: "new-transaction" } });
    const ios = db.docs.get("users/user").subscriptions.ios;
    assert.deepEqual(ios.transactionIds, ["previous", "new-transaction"]);
    assert.equal(ios.finishState, "unknown"); assert.ok(ios.verifiedAt);
  });
  const { inspectSubscriptionSeriesOwnership, claimIosSubscriptionOwnership, claimAndroidSubscriptionOwnership } = require('./subscriptionOwnership');
  for (const platform of ['android','ios']) {
    for (const cross of [false,true]) {
      for (const state of ['active','ended','unknown']) {
        await test(`Build356 ${platform} cross=${cross}: foreign ${state}`, async () => {
          const expiry = state === 'active' ? Date.now()+100000 : Date.now()-100000;
          const ownerId = platform === 'android' ? buildAndroidOwnershipId('foreign-token') : buildIosOwnershipId('foreign-original');
          const currentToken='11111111-1111-4111-8111-111111111111';
          const oldToken='22222222-2222-4222-8222-222222222222';
          const userData = {appStoreAppAccountToken:currentToken};
          if(cross) Object.assign(userData,{subscriptionPlatform:platform==='ios'?'android':'ios',subscriptionStatus:'active',subscriptionExpiryTime:new Date(Date.now()+100000),subscriptions:{[platform==='ios'?'android':'ios']:{status:'active',expiryTime:new Date(Date.now()+100000),productId:APP_STORE_PRODUCT_ID}}});
          const opposite=platform==='ios'?'android':'ios';
          const oldData={subscriptions:{[platform]:{status:'active',expiryTime:new Date(Date.now()+100000),productId:APP_STORE_PRODUCT_ID,
            ...(platform==='android'?{primaryPurchaseToken:'foreign-token'}:{originalTransactionId:'foreign-original'})},
            [opposite]:{status:'active',expiryTime:new Date(Date.now()+100000),productId:APP_STORE_PRODUCT_ID}},
            ...(platform==='android'?{googlePlayPrimaryPurchaseToken:'foreign-token',activePurchaseTokens:['foreign-token','another-token']}:{appStoreOriginalTransactionId:'foreign-original'})};
          const db=mockDb({'users/user':userData,[`subscription_ownership/${ownerId}`]:{ownerUid:'old',platform,status:'active'},'users/old':oldData});
          const candidate=platform==='android'?{purchaseToken:'foreign-token'}:{originalTransactionId:'foreign-original'};
          const liveAdmin={...admin,FieldValue:{serverTimestamp:()=>new Date(),delete:()=>({__deleted:true})}};
          const api=handlers(db,{admin:liveAdmin,inspectOwner:inspectSubscriptionSeriesOwnership,
            verifyGoogle:async()=>({subscription:{subscriptionState:state==='active'?'SUBSCRIPTION_STATE_ACTIVE':state==='ended'?'SUBSCRIPTION_STATE_EXPIRED':'INVALID'},matchedLineItem:item(expiry)}),
            verifyApple:async()=>[{state,transaction:{...apple(expiry,{appAccountToken:oldToken}),originalTransactionId:'foreign-original'},originalTransactionId:'foreign-original',expiryMs:expiry}]});
          const input=payload(platform,{storeCandidates:[candidate]});
          const first=await api.read(input);
          assert.equal(first.state,state==='active'?'blocked':state==='ended'?'eligible':'unknown');
          assert.equal(db.writes.length,0);
          if(state==='ended') {
            assert.equal(first.syncRequired,true);
            assert.equal((await api.sync({...input,data:{...input.data,expectedRevision:first.revision}})).state,'completed');
            const second=await api.read(input);
            assert.equal(second.state,'eligible'); assert.equal(second.syncRequired,false);
            const stored=db.docs.get('users/user');
            assert.equal(stored.subscriptions[platform].status,'expired');
            assert.equal(stored.subscriptions[platform].primaryPurchaseToken,undefined);
            assert.equal(stored.subscriptions[platform].originalTransactionId,undefined);
            assert.equal(db.docs.get(`subscription_ownership/${ownerId}`).ownerUid,'old');
            assert.equal(stored.billingConfirmation[platform].expiredForeignSeries[0].ownerUid,'old');
            // A replay of the expired purchase cannot reassign ownership.
            await assert.rejects(()=>platform==='android'?claimAndroidSubscriptionOwnership(db,liveAdmin,{uid:'user',purchaseToken:'foreign-token',verifiedPurchase:{uidBound:true,active:true,purchasedAt:expiry-1}}):
              claimIosSubscriptionOwnership(db,liveAdmin,{uid:'user',update:{appStoreOriginalTransactionId:'foreign-original'},transactionInfo:{appAccountToken:currentToken,expiresDate:Date.now()+100000},verifiedPurchase:{uidBound:true,active:true,purchasedAt:expiry-1}}));
            // Only a newly verified UID-bound purchase after the server proof can reassign.
            const verifiedPurchase={uidBound:true,active:true,purchasedAt:Date.now()};
            if(platform==='android') await claimAndroidSubscriptionOwnership(db,liveAdmin,{uid:'user',purchaseToken:'foreign-token',verifiedPurchase});
            else await claimIosSubscriptionOwnership(db,liveAdmin,{uid:'user',update:{appStoreOriginalTransactionId:'foreign-original'},transactionInfo:{appAccountToken:currentToken,expiresDate:Date.now()+100000},verifiedPurchase});
            assert.equal(db.docs.get(`subscription_ownership/${ownerId}`).ownerUid,'user');
            assert.equal(db.docs.get('users/old').subscriptions[platform].status,'expired');
            assert.equal(db.docs.get('users/old').subscriptions[opposite].status,'active');
            if(platform==='android') {
              assert.equal(db.docs.get('users/old').googlePlayPrimaryPurchaseToken,undefined);
              assert.equal(db.docs.get('users/old').subscriptions.android.primaryPurchaseToken,undefined);
              assert.deepEqual(db.docs.get('users/old').activePurchaseTokens,['another-token']);
              db.docs.set('users/user',{...db.docs.get('users/user'),googlePlayPrimaryPurchaseToken:'foreign-token',activePurchaseTokens:['foreign-token']});
              const routed=await require('./googlePlaySubscriptionNotifications').findUserByPurchaseToken(db,'foreign-token','');
              assert.equal(routed.kind,'single');assert.equal(routed.uid,'user');
            }
            assert.equal((await inspectSubscriptionSeriesOwnership(db,{uid:'user',platform,...candidate})).decision,'match');
          }
        });
      }
    }
    await test(`Build356 ${platform}: foreign ended cannot overwrite unverified own Active`,async()=>{
      const expiry=Date.now()-100000;
      const entry={state:'ended',owner:'foreign_ended',expiryMs:expiry};
      assert.equal(resultFor({platform,data:{subscriptions:{[platform]:{status:'active',expiryTime:new Date(Date.now()+100000)}}},entries:[entry]}).state,'unknown');
      assert.equal(resultFor({platform,data:{subscriptionPlatform:platform,subscriptionStatus:'active'},entries:[entry]}).state,'unknown');
    });
  }

  await test('Build356 legacy Apple user ownership requires verified expiry and fresh UID-bound purchase', async()=>{
    const original='legacy-original';const token='11111111-1111-4111-8111-111111111111';
    const db=mockDb({'users/user':{appStoreAppAccountToken:token},'users/old':{appStoreOriginalTransactionId:original,subscriptionStatus:'active',subscriptionPlatform:'ios',subscriptionExpiryTime:new Date(Date.now()+100000)}});
    const liveAdmin={...admin,FieldValue:{serverTimestamp:()=>new Date(),delete:()=>({__deleted:true})}};
    const endedExpiry=Date.now()-100000;
    const stableApi=handlers(db,{admin:liveAdmin,inspectOwner:inspectSubscriptionSeriesOwnership,verifyApple:async()=>[{state:'ended',transaction:{...apple(endedExpiry),originalTransactionId:original,appAccountToken:'22222222-2222-4222-8222-222222222222'},originalTransactionId:original,expiryMs:endedExpiry}]});
    const input=payload('ios',{storeCandidates:[{originalTransactionId:original}]});
    const read=await stableApi.read(input);assert.equal(read.state,'eligible');
    assert.equal((await stableApi.sync({...input,data:{...input.data,expectedRevision:read.revision}})).state,'completed');
    const stored=db.docs.get('users/user');assert.equal(stored.billingConfirmation.ios.expiredForeignSeries[0].kind,'users');
    const assertOwner=require('./subscriptionOwnership').assertSubscriptionNotLinkedToOtherUser;
    await assert.rejects(()=>assertOwner(db,{uid:'user',platform:'ios',identifiers:{originalTransactionId:original},verifiedPurchase:{uidBound:false,purchasedAt:Date.now()}}));
    await assertOwner(db,{uid:'user',platform:'ios',identifiers:{originalTransactionId:original},verifiedPurchase:{uidBound:true,active:true,purchasedAt:Date.now()}});
    await claimIosSubscriptionOwnership(db,liveAdmin,{uid:'user',update:{appStoreOriginalTransactionId:original},transactionInfo:{appAccountToken:token,expiresDate:Date.now()+100000},verifiedPurchase:{uidBound:true,active:true,purchasedAt:Date.now()}});
    stored.billingConfirmation.ios.state='active';
    await assertOwner(db,{uid:'user',platform:'ios',identifiers:{originalTransactionId:original},verifiedPurchase:{uidBound:true,active:true,purchasedAt:Date.now()}});
  });
  for(const platform of ['ios','android']) for(const state of ['active','ended']) await test(`Build356 owned ${platform} ${state} preserves normal path`,async()=>{
    const expiry=state==='active'?Date.now()+100000:Date.now()-100000;
    const candidate=platform==='android'?{purchaseToken:'owned'}:{originalTransactionId:'owned'};
    const ownerId=platform==='android'?buildAndroidOwnershipId('owned'):buildIosOwnershipId('owned');
    const db=mockDb({'users/user':{},[`subscription_ownership/${ownerId}`]:{ownerUid:'user',platform}});
    const api=handlers(db,{inspectOwner:inspectSubscriptionSeriesOwnership,
      verifyGoogle:async()=>({subscription:{subscriptionState:state==='active'?'SUBSCRIPTION_STATE_ACTIVE':'SUBSCRIPTION_STATE_EXPIRED'},matchedLineItem:item(expiry)}),
      verifyApple:async()=>[{state,transaction:{...apple(expiry),originalTransactionId:'owned'},originalTransactionId:'owned',expiryMs:expiry}]});
    assert.equal((await api.read(payload(platform,{storeCandidates:[candidate]}))).state,state==='active'?'active':'eligible');
  });

  await test('Build356 linked Google repurchase detaches only former series and routes RTDN to new UID',async()=>{
    const oldId=buildAndroidOwnershipId('old-token');const expiry=Date.now()-100000;
    const db=mockDb({'users/user':{},'users/old':{googlePlayPrimaryPurchaseToken:'old-token',googlePlayLinkedPurchaseToken:'old-token',
      activePurchaseTokens:['old-token','unrelated'],subscriptions:{android:{status:'active',expiryTime:new Date(Date.now()+100000),primaryPurchaseToken:'old-token',activePurchaseTokens:['old-token','unrelated']}}},
      [`subscription_ownership/${oldId}`]:{ownerUid:'old',platform:'android'}});
    const liveAdmin={...admin,FieldValue:{serverTimestamp:()=>new Date(),delete:()=>({__deleted:true})}};
    const api=handlers(db,{admin:liveAdmin,inspectOwner:inspectSubscriptionSeriesOwnership,
      verifyGoogle:async()=>({subscription:{subscriptionState:'SUBSCRIPTION_STATE_EXPIRED'},matchedLineItem:item(expiry)})});
    const input=payload('android',{storeCandidates:[{purchaseToken:'old-token'}]});const read=await api.read(input);
    assert.equal(read.state,'eligible');assert.equal((await api.sync({...input,data:{...input.data,expectedRevision:read.revision}})).state,'completed');
    assert.equal(db.docs.get('users/old').subscriptions.android.status,'active'); // READ/sync never changes old UID.
    const purchaseFacts=await require('./verifiedOwnershipPurchase').verifiedGoogleOwnershipFacts({db,uid:'user',purchaseToken:'new-token',
      subscription:{subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',startTime:new Date().toISOString(),linkedPurchaseToken:'old-token',externalAccountIdentifiers:{obfuscatedExternalAccountId:crypto.createHash('sha256').update('kamome-account:user').digest('hex')}},matchedLineItem:item(Date.now()+100000),
      verifyLinked:async()=>({subscription:{subscriptionState:'SUBSCRIPTION_STATE_EXPIRED'},matchedLineItem:item(expiry)})});
    await claimAndroidSubscriptionOwnership(db,liveAdmin,{uid:'user',purchaseToken:'new-token',linkedPurchaseToken:'old-token',verifiedPurchase:purchaseFacts});
    assert.equal(db.docs.get('users/old').subscriptions.android.status,'expired');
    assert.deepEqual(db.docs.get('users/old').activePurchaseTokens,['unrelated']);
    assert.deepEqual(db.docs.get('users/old').subscriptions.android.activePurchaseTokens,['unrelated']);
    assert.equal(db.docs.get('users/old').googlePlayLinkedPurchaseToken,undefined);
    assert.equal(db.docs.get(`subscription_ownership/${oldId}`).ownerUid,'old'); // Ownership history retained.
    db.docs.set('users/user',{...db.docs.get('users/user'),googlePlayPrimaryPurchaseToken:'new-token',activePurchaseTokens:['new-token','old-token']});
    const routed=await require('./googlePlaySubscriptionNotifications').findUserByPurchaseToken(db,'new-token','old-token');
    assert.equal(routed.kind,'single');assert.equal(routed.uid,'user');
    const inspected=await inspectSubscriptionSeriesOwnership(db,{uid:'user',platform:'android',purchaseToken:'new-token',linkedPurchaseToken:'old-token',
      verifySeriesState:async({conflictingOwnershipIds})=>{assert.deepEqual(conflictingOwnershipIds,[oldId]);return 'ended';}});
    assert.equal(inspected.decision,'match');
  });

  for (const platform of ['ios','android']) await test(`Build356 ${platform}: foreign Expired sync and reassignment preserve opposite legacy-only contract`, async()=>{
    const other=platform==='ios'?'android':'ios';const expiry=Date.now()-100000;
    const legacy={subscriptionPlatform:other,subscriptionStatus:'active',subscriptionExpiryTime:new Date(Date.now()+100000),
      entitlementUsable:true,entitlementSource:other,entitlementExpiryTime:new Date(Date.now()+100000)};
    const original='legacy-foreign';const ownerId=platform==='ios'?buildIosOwnershipId(original):buildAndroidOwnershipId(original);
    const token='11111111-1111-4111-8111-111111111111';
    const db=mockDb({'users/user':{...legacy,appStoreAppAccountToken:token},'users/old':{...legacy,
      ...(platform==='ios'?{appStoreOriginalTransactionId:original}:{googlePlayPrimaryPurchaseToken:original,activePurchaseTokens:[original]})},
      [`subscription_ownership/${ownerId}`]:{ownerUid:'old',platform}});
    const liveAdmin={...admin,FieldValue:{serverTimestamp:()=>new Date(),delete:()=>({__deleted:true})}};
    const api=handlers(db,{admin:liveAdmin,inspectOwner:inspectSubscriptionSeriesOwnership,
      verifyGoogle:async()=>({subscription:{subscriptionState:'SUBSCRIPTION_STATE_EXPIRED'},matchedLineItem:item(expiry)}),
      verifyApple:async()=>[{state:'ended',transaction:{...apple(expiry),originalTransactionId:original,appAccountToken:'22222222-2222-4222-8222-222222222222'},originalTransactionId:original,expiryMs:expiry}]});
    const candidate=platform==='ios'?{originalTransactionId:original}:{purchaseToken:original};
    const input=payload(platform,{storeCandidates:[candidate]});const read=await api.read(input);
    assert.equal(read.state,'eligible');assert.equal((await api.sync({...input,data:{...input.data,expectedRevision:read.revision}})).state,'completed');
    for(const [key,value] of Object.entries(legacy)) assert.deepEqual(db.docs.get('users/user')[key],value);
    assert.equal(db.docs.get('users/user').subscriptions[platform].status,'expired');
    assert.equal(db.docs.get('users/user').subscriptions[other],undefined);
    assert.equal((await api.read(input)).state,'eligible');
    const facts={uidBound:true,active:true,purchasedAt:Date.now()};
    if(platform==='ios') await claimIosSubscriptionOwnership(db,liveAdmin,{uid:'user',update:{appStoreOriginalTransactionId:original},transactionInfo:{appAccountToken:token,expiresDate:Date.now()+100000},verifiedPurchase:facts});
    else await claimAndroidSubscriptionOwnership(db,liveAdmin,{uid:'user',purchaseToken:original,verifiedPurchase:facts});
    for(const [key,value] of Object.entries(legacy)) assert.deepEqual(db.docs.get('users/old')[key],value);
    assert.equal(db.docs.get('users/old').subscriptions[platform].status,'expired');
    assert.equal(db.docs.get('users/old').subscriptions[other],undefined);
    assert.equal(db.docs.get(`subscription_ownership/${ownerId}`).ownerUid,'user');
  });

  await test("purchase-only current contract verifies only the requested series and skips history", async () => {
    const token = "current-only-active-token";
    const expiry = Date.now() + 86400000;
    const ownerId = buildAndroidOwnershipId(token);
    const db = mockDb({ "users/user": managed({
      subscriptions: { android: { status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        expiryTime: new Date(expiry), primaryPurchaseToken: token,
        packageId: "com.lahainarsnet.ohayokamome.live", linkedPurchaseToken: "",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
        verificationSource: "google_play_subscriptions_v2", activePurchaseTokens: [token, "old-invalid"] } },
      activePurchaseTokens: [token, "old-invalid"],
    }), [`subscription_ownership/${ownerId}`]: { ownerUid: "user", platform: "android", status: "active" },
      [`subscription_ownership/${buildAndroidOwnershipId("old-invalid")}`]: { ownerUid: "user", platform: "android", status: "expired" },
      "subscription_events/old": { uid: "user", platform: "google_play", purchaseTokenHash: "old" } });
    let historyQueries = 0;
    db.beforeQuery = async () => { historyQueries++; };
    const calls = [];
    const input = payload("android", { selectionMode: "current_contract_only",
      storeCandidates: [{ purchaseToken: token }], storeState: "purchased" });
    const result = await handlers(db, { verifyGoogle: async (pkg, value) => {
      calls.push({ pkg, value });
      return { subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(expiry) };
    } }).read(input);
    assert.equal(result.state, "active");
    assert.deepEqual(calls, [{ pkg: "com.lahainarsnet.ohayokamome.live", value: token }]);
    assert.equal(historyQueries, 0);
  });
  await test("purchase-only Store Active safely syncs Firebase; revision change rejects old result", async () => {
    const token = "current-only-sync-token";
    const expiry = Date.now() + 86400000;
    const db = mockDb({ "users/user": managed({ billingRevision: 4,
      subscriptions: { android: { status: "expired", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        expiryTime: new Date(past), primaryPurchaseToken: token,
        packageId: "com.lahainarsnet.ohayokamome.live", linkedPurchaseToken: "",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
        verificationSource: "google_play_subscriptions_v2" } },
    }), [`subscription_ownership/${buildAndroidOwnershipId(token)}`]: { ownerUid: "user", platform: "android", status: "active" } });
    const input = payload("android", { selectionMode: "current_contract_only",
      storeCandidates: [{ purchaseToken: token }], storeState: "purchased" });
    const api = handlers(db, { verifyGoogle: async () => ({
      subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(expiry) }) });
    const active = await api.read(input);
    assert.equal(active.state, "active");
    assert.equal(active.syncRequired, true);
    assert.equal((await api.sync({ ...input, data: { ...input.data, expectedRevision: active.revision } })).state, "completed");
    assert.equal(db.docs.get("users/user").subscriptions.android.status, "active");
    const staleInput = payload("android", { attemptId: "attempt_2", selectionMode: "current_contract_only",
      storeCandidates: [{ purchaseToken: token }], storeState: "purchased" });
    const stale = await api.read(staleInput);
    db.docs.set("users/user", { ...db.docs.get("users/user"), subscriptions: {
      ...db.docs.get("users/user").subscriptions, android: { ...db.docs.get("users/user").subscriptions.android,
        status: "expired", expiryTime: new Date(past) } } });
    const refused = await api.sync({ ...staleInput, data: { ...staleInput.data, expectedRevision: stale.revision } });
    assert.equal(refused.state, "not_applied");
    assert.equal(db.docs.get("users/user").subscriptions.android.status, "expired");
  });
  await test("purchase-only same-owner Expired is eligible and retains its ownership record", async () => {
    const token = "current-only-expired-token";
    const expiry = Date.now() - 100000;
    const ownerId = buildAndroidOwnershipId(token);
    const db = mockDb({ "users/user": managed(),
      [`subscription_ownership/${ownerId}`]: { ownerUid: "user", platform: "android", status: "active" } });
    const input = payload("android", { selectionMode: "current_contract_only",
      storeCandidates: [{ purchaseToken: token }], storeState: "purchased" });
    const api = handlers(db, { inspectOwner: async () => ({ decision: "match", reason: "same_uid_series" }),
      verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(expiry) }) });
    const read = await api.read(input);
    assert.equal(read.state, "eligible", read.reason);
    assert.equal(read.storeStatus, "expired");
    assert.equal(read.syncRequired, true);
    assert.equal((await api.sync({ ...input, data: { ...input.data, expectedRevision: read.revision } })).state, "completed");
    assert.equal(db.docs.get(`subscription_ownership/${ownerId}`).ownerUid, "user");
    assert.equal(db.docs.get("users/user").subscriptions.android.status, "expired");
  });
  await test("purchase-only foreign-owner Expired is eligible without reassigning ownership before purchase", async () => {
    const token = "current-only-foreign-expired-token";
    const expiry = Date.now() - 100000;
    const ownerId = buildAndroidOwnershipId(token);
    const db = mockDb({ "users/user": managed(), "users/old": managed({ subscriptions: { android: {
      status: "expired", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID, expiryTime: new Date(expiry),
      primaryPurchaseToken: token, packageId: "com.lahainarsnet.ohayokamome.live",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(expiry),
      verificationSource: "google_play_subscriptions_v2" } } }),
      [`subscription_ownership/${ownerId}`]: { ownerUid: "old", platform: "android", status: "expired" } });
    const input = payload("android", { selectionMode: "current_contract_only",
      storeCandidates: [{ purchaseToken: token }], storeState: "purchased" });
    const api = handlers(db, { inspectOwner: inspectSubscriptionSeriesOwnership,
      verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(expiry) }) });
    const read = await api.read(input);
    assert.equal(read.state, "eligible", read.reason);
    assert.equal(read.storeStatus, "expired");
    assert.equal(read.syncRequired, true);
    assert.equal(db.docs.get(`subscription_ownership/${ownerId}`).ownerUid, "old");
    assert.equal(db.docs.get("users/user").subscriptions?.android, undefined);
  });
  await test("purchase-only Firebase Active plus verified Store Expired syncs to Expired before purchase", async () => {
    const token = "current-only-firebase-active-store-ended";
    const expiry = Date.now() - 100000;
    const ownerId = buildAndroidOwnershipId(token);
    const db = mockDb({ "users/user": managed({ subscriptions: { android: {
      status: "active", productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
      expiryTime: new Date(Date.now() + 86400000), primaryPurchaseToken: token,
      packageId: "com.lahainarsnet.ohayokamome.live", linkedPurchaseToken: "",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED", verifiedAt: new Date(),
      verificationSource: "google_play_subscriptions_v2" } } }),
      [`subscription_ownership/${ownerId}`]: { ownerUid: "user", platform: "android", status: "active" } });
    const input = payload("android", { attemptId: "attempt_store_ended", selectionMode: "current_contract_only",
      storeCandidates: [{ purchaseToken: token }], storeState: "purchased" });
    const api = handlers(db, { inspectOwner: async () => ({ decision: "match", reason: "same_uid_series" }),
      verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" }, matchedLineItem: item(expiry) }) });
    const read = await api.read(input);
    assert.equal(read.state, "eligible");
    assert.equal(read.storeStatus, "expired");
    assert.equal(read.syncRequired, true);
    assert.equal((await api.sync({ ...input, data: { ...input.data, expectedRevision: read.revision } })).state, "completed");
    assert.equal(db.docs.get("users/user").subscriptions.android.status, "expired");
    assert.equal(db.docs.get(`subscription_ownership/${ownerId}`).ownerUid, "user");
  });
  await test("purchase-only other UID Active blocks and Store API failure remains Unknown", async () => {
    const token = "current-only-other-owner-token";
    const expiry = Date.now() + 86400000;
    const db = mockDb({ "users/user": managed(),
      [`subscription_ownership/${buildAndroidOwnershipId(token)}`]: { ownerUid: "previous", platform: "android", status: "active" } });
    const input = payload("android", { selectionMode: "current_contract_only",
      storeCandidates: [{ purchaseToken: token }], storeState: "purchased" });
    const blocked = await handlers(db, { inspectOwner: async () => ({ decision: "mismatch", reason: "owner_mismatch" }),
      verifyGoogle: async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" }, matchedLineItem: item(expiry) }) }).read(input);
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.reason, "owner_mismatch");
    assert.equal(db.docs.get("users/user").subscriptions, undefined);
    const unknown = await handlers(db, { verifyGoogle: async () => { throw new Error("temporary API failure"); } })
      .read(payload("android", { selectionMode: "current_contract_only",
        storeCandidates: [{ purchaseToken: token }], storeState: "purchased" }));
    assert.equal(unknown.state, "unknown");
    assert.equal(unknown.reason, "server_read_unavailable");
  });

  console.log(`preChatBillingConfirmation.test.js: ${passed} tests passed`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
