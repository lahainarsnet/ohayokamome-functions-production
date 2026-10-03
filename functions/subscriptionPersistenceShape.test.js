"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { Firestore, FieldValue, Timestamp } = require("@google-cloud/firestore");
const entitlement = require("./subscriptionEntitlement");
const { applyGoogleSubscriptionUpdateToUser } = require("./googlePlaySubscriptionNotifications");
const { applyUserSubscriptionUpdate } = require("./appStoreSubscriptionNotifications");
const { verifiedStoreMetadata } = require("./preChatBillingConfirmation");
const admin = { FieldValue, Timestamp };
const quiet = { info() {}, warn() {}, error() {}, log() {} };
const expiry = Timestamp.fromMillis(Date.now() + 86400000);
let count = 0;
async function test(name, run) { await run(); console.log(`ok ${++count}: ${name}`); }
// Real SDK serializer and snapshot decoder, with transport replaced before any network call.
// This is a wire-shape check, not a Firestore backend/emulator integration test.
function sdkDb(initial = {}) {
  const sdk = new Firestore({ projectId: "local-shape-test" });
  sdk.initializeIfNeeded = async () => {};
  const wires = [];
  let decoded = initial;
  sdk.request = async (method, request) => {
    assert.equal(method, "commit");
    wires.push(...request.writes);
    return { writeResults: request.writes.map(() => ({ updateTime: { seconds: 1, nanos: 0 } })), commitTime: { seconds: 1, nanos: 0 } };
  };
  const ref = sdk.doc("users/user");
  const db = { collection: () => ({ doc: () => ({ ...ref, id: "user", get: async () => ({ exists: true, data: () => decoded }) }) }),
    runTransaction: async (run) => {
      const batch = sdk.batch();
      const result = await run({ get: async () => ({ exists: true, data: () => decoded }),
        set: (_ref, data, options) => batch.set(ref, data, options) });
      await batch.commit();
      const wire = wires.at(-1);
      const snap = sdk.snapshot_({ name: wire.update.name, fields: wire.update.fields,
        createTime: { seconds: 1, nanos: 0 }, updateTime: { seconds: 1, nanos: 0 } });
      const partial = snap.data();
      // Opposite OS presence is asserted against the actual SDK updateMask below.
      decoded = { ...decoded, ...partial, subscriptions: { ...decoded.subscriptions, ...partial.subscriptions } };
      return result;
    } };
  return { sdk, ref, db, wires, data: () => decoded };
}
function shape(env, platform) {
  const wire = env.wires.at(-1);
  const fields = wire.update.fields;
  assert.ok(fields.subscriptions.mapValue.fields[platform].mapValue);
  assert.equal(Object.hasOwn(fields, `subscriptions.${platform}`), false);
  assert.equal(Object.hasOwn(env.data(), `subscriptions.${platform}`), false);
  assert.ok(env.data().subscriptions[platform]);
  assert.ok(wire.updateMask.fieldPaths.some((key) => key.startsWith(`subscriptions.${platform}.`)));
  assert.equal(wire.updateMask.fieldPaths.includes(`\`subscriptions.${platform}\``), false);
}
async function dual(env, platform, source = "shape_test") {
  await entitlement.commitUserSubscriptionDualWrite({ db: env.db, admin, uid: "user", platform, source,
    storeState: { status: "active", expiryTime: expiry, autoRenewing: true,
      ...(platform === "android" ? { primaryPurchaseToken: "test-token" } : { originalTransactionId: "test-original", transactionId: "test-txn" }) },
    legacyUpdate: { subscriptionStatus: "active", subscriptionPlatform: platform, subscriptionExpiryTime: expiry }, log: quiet });
}
(async () => {
  await test("SDK set treats dotted object keys as literal fields", async () => {
    const env = sdkDb();
    await env.sdk.batch().set(env.ref, { "subscriptions.android": { status: "active" } }, { merge: true }).commit();
    const wire = env.wires[0];
    assert.ok(wire.update.fields["subscriptions.android"].mapValue);
    assert.equal(wire.update.fields.subscriptions, undefined);
    assert.ok(wire.updateMask.fieldPaths.includes("`subscriptions.android`.status"));
  });
  await test("SDK update treats dotted keys as field paths, unlike set", async () => {
    const env = sdkDb();
    await env.sdk.batch().update(env.ref, { "subscriptions.android": { status: "active" } }).commit();
    assert.ok(env.wires[0].update.fields.subscriptions.mapValue.fields.android.mapValue);
    assert.deepEqual(env.wires[0].updateMask.fieldPaths, ["subscriptions.android"]);
  });
  for (const platform of ["android", "ios"]) {
    await test(`${platform} dual-write has nested map and no literal top-level dotted key`, async () => {
      const env = sdkDb(); await dual(env, platform); shape(env, platform);
      assert.equal(env.data().subscriptionStatus, "active");
      assert.equal(env.data().entitlementUsable, true);
    });
    await test(`${platform} update preserves opposite OS by leaf merge mask`, async () => {
      const other = platform === "android" ? "ios" : "android";
      const prior = { status: "expired", expiryTime: Timestamp.fromMillis(1), transactionId: "other", marker: "retain" };
      const env = sdkDb({ subscriptions: { [other]: prior } });
      await dual(env, platform); shape(env, platform);
      assert.deepEqual(env.data().subscriptions[other], prior);
      assert.ok(env.wires.at(-1).updateMask.fieldPaths.every((p) => !p.startsWith(`subscriptions.${other}`)));
    });
  }
  await test("Google verification persistence block produces nested Android map", async () => {
    const env = sdkDb();
    const source = fs.readFileSync(require.resolve("./index"), "utf8");
    const from = source.indexOf("      const legacyUpdate = {", source.indexOf("exports.verifyGooglePlaySubscriptionPurchase"));
    const to = source.indexOf("      console.info(", from);
    assert.ok(from > 0 && to > from);
    const run = vm.runInNewContext(`(async () => {${source.slice(from, to)}})`, {
      ...entitlement, verifiedStoreMetadata, admin: { ...admin, getDb: () => env.db }, uid: "user", purchaseToken: "test-token",
      linkedPurchaseToken: "", subscription: {}, subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      GOOGLE_PLAY_MONTHLY_PRODUCT_ID: "ohayo_kamome_monthly", expiryTime: expiry, now: FieldValue.serverTimestamp(), source: "google_verify", console: quiet });
    await run(); shape(env, "android");
  });
  await test("RTDN real persistence helper produces nested Android map", async () => {
    const env = sdkDb();
    await applyGoogleSubscriptionUpdateToUser(env.db, admin, "user", { status: "active", expiryTime: expiry,
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" }, "test-token", { logger: quiet });
    shape(env, "android");
  });
  await test("Apple verification real persistence helper produces nested iOS map", async () => {
    const env = sdkDb();
    const source = fs.readFileSync(require.resolve("./index"), "utf8");
    const from = source.indexOf("async function writeAppStoreVerifyUserUpdate(");
    const to = source.indexOf("\nfunction buildAppStoreVerifyInactiveUpdate", from);
    const run = vm.runInNewContext(`(${source.slice(from, to).trim()})`, {
      ...entitlement, admin: { ...admin, getDb: () => env.db } });
    await run({ uid: "user", update: { subscriptionStatus: "active", subscriptionExpiryTime: expiry,
      appStoreOriginalTransactionId: "test-original", appStoreTransactionId: "test-txn" }, log: quiet });
    shape(env, "ios");
  });
  await test("ASN real persistence helper produces nested iOS map", async () => {
    const env = sdkDb();
    await applyUserSubscriptionUpdate(env.db, admin, "user", { status: "active", expiresDate: expiry.toMillis(),
      originalTransactionId: "test-original", latestTransactionId: "test-txn", environment: "Sandbox", validationCode: "OK" },
      "app_store_notification_v2", { logger: quiet });
    shape(env, "ios");
  });
  await test("Legacy active fields alone do not satisfy primary nested shape assertion", async () => {
    const env = sdkDb({ subscriptionStatus: "active", subscriptionPlatform: "android" });
    assert.equal(env.data().subscriptions, undefined);
    await dual(env, "android"); shape(env, "android");
  });
  await test("Revision and confirmation invalidation remain with nested write", async () => {
    const env = sdkDb({ billingRevision: 8, billingConfirmation: { android: { coverage: "proof" }, ios: { state: "eligible" } } });
    await dual(env, "android");
    assert.equal(env.data().billingRevision, 9);
    assert.equal(env.data().billingConfirmation.android.state, "unknown");
    assert.equal(env.data().billingConfirmation.android.coverage, "proof");
    assert.equal(env.data().billingConfirmation.ios.state, "eligible");
  });
  console.log(`subscriptionPersistenceShape.test.js: ${count} tests passed (real SDK serializer/decoder, transport intercepted, no backend write)`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
