/**
 * Case 9 fix: Apple renewal/expiry notifications that still carry the PREVIOUS owner's appAccountToken are applied to the
 * CURRENT owner only when a formal ownership transfer is proven from server-saved records; everything else stays deferred.
 */
const assert = require("node:assert/strict");
const {
  decideAppStoreNotificationApply,
  evaluateRecordedTransferProof,
  evaluateTransferProofFromDb,
  applyUserSubscriptionUpdate,
  applyUserSubscriptionUpdateWithTransferGuard,
  findUsersByAppAccountToken,
  resolveAppStoreNotificationUser,
} = require("./appStoreSubscriptionNotifications");
const { buildIosOwnershipId } = require("./subscriptionOwnership");

const ORIG = "2000001250349522";
const OID = buildIosOwnershipId(ORIG);
const T_X = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000a1"; // purchase-time token of the previous owner X
const T_Y = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000b2"; // current owner Y's own token
const T_Z = "aaaaaaaa-bbbb-4ccc-8ddd-0000000000c3";
const silentLog = { info() {}, warn() {}, error() {} };

const admin = {
  FieldValue: {
    serverTimestamp() { return "SERVER_TIMESTAMP"; },
    delete() { return { __type: "delete" }; },
  },
  Timestamp: {
    fromMillis(ms) {
      const date = new Date(ms);
      return { toDate: () => date, toMillis: () => ms, seconds: Math.floor(ms / 1000), nanoseconds: 0 };
    },
    fromDate(date) { return this.fromMillis(date.getTime()); },
  },
};

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

function applyMerge(target, data) {
  const next = { ...(target || {}) };
  for (const [key, value] of Object.entries(data || {})) {
    if (value && value.__type === "delete") { delete next[key]; continue; }
    const plain = value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && !value.__type;
    next[key] = plain ? applyMerge(next[key], value) : value;
  }
  return next;
}

// Minimal Firestore double: users / subscription_ownership, queries, transactions, and a hook to simulate concurrent changes.
function createDb(seed) {
  const store = { users: { ...(seed.users || {}) }, subscription_ownership: { ...(seed.ownership || {}) } };
  const db = {
    store,
    onTxRead: null, // (collection, id) => void, called before each transaction read
    collection(name) {
      const docs = store[name];
      if (!docs) throw new Error(`Unexpected collection ${name}`);
      return {
        doc(id) {
          const ref = {
            id,
            collection: name,
            async get() { return snap(docs[id], id); },
            async set(data) { docs[id] = applyMerge(docs[id], data); },
          };
          return ref;
        },
        where(field, op, value) {
          const hits = Object.entries(docs).filter(([, data]) => {
            if (op === "==") return String(data?.[field] || "") === String(value);
            if (op === "array-contains") return Array.isArray(data?.[field]) && data[field].includes(value);
            return false;
          });
          return {
            limit() {
              return {
                async get() {
                  return { size: hits.length, docs: hits.map(([id, data]) => ({ id, data: () => data, ref: { id } })) };
                },
              };
            },
          };
        },
      };
    },
    async runTransaction(callback) {
      const tx = {
        async get(ref) {
          if (db.onTxRead) db.onTxRead(ref.collection, ref.id);
          return snap(store[ref.collection][ref.id], ref.id);
        },
        set(ref, data, options) {
          const docs = store[ref.collection];
          docs[ref.id] = options && options.merge === false ? data : applyMerge(docs[ref.id], data);
        },
      };
      return callback(tx);
    },
  };
  return db;
}

function snap(data, id) {
  return { exists: data != null, id, data: () => data, get: (field) => (data ? data[field] : undefined) };
}

// State right after a formal X -> Y transfer of series ORIG (what ownershipTransferAtomic writes).
function transferredSeed() {
  return {
    ownership: {
      [OID]: { ownerUid: "Y", platform: "ios", status: "active", appAccountToken: T_X, appStoreOriginalTransactionId: ORIG, productId: "ohayo_kamome_monthly" },
    },
    users: {
      X: {
        appStoreAppAccountToken: T_X,
        subscriptionStatus: "expired",
        subscriptions: { ios: { status: "expired", source: "ownership_transferred", transferredAt: "TS", transactionIds: [] } },
      },
      Y: {
        appStoreAppAccountToken: T_Y,
        appStoreOriginalTransactionId: ORIG,
        subscriptionStatus: "active",
        boundSubscriptionSeries: { ios: { ownershipId: OID, originalTransactionId: ORIG } },
        subscriptions: { ios: { status: "active", source: "app_store_ownership_transfer", originalTransactionId: ORIG } },
      },
    },
  };
}

function proofArgs(overrides = {}) {
  return { appAccountToken: T_X, originalTransactionId: ORIG, currentOwnerUid: "Y", tokenOwnerUid: "X", ...overrides };
}

function derived(status, extra = {}) {
  return {
    status,
    originalTransactionId: ORIG,
    latestTransactionId: "2000001250999999",
    environment: "Sandbox",
    validationCode: status === "active" ? "ACTIVE" : "SUBSCRIPTION_EXPIRED",
    expiresDate: Date.now() + (status === "active" ? 3 * 60 * 1000 : -60 * 1000),
    storeObservedAtMs: Date.now(),
    ...extra,
  };
}

async function proofOf(db, overrides = {}) {
  return evaluateTransferProofFromDb(db, db, proofArgs(overrides));
}

async function runTests() {
  // ---- 1. proof matrix (pure) ------------------------------------------------------------------------------------
  const seed = transferredSeed();
  const base = () => ({
    ...proofArgs(),
    ownershipRecord: clone(seed.ownership[OID]),
    ownerUser: clone(seed.users.Y),
    tokenOwnerUser: clone(seed.users.X),
  });
  assert.equal(evaluateRecordedTransferProof(base()).ok, true);

  const mutate = (fn) => { const a = base(); fn(a); return evaluateRecordedTransferProof(a); };
  const expectReject = (fn, reason) => {
    const result = mutate(fn);
    assert.equal(result.ok, false, `expected reject: ${reason}`);
    assert.equal(result.reason, reason);
  };
  expectReject((a) => { a.appAccountToken = ""; }, "notification_token_missing");
  expectReject((a) => { a.tokenOwnerUid = "Y"; }, "same_uid");
  expectReject((a) => { a.currentOwnerUid = ""; }, "identity_missing");
  expectReject((a) => { a.ownershipRecord = null; }, "ownership_record_missing");
  expectReject((a) => { a.ownershipRecord.ownerUid = "C"; }, "ownership_owner_mismatch");
  expectReject((a) => { a.ownershipRecord.status = "suspended"; }, "ownership_status_untrusted");
  expectReject((a) => { a.ownershipRecord.appStoreOriginalTransactionId = "2000009999999999"; }, "series_mismatch");
  expectReject((a) => { a.ownershipRecord.appAccountToken = T_Z; }, "recorded_token_mismatch");
  expectReject((a) => { delete a.ownershipRecord.appAccountToken; }, "recorded_token_mismatch");
  expectReject((a) => { a.appAccountToken = T_Z; }, "recorded_token_mismatch");
  expectReject((a) => { a.ownerUser.boundSubscriptionSeries = {}; }, "owner_not_bound_to_series");
  expectReject((a) => { a.ownerUser.boundSubscriptionSeries.ios.ownershipId = buildIosOwnershipId("2000007777777777"); }, "owner_not_bound_to_series");
  expectReject((a) => { a.tokenOwnerUser = null; }, "token_owner_record_missing");
  expectReject((a) => { a.tokenOwnerUser.appStoreAppAccountToken = T_Z; }, "token_owner_record_mismatch");
  expectReject((a) => { a.tokenOwnerUser.subscriptions.ios.source = "verified_expired_owner_reassigned"; }, "transfer_record_missing");
  expectReject((a) => { a.tokenOwnerUser.subscriptions.ios.source = "app_store_notification_v2"; }, "transfer_record_missing");
  expectReject((a) => { delete a.tokenOwnerUser.subscriptions.ios.transferredAt; }, "transfer_time_missing");
  expectReject((a) => { a.tokenOwnerUser.subscriptions.ios.originalTransactionId = ORIG; }, "previous_owner_still_holds_series");
  expectReject((a) => { a.tokenOwnerUser.appStoreOriginalTransactionId = ORIG; }, "previous_owner_still_holds_series");

  // ---- 2. decision function --------------------------------------------------------------------------------------
  // (1) normal renewal: token owner == current owner -> unchanged behaviour, no proof needed.
  const normal = decideAppStoreNotificationApply({ originalOwnerUid: "Y", appAccountToken: T_Y, tokenOwnerUids: ["Y"] });
  assert.equal(normal.action, "apply");
  assert.equal(normal.reason, "token_matches_original_owner");
  // legacy / unlinked behaviour unchanged
  assert.equal(decideAppStoreNotificationApply({ originalOwnerUid: "Y", appAccountToken: "", tokenOwnerUids: [] }).reason, "legacy_missing_token");
  assert.equal(decideAppStoreNotificationApply({ originalOwnerUid: "Y", appAccountToken: T_X, tokenOwnerUids: [] }).reason, "legacy_token_unlinked");
  // mismatch without / with unproven transfer -> still deferred
  for (const proof of [undefined, null, { ok: false, reason: "transfer_record_missing" }, { ok: "true" }, {}]) {
    const d = decideAppStoreNotificationApply({ originalOwnerUid: "Y", appAccountToken: T_X, tokenOwnerUids: ["X"], transferProof: proof });
    assert.equal(d.action, "defer");
    assert.equal(d.reason, "deferred_token_mismatch");
  }
  // proven transfer -> apply (and only for the single-token-owner case)
  const proven = decideAppStoreNotificationApply({ originalOwnerUid: "Y", appAccountToken: T_X, tokenOwnerUids: ["X"], transferProof: { ok: true, reason: "recorded_ownership_transfer" } });
  assert.equal(proven.action, "apply");
  assert.equal(proven.reason, "token_matches_recorded_ownership_transfer");
  assert.equal(proven.tokenOwnerUid, "X");
  const ambiguous = decideAppStoreNotificationApply({ originalOwnerUid: "Y", appAccountToken: T_X, tokenOwnerUids: ["X", "W"], transferProof: { ok: true } });
  assert.equal(ambiguous.action, "defer");
  assert.equal(ambiguous.reason, "deferred_token_ambiguous");

  // ---- 3. case 9 end to end (renewal + expiry) -------------------------------------------------------------------
  {
    const db = createDb(transferredSeed());
    const xBefore = clone(db.store.users.X);
    const lookup = await resolveAppStoreNotificationUser(db, ORIG, "2000001250999999");
    assert.equal(lookup.uid, "Y");
    assert.equal(lookup.resolution, "ownership_document");
    const tokenLookup = await findUsersByAppAccountToken(db, T_X);
    assert.deepEqual(tokenLookup.uids, ["X"]);

    // old behaviour: deferred
    assert.equal(decideAppStoreNotificationApply({ originalOwnerUid: lookup.uid, appAccountToken: T_X, tokenOwnerUids: tokenLookup.uids }).action, "defer");
    // new behaviour: proof -> apply to Y
    const proof = await proofOf(db);
    assert.equal(proof.ok, true);
    const decision = decideAppStoreNotificationApply({ originalOwnerUid: lookup.uid, appAccountToken: T_X, tokenOwnerUids: tokenLookup.uids, transferProof: proof });
    assert.equal(decision.action, "apply");

    // DID_RENEW -> Y
    await applyUserSubscriptionUpdateWithTransferGuard(db, admin, "Y", derived("active"), "app_store_notification_v2", { logger: silentLog, notificationUUID: "n1" }, proofArgs());
    assert.equal(db.store.users.Y.subscriptionStatus, "active");
    assert.equal(db.store.users.Y.subscriptions.ios.status, "active");
    assert.equal(db.store.users.Y.subscriptions.ios.source, "app_store_notification_v2");
    // the previous owner X is never touched (old UID protection)
    assert.deepEqual(db.store.users.X, xBefore);

    // EXPIRED -> Y (still after the transfer); X still untouched
    await applyUserSubscriptionUpdateWithTransferGuard(db, admin, "Y", derived("expired"), "app_store_notification_v2", { logger: silentLog, notificationUUID: "n2" }, proofArgs());
    assert.equal(db.store.users.Y.subscriptionStatus, "expired");
    assert.equal(db.store.users.Y.subscriptions.ios.status, "expired");
    assert.deepEqual(db.store.users.X, xBefore);
  }

  // ---- 4. no formal transfer record -> deferred; guard refuses to write ------------------------------------------
  {
    const noRecord = transferredSeed();
    noRecord.users.X.subscriptions.ios.source = "verified_expired_owner_reassigned"; // case-10 style reassignment, not a transfer
    const db = createDb(noRecord);
    const proof = await proofOf(db);
    assert.equal(proof.ok, false);
    assert.equal(decideAppStoreNotificationApply({ originalOwnerUid: "Y", appAccountToken: T_X, tokenOwnerUids: ["X"], transferProof: proof }).action, "defer");
    const yBefore = clone(db.store.users.Y);
    await assert.rejects(
      () => applyUserSubscriptionUpdateWithTransferGuard(db, admin, "Y", derived("active"), "app_store_notification_v2", { logger: silentLog }, proofArgs()),
      (error) => error.code === "TRANSFER_PROOF_CHANGED"
    );
    assert.deepEqual(db.store.users.Y, yBefore);

    // token recorded for a different series / a token nobody recorded -> deferred
    const wrongToken = createDb(transferredSeed());
    assert.equal((await proofOf(wrongToken, { appAccountToken: T_Z })).ok, false);
    const wrongSeries = createDb(transferredSeed());
    assert.equal((await proofOf(wrongSeries, { originalTransactionId: "2000008888888888" })).ok, false);
    // ownership record without a recorded token (legacy) -> deferred
    const legacy = transferredSeed();
    delete legacy.ownership[OID].appAccountToken;
    assert.equal((await proofOf(createDb(legacy))).ok, false);
  }

  // ---- 5. B -> C chain: only the CURRENT owner may receive updates -----------------------------------------------
  {
    const chain = transferredSeed();
    chain.ownership[OID].ownerUid = "C";
    chain.users.Y.boundSubscriptionSeries = {}; // Y (B) transferred away
    chain.users.Y.subscriptions.ios = { status: "expired", source: "ownership_transferred", transferredAt: "TS2", transactionIds: [] };
    chain.users.C = {
      appStoreAppAccountToken: T_Z,
      boundSubscriptionSeries: { ios: { ownershipId: OID, originalTransactionId: ORIG } },
      subscriptions: { ios: { status: "active", source: "app_store_ownership_transfer", originalTransactionId: ORIG } },
    };
    const db = createDb(chain);
    const before = { X: clone(db.store.users.X), Y: clone(db.store.users.Y) };
    // current owner C: proven
    assert.equal((await proofOf(db, { currentOwnerUid: "C" })).ok, true);
    await applyUserSubscriptionUpdateWithTransferGuard(db, admin, "C", derived("active"), "app_store_notification_v2", { logger: silentLog }, proofArgs({ currentOwnerUid: "C" }));
    assert.equal(db.store.users.C.subscriptionStatus, "active");
    assert.deepEqual(db.store.users.X, before.X);
    assert.deepEqual(db.store.users.Y, before.Y);
    // stale resolution naming the intermediate owner B (Y) is refused (ownership record now says C)
    const stale = await proofOf(db, { currentOwnerUid: "Y" });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "ownership_owner_mismatch");
    await assert.rejects(
      () => applyUserSubscriptionUpdateWithTransferGuard(db, admin, "Y", derived("active"), "app_store_notification_v2", { logger: silentLog }, proofArgs({ currentOwnerUid: "Y" })),
      (error) => error.code === "TRANSFER_PROOF_CHANGED"
    );
    assert.deepEqual(db.store.users.Y, before.Y);
    // writing to anyone other than the proven current owner is refused up front
    await assert.rejects(
      () => applyUserSubscriptionUpdateWithTransferGuard(db, admin, "X", derived("active"), "app_store_notification_v2", { logger: silentLog }, proofArgs({ currentOwnerUid: "C" })),
      (error) => error.code === "TRANSFER_PROOF_CHANGED" && error.reason === "target_is_not_current_owner"
    );
    assert.deepEqual(db.store.users.X, before.X);
  }

  // ---- 6. ownership changes while the notification is being processed --------------------------------------------
  {
    // (a) owner changes to C between the proof and the write
    const db = createDb(transferredSeed());
    const initial = await proofOf(db);
    assert.equal(initial.ok, true);
    db.store.users.C = { appStoreAppAccountToken: T_Z, boundSubscriptionSeries: { ios: { ownershipId: OID } } };
    db.onTxRead = (collection, id) => {
      if (collection === "subscription_ownership" && id === OID) {
        db.store.subscription_ownership[OID].ownerUid = "C";
        db.onTxRead = null;
      }
    };
    const yBefore = clone(db.store.users.Y);
    await assert.rejects(
      () => applyUserSubscriptionUpdateWithTransferGuard(db, admin, "Y", derived("active"), "app_store_notification_v2", { logger: silentLog }, proofArgs()),
      (error) => error.code === "TRANSFER_PROOF_CHANGED" && error.reason === "ownership_owner_mismatch"
    );
    assert.deepEqual(db.store.users.Y, yBefore, "stale owner Y must not be written");

    // (b) the previous owner's transfer record disappears (X re-bought / record overwritten) -> deferred, nothing written
    const db2 = createDb(transferredSeed());
    db2.onTxRead = (collection, id) => {
      if (collection === "users" && id === "X") {
        db2.store.users.X.subscriptions.ios.source = "app_store_notification_v2";
        db2.onTxRead = null;
      }
    };
    const y2Before = clone(db2.store.users.Y);
    await assert.rejects(
      () => applyUserSubscriptionUpdateWithTransferGuard(db2, admin, "Y", derived("active"), "app_store_notification_v2", { logger: silentLog }, proofArgs()),
      (error) => error.code === "TRANSFER_PROOF_CHANGED" && error.reason === "transfer_record_missing"
    );
    assert.deepEqual(db2.store.users.Y, y2Before);
  }

  // ---- 7. case 10 (new purchase by the new UID) is not changed ---------------------------------------------------
  {
    // after the reassignment: Y owns the series, the purchase carried Y's own token -> normal match, no proof involved
    const afterReassign = {
      ownership: { [OID]: { ownerUid: "Y", platform: "ios", status: "active", appAccountToken: T_Y, appStoreOriginalTransactionId: ORIG } },
      users: { X: { appStoreAppAccountToken: T_X, subscriptions: { ios: { status: "expired", source: "verified_expired_owner_reassigned" } } }, Y: { appStoreAppAccountToken: T_Y } },
    };
    const db = createDb(afterReassign);
    const lookup = await resolveAppStoreNotificationUser(db, ORIG, "2000001250999999");
    const tokenLookup = await findUsersByAppAccountToken(db, T_Y);
    const decision = decideAppStoreNotificationApply({ originalOwnerUid: lookup.uid, appAccountToken: T_Y, tokenOwnerUids: tokenLookup.uids });
    assert.equal(decision.action, "apply");
    assert.equal(decision.reason, "token_matches_original_owner");

    // the 1-second race right after the purchase: record still names X, notification already carries Y's token -> still deferred
    const racing = {
      ownership: { [OID]: { ownerUid: "X", platform: "ios", status: "active", appAccountToken: T_X, appStoreOriginalTransactionId: ORIG } },
      users: { X: { appStoreAppAccountToken: T_X, boundSubscriptionSeries: { ios: { ownershipId: OID } } }, Y: { appStoreAppAccountToken: T_Y } },
    };
    const dbRace = createDb(racing);
    const proof = await evaluateTransferProofFromDb(dbRace, dbRace, { appAccountToken: T_Y, originalTransactionId: ORIG, currentOwnerUid: "X", tokenOwnerUid: "Y" });
    assert.equal(proof.ok, false);
    assert.equal(decideAppStoreNotificationApply({ originalOwnerUid: "X", appAccountToken: T_Y, tokenOwnerUids: ["Y"], transferProof: proof }).action, "defer");
  }

  // ---- 8. plain (unguarded) apply is unchanged -------------------------------------------------------------------
  {
    const db = createDb({ users: { Y: { appStoreAppAccountToken: T_Y, subscriptionStatus: "expired" } } });
    await applyUserSubscriptionUpdate(db, admin, "Y", derived("active"), "app_store_notification_v2", { logger: silentLog, notificationUUID: "n9" });
    assert.equal(db.store.users.Y.subscriptionStatus, "active");
  }

  console.log("appStoreTransferProof checks passed");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
