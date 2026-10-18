"use strict";
// Case 9: atomic ownership transfer on iPhone (same Apple Account, UID X -> UID Y, contract Active).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  createTransferActiveContractOwnershipHandler,
  createTransferActiveContractOwnershipIosHandler,
  createTransferActiveContractOwnershipDispatcher,
  OWNERSHIP_TRANSFER_CODES,
} = require("./ownershipTransferAtomic");
const { buildIosOwnershipId, SUBSCRIPTION_ALREADY_LINKED_CODE } = require("./subscriptionOwnership");
const { evaluatePlatformEntitlement } = require("./platformEntitlement");
const { APP_STORE_BUNDLE_ID, APP_STORE_PRODUCT_ID } = require("./appStoreServerCommon");
const { ANDROID_FIREBASE_APP_ID, IOS_FIREBASE_APP_ID } = require("./appCheckPlatform");
const { makeDb, adminFor, snapshotOf } = require("./ownershipTransferTestKit");

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const ORIG = "2000001194540581";
const TX = "2000001194999999";
const OWN_ID = buildIosOwnershipId(ORIG);
const X = "user-x-abcdefghij0123456789";
const Y = "user-y-abcdefghij0123456789";
const THIRD = "user-third-abcdefghij0123456789";
const DEVICE_B = "11111111-1111-4111-8111-111111111111";
const DEVICE_C = "22222222-2222-4222-8222-222222222222";
const DEVICE_D = "33333333-3333-4333-8333-333333333333";
const TAG_X = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAG_Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TAG_THIRD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const iso = (ms) => new Date(ms).toISOString();

// ---- Apple fixtures (shape of preChatBillingConfirmation.verifyAppleSeries entries) ----
const entry = (overrides = {}, txOverrides = {}) => ({
  state: "active", appleStatus: 1, renewal: null, originalTransactionId: ORIG, expiryMs: NOW + 20 * 24 * HOUR,
  transaction: { bundleId: APP_STORE_BUNDLE_ID, productId: APP_STORE_PRODUCT_ID, originalTransactionId: ORIG, transactionId: TX,
    appAccountToken: TAG_X, inAppOwnershipType: "PURCHASED", purchaseDate: NOW - 10 * 24 * HOUR, expiresDate: NOW + 20 * 24 * HOUR, environment: "Production", ...txOverrides },
  ...overrides,
});
// stand-in for the iOS verification handler's own builder (same shape)
const buildActiveUpdate = (admin) => ({ derived, environment, transactionInfo, lookupTransactionId }) => ({
  _storeDeadlines: { expirySource: "normal", normalExpiryTime: admin.Timestamp.fromMillis(derived.expiresDate), graceExpiryTime: null,
    storeObservedAtMs: derived.storeObservedAtMs || 0, storeTransactionTimeMs: Number(transactionInfo.purchaseDate || 0) },
  subscriptionStatus: "active", subscriptionProductId: APP_STORE_PRODUCT_ID, subscriptionExpiryTime: admin.Timestamp.fromMillis(derived.expiresDate),
  activePurchaseTokens: [derived.latestTransactionId || transactionInfo.transactionId || lookupTransactionId],
  lastSubscriptionSource: "app_store_server_api", subscriptionPlatform: "ios", appStoreEnvironment: derived.environment || environment || "",
  appStoreTransactionId: derived.latestTransactionId || transactionInfo.transactionId, appStoreOriginalTransactionId: derived.originalTransactionId || "",
  appStoreValidationCode: "ACTIVE", appStoreVerifiedMetadata: { bundleId: APP_STORE_BUNDLE_ID, productId: APP_STORE_PRODUCT_ID,
    appAccountToken: transactionInfo.appAccountToken || "", verificationSource: "app_store_signed_status" },
});
const xUser = (overrides = {}) => ({
  subscriptions: { ios: { status: "active", expiryTime: iso(NOW + 20 * 24 * HOUR), originalTransactionId: ORIG, transactionId: TX, transactionIds: [TX], productId: APP_STORE_PRODUCT_ID } },
  subscriptionStatus: "active", subscriptionPlatform: "ios", subscriptionExpiryTime: iso(NOW + 20 * 24 * HOUR),
  appStoreOriginalTransactionId: ORIG, appStoreTransactionId: TX, activePurchaseTokens: [TX], appStoreAppAccountToken: TAG_X,
  entitlementUsable: true, entitlementSource: "ios", entitlementExpiryTime: iso(NOW + 20 * 24 * HOUR), activeDeviceId: DEVICE_C, ...overrides,
});
const baseDocs = (extra = {}) => {
  const docs = {
  [`users/${X}`]: xUser(),
  [`users/${Y}`]: { appStoreAppAccountToken: TAG_Y },
  [`subscription_ownership/${OWN_ID}`]: { ownerUid: X, platform: "ios", status: "active", appAccountToken: TAG_X, appStoreOriginalTransactionId: ORIG },
  ...extra,
};
  // Registered devices in these existing regression cases are verified on this OS.
  for (const [path, user] of Object.entries(docs)) {
    if (/^users\/[^/]+$/.test(path) && user?.activeDeviceId) {
      docs[`${path}/devices/${user.activeDeviceId}`] = {platform: "ios", platformAppCheckVerified: true, firstUsedAt: {__type:"existing"}};
    }
  }
  return docs;
};
const request = (data = {}, uid = Y) => ({
  auth: { uid }, app: { appId: IOS_FIREBASE_APP_ID },
  data: { platform: "ios", deviceId: DEVICE_B, originalTransactionId: ORIG, productId: APP_STORE_PRODUCT_ID, appAccountToken: TAG_X, ...data },
});
const quiet = { info() {}, warn() {}, error() {} };
const handlerFor = (db, entries = [entry()], extra = {}) => {
  const admin = adminFor(db);
  return createTransferActiveContractOwnershipIosHandler({ admin, logger: quiet, nowMs: () => NOW,
    verifyApple: async () => entries, buildActiveUpdate: buildActiveUpdate(admin), ...extra });
};
const rejects = async (promise, code, label) => {
  await assert.rejects(promise, (error) => {
    const got = (error && error.details && error.details.code) || (error && error.message);
    assert.equal(got, code, `${label}: expected ${code}, got ${got}`);
    return true;
  }, label);
};
const ownerOf = (db) => db.docs.get(`subscription_ownership/${OWN_ID}`).ownerUid;
const usable = (db, uid) => evaluatePlatformEntitlement(db.docs.get(`users/${uid}`), "ios", new Date(NOW)).usable;

(async () => {
  // ① valid Active contract (the owner's own tag, restored on Y's phone) -> X to Y.  ② B usable without a purchase.  ③ X cannot use it.
  let db = makeDb(baseDocs());
  let result = await handlerFor(db)(request());
  assert.deepEqual(result, { success: true, transferred: true, deviceRegistered: true, replacedPreviousDevice: false });
  assert.equal(ownerOf(db), Y, "① ownership moves X -> Y");
  const y = db.docs.get(`users/${Y}`);
  assert.equal(y.subscriptions.ios.status, "active", "② Y holds an Active iOS contract record");
  assert.equal(y.subscriptions.ios.originalTransactionId, ORIG);
  assert.equal(y.entitlementUsable, true, "② Y is entitled without buying");
  assert.equal(usable(db, Y), true, "② server-side entitlement check passes for Y");
  assert.equal(y.activeDeviceId, DEVICE_B, "② B is registered as Y's device");
  assert.equal(y.boundSubscriptionSeries.ios.ownershipId, OWN_ID);
  assert.equal(y.boundSubscriptionSeries.ios.originalTransactionId, ORIG);
  assert.equal(y.fcmToken, undefined, "FCM token is never written by the transfer");
  assert.equal(db.docs.get(`subscription_ownership/${OWN_ID}`).appAccountToken, TAG_X, "ownership record keeps the series tag");
  const x = db.docs.get(`users/${X}`);
  assert.equal(x.subscriptions.ios.status, "expired", "③ X marked");
  assert.equal(x.subscriptions.ios.source, "ownership_transferred");
  assert.ok(x.subscriptions.ios.transferredAt);
  assert.equal(usable(db, X), false, "③ X can no longer use the contract");
  assert.equal(x.entitlementUsable, false);
  assert.equal(x.appStoreOriginalTransactionId, undefined, "③ X keeps no pointer to the moved series");
  assert.equal(x.subscriptions.ios.originalTransactionId, undefined);
  assert.equal(x.activeDeviceId, DEVICE_C, "X's own device registration is untouched");
  // case differences in the tag do not matter
  db = makeDb(baseDocs());
  await handlerFor(db, [entry({}, { appAccountToken: TAG_X.toUpperCase() })])(request({ appAccountToken: TAG_X }));
  assert.equal(ownerOf(db), Y, "① upper/lower case of the tag is irrelevant");

  // ④ invalid / insufficient proof: nothing changes.
  const refusals = [
    ["Apple says expired", [entry({ state: "ended", appleStatus: 2, expiryMs: NOW - HOUR }, { expiresDate: NOW - HOUR })], OWNERSHIP_TRANSFER_CODES.notActive],
    ["Apple says billing retry (blocked)", [entry({ state: "blocked", appleStatus: 3 })], OWNERSHIP_TRANSFER_CODES.notActive],
    ["period already ended", [entry({}, { expiresDate: NOW - HOUR })], OWNERSHIP_TRANSFER_CODES.notActive],
    ["revoked", [entry({}, { revocationDate: NOW - HOUR })], OWNERSHIP_TRANSFER_CODES.notActive],
    ["other product", [entry({}, { productId: "other" })], OWNERSHIP_TRANSFER_CODES.notActive],
    ["answer for another series", [entry({ originalTransactionId: "999" }, { originalTransactionId: "999" })], OWNERSHIP_TRANSFER_CODES.seriesMismatch],
    ["Apple tag differs from the device's tag", [entry({}, { appAccountToken: TAG_THIRD })], OWNERSHIP_TRANSFER_CODES.proofMismatch],
    ["Apple has no tag", [entry({}, { appAccountToken: "" })], OWNERSHIP_TRANSFER_CODES.proofMismatch],
    ["Apple has no tag (field absent)", [entry({}, { appAccountToken: undefined })], OWNERSHIP_TRANSFER_CODES.proofMismatch],
    ["family shared", [entry({}, { inAppOwnershipType: "FAMILY_SHARED" })], OWNERSHIP_TRANSFER_CODES.notPurchased],
    ["ownership type unknown", [entry({}, { inAppOwnershipType: undefined })], OWNERSHIP_TRANSFER_CODES.notPurchased],
  ];
  for (const [label, entries, code] of refusals) {
    db = makeDb(baseDocs());
    const before = snapshotOf(db);
    await rejects(handlerFor(db, entries)(request()), code, label);
    assert.equal(snapshotOf(db), before, `④ nothing changed: ${label}`);
  }
  let before;
  // ⑫ proof from the device: a transaction number alone, or only the requester's own tag, never moves the contract.
  const proofRefusals = [
    ["transaction number only (no device tag)", { appAccountToken: undefined }, [entry()], OWNERSHIP_TRANSFER_CODES.proofMissing],
    ["empty device tag", { appAccountToken: "  " }, [entry()], OWNERSHIP_TRANSFER_CODES.proofMissing],
    ["guessed device tag", { appAccountToken: TAG_THIRD }, [entry()], OWNERSHIP_TRANSFER_CODES.proofMismatch],
    ["requester's own tag only (device and Apple agree on Y's tag)", { appAccountToken: TAG_Y }, [entry({}, { appAccountToken: TAG_Y })], SUBSCRIPTION_ALREADY_LINKED_CODE],
    ["three-way match but not the owner's tag", { appAccountToken: TAG_THIRD }, [entry({}, { appAccountToken: TAG_THIRD })], SUBSCRIPTION_ALREADY_LINKED_CODE],
  ];
  for (const [label, data, entries, code] of proofRefusals) {
    db = makeDb(baseDocs());
    before = snapshotOf(db);
    await rejects(handlerFor(db, entries)(request(data)), code, label);
    assert.equal(snapshotOf(db), before, `⑫ nothing changed: ${label}`);
    assert.equal(usable(db, X), true, `⑫ X keeps the contract: ${label}`);
  }
  // owner record without any tag: refused (the owner user's own tag, when present, is the fallback)
  db = makeDb(baseDocs({ [`subscription_ownership/${OWN_ID}`]: { ownerUid: X, platform: "ios", status: "active" }, [`users/${X}`]: xUser({ appStoreAppAccountToken: undefined }) }));
  await rejects(handlerFor(db)(request()), SUBSCRIPTION_ALREADY_LINKED_CODE, "owner without any recorded tag");
  db = makeDb(baseDocs({ [`subscription_ownership/${OWN_ID}`]: { ownerUid: X, platform: "ios", status: "active" } }));
  await handlerFor(db)(request());
  assert.equal(ownerOf(db), Y, "owner record without tag falls back to the owner user's tag");

  // ⑬ failure limiter (per UID): 5 refusals lock; lock lifts by itself; success clears; other UIDs unaffected.
  let clock = NOW;
  const limited = (db2) => handlerFor(db2, [entry()], { nowMs: () => clock });
  db = makeDb(baseDocs());
  for (let i = 0; i < 5; i += 1) await rejects(limited(db)(request({ appAccountToken: TAG_THIRD })), OWNERSHIP_TRANSFER_CODES.proofMismatch, `⑬ refusal ${i + 1}`);
  await rejects(limited(db)(request()), OWNERSHIP_TRANSFER_CODES.rateLimited, "⑬ even the right request is paused while locked");
  assert.equal(ownerOf(db), X, "⑬ nothing moved while locked");
  clock = NOW + 16 * 60 * 1000;
  await limited(db)(request());
  assert.equal(ownerOf(db), Y, "⑬ the lock lifts by itself and the legitimate request succeeds");
  assert.equal(db.docs.has(`ownership_transfer_failures/${Y}`), false, "⑬ success clears the counter");
  clock = NOW;
  db = makeDb(baseDocs());
  for (let i = 0; i < 4; i += 1) await rejects(limited(db)(request({ appAccountToken: TAG_THIRD })), OWNERSHIP_TRANSFER_CODES.proofMismatch, "⑬ below the limit");
  await limited(db)(request());
  assert.equal(ownerOf(db), Y, "⑬ 4 refusals do not lock a legitimate user");
  db = makeDb(baseDocs());
  for (let i = 0; i < 5; i += 1) await rejects(limited(db)(request({ appAccountToken: TAG_THIRD })), OWNERSHIP_TRANSFER_CODES.proofMismatch, "⑬ lock Y");
  await rejects(limited(db)(request({ appAccountToken: TAG_THIRD }, THIRD)), OWNERSHIP_TRANSFER_CODES.proofMismatch, "⑬ another UID is not locked (only refused on its merits)");
  clock = NOW + 16 * 60 * 1000;
  db = makeDb(baseDocs());
  for (let i = 0; i < 3; i += 1) await rejects(limited(db)(request({ appAccountToken: TAG_THIRD })), OWNERSHIP_TRANSFER_CODES.proofMismatch, "window");
  clock = NOW + 40 * 60 * 1000;
  for (let i = 0; i < 3; i += 1) await rejects(limited(db)(request({ appAccountToken: TAG_THIRD })), OWNERSHIP_TRANSFER_CODES.proofMismatch, "⑬ old refusals expire from the window");
  clock = NOW;
  // non-refusal errors (Apple down, device consent, Y has another contract) do not count
  db = makeDb(baseDocs());
  for (let i = 0; i < 6; i += 1) await assert.rejects(handlerFor(db, [], { verifyApple: async () => { throw new Error("apple down"); } })(request()));
  assert.equal(db.docs.has(`ownership_transfer_failures/${Y}`), false, "⑬ outages are not counted as refusals");
  await handlerFor(db)(request());
  assert.equal(ownerOf(db), Y);
  // a failing limiter store never blocks a legitimate transfer
  db = makeDb(baseDocs(), { failSetPath: `ownership_transfer_failures/${Y}` });
  await assert.rejects(handlerFor(db, [entry()])(request({ appAccountToken: TAG_THIRD })));
  await handlerFor(db)(request());
  assert.equal(ownerOf(db), Y, "⑬ limiter bookkeeping failure does not affect the contract path");

  for (const [label, verifyApple] of [["Apple API failure", async () => { throw new Error("apple down"); }], ["no verified product", async () => []], ["garbage answer", async () => null]]) {
    db = makeDb(baseDocs());
    before = snapshotOf(db);
    await assert.rejects(handlerFor(db, [], { verifyApple })(request()), undefined, label);
    assert.equal(snapshotOf(db), before, `④ nothing changed: ${label}`);
  }
  db = makeDb({ [`users/${X}`]: xUser(), [`users/${Y}`]: {} });
  before = snapshotOf(db);
  await rejects(handlerFor(db)(request()), OWNERSHIP_TRANSFER_CODES.notApplicable, "no ownership record");
  assert.equal(snapshotOf(db), before);
  db = makeDb(baseDocs({ [`users/${Y}`]: { appStoreAppAccountToken: TAG_Y, subscriptions: { ios: { status: "active", expiryTime: iso(NOW + HOUR), originalTransactionId: "other-series" } } } }));
  before = snapshotOf(db);
  await rejects(handlerFor(db)(request()), SUBSCRIPTION_ALREADY_LINKED_CODE, "Y has another contract");
  assert.equal(snapshotOf(db), before);
  for (const [label, data] of [["bad device id", { deviceId: "nope" }], ["no original id", { originalTransactionId: "" }], ["wrong product", { productId: "x" }]]) {
    db = makeDb(baseDocs());
    before = snapshotOf(db);
    await assert.rejects(handlerFor(db)(request(data)), undefined, label);
    assert.equal(snapshotOf(db), before, `④ nothing changed: ${label}`);
  }
  db = makeDb(baseDocs());
  await assert.rejects(handlerFor(db)({ ...request(), app: { appId: ANDROID_FIREBASE_APP_ID } }), undefined, "Android app id cannot use the iOS path");
  await assert.rejects(handlerFor(db)({ ...request(), auth: null }));
  assert.equal(snapshotOf(db), snapshotOf(makeDb(baseDocs())));

  // ⑤ a failure inside the transaction changes NONE of the items.
  for (const [label, opts] of [
    ["ownership record", { failSetPath: `subscription_ownership/${OWN_ID}` }],
    ["X's record", { failSetPath: `users/${X}` }],
    ["B's device record", { failSetPath: `users/${Y}/devices/${DEVICE_B}` }],
    ["commit", { failCommit: true }],
  ]) {
    db = makeDb(baseDocs(), opts);
    before = snapshotOf(db);
    await assert.rejects(handlerFor(db)(request()), undefined, label);
    assert.equal(snapshotOf(db), before, `⑤ all items unchanged: ${label}`);
    assert.equal(usable(db, X), true, `⑤ X keeps using: ${label}`);
    assert.equal(db.docs.get(`users/${Y}`).activeDeviceId, undefined, `⑤ B not registered: ${label}`);
  }

  // ⑥ + ⑦ Y already uses device C: nothing moves without approval (cancel); with approval everything moves at once.
  const withC = () => baseDocs({ [`users/${Y}`]: { appStoreAppAccountToken: TAG_Y, activeDeviceId: DEVICE_C, pendingActiveDeviceId: DEVICE_D, pendingActiveClaimGeneration: 7 } });
  db = makeDb(withC());
  before = snapshotOf(db);
  await rejects(handlerFor(db)(request()), OWNERSHIP_TRANSFER_CODES.deviceConfirmationRequired, "⑦ no approval");
  assert.equal(snapshotOf(db), before, "⑦ cancel: nothing changed");
  assert.equal(usable(db, X), true, "⑦ cancel: X keeps the contract");
  result = await handlerFor(db)(request({ confirmDeviceReplacement: true }));
  assert.deepEqual(result, { success: true, transferred: true, deviceRegistered: true, replacedPreviousDevice: true });
  const y6 = db.docs.get(`users/${Y}`);
  assert.equal(y6.activeDeviceId, DEVICE_B, "⑥ B replaces C only after approval");
  assert.equal(y6.pendingActiveDeviceId, ""); assert.equal(y6.pendingActiveClaimGeneration, 0);
  assert.equal(ownerOf(db), Y); assert.equal(usable(db, Y), true); assert.equal(usable(db, X), false);
  db = makeDb(withC(), { failSetPath: `users/${Y}/devices/${DEVICE_B}` });
  before = snapshotOf(db);
  await assert.rejects(handlerFor(db)(request({ confirmDeviceReplacement: true })));
  assert.equal(snapshotOf(db), before, "⑥ approved but failed: nothing changed, C stays usable");
  db = makeDb(baseDocs({ [`users/${Y}`]: { appStoreAppAccountToken: TAG_Y, activeDeviceId: DEVICE_B } }));
  result = await handlerFor(db)(request());
  assert.equal(result.replacedPreviousDevice, false, "Y's active device already is B: nobody is replaced");
  const dev = db.docs.get(`users/${Y}/devices/${DEVICE_B}`);
  assert.equal(dev.platform, "ios"); assert.equal(dev.platformAppCheckVerified, true); assert.ok(dev.lastUsedAt && dev.firstUsedAt);
  assert.equal(dev.fcmToken, undefined, "device FCM token is not written before approval");

  // ⑧ retry after a lost response, and concurrent requests: consistent, no double transfer.
  db = makeDb(baseDocs());
  await handlerFor(db)(request());
  result = await handlerFor(db)(request());
  assert.deepEqual(result, { success: true, transferred: false, deviceRegistered: true, replacedPreviousDevice: false }, "⑧ retry converges");
  assert.equal(ownerOf(db), Y); assert.equal(db.docs.get(`users/${X}`).subscriptions.ios.status, "expired"); assert.equal(db.docs.get(`users/${Y}`).activeDeviceId, DEVICE_B);
  db = makeDb(baseDocs());
  const both = await Promise.all([handlerFor(db)(request()), handlerFor(db)(request())]);
  assert.equal(both.filter((r) => r.transferred).length, 1, "⑧ concurrent identical requests: exactly one transfers");
  assert.equal(ownerOf(db), Y); assert.equal(db.docs.get(`users/${Y}`).activeDeviceId, DEVICE_B); assert.equal(usable(db, X), false);
  db = makeDb(baseDocs());
  const two = await Promise.all([handlerFor(db)(request({ confirmDeviceReplacement: true })), handlerFor(db)(request({ deviceId: DEVICE_D, confirmDeviceReplacement: true }))]);
  assert.ok(two.every((r) => r.success), "⑧ two approved devices: both calls end consistently");
  assert.equal(ownerOf(db), Y);
  assert.ok([DEVICE_B, DEVICE_D].includes(db.docs.get(`users/${Y}`).activeDeviceId), "⑧ exactly one device is active");
  assert.equal(usable(db, X), false); assert.equal(usable(db, Y), true);
  // a request that is NOT approved never replaces a device that registered meanwhile
  db = makeDb(baseDocs());
  await handlerFor(db)(request({ confirmDeviceReplacement: true }));
  await rejects(handlerFor(db)(request({ deviceId: DEVICE_D })), OWNERSHIP_TRANSFER_CODES.deviceConfirmationRequired, "⑧ unapproved second device");
  assert.equal(db.docs.get(`users/${Y}`).activeDeviceId, DEVICE_B);

  // ⑨ + ⑩ diagnostics: traceable, free of secrets, never change the outcome.
  const records = [];
  const recorder = { info: (m, f) => records.push({ m, f }), warn: (m, f) => records.push({ m, f }), error: (m, f) => records.push({ m, f }) };
  db = makeDb(withC());
  await handlerFor(db, [entry()], { logger: recorder })(request({ confirmDeviceReplacement: true, billingTraceId: "trace-ios-1" }));
  const events = records.map((r) => r.m.replace("OWNERSHIP_TRANSFER ", ""));
  for (const e of ["request_received", "verify_start", "verify_result", "transaction_begin", "transaction_committed"]) assert.ok(events.includes(e), `⑨ stage logged: ${e}`);
  const committed = records.find((r) => r.m.endsWith("transaction_committed")).f;
  assert.equal(committed.platform, "ios"); assert.equal(committed.replacedPreviousDevice, true); assert.equal(committed.billingTraceId, "trace-ios-1");
  const dumped = JSON.stringify(records);
  for (const secret of [ORIG, TX, TAG_X, TAG_Y, X, Y, DEVICE_B, DEVICE_C, OWN_ID]) assert.ok(!dumped.includes(secret), `⑨ log leaks ${secret}`);
  assert.ok(records.length <= 15, "⑨ bounded log volume (a fixed handful of lines per request)");
  for (const e of ["apple_call", "apple_series", "proof_inputs", "proof_c_result"]) assert.ok(events.includes(e), `⑨ diagnostic stage logged: ${e}`);
  assert.equal(committed.ownershipMoved, true); assert.equal(committed.previousOwnerUpdated, true); assert.equal(committed.contractWritten, true);
  records.length = 0;
  db = makeDb(baseDocs());
  await rejects(handlerFor(db, [entry({}, { appAccountToken: TAG_THIRD })], { logger: recorder })(request({ appAccountToken: TAG_THIRD })), SUBSCRIPTION_ALREADY_LINKED_CODE, "⑨ refusal");
  assert.ok(records.some((r) => r.m.endsWith("transaction_rejected") && r.f.stage === "transaction" && r.f.proofCode), "⑨ the reason (proof code) is traceable");
  assert.ok(records.some((r) => r.m.endsWith("failure_recorded") && r.f.count === 1), "⑨ the counted refusal is traceable");
  records.length = 0;
  db = makeDb(baseDocs());
  await rejects(handlerFor(db, [entry({}, { inAppOwnershipType: "FAMILY_SHARED" })], { logger: recorder })(request({ billingTraceId: "trace-ios-2" })), OWNERSHIP_TRANSFER_CODES.notPurchased, "⑨ family shared");
  const proofLog = records.find((r) => r.m.endsWith("verify_proof")).f;
  assert.equal(proofLog.clientTagPresent, true); assert.equal(proofLog.appleTagPresent, true); assert.equal(proofLog.clientMatchesApple, true); assert.equal(proofLog.ownershipType, "FAMILY_SHARED");
  records.length = 0;
  db = makeDb(baseDocs());
  await rejects(handlerFor(db, [entry()], { logger: recorder })(request({ appAccountToken: undefined })), OWNERSHIP_TRANSFER_CODES.proofMissing, "⑨ missing proof");
  assert.equal(records.find((r) => r.m.endsWith("rejected")).f.reason, "device_proof_missing");
  db = makeDb(baseDocs());
  for (let i = 0; i < 5; i += 1) await assert.rejects(handlerFor(db, [entry()], { logger: recorder })(request({ appAccountToken: TAG_THIRD })));
  records.length = 0;
  await rejects(handlerFor(db, [entry()], { logger: recorder })(request()), OWNERSHIP_TRANSFER_CODES.rateLimited, "⑨ locked");
  assert.ok(records.some((r) => r.m.endsWith("rate_limited") && r.f.retryAfterSec > 0), "⑨ rate-limit rejection is traceable");
  const limiterDump = JSON.stringify([...records, ...[...db.docs.entries()].filter(([k]) => k.startsWith("ownership_transfer_failures/"))]);
  for (const secret of [TAG_X, TAG_Y, TAG_THIRD, ORIG, TX, OWN_ID]) assert.ok(!limiterDump.includes(secret), `⑨ limiter data/log leaks ${secret}`);
  records.length = 0;
  db = makeDb(baseDocs());
  await rejects(handlerFor(db, [entry({ state: "ended" })], { logger: recorder })(request()), OWNERSHIP_TRANSFER_CODES.notActive, "⑨ verify refusal");
  assert.ok(records.some((r) => r.m.endsWith("rejected") && r.f.stage === "store_verify"), "⑨ verification failure is traceable");
  const broken = { info() { throw new Error("sink down"); }, warn() { throw new Error("sink down"); }, error() { throw new Error("sink down"); } };
  const dbA = makeDb(withC()); const dbB = makeDb(withC());
  const resA = await handlerFor(dbA, [entry()], { logger: broken })(request({ confirmDeviceReplacement: true }));
  const resB = await handlerFor(dbB, [entry()], { logger: quiet })(request({ confirmDeviceReplacement: true }));
  assert.deepEqual(resA, resB, "⑩ same result with a failing logger");
  assert.equal(snapshotOf(dbA), snapshotOf(dbB), "⑩ same data with a failing logger");

  // dispatcher: the OS comes from the verified App Check app id, never from the request body.
  const calls = [];
  const dispatcher = createTransferActiveContractOwnershipDispatcher({ android: async () => { calls.push("android"); return { ok: 1 }; }, ios: async () => { calls.push("ios"); return { ok: 2 }; } });
  await dispatcher({ app: { appId: IOS_FIREBASE_APP_ID }, data: { platform: "android" } });
  await dispatcher({ app: { appId: ANDROID_FIREBASE_APP_ID }, data: { platform: "ios" } });
  assert.deepEqual(calls, ["ios", "android"], "dispatch follows the App Check app id");
  await assert.rejects(dispatcher({ app: { appId: "unknown" }, data: {} }));
  await assert.rejects(dispatcher({ data: {} }));
  // the iOS handler rejects an Android build even if called directly; the Android handler rejects an iPhone build
  db = makeDb(baseDocs());
  await assert.rejects(createTransferActiveContractOwnershipHandler({ admin: adminFor(db), logger: quiet })(request()));

  // ⑪ normal-path safety is not weakened (case 3 keeps its own test; every other callable keeps its device guard).
  const indexSource = fs.readFileSync(require.resolve("./index.js"), "utf8");
  assert.equal((indexSource.match(/await assertActiveDeviceAllowed\(/g) || []).length, 4, "⑪ the four existing device guards remain");
  assert.ok(/createTransferActiveContractOwnershipIosHandler\(/.test(indexSource) && /createTransferActiveContractOwnershipDispatcher\(/.test(indexSource), "⑪ the iPhone path is registered behind the dispatcher");
  const moduleSource = fs.readFileSync(require.resolve("./ownershipTransferAtomic.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/assertActiveDeviceAllowed\(/.test(moduleSource), "⑪ the guard is skipped only inside the dedicated module");
  assert.ok(/evaluateOwnershipTransferProof\(/.test(moduleSource) && /deriveSubscriptionState\(/.test(moduleSource) && /entry\.state !== "active"/.test(moduleSource), "⑪ Apple verification and the ownership proof are still required");
  const iosPart = moduleSource.slice(moduleSource.indexOf("function createIosAdapter"), moduleSource.indexOf("// Public factories"));
  assert.ok(!/googleState|syncGooglePlay|deriveGooglePlayEntitlement|purchaseToken/.test(iosPart), "⑪ Google Play verification is not reused for Apple");

  // ⑭ Case 10 recovery: Y's OWN purchase (Y's tag on Apple's latest transaction) after X's contract had ended.
  // Accepted only with Proof A (fresh pre-purchase record) or Proof B (X's recorded end before the purchase); never for a usable contract.
  const { fingerprint } = require("./expiredOwnershipProof");
  const END = NOW - 2 * 24 * HOUR;
  const PURCHASED = NOW - 5 * 60 * 1000;
  const yPurchase = (txOverrides = {}) => [entry({}, { appAccountToken: TAG_Y, purchaseDate: PURCHASED, expiresDate: NOW + 30 * 24 * HOUR, ...txOverrides })];
  const xEnded = (overrides = {}) => xUser({
    subscriptions: { ios: { status: "expired", expiryTime: iso(END), originalTransactionId: ORIG, transactionId: TX, transactionIds: [TX], productId: APP_STORE_PRODUCT_ID } },
    subscriptionStatus: "expired", subscriptionExpiryTime: iso(END), entitlementUsable: false, entitlementExpiryTime: iso(END), ...overrides });
  const docs10 = (extra = {}) => baseDocs({ [`users/${X}`]: xEnded(), ...extra });
  const req10 = (data = {}) => request({ appAccountToken: TAG_Y, ...data });
  const freshProofDocs = async (xRecord, checkedAt) => {
    const probe = makeDb({ [`users/${X}`]: xRecord, [`subscription_ownership/${OWN_ID}`]: baseDocs()[`subscription_ownership/${OWN_ID}`] });
    const own = await probe.collection("subscription_ownership").doc(OWN_ID).get();
    const xs = await probe.collection("users").doc(X).get();
    return baseDocs({ [`users/${X}`]: xRecord, [`users/${Y}`]: { appStoreAppAccountToken: TAG_Y, billingConfirmation: { ios: { state: "eligible",
      reason: "verified_current_series_ended", checkedAt, expiredForeignSeries: [{ ownershipId: OWN_ID, ownerUid: X, kind: "subscription_ownership",
        fingerprint: fingerprint(own), ownerUserFingerprint: fingerprint(xs), expiryMs: END }] } } } });
  };

  // Proof B: X's record is a normal ended contract. Ownership, contract and device move in one commit; X is only marked expired.
  db = makeDb(docs10());
  result = await handlerFor(db, yPurchase())(req10());
  assert.deepEqual(result, { success: true, transferred: true, deviceRegistered: true, replacedPreviousDevice: false }, "⑭ recovery with Proof B");
  assert.equal(ownerOf(db), Y, "⑭ ownership X -> Y");
  assert.equal(usable(db, Y), true, "⑭ Y is entitled without buying again");
  assert.equal(db.docs.get(`users/${Y}`).activeDeviceId, DEVICE_B, "⑭ the device is registered in the same commit");
  const x14 = db.docs.get(`users/${X}`);
  assert.equal(x14.subscriptions.ios.status, "expired"); assert.equal(usable(db, X), false);
  assert.notEqual(x14.subscriptions.ios.source, "ownership_transferred", "⑭ X's ended contract is not reported as 'moved to another phone'");
  assert.equal(x14.subscriptions.ios.transferredAt, undefined);
  result = await handlerFor(db, yPurchase())(req10());
  assert.deepEqual(result, { success: true, transferred: false, deviceRegistered: true, replacedPreviousDevice: false }, "⑭ retry converges, no second transfer");
  const both14 = await Promise.all([handlerFor(makeDb(docs10()), yPurchase())(req10()), handlerFor(db, yPurchase())(req10())]);
  assert.ok(both14.every((r) => r.success), "⑭ concurrent requests end consistently");

  // Proof A (fresh) rescues a case where Proof B cannot be built from X's record (no series id recorded).
  const xNoId = xEnded({ subscriptions: { ios: { status: "expired", expiryTime: iso(END), productId: APP_STORE_PRODUCT_ID } }, appStoreOriginalTransactionId: undefined });
  db = makeDb(docs10({ [`users/${X}`]: xNoId }));
  before = snapshotOf(db);
  await rejects(handlerFor(db, yPurchase())(req10()), SUBSCRIPTION_ALREADY_LINKED_CODE, "⑭ Proof B alone fails when X has no recorded series");
  assert.equal(snapshotOf(db), before, "⑭ refused: nothing changed");
  db = makeDb(await freshProofDocs(xNoId, NOW - 10 * 60 * 1000));
  await handlerFor(db, yPurchase())(req10());
  assert.equal(ownerOf(db), Y, "⑭ Proof A (within 15 minutes) recovers it");
  db = makeDb(await freshProofDocs(xNoId, NOW - 20 * 60 * 1000));
  before = snapshotOf(db);
  await rejects(handlerFor(db, yPurchase())(req10()), SUBSCRIPTION_ALREADY_LINKED_CODE, "⑭ expired Proof A (20 minutes) and no Proof B");
  assert.equal(snapshotOf(db), before);

  // Never a usable contract, never a purchase that is not the requester's own, never when Y already has another contract.
  const refusals14 = [
    ["X still usable", docs10({ [`users/${X}`]: xUser() }), yPurchase(), req10()],
    ["X's recorded end is not before the purchase", docs10({ [`users/${X}`]: xEnded({ subscriptions: { ios: { status: "expired", expiryTime: iso(NOW - 60 * 1000), originalTransactionId: ORIG, productId: APP_STORE_PRODUCT_ID } } }) }), yPurchase(), req10()],
    ["X's record cannot give an end (status none)", docs10({ [`users/${X}`]: xEnded({ subscriptions: { ios: { status: "none", originalTransactionId: ORIG, productId: APP_STORE_PRODUCT_ID } } }) }), yPurchase(), req10()],
    ["X's user record is missing", docs10({ [`users/${X}`]: undefined }), yPurchase(), req10()],
    ["Apple's tag is not Y's stored tag", docs10({ [`users/${Y}`]: { appStoreAppAccountToken: TAG_THIRD } }), yPurchase(), req10()],
    ["Y already holds another usable contract", docs10({ [`users/${Y}`]: { appStoreAppAccountToken: TAG_Y, subscriptions: { ios: { status: "active", expiryTime: iso(NOW + HOUR), originalTransactionId: "other-series" } } } }), yPurchase(), req10()],
  ];
  for (const [label, docs, entries, req] of refusals14) {
    const clean = Object.fromEntries(Object.entries(docs).filter(([, v]) => v !== undefined));
    db = makeDb(clean);
    before = snapshotOf(db);
    await rejects(handlerFor(db, entries)(req), SUBSCRIPTION_ALREADY_LINKED_CODE, `⑭ ${label}`);
    assert.equal(snapshotOf(db).replace(/"ownership_transfer_failures[^]*$/, ""), before.replace(/"ownership_transfer_failures[^]*$/, ""), `⑭ nothing but the counter changed: ${label}`);
    assert.equal(ownerOf(db), X, `⑭ ownership stays with X: ${label}`);
  }
  // Y's own tag with X still usable stays refused and the refusal is counted (the limiter is unchanged).
  db = makeDb(docs10({ [`users/${X}`]: xUser() }));
  await rejects(handlerFor(db, yPurchase())(req10()), SUBSCRIPTION_ALREADY_LINKED_CODE, "⑭ refusal");
  assert.equal(db.docs.get(`ownership_transfer_failures/${Y}`).count, 1, "⑭ a refused recovery counts toward the limit");
  assert.equal(usable(db, X), true, "⑭ X's usable contract is untouched");
  // The recovery is a quiet success: logs carry no identifiers or tags.
  records.length = 0;
  db = makeDb(docs10());
  await handlerFor(db, yPurchase(), { logger: recorder })(req10({ billingTraceId: "trace-ios-10" }));
  assert.ok(records.some((r) => r.m.endsWith("own_purchase_recovery")), "⑭ the recovery path is traceable");
  const dump14 = JSON.stringify(records);
  for (const secret of [ORIG, TX, TAG_X, TAG_Y, X, Y, DEVICE_B, OWN_ID]) assert.ok(!dump14.includes(secret), `⑭ log leaks ${secret}`);
  // Diagnostics for the recovery: every stage and the reason of a refusal can be read from the logs, without identifiers.
  const stageLog = (entriesLike, docs, req, extra = {}) => {
    records.length = 0;
    return (async () => {
      const dbL = makeDb(docs);
      let error = null;
      try { await handlerFor(dbL, entriesLike, { logger: recorder })(req); } catch (e) { error = e; }
      return { dbL, error, events: records.map((r) => r.m.replace("OWNERSHIP_TRANSFER ", "")), byName: (n) => records.find((r) => r.m.endsWith(n)), ...extra };
    })();
  };
  let t = await stageLog(yPurchase(), docs10(), req10({ billingTraceId: "trace-ios-11" }));
  for (const e of ["request_received", "verify_start", "apple_call", "apple_series", "verify_proof", "verify_result", "transaction_begin", "proof_inputs",
    "proof_c_result", "own_purchase_recovery_eval", "own_purchase_recovery", "transaction_committed"]) assert.ok(t.events.includes(e), `⑭ stage logged: ${e}`);
  assert.equal(t.byName("proof_inputs").f.requesterTagMatchesAppleTag, true, "⑭ the token match is traceable");
  assert.equal(t.byName("proof_c_result").f.allowed, false, "⑭ the owner-tag proof (case 9) did not apply");
  const evalLog = t.byName("own_purchase_recovery_eval").f;
  assert.equal(evalLog.allowed, true); assert.ok(evalLog.code, "⑭ the code of the proof that allowed it is logged");
  assert.equal(evalLog.proofA.hasRecord, false, "⑭ Proof A inputs are explained");
  assert.equal(evalLog.facts.ownerUsableNow, false, "⑭ Proof B facts are logged");
  const done = t.byName("transaction_committed").f;
  assert.equal(done.ownershipMoved, true); assert.equal(done.previousOwnerUpdated, true); assert.equal(done.contractWritten, true); assert.equal(done.deviceRegistered, true);
  assert.ok(records.filter((r) => r.m.startsWith("OWNERSHIP_TRANSFER")).every((r) => r.f.billingTraceId === "trace-ios-11"), "⑭ every transfer line carries the client's trace id");
  // A refusal says which Proof A condition failed (old record) and which Proof B condition failed.
  t = await stageLog(yPurchase(), await freshProofDocs(xNoId, NOW - 20 * 60 * 1000), req10({ billingTraceId: "trace-ios-12" }));
  assert.ok(t.error, "⑭ refused");
  const refusedEval = t.byName("own_purchase_recovery_eval").f;
  assert.equal(refusedEval.allowed, false); assert.ok(typeof refusedEval.code === "string" && refusedEval.code.length > 0, "⑭ Proof B refusal reason is logged");
  assert.equal(refusedEval.proofA.hasRecord, true); assert.equal(refusedEval.proofA.withinWindow, false, "⑭ Proof A: the 15-minute window is reported");
  assert.ok(refusedEval.proofA.recordAgeSec >= 1200, "⑭ Proof A: the record age is reported");
  assert.equal(refusedEval.proofA.ownershipUnchanged, true); assert.equal(refusedEval.proofA.previousOwnerRecordUnchanged, true);
  assert.ok(t.byName("ownership_proof_refused").f.proofCode, "⑭ the refusal reason is logged");
  const dump15 = JSON.stringify(records);
  for (const secret of [ORIG, TX, TAG_X, TAG_Y, X, Y, DEVICE_B, OWN_ID]) assert.ok(!dump15.includes(secret), `⑭ refusal log leaks ${secret}`);
  // A refusal in the recovery leaves the data as it was; a failing log sink never changes the result.
  const brokenSink = { info() { throw new Error("sink down"); }, warn() { throw new Error("sink down"); }, error() { throw new Error("sink down"); } };
  const dbBroken = makeDb(docs10()); const dbQuiet = makeDb(docs10());
  const rBroken = await handlerFor(dbBroken, yPurchase(), { logger: brokenSink })(req10());
  const rQuiet = await handlerFor(dbQuiet, yPurchase(), { logger: quiet })(req10());
  assert.deepEqual(rBroken, rQuiet, "⑭ same result with a failing logger");
  assert.equal(snapshotOf(dbBroken), snapshotOf(dbQuiet), "⑭ same data with a failing logger");

  // Android keeps its own rules: the recovery is iPhone-only.
  const androidSource = fs.readFileSync(require.resolve("./ownershipTransferAtomic.js"), "utf8");
  assert.equal((androidSource.match(/ownPurchaseRecovery: true/g) || []).length, 1, "⑭ only the iPhone adapter opts in");

  // Build477: Y's own registered OS is checked inside the same ownership transaction.
  for (const sourceOs of ["ios", "android", "unknown"]) {
    const osDocs = baseDocs({[`users/${Y}`]: {activeDeviceId: DEVICE_C}});
    osDocs[`users/${Y}/devices/${DEVICE_C}`] = {platform:sourceOs,platformAppCheckVerified:sourceOs!=="unknown"};
    db=makeDb(osDocs);const beforeOs=snapshotOf(db);const osLogs=[];
    const osLogger={info:(tag,fields)=>osLogs.push({tag,...fields}),warn(){},error(){}};
    if (sourceOs === "ios") {
      await handlerFor(db, [entry()], {logger: osLogger})(request({confirmDeviceReplacement:true,osGateTraceId:"og-123456789-1"}));
      assert(osLogs.some(e=>e.event==="OS_GATE_2_COMMIT"&&e.path==="ownership_transfer"));
    } else {
      await rejects(handlerFor(db, [entry()], {logger: osLogger})(request({confirmDeviceReplacement:true,osGateTraceId:"og-123456789-1"})),sourceOs==="unknown"?"OS_GATE_UNKNOWN":"OS_GATE_CROSS_OS","Build477 ownership OS rejection");
      assert.equal(snapshotOf(db),beforeOs,"ownership OS rejection preserves contracts, devices, owner and FCM");
      assert(osLogs.some(e=>e.event===(sourceOs==="unknown"?"OS_GATE_2_UNKNOWN":"OS_GATE_2_REJECT")&&e.path==="ownership_transfer"));
    }
    assert(osLogs.filter(e=>String(e.event).startsWith("OS_GATE_")).every(e=>e.osGateTraceId==="og-123456789-1"));
  }
  console.log("ownershipTransferAtomicIos: case-9 atomic transfer checks PASS");
})().catch((error) => { console.error(error); process.exit(1); });
