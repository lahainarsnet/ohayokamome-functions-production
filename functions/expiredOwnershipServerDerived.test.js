"use strict";
// "Latest holder wins": a different Firebase UID takes over a series when the Store reports it ACTIVE and the
// purchase carries the requester's own tag or the previous owner's recorded tag. Unrelated tags are refused.
// Expired previous owners are still handled by the earlier ended-series proofs.
const assert = require("node:assert/strict");
const {
  claimOwnershipDocument,
  assertSubscriptionNotLinkedToOtherUser,
  buildIosOwnershipId,
  buildAndroidOwnershipId,
  SUBSCRIPTION_ALREADY_LINKED_CODE,
} = require("./subscriptionOwnership");
const { getExpiredReassignmentProof, fingerprint } = require("./expiredOwnershipProof");

const HOUR = 60 * 60 * 1000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const log = { info() {}, warn() {} };
const admin = {
  FieldValue: { serverTimestamp: () => ({ __type: "serverTimestamp" }), delete: () => ({ __type: "delete" }) },
  Timestamp: {
    fromMillis: (ms) => ({ __ms: ms, toMillis: () => ms, toDate: () => new Date(ms) }),
    fromDate: (date) => ({ __ms: date.getTime(), toMillis: () => date.getTime(), toDate: () => date }),
  },
};

function makeDb({ users = {}, ownership = {}, usersQuery = {} } = {}) {
  const snap = (data, id) => ({ id, exists: data != null, data: () => data, get: (field) => (data ? data[field] : undefined) });
  const merge = (target, data) => {
    const next = { ...(target || {}) };
    for (const [key, value] of Object.entries(data || {})) {
      if (value && value.__type === "delete") delete next[key]; else next[key] = value;
    }
    return next;
  };
  const userRef = (id) => ({ id, __kind: "user", get: async () => snap(users[id], id) });
  const ownRef = (id) => ({ id, __kind: "ownership", get: async () => snap(ownership[id], id) });
  return {
    users, ownership,
    collection(name) {
      if (name === "users") {
        return {
          doc: userRef,
          where(field, op, value) {
            const ids = usersQuery[`${field}|${op}|${value}`] || [];
            return { limit: () => ({ get: async () => ({ docs: ids.map((id) => ({ id })) }) }) };
          },
        };
      }
      if (name === "subscription_ownership") return { doc: ownRef };
      throw new Error(`Unexpected collection: ${name}`);
    },
    async runTransaction(callback) {
      return callback({
        get: async (ref) => (ref.__kind === "user" ? snap(users[ref.id], ref.id) : snap(ownership[ref.id], ref.id)),
        set(ref, data, options) {
          const store = ref.__kind === "user" ? users : ownership;
          store[ref.id] = options && options.merge ? merge(store[ref.id], data) : { ...data };
        },
      });
    },
  };
}

// Expect the ownership guard itself to refuse (not an unrelated failure).
async function rejectsAlreadyLinked(promise, label) {
  await assert.rejects(promise, (error) => {
    assert.equal(error && error.details && error.details.code, SUBSCRIPTION_ALREADY_LINKED_CODE, `${label}: expected ${SUBSCRIPTION_ALREADY_LINKED_CODE}, got ${error && (error.details?.code || error.message)}`);
    return true;
  }, label);
}
// Expect a safe stop because the Store state could not be confirmed.
async function rejectsUnconfirmed(promise, label) {
  await assert.rejects(promise, (error) => {
    assert.equal(error && error.code, "unavailable", `${label}: expected unavailable, got ${error && (error.code || error.message)}`);
    return true;
  }, label);
}

// ---------------- iOS (same originalTransactionId continues after expiry) ----------------
const ORIGINAL = "2000001194540581";
const IOS_ID = buildIosOwnershipId(ORIGINAL);
const iosOwnerUser = (overrides = {}) => ({
  subscriptions: { ios: { status: "expired", expiryTime: iso(now - 2 * HOUR), originalTransactionId: ORIGINAL, source: "app_store_verify", ...overrides } },
  appStoreOriginalTransactionId: ORIGINAL,
});
const iosPurchase = (overrides = {}) => ({ uidBound: true, active: true, purchasedAt: now - 5 * 60 * 1000, ...overrides });
const iosClaim = (db, purchase, uid = "uid-b") => claimOwnershipDocument(db, admin, {
  uid, ownershipId: IOS_ID, platform: "ios", ownershipFields: { productId: "ohayo_kamome_monthly" }, log, verifiedPurchase: purchase,
});
const iosDb = (ownerUser) => makeDb({
  users: { "uid-a": ownerUser, "uid-b": {} },
  ownership: { [IOS_ID]: { ownerUid: "uid-a", platform: "ios", status: "active" } },
});

(async () => {
  // 1 + 2: previous owner Expired -> new UID's genuine purchase is accepted; ownership moves, previous owner expired.
  let db = iosDb(iosOwnerUser());
  await iosClaim(db, iosPurchase());
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-b", "iOS: expired previous owner -> ownership moves to new UID");
  assert.equal(db.users["uid-a"].subscriptions.ios.status, "expired", "iOS: previous owner stays expired");
  assert.equal(db.users["uid-a"].subscriptions.ios.source, "verified_expired_owner_reassigned");

  // 6 (retry): the same UID repeating the claim is a plain reuse, no second transfer, no rejection.
  await iosClaim(db, iosPurchase());
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-b", "iOS: retry by the new owner keeps ownership");

  // 1: previous owner ACTIVE -> protected, nothing changes.
  db = iosDb(iosOwnerUser({ status: "active", expiryTime: iso(now + 24 * HOUR) }));
  await rejectsAlreadyLinked(iosClaim(db, iosPurchase({ uidBound: false })), "iOS active owner");
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-a", "iOS: active owner keeps ownership");
  assert.equal(db.users["uid-a"].subscriptions.ios.status, "active");

  // 3: previous owner was still paid up when this purchase began and only ended afterwards -> not accepted.
  db = iosDb(iosOwnerUser({ expiryTime: iso(now - 60 * 1000) }));
  await rejectsAlreadyLinked(iosClaim(db, iosPurchase({ uidBound: false, purchasedAt: now - 5 * 60 * 1000 })), "iOS ended only after purchase began");
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-a");

  // 4: unconfirmed evidence is never enough (fail closed).
  for (const [label, ownerUser] of [
    ["no identity", { subscriptions: { ios: { status: "expired", expiryTime: iso(now - 2 * HOUR) } } }],
    ["other series", iosOwnerUser({ originalTransactionId: "999" })],
    ["no store record", { appStoreOriginalTransactionId: ORIGINAL }],
    ["revoked", iosOwnerUser({ status: "revoked" })],
    ["no deadline", iosOwnerUser({ expiryTime: undefined })],
    ["unknown status", iosOwnerUser({ status: "mystery" })],
  ]) {
    db = iosDb(ownerUser);
    await rejectsAlreadyLinked(iosClaim(db, iosPurchase({ uidBound: false })), `iOS unconfirmed: ${label}`);
    assert.equal(db.ownership[IOS_ID].ownerUid, "uid-a", `iOS unconfirmed keeps owner: ${label}`);
  }
  // The new purchase itself must be genuine: bound to this UID and active.
  for (const purchase of [iosPurchase({ uidBound: false }), iosPurchase({ uidBound: false, active: false }), iosPurchase({ uidBound: true, active: false })]) {
    db = iosDb(iosOwnerUser());
    await rejectsAlreadyLinked(iosClaim(db, purchase), `iOS purchase evidence ${JSON.stringify(purchase)}`);
    assert.equal(db.ownership[IOS_ID].ownerUid, "uid-a");
  }

  // 5: the previous owner's record changes between the pre-check and the commit -> the transaction re-checks.
  db = iosDb(iosOwnerUser());
  assert.ok(getExpiredReassignmentProof({ userData: {}, platform: "ios", purchase: iosPurchase(), ownershipId: IOS_ID, ownerUid: "uid-a",
    ownerSnapshot: await db.collection("subscription_ownership").doc(IOS_ID).get(), ownerUserSnapshot: await db.collection("users").doc("uid-a").get() }), "pre-check passes");
  db.users["uid-a"] = iosOwnerUser({ status: "active", expiryTime: iso(now + 24 * HOUR) });
  await rejectsAlreadyLinked(iosClaim(db, iosPurchase({ uidBound: false })), "iOS owner became active before commit");
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-a");

  // The same previous owner re-purchasing is never affected by any of this.
  db = iosDb(iosOwnerUser({ status: "active", expiryTime: iso(now + HOUR) }));
  await iosClaim(db, iosPurchase(), "uid-a");
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-a", "same UID re-purchase keeps ownership");

  // Users-collection scan (history by identifier): expired owner allowed, active owner rejected.
  const scanDb = (ownerUser) => makeDb({
    users: { "uid-a": ownerUser, "uid-b": {} },
    ownership: { [IOS_ID]: { ownerUid: "uid-a", platform: "ios", status: "active" } },
    usersQuery: { [`appStoreOriginalTransactionId|==|${ORIGINAL}`]: ["uid-a"] },
  });
  const scanArgs = { uid: "uid-b", platform: "ios", identifiers: { originalTransactionId: ORIGINAL, transactionId: "t-1" }, verifiedPurchase: iosPurchase(), log };
  await assertSubscriptionNotLinkedToOtherUser(scanDb(iosOwnerUser()), scanArgs);
  await rejectsAlreadyLinked(assertSubscriptionNotLinkedToOtherUser(scanDb(iosOwnerUser({ status: "active", expiryTime: iso(now + HOUR) })), { ...scanArgs, verifiedPurchase: iosPurchase({ uidBound: false }) }), "iOS scan active owner, unrelated purchase");

  // ---------------- Android (a new token linked to an older token through linkedPurchaseToken) ----------------
  const OLD_TOKEN = "old-token-of-uid-a";
  const NEW_TOKEN = "new-token-of-uid-b";
  const OLD_ID = buildAndroidOwnershipId(OLD_TOKEN);
  const NEW_ID = buildAndroidOwnershipId(NEW_TOKEN);
  const androidOwnerUser = (overrides = {}) => ({
    subscriptions: { android: { status: "expired", expiryTime: iso(now - 2 * HOUR), primaryPurchaseToken: OLD_TOKEN, activePurchaseTokens: [OLD_TOKEN], source: "google_play_verify", ...overrides } },
    googlePlayPrimaryPurchaseToken: OLD_TOKEN,
  });
  const androidDb = (ownerUser) => makeDb({
    users: { "uid-a": ownerUser, "uid-b": {} },
    ownership: { [OLD_ID]: { ownerUid: "uid-a", platform: "android", status: "active" } },
  });
  const androidPurchase = async (db, overrides = {}) => {
    const purchasedAt = overrides.purchasedAt ?? now - 5 * 60 * 1000;
    return {
      uidBound: true, active: true, purchasedAt,
      linkedState: "ended", linkedOwnershipId: OLD_ID, linkedExpiryMs: now - 2 * HOUR,
      linkedObservation: { ownershipId: OLD_ID, ownerUid: "uid-a", fingerprint: fingerprint(await db.collection("subscription_ownership").doc(OLD_ID).get()),
        ownerUserFingerprint: fingerprint(await db.collection("users").doc("uid-a").get()) },
      linkedLegacyOwners: [],
      ...overrides,
    };
  };
  const androidClaim = (db, purchase) => claimOwnershipDocument(db, admin, {
    uid: "uid-b", ownershipId: NEW_ID, platform: "android", linkedOwnershipId: OLD_ID, ownershipFields: { productId: "ohayo_kamome_monthly" }, log, verifiedPurchase: purchase,
  });

  db = androidDb(androidOwnerUser());
  await androidClaim(db, await androidPurchase(db));
  assert.equal(db.ownership[NEW_ID].ownerUid, "uid-b", "Android: new token owned by the new UID");
  assert.equal(db.users["uid-a"].subscriptions.android.status, "expired", "Android: previous owner stays expired");
  assert.equal(db.ownership[OLD_ID].ownerUid, "uid-a", "Android: history of the old token is kept");

  // ① previous owner ACTIVE
  db = androidDb(androidOwnerUser({ status: "active", expiryTime: iso(now + 24 * HOUR) }));
  await rejectsAlreadyLinked(androidClaim(db, await androidPurchase(db, { uidBound: false })), "Android active owner");
  assert.equal(db.ownership[NEW_ID], undefined, "Android: nothing was created for the new token");
  assert.equal(db.users["uid-a"].subscriptions.android.status, "active");

  // ③ replaced while still paid up: Google's old-token end is NOT before this purchase began.
  db = androidDb(androidOwnerUser());
  await rejectsAlreadyLinked(androidClaim(db, await androidPurchase(db, { uidBound: false, linkedExpiryMs: now - 5 * 60 * 1000 })), "Android old token ended at purchase time");
  await rejectsAlreadyLinked(androidClaim(db, await androidPurchase(db, { uidBound: false, linkedExpiryMs: now + HOUR })), "Android old token still paid up");
  assert.equal(db.ownership[NEW_ID], undefined);

  // ④ unconfirmed Google state / evidence
  for (const overrides of [{ linkedState: "unknown" }, { linkedState: "active" }]) {
    db = androidDb(androidOwnerUser());
    await rejectsUnconfirmed(androidClaim(db, await androidPurchase(db, overrides)), `Android Store state ${JSON.stringify(overrides)}`);
    assert.equal(db.ownership[NEW_ID], undefined);
  }
  for (const overrides of [{ uidBound: false, linkedExpiryMs: NaN }, { uidBound: false }, { uidBound: false, active: false }]) {
    db = androidDb(androidOwnerUser());
    await rejectsAlreadyLinked(androidClaim(db, await androidPurchase(db, overrides)), `Android evidence ${JSON.stringify(overrides)}`);
    assert.equal(db.ownership[NEW_ID], undefined);
  }

  // Users-collection scan for Android: expired previous owner (verified link) allowed, active one rejected.
  const androidScanDb = (ownerUser) => makeDb({
    users: { "uid-a": ownerUser, "uid-b": {} },
    ownership: { [OLD_ID]: { ownerUid: "uid-a", platform: "android", status: "active" } },
    usersQuery: { [`activePurchaseTokens|array-contains|${OLD_TOKEN}`]: ["uid-a"] },
  });
  db = androidScanDb(androidOwnerUser());
  await assertSubscriptionNotLinkedToOtherUser(db, { uid: "uid-b", platform: "android", identifiers: { purchaseToken: NEW_TOKEN, linkedPurchaseToken: OLD_TOKEN }, verifiedPurchase: await androidPurchase(db), log });
  db = androidScanDb(androidOwnerUser({ status: "active", expiryTime: iso(now + 24 * HOUR) }));
  await rejectsAlreadyLinked(assertSubscriptionNotLinkedToOtherUser(db, { uid: "uid-b", platform: "android", identifiers: { purchaseToken: NEW_TOKEN, linkedPurchaseToken: OLD_TOKEN }, verifiedPurchase: await androidPurchase(db, { uidBound: false }), log }), "Android scan active owner");

  // The previous owner's own record must also agree (stale "active" record fails closed).
  db = androidDb({ subscriptions: { android: { status: "active", expiryTime: iso(now + HOUR), primaryPurchaseToken: OLD_TOKEN } } });
  await rejectsAlreadyLinked(androidClaim(db, await androidPurchase(db, { uidBound: false })), "Android owner record still active");

  // Same token (not a link) is never covered: Google issues a new token after expiry.
  db = makeDb({ users: { "uid-a": androidOwnerUser(), "uid-b": {} }, ownership: { [NEW_ID]: { ownerUid: "uid-a", platform: "android", status: "active" } } });
  await rejectsAlreadyLinked(claimOwnershipDocument(db, admin, { uid: "uid-b", ownershipId: NEW_ID, platform: "android", ownershipFields: {}, log,
    verifiedPurchase: { uidBound: false, active: true, purchasedAt: now - 1000 } }), "Android same token other owner");

  // 8: the previous behaviour (client-confirmed proof) is still honoured and is not required any more.
  assert.equal(getExpiredReassignmentProof({ userData: {}, platform: "ios", purchase: iosPurchase({ uidBound: false }), ownershipId: IOS_ID, ownerUid: "uid-a",
    ownerSnapshot: { exists: true, data: () => ({ ownerUid: "uid-a" }) }, ownerUserSnapshot: { exists: true, data: () => iosOwnerUser() } }), null);

  // Legacy (account-level) owner record, written before the per-OS format: same rule, same outcome.
  const legacyOwner = (overrides = {}) => ({ appStoreOriginalTransactionId: ORIGINAL, subscriptionPlatform: "ios", subscriptionStatus: "expired", subscriptionExpiryTime: iso(now - 2 * HOUR), ...overrides });
  db = iosDb(legacyOwner());
  await iosClaim(db, iosPurchase());
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-b", "iOS legacy-format expired owner record is accepted");
  db = iosDb(legacyOwner({ subscriptionStatus: "active", subscriptionExpiryTime: iso(now + HOUR) }));
  await rejectsAlreadyLinked(iosClaim(db, iosPurchase({ uidBound: false })), "iOS legacy active owner");
  db = iosDb(legacyOwner({ subscriptionPlatform: "android" }));
  await rejectsAlreadyLinked(iosClaim(db, iosPurchase({ uidBound: false })), "iOS legacy record of the other OS is no evidence");

  // ---------------- Diagnostics: every decision is traceable, specific, and free of secrets ----------------
  const recorder = () => {
    const records = [];
    return { records, info: (message, fields) => records.push({ level: "info", message, fields }), warn: (message, fields) => records.push({ level: "warn", message, fields }) };
  };
  const decisions = (rec) => rec.records.filter((r) => r.message === "subscription_ownership.reassignment_decision");
  const TRACE = "trace-1234";

  // allow (iOS)
  let rec = recorder();
  db = iosDb(iosOwnerUser());
  await claimOwnershipDocument(db, admin, { uid: "uid-b", ownershipId: IOS_ID, platform: "ios", ownershipFields: {}, log: rec, traceId: TRACE, verifiedPurchase: iosPurchase() });
  let [decision] = decisions(rec);
  assert.equal(decision.fields.decision, "allow");
  assert.equal(decision.fields.decisionCode, "ALLOW_SERVER_DERIVED_IOS_OWNER_RECORD");
  assert.equal(decision.fields.evidenceSource, "server_derived_ios_owner_record");
  assert.equal(decision.fields.billingTraceId, TRACE);
  assert.equal(decision.fields.platform, "ios");
  assert.equal(decision.fields.context, "existing_owner_conflict");
  assert.ok(decision.fields.purchaseStartedAt && decision.fields.ownerRecordedEndedAt, "purchase start and previous end are recorded");
  assert.ok(rec.records.some((r) => r.message === "Subscription ownership reassigned from inactive owner." && r.fields.evidenceSource === "server_derived_ios_owner_record"), "DB write result is logged");

  // retry by the new owner: no second reassignment decision, nothing rejected
  rec = recorder();
  await claimOwnershipDocument(db, admin, { uid: "uid-b", ownershipId: IOS_ID, platform: "ios", ownershipFields: {}, log: rec, traceId: TRACE, verifiedPurchase: iosPurchase() });
  assert.equal(decisions(rec).length, 0);
  assert.ok(rec.records.some((r) => r.message === "Subscription ownership reused."));

  // ---------------- "Latest holder wins": an ACTIVE contract moves to the requesting UID ----------------
  const OWNER_TAG = "11111111-2222-3333-4444-555555555555";
  const activeOwner = () => iosOwnerUser({ status: "active", expiryTime: iso(now + 24 * HOUR) });
  const taggedIosDb = () => makeDb({ users: { "uid-a": activeOwner(), "uid-b": {} },
    ownership: { [IOS_ID]: { ownerUid: "uid-a", platform: "ios", status: "active", appAccountToken: OWNER_TAG } } });
  // iOS: moving an ACTIVE contract between UIDs is NOT done by the shared claim any more (only by the dedicated
  // transferActiveContractOwnership, which needs the device's own StoreKit proof). Every variant is refused, nothing changes.
  const FOREIGN_TAG = "99999999-9999-9999-9999-999999999999";
  for (const purchase of [iosPurchase({ uidBound: true }), iosPurchase({ uidBound: false, accountTag: OWNER_TAG }), iosPurchase({ uidBound: false, accountTag: OWNER_TAG.toUpperCase() }),
    iosPurchase({ uidBound: false, accountTag: FOREIGN_TAG }), iosPurchase({ uidBound: false }), iosPurchase({ uidBound: true, active: false })]) {
    db = taggedIosDb();
    await rejectsAlreadyLinked(iosClaim(db, purchase), `iOS shared claim cannot move an active contract: ${JSON.stringify(purchase)}`);
    assert.equal(db.ownership[IOS_ID].ownerUid, "uid-a", "iOS: ownership unchanged");
    assert.equal(db.users["uid-a"].subscriptions.ios.status, "active", "iOS: previous owner keeps the contract");
    assert.equal(db.users["uid-a"].entitlementUsable === false, false);
  }
  // iOS: the same UID is unaffected (no transfer, no change of state).
  db = taggedIosDb();
  await iosClaim(db, iosPurchase({ uidBound: true }), "uid-a");
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-a", "same UID keeps its contract");
  assert.equal(db.users["uid-a"].subscriptions.ios.status, "active", "same UID stays active");
  // iOS: the users-collection scan refuses an owner-tag match too.
  const tScan = () => makeDb({ users: { "uid-a": activeOwner(), "uid-b": {} },
    ownership: { [IOS_ID]: { ownerUid: "uid-a", platform: "ios", status: "active", appAccountToken: OWNER_TAG } },
    usersQuery: { [`appStoreOriginalTransactionId|==|${ORIGINAL}`]: ["uid-a"] } });
  await rejectsAlreadyLinked(assertSubscriptionNotLinkedToOtherUser(tScan(), { ...scanArgs, verifiedPurchase: iosPurchase({ uidBound: false, accountTag: OWNER_TAG }) }), "transfer scan: owner tag alone");
  await rejectsAlreadyLinked(assertSubscriptionNotLinkedToOtherUser(tScan(), { ...scanArgs, verifiedPurchase: iosPurchase({ uidBound: false, accountTag: FOREIGN_TAG }) }), "transfer scan: foreign tag");
  // Android: a restore tagged with the previous owner's account id moves; any other tag is refused.
  const crypto = require("node:crypto");
  const tagOf = (uid) => crypto.createHash("sha256").update(`kamome-account:${uid}`).digest("hex");
  const sameTokenDb = () => makeDb({ users: { "uid-a": { ...androidOwnerUser({ status: "active", expiryTime: iso(now + 24 * HOUR), primaryPurchaseToken: NEW_TOKEN, activePurchaseTokens: [NEW_TOKEN] }), googlePlayPrimaryPurchaseToken: NEW_TOKEN }, "uid-b": {} },
    ownership: { [NEW_ID]: { ownerUid: "uid-a", platform: "android", status: "active" } } });
  const sameTokenClaim = (d, purchase) => claimOwnershipDocument(d, admin, { uid: "uid-b", ownershipId: NEW_ID, platform: "android", ownershipFields: {}, log, verifiedPurchase: purchase });
  db = sameTokenDb();
  await sameTokenClaim(db, { uidBound: false, active: true, purchasedAt: now - HOUR, accountTag: tagOf("uid-a") });
  assert.equal(db.ownership[NEW_ID].ownerUid, "uid-b", "Android transfer: ownership moves");
  assert.equal(db.users["uid-a"].subscriptions.android.status, "expired", "Android transfer: previous owner is stopped");
  for (const purchase of [{ uidBound: false, active: true, accountTag: tagOf("uid-x") }, { uidBound: false, active: true }, { uidBound: false, active: false, accountTag: tagOf("uid-a") }]) {
    db = sameTokenDb();
    await rejectsAlreadyLinked(sameTokenClaim(db, { purchasedAt: now - HOUR, ...purchase }), `Android transfer refused: ${JSON.stringify(purchase)}`);
    assert.equal(db.ownership[NEW_ID].ownerUid, "uid-a");
  }
  // The decision is logged with its own code and no identifiers.
  rec = recorder();
  await assert.rejects(() => claimOwnershipDocument(taggedIosDb(), admin, { uid: "uid-b", ownershipId: IOS_ID, platform: "ios", ownershipFields: {}, log: rec, traceId: TRACE, verifiedPurchase: iosPurchase({ uidBound: true }) }));
  assert.equal(decisions(rec)[0].fields.decisionCode, "REJECT_OWNER_STILL_USABLE", "iOS shared claim: refusal is logged with its code");
  assert.ok(!JSON.stringify(rec.records).includes(OWNER_TAG), "refusal log carries no account tag");

  // rejections carry a specific code
  const expectCode = async (build, code, label) => {
    const r = recorder();
    const d = build();
    await assert.rejects(() => claimOwnershipDocument(d.db, admin, { uid: "uid-b", ownershipId: d.ownershipId, platform: d.platform, linkedOwnershipId: d.linkedOwnershipId || "",
      ownershipFields: {}, log: r, traceId: TRACE, verifiedPurchase: d.purchase }));
    const [one] = decisions(r);
    assert.ok(one, `${label}: decision logged`);
    assert.equal(one.fields.decision, "reject", label);
    assert.equal(one.fields.decisionCode, code, `${label}: ${one.fields.decisionCode}`);
    assert.equal(one.level, "warn");
    assert.ok(r.records.some((x) => x.message === "subscription_ownership.claim_rejected" && x.fields.rejectReason), `${label}: rejection reason logged`);
    return r;
  };
  const ios = (ownerUser, purchase) => () => ({ db: iosDb(ownerUser), ownershipId: IOS_ID, platform: "ios", purchase });
  await expectCode(ios(iosOwnerUser({ status: "active", expiryTime: iso(now + 24 * HOUR) }), iosPurchase({ uidBound: false })), "REJECT_PURCHASE_NOT_BOUND_TO_UID", "iOS active owner, unrelated purchase");
  await expectCode(ios(iosOwnerUser(), iosPurchase({ uidBound: false })), "REJECT_PURCHASE_NOT_BOUND_TO_UID", "iOS not bound");
  await expectCode(ios(iosOwnerUser(), iosPurchase({ active: false })), "REJECT_PURCHASE_NOT_ACTIVE", "iOS not active");
  const android = (ownerUser, overrides = {}) => () => {
    const d = androidDb(ownerUser);
    return { db: d, ownershipId: NEW_ID, platform: "android", linkedOwnershipId: OLD_ID,
      purchase: { uidBound: true, active: true, purchasedAt: now - 5 * 60 * 1000, linkedState: "ended", linkedOwnershipId: OLD_ID, linkedExpiryMs: now - 2 * HOUR,
        linkedObservation: { ownershipId: OLD_ID, ownerUid: "uid-a", fingerprint: fingerprint(snapOf(d.ownership[OLD_ID])), ownerUserFingerprint: fingerprint(snapOf(d.users["uid-a"])) }, ...overrides } };
  };
  const snapOf = (data) => ({ exists: data != null, data: () => data });
  await expectCode(android(androidOwnerUser({ status: "active", expiryTime: iso(now + HOUR) }), { uidBound: false }), "REJECT_PURCHASE_NOT_BOUND_TO_UID", "Android active owner, unrelated purchase");

  // allow (Android) names Google as the evidence
  rec = recorder();
  const ad = android(androidOwnerUser())();
  await claimOwnershipDocument(ad.db, admin, { uid: "uid-b", ownershipId: NEW_ID, platform: "android", linkedOwnershipId: OLD_ID, ownershipFields: {}, log: rec, traceId: TRACE, verifiedPurchase: ad.purchase });
  [decision] = decisions(rec);
  assert.equal(decision.fields.decisionCode, "ALLOW_SERVER_DERIVED_GOOGLE_LINKED");
  assert.ok(decision.fields.googleLinkedEndedAt && decision.fields.purchaseStartedAt, "Android old end and purchase start are recorded");

  // no secrets: identifiers are masked, no full UID / token / e-mail anywhere in any recorded payload
  const everything = JSON.stringify(rec.records) + JSON.stringify(decisions(rec));
  for (const secret of ["uid-a", "uid-b", OLD_TOKEN, NEW_TOKEN, ORIGINAL, "@"]) {
    assert.ok(!everything.includes(secret), `payload leaks ${secret}`);
  }

  // a failing logger must not change the outcome (allow stays allow, reject stays reject with the same error)
  const broken = { info() { throw new Error("log sink down"); }, warn() { throw new Error("log sink down"); } };
  db = iosDb(iosOwnerUser());
  await claimOwnershipDocument(db, admin, { uid: "uid-b", ownershipId: IOS_ID, platform: "ios", ownershipFields: {}, log: broken, traceId: TRACE, verifiedPurchase: iosPurchase() });
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-b", "allow still succeeds with a broken logger");
  db = iosDb(iosOwnerUser({ status: "active", expiryTime: iso(now + HOUR) }));
  await assert.rejects(() => claimOwnershipDocument(db, admin, { uid: "uid-b", ownershipId: IOS_ID, platform: "ios", ownershipFields: {}, log: broken, traceId: TRACE, verifiedPurchase: iosPurchase({ uidBound: false }) }),
    (error) => error.details && error.details.code === SUBSCRIPTION_ALREADY_LINKED_CODE);
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-a");
  // a missing logger is fine too
  db = iosDb(iosOwnerUser());
  await claimOwnershipDocument(db, admin, { uid: "uid-b", ownershipId: IOS_ID, platform: "ios", ownershipFields: {}, verifiedPurchase: iosPurchase() });
  assert.equal(db.ownership[IOS_ID].ownerUid, "uid-b");

  // The server's ownership inspect (used at login) logs what it decided and why.
  const { createInspectSubscriptionSeriesOwnershipHandler } = require("./inspectSubscriptionSeriesOwnership");
  const inspectLog = (() => { const records = []; return { records, info: (m, f) => records.push({ level: "info", m, f }), warn: (m, f) => records.push({ level: "warn", m, f }), error() {} }; })();
  const runInspect = (dbForInspect, verifySeriesState) => createInspectSubscriptionSeriesOwnershipHandler({ admin: { getDb: () => dbForInspect }, logger: inspectLog, verifySeriesState })(
    { auth: { uid: LONG_UID }, data: { platform: "ios", originalTransactionId: ORIGINAL, billingTraceId: TRACE } });
  const LONG_UID = "firebase-uid-of-user-b-0123456789";
  let inspected = await runInspect(iosDb(iosOwnerUser({ status: "active", expiryTime: iso(now + HOUR) })), async () => "active");
  assert.equal(inspected.decision, "mismatch");
  let logged = inspectLog.records.find((r) => r.m === "subscription_ownership.inspect_result");
  assert.equal(logged.f.decision, "mismatch");
  assert.equal(logged.f.reason, "other_owner_active");
  assert.equal(logged.f.billingTraceId, TRACE);
  assert.ok(!JSON.stringify(logged).includes(LONG_UID) && !JSON.stringify(logged).includes(ORIGINAL), "inspect log carries no full identifiers");
  inspected = await runInspect(iosDb(iosOwnerUser()), async () => { throw new Error("store unreachable"); });
  assert.equal(inspected.decision, "ambiguous", "an unconfirmed Store state stops safely");
  assert.equal(inspectLog.records.filter((r) => r.m === "subscription_ownership.inspect_result").pop().f.reason, "other_owner_store_unconfirmed");
  await assert.rejects(() => runInspect({ collection() { throw new Error("db down"); } }, async () => "active"), (error) => error.code === "unavailable");
  assert.ok(inspectLog.records.some((r) => r.level === "warn" && r.m === "subscription_ownership.inspect_failed"), "communication failure is logged");

  // rejection logs never carry another user's full UID
  const { summarizeHttpsError } = require("./billingFinalTrace");
  const summary = summarizeHttpsError({ code: "failed-precondition", message: SUBSCRIPTION_ALREADY_LINKED_CODE, details: { code: SUBSCRIPTION_ALREADY_LINKED_CODE, ownerUid: "full-uid-of-another-user-123456" } });
  assert.equal(summary.details.ownerUid, undefined);
  assert.equal(summary.details.ownerUidTail, "123456");
  assert.equal(summary.details.code, SUBSCRIPTION_ALREADY_LINKED_CODE);

  console.log("expiredOwnershipServerDerived: iOS and Android C-plan safety checks PASS");
})().catch((error) => { console.error(error); process.exit(1); });
