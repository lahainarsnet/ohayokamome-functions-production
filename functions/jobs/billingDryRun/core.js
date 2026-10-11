"use strict";
const crypto = require("node:crypto");
const fixed = require("./config");
const { syncGooglePlaySubscriptionByPurchaseToken, GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
  deriveGooglePlayEntitlement } = require("../../googlePlaySubscriptionNotifications");
const { inspectSubscriptionSeriesOwnership, buildAndroidOwnershipId } = require("../../subscriptionOwnership");
const { commitUserSubscriptionDualWrite, buildAndroidStoreState, inferAndroidAutoRenewing,
  computeAccountEntitlement, deriveLegacyAccountFields } = require("../../subscriptionEntitlement");
const { googleState, billingRevision, verifiedStoreMetadata } = require("../../preChatBillingConfirmation");
const quiet = { info() {}, warn() {}, error() {}, log() {} };
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function canonical(v) {
  if (v?.toMillis) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
const fingerprint = (value) => hash(JSON.stringify(canonical(value)));
function expiry(value) {
  const converted = canonical(value);
  const ms = typeof converted === "number" ? converted : Date.parse(converted);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function fail(code) { const error = new Error(code); error.safeCode = code; throw error; }
function readOnlyDb(db) {
  const forbidden = new Set(["set", "update", "create", "delete", "add", "batch", "bulkWriter", "runTransaction", "recursiveDelete"]);
  function wrap(value) {
    if (!value || typeof value !== "object" || value instanceof Date || value.toMillis) return value;
    return new Proxy(value, { get(target, key) {
      if (forbidden.has(key)) return () => fail("dry_run_write_forbidden");
      const item = Reflect.get(target, key, target);
      if (typeof item !== "function") return wrap(item);
      if (key === "data") return item.bind(target);
      return (...args) => {
        const result = item.apply(target, args);
        return result && typeof result.then === "function" ? result.then(wrap) : wrap(result);
      };
    } });
  }
  return wrap(db);
}
function validate(request) {
  if (request.uid !== fixed.uid || request.platform !== fixed.platform || request.project !== fixed.project ||
    request.expectedRevision !== fixed.expectedRevision || request.mode !== "dry-run") fail("fixed_scope_violation");
}
const operationId = () => hash(`subscription-shape-v1:${fixed.uid}:${fixed.platform}:${fixed.expectedRevision}`);
function summary(extra) { return { operationId: operationId(), uidSuffix: fixed.uid.slice(-6), platform: fixed.platform,
  expectedRevision: fixed.expectedRevision, dryRun: true, ...extra }; }
function sameSnapshot(snap, expected) {
  return snap.exists && fingerprint(snap.data()) === expected.dataHash &&
    canonical(snap.updateTime) === expected.updateTime;
}
async function prepare({ db, admin, verify = syncGooglePlaySubscriptionByPurchaseToken,
  inspect = inspectSubscriptionSeriesOwnership, request = fixed, audit = {} }) {
  validate(request);
  db = readOnlyDb(db);
  const userRef = db.collection("users").doc(fixed.uid);
  const opRef = db.collection("subscriptionShapeRepairOperations").doc(operationId());
  const [user, operation] = await Promise.all([userRef.get(), opRef.get()]);
  if (operation.exists) {
    if (operation.get("state") === "completed" && operation.get("uid") === fixed.uid &&
      operation.get("expectedRevision") === fixed.expectedRevision) return { alreadyCompleted: true, output: summary({ ...audit, result: "already_completed" }) };
    fail("operation_conflict");
  }
  if (!user.exists) fail("user_missing");
  const data = user.data();
  Object.assign(audit, { currentRevision: Number(data.billingRevision || 0), wrongPresent: Object.hasOwn(data, "subscriptions.android"),
    nestedPresent: !!data.subscriptions?.android, wrongStatus: data["subscriptions.android"]?.status || "",
    wrongExpiry: expiry(data["subscriptions.android"]?.expiryTime), nestedStatus: data.subscriptions?.android?.status || "",
    nestedExpiry: expiry(data.subscriptions?.android?.expiryTime), legacyStatus: data.subscriptionStatus || "",
    legacyExpiry: expiry(data.subscriptionExpiryTime) });
  if (Number(data.billingRevision || 0) !== fixed.expectedRevision) fail("revision_changed");
  if (data.accountDeletionState) fail("account_deleted");
  const wrong = data["subscriptions.android"];
  if (!wrong || typeof wrong !== "object" || Array.isArray(wrong)) fail("wrong_shape_missing");
  if (data.subscriptions !== undefined && (!data.subscriptions || typeof data.subscriptions !== "object" || Array.isArray(data.subscriptions))) fail("nested_schema_invalid");
  for (const saved of [wrong, data.subscriptions?.android]) {
    if (saved?.packageId && saved.packageId !== GOOGLE_PLAY_PACKAGE_NAME || saved?.productId && saved.productId !== GOOGLE_PLAY_MONTHLY_PRODUCT_ID) fail("stored_package_or_product_mismatch");
  }
  if (data.subscriptionProductId && data.subscriptionProductId !== GOOGLE_PLAY_MONTHLY_PRODUCT_ID) fail("stored_product_mismatch");
  const token = String(data.googlePlayPrimaryPurchaseToken || "").trim();
  if (!token || wrong.primaryPurchaseToken !== token ||
    (data.subscriptions?.android?.primaryPurchaseToken && data.subscriptions.android.primaryPurchaseToken !== token)) fail("token_missing_or_mismatch");
  const baseline = { dataHash: fingerprint(data), updateTime: canonical(user.updateTime), billingHash: billingRevision(data) };
  const owners = [], checked = [], seen = new Set();
  let current = token;
  while (current) {
    if (seen.has(current) || checked.length >= 5) fail("linked_series_limit");
    seen.add(current);
    const ownerRef = db.collection("subscription_ownership").doc(buildAndroidOwnershipId(current));
    const owner = await ownerRef.get();
    if (!owner.exists || owner.get("ownerUid") !== fixed.uid || owner.get("platform") !== "android" ||
      owner.get("productId") !== GOOGLE_PLAY_MONTHLY_PRODUCT_ID) fail("owner_mismatch_or_missing");
    const verified = await verify(GOOGLE_PLAY_PACKAGE_NAME, current);
    if (verified.matchedLineItem?.productId !== GOOGLE_PLAY_MONTHLY_PRODUCT_ID) fail("product_mismatch");
    const state = googleState(verified.subscription, verified.matchedLineItem);
    if (!["active", "ended"].includes(state)) fail("store_blocked_or_unknown");
    const linked = String(verified.subscription.linkedPurchaseToken || "").trim();
    const inspected = await inspect(db, { uid: fixed.uid, platform: "android", purchaseToken: current,
      linkedPurchaseToken: linked, log: quiet });
    if (inspected.decision !== "match") fail("series_owner_unconfirmed");
    owners.push({ ref: ownerRef, dataHash: fingerprint(owner.data()), updateTime: canonical(owner.updateTime) });
    checked.push({ ...verified, token: current, state });
    current = linked;
  }
  const recorded = [...(data.activePurchaseTokens || []), ...(wrong.activePurchaseTokens || []),
    ...(data.subscriptions?.android?.activePurchaseTokens || []), data.googlePlayLinkedPurchaseToken, wrong.linkedPurchaseToken].filter(Boolean);
  if (recorded.some(t => !seen.has(t))) fail("unresolved_saved_series");
  const freshUser = await userRef.get();
  if (!sameSnapshot(freshUser, baseline) || billingRevision(freshUser.data()) !== baseline.billingHash) fail("user_changed_during_check");
  for (const owner of owners) if (!sameSnapshot(await owner.ref.get(), owner)) fail("owner_changed_during_check");
  const primary = checked[0];
  if (primary.state === "ended" && checked.some(item => item.state !== "ended")) fail("linked_active_series");
  const derived = deriveGooglePlayEntitlement(primary);
  const timestamp = admin.FieldValue.serverTimestamp();
  const storeState = buildAndroidStoreState({ status: derived.status, expiryTime: derived.expiryTime,
    autoRenewing: inferAndroidAutoRenewing(derived), primaryPurchaseToken: token,
    activePurchaseTokens: checked.map(item => item.token), subscriptionState: primary.subscription.subscriptionState,
    source: "single_user_shape_repair", updatedAt: timestamp });
  Object.assign(storeState, verifiedStoreMetadata("android", primary, timestamp));
  const entitlement = computeAccountEntitlement(data.subscriptions?.ios, storeState);
  const legacy = deriveLegacyAccountFields(data.subscriptions?.ios, storeState, data, "android");
  return { userRef: db.collection("users").doc(fixed.uid), opRef, baseline, owners, createdAt: Date.now(),
    storeFingerprint: fingerprint(checked.map(item => ({ subscription: item.subscription, matchedLineItem: item.matchedLineItem }))),
    storeState, legacyUpdate: { ...legacy,
    googlePlayPrimaryPurchaseToken: token, googlePlayLinkedPurchaseToken: primary.subscription.linkedPurchaseToken || "",
    googlePlayAcknowledgementState: primary.subscription.acknowledgementState || "unknown" }, token,
    output: summary({ ...audit, result: "ready_no_write", currentRevision: Number(data.billingRevision), storeState: primary.state,
      ownerResult: "same_uid_all_series", checkedSeries: checked.length, nestedWouldBeCreated: !data.subscriptions?.android,
      entitlementWouldBeUsable: entitlement.entitlementUsable, wrongPresent: true, nestedPresent: !!data.subscriptions?.android,
      firestoreStatus: data.subscriptionStatus || "", verifiedStatus: derived.status, verifiedExpiry: derived.expiryTime,
      plannedRevision: fixed.expectedRevision + 1, plannedBillingConfirmation: "unknown", plannedConfirmationReason: "contract_changed_requires_recheck",
      plannedLegacyStatus: legacy.subscriptionStatus, plannedLegacyExpiry: expiry(legacy.subscriptionExpiryTime),
      plannedEntitlementExpiry: expiry(entitlement.entitlementExpiryTime), literalFieldDeletionPlanned: false }) };
}
async function dryRun(dependencies) {
  const audit = {};
  try { return (await prepare({ ...dependencies, audit })).output; }
  catch (error) { return summary({ ...audit, result: "blocked", reason: error.safeCode || "read_or_verification_failed" }); }
}
// Future repair adapter: deliberately not imported/called by production entry.
// It is testable now, but not an authorized runtime mode.
async function repairAdapter({ db, admin, plan, verify, inspect, commit = commitUserSubscriptionDualWrite }) {
  if (plan.alreadyCompleted) return { result: "already_completed" };
  if (!Number.isFinite(plan.createdAt) || Date.now() - plan.createdAt > 30000 || Date.now() < plan.createdAt) fail("repair_plan_stale");
  const refreshed = await prepare({ db, admin, verify, inspect });
  if (refreshed.alreadyCompleted) return { result: "already_completed" };
  if (refreshed.storeFingerprint !== plan.storeFingerprint) fail("store_changed_before_repair");
  let duplicate = false;
  const guardedDb = { collection: (...args) => db.collection(...args), runTransaction: (run) => db.runTransaction(async (tx) => {
    const opRef = db.collection("subscriptionShapeRepairOperations").doc(operationId());
    const userRef = db.collection("users").doc(fixed.uid);
    const op = await tx.get(opRef);
    if (op.exists) {
      if (op.get("state") === "completed" && op.get("uid") === fixed.uid && op.get("expectedRevision") === fixed.expectedRevision) {
        duplicate = true; fail("operation_already_completed");
      }
      fail("operation_conflict");
    }
    const user = await tx.get(userRef);
    if (!sameSnapshot(user, plan.baseline) || Number(user.data().billingRevision || 0) !== fixed.expectedRevision) fail("repair_revision_or_fingerprint_changed");
    for (const owner of plan.owners) if (!sameSnapshot(await tx.get(owner.ref), owner)) fail("repair_owner_changed");
    const result = await run(tx);
    tx.set(opRef, { state: "completed", uid: fixed.uid, platform: "android", expectedRevision: fixed.expectedRevision,
      sourceUserFingerprint: plan.baseline.dataHash, completedAt: admin.FieldValue.serverTimestamp() });
    return result;
  }) };
  try { await commit({ db: guardedDb, admin, uid: fixed.uid, platform: "android", source: "single_user_shape_repair",
    storeState: plan.storeState, legacyUpdate: plan.legacyUpdate, meta: { purchaseToken: plan.token }, log: quiet });
  } catch (error) { if (error.safeCode !== "operation_already_completed") throw error; }
  return { result: duplicate ? "already_completed" : "completed" };
}
module.exports = { fixed, fingerprint, operationId, readOnlyDb, prepare, dryRun, repairAdapter };
