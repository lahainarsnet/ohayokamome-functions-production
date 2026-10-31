"use strict";
// Build 495: iPhone purchase verification takes over an ENDED Apple series for the requester's own purchase.
const assert = require("node:assert/strict");
const { reassignEndedIosSeriesToOwnPurchase } = require("./iosOwnPurchaseReassignment");
const { buildIosOwnershipId } = require("./subscriptionOwnership");
const { fingerprint } = require("./expiredOwnershipProof");
const { makeDb, adminFor, snapshotOf } = require("./ownershipTransferTestKit");

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const ORIG = "2000001194540581";
const OTHER_ORIG = "2000001194000001";
const TX = "2000001194999999";
const OWN_ID = buildIosOwnershipId(ORIG);
const X = "user-x-abcdefghij0123456789";
const Y = "user-y-abcdefghij0123456789";
const TAG_Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const iso = (ms) => new Date(ms).toISOString();
const PURCHASED_AT = NOW - 5 * 60 * 1000;

const xUser = ({ expiry = NOW - 2 * HOUR, status = "expired", orig = ORIG } = {}) => ({
  subscriptions: { ios: { status, expiryTime: iso(expiry), originalTransactionId: orig, transactionId: TX, transactionIds: [TX] } },
  subscriptionStatus: status, subscriptionPlatform: "ios", subscriptionExpiryTime: iso(expiry),
  appStoreOriginalTransactionId: orig, appStoreTransactionId: TX, activePurchaseTokens: [TX],
  entitlementUsable: status === "active", entitlementSource: status === "active" ? "ios" : "none", entitlementExpiryTime: iso(expiry),
});
const docs = (overrides = {}) => ({
  [`users/${X}`]: xUser(),
  [`users/${Y}`]: { appStoreAppAccountToken: TAG_Y },
  [`subscription_ownership/${OWN_ID}`]: { ownerUid: X, platform: "ios", status: "active", appStoreOriginalTransactionId: ORIG },
  ...overrides,
});
const purchase = (overrides = {}) => ({ active: true, uidBound: true, accountTag: TAG_Y, purchasedAt: PURCHASED_AT, ...overrides });
const run = (db, extra = {}) => reassignEndedIosSeriesToOwnPurchase(db, adminFor(db), {
  uid: Y, transactionInfo: { originalTransactionId: ORIG, transactionId: "2000001195000000" }, purchase: purchase(), now: NOW, ...extra,
});
const results = [];
const check = async (name, fn) => { await fn(); results.push(name); };

(async () => {
  await check("1. previous owner ended before the purchase: the series moves to the buyer (Proof B)", async () => {
    const db = makeDb(docs());
    const r = await run(db);
    assert.equal(r.reassigned, true);
    assert.equal(r.code, "ALLOW_SERVER_DERIVED_IOS_OWNER_RECORD");
    assert.equal(db.docs.get(`subscription_ownership/${OWN_ID}`).ownerUid, Y);
    const x = db.docs.get(`users/${X}`);
    assert.equal(x.subscriptions.ios.status, "expired");
    assert.equal(x.subscriptions.ios.source, "verified_expired_owner_reassigned");
    assert.equal(x.subscriptions.ios.originalTransactionId, undefined);
    assert.deepEqual(x.subscriptions.ios.transactionIds, []);
    assert.equal(x.appStoreOriginalTransactionId, undefined);
    assert.equal(x.appStoreTransactionId, undefined);
    assert.deepEqual(x.activePurchaseTokens, []);
  });

  const unchanged = async (name, dbDocs, extra, expectedCode) => check(name, async () => {
    const db = makeDb(dbDocs);
    const before = snapshotOf(db);
    const r = await run(db, extra);
    assert.equal(r.reassigned, false);
    if (expectedCode) assert.equal(r.code, expectedCode);
    assert.equal(snapshotOf(db), before);
  });
  await unchanged("2. previous owner still Active: nothing moves", docs({ [`users/${X}`]: xUser({ status: "active", expiry: NOW + 20 * 24 * HOUR }) }), {});
  await unchanged("3. purchase not bound to the buyer's tag: nothing moves", docs(), { purchase: purchase({ uidBound: false }) }, "NOT_APPLICABLE");
  await unchanged("4. purchase not active: nothing moves", docs(), { purchase: purchase({ active: false }) }, "NOT_APPLICABLE");
  await unchanged("5. previous contract ended only after the purchase began: nothing moves",
    docs({ [`users/${X}`]: xUser({ expiry: PURCHASED_AT + 60 * 1000 }) }), {}, "REJECT_IOS_OWNER_END_NOT_BEFORE_PURCHASE");
  await unchanged("6. buyer already owns the series: nothing to do",
    docs({ [`subscription_ownership/${OWN_ID}`]: { ownerUid: Y, platform: "ios", status: "active" } }), {}, "NOT_APPLICABLE");
  await unchanged("7. no ownership record (a brand-new series): nothing to do",
    (() => { const d = docs(); delete d[`subscription_ownership/${OWN_ID}`]; return d; })(), {}, "NOT_APPLICABLE");
  await unchanged("8. previous owner's record points to another series and there is no pre-purchase record: nothing moves",
    docs({ [`users/${X}`]: xUser({ orig: OTHER_ORIG }) }), {}, "REJECT_IOS_OWNER_SERIES_UNCONFIRMED");
  await unchanged("9. no originalTransactionId: nothing to do", docs(),
    { transactionInfo: { originalTransactionId: "", transactionId: "2000001195000000" } }, "NOT_APPLICABLE");

  await check("10. pre-purchase record (Proof A) moves the series even when the previous owner's record has no series id", async () => {
    const base = docs({ [`users/${X}`]: xUser({ orig: "" }) });
    const probe = makeDb(base);
    const ownerFp = fingerprint(await probe.collection("subscription_ownership").doc(OWN_ID).get());
    const ownerUserFp = fingerprint(await probe.collection("users").doc(X).get());
    const checkedAt = PURCHASED_AT - 60 * 1000;
    const db = makeDb({ ...base, [`users/${Y}`]: { appStoreAppAccountToken: TAG_Y, billingConfirmation: { ios: {
      state: "eligible", reason: "verified_current_series_ended", checkedAt,
      expiredForeignSeries: [{ ownershipId: OWN_ID, ownerUid: X, fingerprint: ownerFp, ownerUserFingerprint: ownerUserFp, expiryMs: checkedAt - HOUR }],
    } } } });
    const r = await run(db);
    assert.equal(r.reassigned, true);
    assert.equal(r.code, "ALLOW_CLIENT_CONFIRMED_PROOF");
    assert.equal(db.docs.get(`subscription_ownership/${OWN_ID}`).ownerUid, Y);
  });

  await check("11. a failing write leaves everything unchanged and reports no reassignment", async () => {
    const db = makeDb(docs(), { failCommit: true });
    const before = snapshotOf(db);
    const r = await run(db);
    assert.equal(r.reassigned, false);
    assert.equal(r.code, "REASSIGNMENT_NOT_APPLIED");
    assert.equal(snapshotOf(db), before);
  });

  for (const name of results) console.log(`PASS ${name}`);
  console.log(`iosOwnPurchaseReassignment: ${results.length} passed`);
})().catch((error) => { console.error(error); process.exit(1); });
