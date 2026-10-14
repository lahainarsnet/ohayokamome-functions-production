/**
 * Case 10 / proof A retention: an Apple contract inquiry (source ios_subscription_reconcile) that re-observes the
 * IDENTICAL contract (same status, transaction id, expiry) must not rewrite billingConfirmation or billingRevision.
 * Every other write keeps the existing behaviour (confirmation reset to "unknown", revision + 1).
 * Dummy data only; no real contract data is touched.
 */
const assert = require("node:assert/strict");
const { commitUserSubscriptionDualWrite, buildIosStoreState, buildAndroidStoreState } = require("./subscriptionEntitlement");
const { evaluateExpiredReassignment, fingerprint } = require("./expiredOwnershipProof");
const { buildIosOwnershipId } = require("./subscriptionOwnership");

const silentLog = { info() {}, warn() {}, error() {} };
const admin = {
  FieldValue: { serverTimestamp() { return "SERVER_TIMESTAMP"; }, delete() { return { __type: "delete" }; } },
  Timestamp: {
    fromMillis(ms) { const d = new Date(ms); return { toDate: () => d, toMillis: () => ms }; },
    fromDate(d) { return this.fromMillis(d.getTime()); },
  },
};
const ts = (ms) => admin.Timestamp.fromMillis(ms);

function applyMerge(target, data) {
  const next = { ...(target || {}) };
  for (const [key, value] of Object.entries(data || {})) {
    const plain = value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype &&
      typeof value.toMillis !== "function";
    next[key] = plain ? applyMerge(next[key], value) : value;
  }
  return next;
}
function snap(data, id) { return { exists: data != null, id, data: () => data, get: (f) => (data ? data[f] : undefined) }; }
function createDb(users) {
  const docs = { ...users };
  return {
    docs,
    collection() { return { doc: (id) => ({ id, collection: "users", get: async () => snap(docs[id], id) }) }; },
    async runTransaction(cb) {
      return cb({
        async get(ref) { return snap(docs[ref.id], ref.id); },
        set(ref, data) { docs[ref.id] = applyMerge(docs[ref.id], data); },
      });
    },
  };
}

const NOW = Date.UTC(2026, 9, 14, 6, 0, 0);
const EXPIRY = NOW - 3_600_000;
const ORIG = "2000001250731451";
const OID = buildIosOwnershipId(ORIG);

// X (previous owner) records, used for the proof A fingerprints.
const ownerDoc = { ownerUid: "X", platform: "ios", status: "active", appStoreOriginalTransactionId: ORIG };
const ownerUserDoc = { subscriptions: { ios: { status: "expired" } } };
const ownerSnap = snap(ownerDoc, OID);
const ownerUserSnap = snap(ownerUserDoc, "X");

function proofAConfirmation(checkedAtMs) {
  return {
    schemaVersion: 1, state: "eligible", reason: "verified_current_series_ended", coverage: "ok", checkedAt: ts(checkedAtMs), revision: 5,
    expiredForeignSeries: [{ ownershipId: OID, ownerUid: "X", kind: "subscription_ownership", fingerprint: fingerprint(ownerSnap),
      ownerUserFingerprint: fingerprint(ownerUserSnap), expiryMs: checkedAtMs - 1000 }],
  };
}
function yUser(checkedAtMs = NOW - 60_000) {
  return {
    billingRevision: 5,
    billingConfirmation: { ios: proofAConfirmation(checkedAtMs) },
    subscriptions: { ios: { status: "expired", transactionId: "T1", originalTransactionId: "ORIG-Y", expiryTime: ts(EXPIRY), source: "ios_subscription_reconcile" } },
    subscriptionStatus: "expired", subscriptionPlatform: "ios",
  };
}
function iosState(over = {}) {
  return buildIosStoreState({
    status: "expired", expiryTime: ts(EXPIRY), originalTransactionId: "ORIG-Y", transactionId: "T1", environment: "Sandbox",
    storeObservedAtMs: NOW, source: "ios_subscription_reconcile", updatedAt: "SERVER_TIMESTAMP", ...over,
  });
}
async function write(db, { source = "ios_subscription_reconcile", platform = "ios", storeState = iosState() } = {}) {
  return commitUserSubscriptionDualWrite({
    db, admin, uid: "Y", source, platform, storeState, log: silentLog,
    legacyUpdate: { subscriptionStatus: storeState.status, subscriptionPlatform: platform },
  });
}
const purchase = (purchasedAt) => ({ active: true, uidBound: true, purchasedAt });
function proofA(userData, now, purchasedAt = now) {
  return evaluateExpiredReassignment({ userData, platform: "ios", purchase: purchase(purchasedAt), ownershipId: OID, ownerUid: "X",
    ownerSnapshot: ownerSnap, ownerUserSnapshot: ownerUserSnap, now });
}

(async () => {
  // 1 + 3: identical contract -> confirmation (proof A) and revision are kept.
  {
    const db = createDb({ Y: yUser() });
    const before = JSON.stringify(db.docs.Y.billingConfirmation);
    const result = await write(db);
    assert.equal(db.docs.Y.billingRevision, 5, "revision must not change");
    assert.equal(JSON.stringify(db.docs.Y.billingConfirmation), before, "billingConfirmation must be kept as is");
    assert.equal(db.docs.Y.billingConfirmation.ios.state, "eligible");
    assert.equal(result.billingRevisionAfter, 5);
    assert.equal(db.docs.Y.subscriptions.ios.storeObservedAtMs, NOW, "the observation itself is still recorded");
    assert.equal(proofA(db.docs.Y, NOW).source, "client_confirmed", "proof A still usable");
  }
  // 2 + 4: changed expiry / status / transaction id -> previous behaviour.
  for (const [name, over] of [
    ["expiry", { expiryTime: ts(EXPIRY + 86_400_000) }],
    ["status", { status: "active", expiryTime: ts(NOW + 86_400_000) }],
    ["transaction", { transactionId: "T2" }],
  ]) {
    const db = createDb({ Y: yUser() });
    const result = await write(db, { storeState: iosState(over) });
    assert.equal(db.docs.Y.billingRevision, 6, `${name}: revision + 1`);
    assert.equal(db.docs.Y.billingConfirmation.ios.state, "unknown", `${name}: confirmation reset`);
    assert.equal(db.docs.Y.billingConfirmation.ios.reason, "contract_changed_requires_recheck");
    // Firestore merges maps field by field, so the old list may remain; proof A is unusable because state/reason changed.
    assert.equal(result.billingRevisionAfter, 6);
    assert.equal(proofA(db.docs.Y, NOW).proof, null, `${name}: proof A no longer usable`);
  }
  // Missing stored contract / missing transaction id is never "unchanged".
  {
    const user = yUser();
    delete user.subscriptions.ios.transactionId;
    const db = createDb({ Y: user });
    await write(db);
    assert.equal(db.docs.Y.billingRevision, 6);
    assert.equal(db.docs.Y.billingConfirmation.ios.state, "unknown");
    const db2 = createDb({ Y: { billingRevision: 5, billingConfirmation: { ios: proofAConfirmation(NOW) } } });
    await write(db2);
    assert.equal(db2.docs.Y.billingRevision, 6, "no stored contract -> treated as a change");
  }
  // 7: other sources and Android keep the previous behaviour even for an identical contract.
  for (const source of ["apple_notification", "ios_purchase_verify", "ownership_transfer", "app_store_notification_v2"]) {
    const db = createDb({ Y: yUser() });
    await write(db, { source });
    assert.equal(db.docs.Y.billingRevision, 6, `${source}: revision + 1`);
    assert.equal(db.docs.Y.billingConfirmation.ios.state, "unknown", `${source}: reset`);
  }
  {
    const user = yUser();
    user.subscriptions.android = { status: "expired", primaryPurchaseToken: "tok", expiryTime: ts(EXPIRY) };
    user.billingConfirmation.android = { ...proofAConfirmation(NOW), state: "eligible" };
    const db = createDb({ Y: user });
    await write(db, { platform: "android", source: "ios_subscription_reconcile",
      storeState: buildAndroidStoreState({ status: "expired", expiryTime: ts(EXPIRY), primaryPurchaseToken: "tok", source: "x", updatedAt: "SERVER_TIMESTAMP" }) });
    assert.equal(db.docs.Y.billingRevision, 6, "android is unaffected");
    assert.equal(db.docs.Y.billingConfirmation.android.state, "unknown");
  }
  // 5: the 15 minute limit of proof A is unchanged (a retained proof does not live longer).
  {
    const db = createDb({ Y: yUser(NOW - 60_000) });
    await write(db);
    assert.ok(proofA(db.docs.Y, NOW).proof, "within 15 minutes");
    assert.equal(proofA(db.docs.Y, NOW - 60_000 + 15 * 60_000).source, "client_confirmed", "exactly at the limit");
    assert.equal(proofA(db.docs.Y, NOW - 60_000 + 15 * 60_000 + 1).proof, null, "just after 15 minutes: refused");
    assert.equal(proofA(db.docs.Y, NOW, NOW - 120_000).proof, null, "purchase before the check: refused");
  }
  // 6: a changed previous-owner record invalidates the retained proof A.
  {
    const db = createDb({ Y: yUser() });
    await write(db);
    const changedOwner = snap({ ...ownerDoc, updatedMarker: "changed" }, OID);
    const changedOwnerUser = snap({ subscriptions: { ios: { status: "expired", marker: "changed" } } }, "X");
    assert.equal(evaluateExpiredReassignment({ userData: db.docs.Y, platform: "ios", purchase: purchase(NOW), ownershipId: OID, ownerUid: "X",
      ownerSnapshot: changedOwner, ownerUserSnapshot: ownerUserSnap, now: NOW }).proof, null, "ownership record fingerprint changed");
    assert.equal(evaluateExpiredReassignment({ userData: db.docs.Y, platform: "ios", purchase: purchase(NOW), ownershipId: OID, ownerUid: "X",
      ownerSnapshot: ownerSnap, ownerUserSnapshot: changedOwnerUser, now: NOW }).proof, null, "previous owner user record fingerprint changed");
  }
  console.log("subscriptionReconcileProofRetention checks passed");
})().catch((error) => { console.error(error); process.exit(1); });
