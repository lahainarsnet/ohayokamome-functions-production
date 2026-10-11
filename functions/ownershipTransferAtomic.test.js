"use strict";
// Case 3: atomic ownership transfer (Android, same Play account, UID X -> UID Y, contract Active).
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { createTransferActiveContractOwnershipHandler, OWNERSHIP_TRANSFER_CODES } = require("./ownershipTransferAtomic");
const { buildAndroidOwnershipId, SUBSCRIPTION_ALREADY_LINKED_CODE } = require("./subscriptionOwnership");
const { evaluatePlatformEntitlement } = require("./platformEntitlement");
const { ANDROID_FIREBASE_APP_ID } = require("./appCheckPlatform");

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const TOKEN = "play-token-of-contract-1";
const OWN_ID = buildAndroidOwnershipId(TOKEN);
const DEVICE_B = "11111111-1111-4111-8111-111111111111";
const DEVICE_C = "22222222-2222-4222-8222-222222222222";
const tagOf = (uid) => crypto.createHash("sha256").update(`kamome-account:${uid}`).digest("hex");

const { makeDb, adminFor, snapshotOf } = require("./ownershipTransferTestKit");

// ---- fixtures ----
const iso = (ms) => new Date(ms).toISOString();
const googleObserved = (overrides = {}) => ({
  subscription: {
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    externalAccountIdentifiers: { obfuscatedExternalAccountId: tagOf("user-x-abcdefghij0123456789") },
    ...(overrides.subscription || {}),
  },
  matchedLineItem: { productId: "ohayo_kamome_monthly", expiryTime: iso(NOW + 20 * 24 * HOUR), ...(overrides.matchedLineItem || {}) },
  storeObservedAtMs: NOW,
});
const xUser = (overrides = {}) => ({
  subscriptions: { android: { status: "active", expiryTime: iso(NOW + 20 * 24 * HOUR), primaryPurchaseToken: TOKEN, activePurchaseTokens: [TOKEN], productId: "ohayo_kamome_monthly" } },
  subscriptionStatus: "active", subscriptionPlatform: "android", subscriptionExpiryTime: iso(NOW + 20 * 24 * HOUR),
  googlePlayPrimaryPurchaseToken: TOKEN, activePurchaseTokens: [TOKEN],
  entitlementUsable: true, entitlementSource: "android", entitlementExpiryTime: iso(NOW + 20 * 24 * HOUR),
  activeDeviceId: DEVICE_C, ...overrides,
});
const baseDocs = (extra = {}) => ({
  "users/user-x-abcdefghij0123456789": xUser(),
  "users/user-y-abcdefghij0123456789": {},
  [`subscription_ownership/${OWN_ID}`]: { ownerUid: "user-x-abcdefghij0123456789", platform: "android", status: "active" },
  ...extra,
});
const request = (data = {}, uid = "user-y-abcdefghij0123456789") => ({
  auth: { uid }, app: { appId: ANDROID_FIREBASE_APP_ID },
  data: { platform: "android", deviceId: DEVICE_B, purchaseToken: TOKEN, productId: "ohayo_kamome_monthly", ...data },
});
const quiet = { info() {}, warn() {}, error() {} };
const handlerFor = (db, observed = googleObserved(), extra = {}) => createTransferActiveContractOwnershipHandler({
  admin: adminFor(db), logger: quiet, verifyGoogle: async () => observed, nowMs: () => NOW, ...extra,
});
const rejects = async (promise, code, label) => {
  await assert.rejects(promise, (error) => {
    const got = error && error.details && error.details.code || error && error.message;
    assert.equal(got, code, `${label}: expected ${code}, got ${got}`);
    return true;
  }, label);
};

(async () => {
  // ① + ② + ③: valid Active contract moves X -> Y, B becomes usable without a purchase, X can no longer use it.
  let db = makeDb(baseDocs({ "users/user-y-abcdefghij0123456789": { appStoreAppAccountToken: "ignored" } }));
  let result = await handlerFor(db)(request());
  assert.deepEqual(result, { success: true, transferred: true, deviceRegistered: true, replacedPreviousDevice: false });
  assert.equal(db.docs.get(`subscription_ownership/${OWN_ID}`).ownerUid, "user-y-abcdefghij0123456789", "① ownership moves X -> Y");
  const y = db.docs.get("users/user-y-abcdefghij0123456789");
  assert.equal(y.subscriptions.android.status, "active", "③ Y holds an Active contract record");
  assert.equal(y.entitlementUsable, true, "② Y is entitled without buying");
  assert.equal(evaluatePlatformEntitlement(y, "android", new Date(NOW)).usable, true, "② server-side entitlement check passes for Y");
  assert.equal(y.activeDeviceId, DEVICE_B, "④ B is registered as Y's device");
  assert.equal(y.boundSubscriptionSeries.android.ownershipId, OWN_ID);
  assert.ok(db.docs.get(`users/user-y-abcdefghij0123456789/devices/${DEVICE_B}`).firstUsedAt, "device record created");
  assert.equal(y.fcmToken, undefined, "FCM token is never written by the transfer");
  const x = db.docs.get("users/user-x-abcdefghij0123456789");
  assert.equal(x.subscriptions.android.status, "expired", "X marked");
  assert.equal(x.subscriptions.android.source, "ownership_transferred");
  assert.ok(x.subscriptions.android.transferredAt, "X carries the transfer marker");
  assert.equal(evaluatePlatformEntitlement(x, "android", new Date(NOW)).usable, false, "③ X can no longer use the contract");
  assert.equal(x.entitlementUsable, false);
  assert.equal(x.activeDeviceId, DEVICE_C, "X's own device registration is untouched");

  // ④ verification failures change nothing.
  const refusals = [
    ["Google says expired", googleObserved({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" } }), OWNERSHIP_TRANSFER_CODES.notActive],
    ["Google says paused", googleObserved({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_PAUSED" } }), OWNERSHIP_TRANSFER_CODES.notActive],
    ["period already ended", googleObserved({ matchedLineItem: { expiryTime: iso(NOW - HOUR) } }), OWNERSHIP_TRANSFER_CODES.notActive],
    ["other product", googleObserved({ matchedLineItem: { productId: "other" } }), OWNERSHIP_TRANSFER_CODES.notActive],
    ["linked token", googleObserved({ subscription: { linkedPurchaseToken: "older-token" } }), OWNERSHIP_TRANSFER_CODES.linkedUnsupported],
    ["tag of a third party", googleObserved({ subscription: { externalAccountIdentifiers: { obfuscatedExternalAccountId: tagOf("user-third-abcdefghij0123456789") } } }), SUBSCRIPTION_ALREADY_LINKED_CODE],
    ["no tag", googleObserved({ subscription: { externalAccountIdentifiers: {} } }), SUBSCRIPTION_ALREADY_LINKED_CODE],
  ];
  for (const [label, observed, code] of refusals) {
    db = makeDb(baseDocs());
    const before = snapshotOf(db);
    await rejects(handlerFor(db, observed)(request()), code, label);
    assert.equal(snapshotOf(db), before, `④ nothing changed: ${label}`);
  }
  db = makeDb(baseDocs());
  let before = snapshotOf(db);
  await rejects(handlerFor(db, null, { verifyGoogle: async () => { throw new Error("google down"); } })(request()), undefined === 1 ? "" : "Could not verify the Store purchase.", "Google API failure");
  assert.equal(snapshotOf(db), before, "④ nothing changed on Google API failure");
  // no ownership record for this contract -> not this path
  db = makeDb({ "users/user-x-abcdefghij0123456789": xUser(), "users/user-y-abcdefghij0123456789": {} });
  before = snapshotOf(db);
  await rejects(handlerFor(db)(request()), OWNERSHIP_TRANSFER_CODES.notApplicable, "no ownership record");
  assert.equal(snapshotOf(db), before);
  // Y already holds a different usable Android contract -> refused, nothing changed
  db = makeDb(baseDocs({ "users/user-y-abcdefghij0123456789": { subscriptions: { android: { status: "active", expiryTime: iso(NOW + HOUR), primaryPurchaseToken: "other-token" } } } }));
  before = snapshotOf(db);
  await rejects(handlerFor(db)(request()), SUBSCRIPTION_ALREADY_LINKED_CODE, "Y has another contract");
  assert.equal(snapshotOf(db), before);
  // bad requests
  for (const [label, data] of [["bad device id", { deviceId: "not-a-uuid" }], ["no token", { purchaseToken: "" }], ["wrong product", { productId: "x" }]]) {
    db = makeDb(baseDocs());
    before = snapshotOf(db);
    await assert.rejects(handlerFor(db)(request(data)), undefined, label);
    assert.equal(snapshotOf(db), before, `④ nothing changed: ${label}`);
  }
  // wrong OS app id (iPhone app) / unauthenticated
  db = makeDb(baseDocs());
  await assert.rejects(handlerFor(db)({ ...request(), app: { appId: "1:762588322233:ios:7a4f63a7bc68678cea7e68" } }));
  await assert.rejects(handlerFor(db)({ ...request(), auth: null }));
  assert.equal(snapshotOf(db), snapshotOf(makeDb(baseDocs())));

  // ⑤ a failure inside the transaction changes NONE of the four items.
  for (const [label, opts] of [
    ["fail writing the ownership record", { failSetPath: `subscription_ownership/${OWN_ID}` }],
    ["fail writing X's record", { failSetPath: "users/user-x-abcdefghij0123456789" }],
    ["fail writing Y's device record", { failSetPath: `users/user-y-abcdefghij0123456789/devices/${DEVICE_B}` }],
    ["fail at commit", { failCommit: true }],
  ]) {
    db = makeDb(baseDocs(), opts);
    before = snapshotOf(db);
    await assert.rejects(handlerFor(db)(request()), undefined, label);
    assert.equal(snapshotOf(db), before, `⑤ all four items unchanged: ${label}`);
    // X keeps its contract, Y has nothing, the old device registration is intact.
    assert.equal(evaluatePlatformEntitlement(db.docs.get("users/user-x-abcdefghij0123456789"), "android", new Date(NOW)).usable, true, `⑤ X keeps using: ${label}`);
    assert.equal(db.docs.get("users/user-y-abcdefghij0123456789").activeDeviceId, undefined, `⑤ B is not registered: ${label}`);
  }
  // previous owner active on a DIFFERENT series -> the whole transaction aborts
  db = makeDb(baseDocs({ "users/user-x-abcdefghij0123456789": xUser({ subscriptions: { android: { status: "active", expiryTime: iso(NOW + HOUR), primaryPurchaseToken: "another-series" } }, googlePlayPrimaryPurchaseToken: "another-series" }) }));
  before = snapshotOf(db);
  await assert.rejects(handlerFor(db)(request()), undefined, "owner on a different series");
  assert.equal(snapshotOf(db), before, "⑤ unchanged when X's record is on a different series");

  // ⑥ retry / lost response: the same request again converges with no double transfer.
  db = makeDb(baseDocs());
  await handlerFor(db)(request());
  const afterFirst = snapshotOf(db);
  result = await handlerFor(db)(request());
  assert.deepEqual(result, { success: true, transferred: false, deviceRegistered: true, replacedPreviousDevice: false }, "⑥ retry succeeds without transferring again");
  assert.equal(db.docs.get(`subscription_ownership/${OWN_ID}`).ownerUid, "user-y-abcdefghij0123456789");
  assert.equal(db.docs.get("users/user-x-abcdefghij0123456789").subscriptions.android.status, "expired");
  assert.equal(db.docs.get("users/user-y-abcdefghij0123456789").activeDeviceId, DEVICE_B);
  assert.equal(db.docs.get("users/user-y-abcdefghij0123456789").subscriptions.android.primaryPurchaseToken, TOKEN);
  assert.equal(JSON.parse(afterFirst)["users/user-x-abcdefghij0123456789"], undefined, "(sanity)") ;
  // a request from X after the transfer cannot take it back through this path without the same proof checks
  db = makeDb(baseDocs());
  await handlerFor(db)(request());
  await rejects(handlerFor(db, googleObserved({ subscription: { externalAccountIdentifiers: { obfuscatedExternalAccountId: tagOf("user-third-abcdefghij0123456789") } } }))(request({}, "user-x-abcdefghij0123456789")),
    SUBSCRIPTION_ALREADY_LINKED_CODE, "⑥ taking it back still needs a valid proof");

  // ⑦ Y already uses another device C. Replacing it needs the user's explicit approval; the transfer itself is
  // all-or-nothing together with B's registration.
  const withC = () => baseDocs({ "users/user-y-abcdefghij0123456789": { activeDeviceId: DEVICE_C, pendingActiveDeviceId: "99999999-9999-4999-8999-999999999999", pendingActiveClaimGeneration: 7 } });
  // (a) no approval (the user pressed "cancel", or an old client): NOTHING changes. X keeps the contract, device C stays.
  db = makeDb(withC());
  before = snapshotOf(db);
  await rejects(handlerFor(db)(request()), OWNERSHIP_TRANSFER_CODES.deviceConfirmationRequired, "⑦ no approval");
  assert.equal(snapshotOf(db), before, "⑦ cancel: ownership, X, Y's contract and both devices are unchanged");
  assert.equal(evaluatePlatformEntitlement(db.docs.get("users/user-x-abcdefghij0123456789"), "android", new Date(NOW)).usable, true, "⑦ cancel: X keeps the contract");
  // (b) approved: everything moves in one commit, and C stops being the active device.
  result = await handlerFor(db)(request({ confirmDeviceReplacement: true }));
  assert.deepEqual(result, { success: true, transferred: true, deviceRegistered: true, replacedPreviousDevice: true });
  const y7 = db.docs.get("users/user-y-abcdefghij0123456789");
  assert.equal(y7.activeDeviceId, DEVICE_B, "⑦ B replaces C only after approval");
  assert.equal(y7.pendingActiveDeviceId, "", "⑦ any stale pending claim is cleared");
  assert.equal(y7.pendingActiveClaimGeneration, 0);
  assert.equal(db.docs.get(`subscription_ownership/${OWN_ID}`).ownerUid, "user-y-abcdefghij0123456789");
  assert.equal(y7.subscriptions.android.status, "active");
  // (c) approved but the transaction fails: ownership, contract and C's registration are all untouched.
  db = makeDb(withC(), { failSetPath: `users/user-y-abcdefghij0123456789/devices/${DEVICE_B}` });
  before = snapshotOf(db);
  await assert.rejects(handlerFor(db)(request({ confirmDeviceReplacement: true })));
  assert.equal(snapshotOf(db), before, "⑦ approved but failed: nothing changed, C stays usable");
  // (d) Y's active device already is B: simply confirmed, nobody is replaced.
  db = makeDb(baseDocs({ "users/user-y-abcdefghij0123456789": { activeDeviceId: DEVICE_B } }));
  result = await handlerFor(db)(request());
  assert.deepEqual(result, { success: true, transferred: true, deviceRegistered: true, replacedPreviousDevice: false });
  // (e) device registration record: required fields are present (record-only strings are filled by the usage report).
  const dev = db.docs.get(`users/user-y-abcdefghij0123456789/devices/${DEVICE_B}`);
  assert.equal(dev.deviceId, DEVICE_B); assert.equal(dev.platform, "android"); assert.equal(dev.platformAppCheckVerified, true);
  assert.ok(dev.lastUsedAt && dev.firstUsedAt, "device timestamps are recorded");
  assert.equal(dev.fcmToken, undefined, "device FCM token is not written before approval");

  // ⑩ diagnostics: traceable, free of secrets, and they never change the outcome.
  const records = [];
  const recorder = { info: (m, f) => records.push({ level: "info", m, f }), warn: (m, f) => records.push({ level: "warn", m, f }), error: (m, f) => records.push({ level: "error", m, f }) };
  db = makeDb(withC());
  await handlerFor(db, googleObserved(), { logger: recorder })(request({ confirmDeviceReplacement: true, billingTraceId: "trace-abc-123" }));
  const events = records.map((r) => r.m.replace("OWNERSHIP_TRANSFER ", ""));
  for (const e of ["request_received", "verify_start", "verify_result", "transaction_begin", "transaction_committed"]) assert.ok(events.includes(e), `⑩ stage logged: ${e}`);
  const committed = records.find((r) => r.m.endsWith("transaction_committed")).f;
  assert.equal(committed.replacedPreviousDevice, true); assert.equal(committed.stage, "committed"); assert.equal(committed.billingTraceId, "trace-abc-123");
  const dumped = JSON.stringify(records);
  for (const secret of [TOKEN, "user-x-abcdefghij0123456789", "user-y-abcdefghij0123456789", DEVICE_B, DEVICE_C, tagOf("user-x-abcdefghij0123456789"), OWN_ID]) assert.ok(!dumped.includes(secret), `⑩ log leaks ${secret}`);
  assert.ok(records.length <= 8, "⑩ bounded log volume (two proof-stage lines added)");
  records.length = 0;
  db = makeDb(withC());
  await rejects(handlerFor(db, googleObserved(), { logger: recorder })(request()), OWNERSHIP_TRANSFER_CODES.deviceConfirmationRequired, "⑩ rejection");
  assert.ok(records.some((r) => r.m.endsWith("transaction_rejected") && r.f.code === OWNERSHIP_TRANSFER_CODES.deviceConfirmationRequired && r.f.stage === "transaction"), "⑩ failure stage is traceable");
  records.length = 0;
  db = makeDb(baseDocs());
  await rejects(handlerFor(db, googleObserved({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED" } }), { logger: recorder })(request()), OWNERSHIP_TRANSFER_CODES.notActive, "⑩ verify rejection");
  assert.ok(records.some((r) => r.m.endsWith("rejected") && r.f.stage === "store_verify"), "⑩ verification failure is traceable");
  // a broken logger changes nothing
  const broken = { info() { throw new Error("sink down"); }, warn() { throw new Error("sink down"); }, error() { throw new Error("sink down"); } };
  const dbA = makeDb(withC()); const dbB = makeDb(withC());
  const resA = await handlerFor(dbA, googleObserved(), { logger: broken })(request({ confirmDeviceReplacement: true }));
  const resB = await handlerFor(dbB, googleObserved(), { logger: quiet })(request({ confirmDeviceReplacement: true }));
  assert.deepEqual(resA, resB, "⑩ same result with a failing logger");
  assert.equal(snapshotOf(dbA), snapshotOf(dbB), "⑩ same data with a failing logger");

  // ⑨ the normal-path safety checks are not weakened: the device guard stays on every other callable,
  // and the new callable is the only place that skips it.
  const indexSource = fs.readFileSync(require.resolve("./index.js"), "utf8");
  assert.equal((indexSource.match(/await assertActiveDeviceAllowed\(/g) || []).length, 4, "⑨ the four existing device guards remain in index.js");
  assert.ok(/exports\.transferActiveContractOwnership = onCall\(/.test(indexSource), "⑨ the dedicated callable is registered");
  const moduleSource = fs.readFileSync(require.resolve("./ownershipTransferAtomic.js"), "utf8");
  assert.ok(!/assertActiveDeviceAllowed\(/.test(moduleSource.replace(/^\s*\/\/.*$/gm, "")), "⑨ the guard is skipped only inside the dedicated module");
  assert.ok(/evaluateOwnershipTransferProof\(/.test(moduleSource) && /googleState\(/.test(moduleSource), "⑨ ownership proof and Store verification are still required");
  const claimSource = fs.readFileSync(require.resolve("./claimActiveDevice.js"), "utf8");
  assert.ok(/confirmed_rejected_stale/.test(claimSource), "⑨ normal device claims keep their stale-request protection");

  console.log("ownershipTransferAtomic: case-3 atomic transfer checks PASS");
})().catch((error) => { console.error(error); process.exit(1); });
