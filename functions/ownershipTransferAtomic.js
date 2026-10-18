"use strict";
const { safeTrace, enforceOsDecision } = require("./osTransferGate");
// Atomic ownership transfer of an ACTIVE Store contract from UID X to UID Y.
//   Case 3: Android, same Google Play account.   Case 9: iPhone, same Apple Account.
// Dedicated path only: it skips the "is this device already registered" check (a brand-new UID has no
// registered device yet) but NOT the Store verification, the ownership proof, or any check used by the
// normal chat / purchase paths.
//
// All-or-nothing: ownership X->Y, X marked transferred, Y's contract record and Y's device registration are
// written in ONE transaction, or nothing is written. If Y already uses another device, replacing it needs the
// user's explicit approval (`confirmDeviceReplacement`), otherwise nothing is changed.
const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const { extractRequestDeviceId } = require("./activeDeviceGate");
const { resolveVerifiedClientPlatform, verifiedDevicePlatformFields } = require("./devicePlatformAppCheck");
const { platformFromAppCheckAppId } = require("./appCheckPlatform");
const {
  SUBSCRIPTION_ALREADY_LINKED_CODE,
  SUBSCRIPTION_OWNERSHIP_COLLECTION,
  buildAndroidOwnershipId,
  buildIosOwnershipId,
  hashIdentifier,
  expiredPreviousOwnerUpdate,
  isSubscriptionOwnerCurrentlyUsable,
} = require("./subscriptionOwnership");
const { evaluateOwnershipTransferProof, evaluateExpiredReassignment, fingerprint: snapshotDigest } = require("./expiredOwnershipProof");
const {
  buildAndroidStoreState, buildIosStoreState, inferAndroidAutoRenewing, commitUserSubscriptionDualWrite,
} = require("./subscriptionEntitlement");
const { googleState, verifiedStoreMetadata } = require("./preChatBillingConfirmation");

const CODES = {
  notActive: "OWNERSHIP_TRANSFER_CONTRACT_NOT_ACTIVE",
  notApplicable: "OWNERSHIP_TRANSFER_NOT_APPLICABLE",
  linkedUnsupported: "OWNERSHIP_TRANSFER_LINKED_UNSUPPORTED",
  platformUnsupported: "OWNERSHIP_TRANSFER_PLATFORM_UNSUPPORTED",
  contractWriteSkipped: "OWNERSHIP_TRANSFER_CONTRACT_WRITE_SKIPPED",
  deviceConfirmationRequired: "OWNERSHIP_TRANSFER_DEVICE_CONFIRMATION_REQUIRED",
  seriesMismatch: "OWNERSHIP_TRANSFER_SERIES_MISMATCH",
  proofMissing: "OWNERSHIP_TRANSFER_PROOF_MISSING",
  proofMismatch: "OWNERSHIP_TRANSFER_PROOF_MISMATCH",
  notPurchased: "OWNERSHIP_TRANSFER_NOT_PURCHASED_OWNERSHIP",
  rateLimited: "OWNERSHIP_TRANSFER_RATE_LIMITED",
};

// Per-UID failure limiter (both OS): repeated refusals are throttled.
// 5 refusals inside 15 minutes lock the UID for 15 minutes; the lock lifts by itself, a success clears the counter.
const FAILURE_COLLECTION = "ownership_transfer_failures";
const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_LOCK_MS = 15 * 60 * 1000;

const refuse = (code) => new HttpsError("failed-precondition", code, { code });
// Diagnostics never carry raw identifiers: a short one-way hash is the correlation id.
const shortId = (value) => crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 10);
const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");

// ------------------------------------------------------------------------------------------------
// Diagnostics helpers (read-only). They never change a decision, never throw, and carry no identifiers or tokens.
// ------------------------------------------------------------------------------------------------
const SAFE_PROOF_FACT_KEYS = ["nowAt", "purchaseStartedAt", "purchaseBoundToUid", "purchaseActive", "evidenceKind", "ownerRecordedStatus",
  "ownerUsableNow", "ownerUsabilitySource", "ownerRecordedEndedAt", "clientConfirmedProof"];
function safeProofFacts(facts) {
  const out = {};
  try {
    for (const key of SAFE_PROOF_FACT_KEYS) {
      const value = facts && facts[key];
      if (value === undefined) continue;
      out[key] = typeof value === "string" || typeof value === "boolean" || typeof value === "number" || value === null ? value : String(value);
    }
  } catch (_) { /* diagnostics only */ }
  return out;
}
function millisOf(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}
// Why Proof A (the pre-purchase record) would or would not apply. Booleans and ages only.
function describeProofAInputs({ userData, platform, ownershipId, ownerUid, ownerSnapshot, ownerUserSnapshot, purchasedAt, now }) {
  try {
    const confirmation = userData?.billingConfirmation?.[platform];
    const checkedAt = millisOf(confirmation?.checkedAt);
    const entry = Array.isArray(confirmation?.expiredForeignSeries)
      ? confirmation.expiredForeignSeries.find((item) => item && item.ownershipId === ownershipId && item.ownerUid === ownerUid) : null;
    return {
      hasRecord: Boolean(confirmation),
      stateEligible: confirmation?.state === "eligible",
      reasonOk: confirmation?.reason === "verified_current_series_ended",
      recordAgeSec: Number.isFinite(checkedAt) ? Math.round((now - checkedAt) / 1000) : null,
      withinWindow: Number.isFinite(checkedAt) ? now - checkedAt >= 0 && now - checkedAt <= 15 * 60 * 1000 : false,
      purchaseAfterRecord: Number.isFinite(checkedAt) && Number.isFinite(purchasedAt) ? purchasedAt >= checkedAt : false,
      hasForeignSeriesEntry: Boolean(entry),
      ownershipUnchanged: Boolean(entry && ownerSnapshot && entry.fingerprint === snapshotDigest(ownerSnapshot)),
      previousOwnerRecordUnchanged: Boolean(entry && ownerUserSnapshot && entry.ownerUserFingerprint === snapshotDigest(ownerUserSnapshot)),
    };
  } catch (_) {
    return { error: true };
  }
}

// ------------------------------------------------------------------------------------------------
// Shared core
// ------------------------------------------------------------------------------------------------
// adapter: { platform, parse(data) -> {identity}, verify({identity, nowMs, log}) -> verified }
// verified: { ownershipId, accountTag, uidBoundOf(uid, yData), yPrimaryOwnershipId(yData), ownershipFields,
//             boundSeries, writeYContract({tx, uid, now, log}) -> dualWriteResult, detachPreviousOwner(update, xData) }
function createTransferHandler({ admin, logger = console, adapter, nowMs = () => Date.now() }) {
  return async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign-in is required.");
    if (!request.app) throw new HttpsError("failed-precondition", "App Check required.");
    const data = request.data || {};

    const platform = resolveVerifiedClientPlatform(request, data.platform || adapter.platform);
    if (platform !== adapter.platform) throw refuse(CODES.platformUnsupported);
    const device = extractRequestDeviceId(data);
    if (!device.ok) throw new HttpsError("invalid-argument", "deviceId must be a valid UUID.", { code: device.code });
    const deviceId = device.deviceId;
    const { identity, proof } = adapter.parse(data);
    const billingTraceId = typeof data.billingTraceId === "string" && data.billingTraceId.length <= 64 ? data.billingTraceId : null;
    const confirmDeviceReplacement = data.confirmDeviceReplacement === true;

    // The shared dual-write helper logs directly; hand it a logger that can never throw.
    const safeLogger = {
      info: (...args) => { try { (logger.info || (() => {})).apply(logger, args); } catch (_) { /* diagnostics only */ } },
      warn: (...args) => { try { (logger.warn || (() => {})).apply(logger, args); } catch (_) { /* diagnostics only */ } },
      error: (...args) => { try { (logger.error || (() => {})).apply(logger, args); } catch (_) { /* diagnostics only */ } },
    };
    const startedAt = nowMs();
    let stage = "request";
    // Diagnostics only: never throws, never changes the outcome, never carries tokens or raw ids.
    const log = (level, event, fields = {}) => {
      try {
        (logger[level] || logger.info).call(logger, `OWNERSHIP_TRANSFER ${event}`, { platform: adapter.platform, billingTraceId,
          uid: shortId(uid), device: shortId(deviceId), stage, elapsedMs: nowMs() - startedAt, ...fields });
      } catch (_) { /* diagnostics only */ }
    };
    log("info", "request_received", { confirmDeviceReplacement });

    // 0. Failure limiter (adapter opt-in). A locked UID is refused before any Store call; nothing is changed.
    const limiterRef = adapter.failureLimit ? admin.getDb().collection(FAILURE_COLLECTION).doc(uid) : null;
    if (limiterRef) {
      let lockedUntilMs = 0;
      try { lockedUntilMs = Number((await limiterRef.get()).get("lockedUntilMs")) || 0; } catch (_) { /* limiter read is best effort */ }
      if (lockedUntilMs > nowMs()) {
        log("warn", "rate_limited", { retryAfterSec: Math.ceil((lockedUntilMs - nowMs()) / 1000) });
        throw new HttpsError("resource-exhausted", CODES.rateLimited, { code: CODES.rateLimited });
      }
    }
    const recordFailure = async (code) => {
      if (!limiterRef || !adapter.countedFailureCodes.has(code)) return;
      try {
        const now = nowMs();
        await admin.getDb().runTransaction(async (tx) => {
          const snap = await tx.get(limiterRef);
          const prev = snap.exists ? snap.data() || {} : {};
          const fresh = now - Number(prev.windowStartMs || 0) <= FAILURE_WINDOW_MS && Number(prev.windowStartMs) > 0;
          const count = (fresh ? Number(prev.count) || 0 : 0) + 1;
          const next = { count, windowStartMs: fresh ? Number(prev.windowStartMs) : now, lockedUntilMs: count >= FAILURE_LIMIT ? now + FAILURE_LOCK_MS : 0, updatedAt: now };
          tx.set(limiterRef, next);
          log("warn", "failure_recorded", { code, count, locked: next.lockedUntilMs > 0 });
        });
      } catch (_) { /* the limiter never changes the outcome of the request */ }
    };
    const clearFailures = async () => {
      if (!limiterRef) return;
      try { await limiterRef.delete(); } catch (_) { /* best effort */ }
    };
    const codeOf = (error) => (error && error.details && error.details.code) || (error && error.code) || "error";

    // 1. Strict Store verification (outside the transaction). Any failure changes nothing.
    stage = "store_verify";
    log("info", "verify_start");
    let verified;
    try {
      verified = await adapter.verify({ identity, proof, nowMs, log });
    } catch (error) {
      if (error instanceof HttpsError) { await recordFailure(codeOf(error)); throw error; }
      log("warn", "verify_failed", { errorType: error?.constructor?.name || typeof error });
      throw new HttpsError("failed-precondition", "Could not verify the Store purchase.");
    }
    log("info", "verify_result", { state: "active" });
    const { ownershipId, accountTag } = verified;

    // 2. One atomic transaction. Every read happens before the first write.
    const db = admin.getDb();
    const ownRef = db.collection(SUBSCRIPTION_OWNERSHIP_COLLECTION).doc(ownershipId);
    const yRef = db.collection("users").doc(uid);
    const deviceRef = yRef.collection("devices").doc(deviceId);
    stage = "transaction";
    log("info", "transaction_begin", { ownership: shortId(ownershipId) });
    let result;
    try {
      result = await db.runTransaction(async (tx) => {
        const ownSnap = await tx.get(ownRef);
        if (!ownSnap.exists) throw refuse(CODES.notApplicable);
        const ownerUid = String(ownSnap.get("ownerUid") || "").trim();
        if (!ownerUid) throw refuse(CODES.notApplicable);
        const ySnap = await tx.get(yRef);
        const deviceSnap = await tx.get(deviceRef);
        const yData = ySnap.exists ? ySnap.data() || {} : {};
        const alreadyOwner = ownerUid === uid;
        let xRef = null;
        let xSnap = null;
        if (!alreadyOwner) {
          xRef = db.collection("users").doc(ownerUid);
          xSnap = await tx.get(xRef);
        }

        // Y must not already hold a different usable contract on this OS.
        const yPrimary = verified.yPrimaryOwnershipId(yData);
        const yUsable = isSubscriptionOwnerCurrentlyUsable(yData, adapter.platform, new Date(nowMs())).ownerCurrentlyUsable;
        if (yUsable && (!yPrimary || yPrimary !== ownershipId)) {
          throw new HttpsError("failed-precondition", SUBSCRIPTION_ALREADY_LINKED_CODE, { code: SUBSCRIPTION_ALREADY_LINKED_CODE });
        }

        // Ownership proof (re-evaluated inside the transaction): Store-verified ACTIVE and the purchase carries the
        // requester's own tag or the tag of the current owner's record. Anything else is refused.
        let proofCode = alreadyOwner ? "already_owner" : "none";
        let previousOwnerUpdate = null;
        if (!alreadyOwner) {
          const purchase = { active: true, accountTag, uidBound: verified.uidBoundOf(uid, yData), ...(verified.proofFacts || {}) };
          log("info", "proof_inputs", { requesterTagMatchesAppleTag: purchase.uidBound === true,
            previousOwnerRecordExists: Boolean(xSnap && xSnap.exists), purchaseTimeKnown: Number.isFinite(Number(purchase.purchasedAt)) });
          let verdict = evaluateOwnershipTransferProof({
            platform: adapter.platform,
            purchase,
            ownerUid,
            ownerSnapshot: ownSnap,
            ownerUserSnapshot: xSnap,
            now: nowMs(),
          });
          log("info", "proof_c_result", { allowed: Boolean(verdict.proof), code: verdict.code || null });
          // Case 10 recovery (adapter opt-in, iPhone only): the requester's OWN purchase made after the previous owner's
          // contract had ended. This never moves a contract that is still usable: it needs the same Proof A or Proof B
          // that the normal purchase verification uses (previous owner ended before the purchase began).
          let ownPurchaseRecovery = false;
          if (!verdict.proof && adapter.ownPurchaseRecovery === true && purchase.uidBound === true) {
            const recovery = evaluateExpiredReassignment({
              userData: yData, platform: adapter.platform,
              purchase: { active: true, accountTag, uidBound: true, purchasedAt: Number(purchase.purchasedAt) },
              ownershipId, ownerUid, ownerSnapshot: ownSnap, ownerUserSnapshot: xSnap, now: nowMs(),
            });
            verdict = { proof: recovery.proof, code: recovery.code || verdict.code };
            ownPurchaseRecovery = Boolean(recovery.proof);
            log("info", "own_purchase_recovery_eval", { allowed: ownPurchaseRecovery, code: recovery.code || null, evidence: recovery.source || null,
              facts: safeProofFacts(recovery.facts),
              proofA: describeProofAInputs({ userData: yData, platform: adapter.platform, ownershipId, ownerUid, ownerSnapshot: ownSnap,
                ownerUserSnapshot: xSnap, purchasedAt: Number(purchase.purchasedAt), now: nowMs() }) });
            if (ownPurchaseRecovery) log("info", "own_purchase_recovery", { evidence: recovery.source || null });
          }
          proofCode = verdict.code;
          if (!verdict.proof) log("warn", "ownership_proof_refused", { proofCode: verdict.code });
          if (!verdict.proof) throw new HttpsError("failed-precondition", SUBSCRIPTION_ALREADY_LINKED_CODE, { code: SUBSCRIPTION_ALREADY_LINKED_CODE, proofCode });
          if (xSnap.exists) {
            previousOwnerUpdate = verified.detachPreviousOwner(
              expiredPreviousOwnerUpdate(xSnap.data() || {}, adapter.platform, ownershipId, verdict.proof.expiryMs, admin, { transferred: !ownPurchaseRecovery }),
              xSnap.data() || {});
          }
        }

        // Device decision. If Y already uses another device, replacing it needs the user's explicit approval
        // (sent by the app only after the "use this phone" dialog). Without it NOTHING is changed.
        const activeDeviceId = String(yData.activeDeviceId || "").trim();
        const activeOsSnap = activeDeviceId ? await tx.get(yRef.collection("devices").doc(activeDeviceId)) : null;
        enforceOsDecision({ logger: safeLogger, path: "ownership_transfer", uid, deviceId, activeDeviceId,
          deviceData: activeOsSnap?.exists ? activeOsSnap.data() : null, currentOs: adapter.platform,
          traceId: safeTrace(request.data?.osGateTraceId) });
        const otherActiveDevice = Boolean(activeDeviceId) && activeDeviceId !== deviceId;
        if (otherActiveDevice && !confirmDeviceReplacement) log("warn", "device_confirmation_decision", { frameStage: "judgment",
          uidRelation: alreadyOwner ? "already_owner" : "different_owner_uid",
          hasRegisteredDevice: Boolean(activeDeviceId),
          localMatchesRegistered: activeDeviceId === deviceId,
          requiresDeviceReplacementConsent: otherActiveDevice,
          consentProvided: confirmDeviceReplacement,
          nextAction: otherActiveDevice && !confirmDeviceReplacement ? "refuse" : "atomic_commit" });
        if (otherActiveDevice && !confirmDeviceReplacement) throw refuse(CODES.deviceConfirmationRequired);

        const now = admin.FieldValue.serverTimestamp();
        const dual = await verified.writeYContract({ tx, uid, now, log: safeLogger });
        // The contract record was not written (e.g. an older observation): abort everything.
        if (dual && dual.reconcileWriteSkipped) throw refuse(CODES.contractWriteSkipped);

        // Remaining writes (no more reads after this point).
        if (!alreadyOwner) {
          tx.set(ownRef, { ownerUid: uid, platform: adapter.platform, status: "active", updatedAt: now, ...verified.ownershipFields }, { merge: true });
          if (previousOwnerUpdate) tx.set(xRef, previousOwnerUpdate, { merge: true });
        }
        tx.set(yRef, { boundSubscriptionSeries: { [adapter.platform]: { ownershipId, boundAt: now, ...(verified.boundSeries || {}) } } }, { merge: true });
        // B becomes Y's device in the same commit (clearing any pending claim also invalidates stale confirms).
        // Required fields only: id, platform + App Check verification (used by the recipient-platform lookup), timestamps.
        // Model / version strings are record-only (analytics) and are filled by the existing device usage report.
        tx.set(yRef, { activeDeviceId: deviceId, activeDeviceUpdatedAt: now, pendingActiveDeviceId: "", pendingActiveClaimGeneration: 0 }, { merge: true });
        const deviceUpdate = { deviceId, ...verifiedDevicePlatformFields(adapter.platform), lastUsedAt: now };
        if (!deviceSnap.exists) deviceUpdate.firstUsedAt = now;
        tx.set(deviceRef, deviceUpdate, { merge: true });
        return { transferred: !alreadyOwner, deviceRegistered: true, replacedPreviousDevice: otherActiveDevice, proofCode,
          previousOwnerUpdated: Boolean(previousOwnerUpdate), activeDeviceChanged: activeDeviceId !== deviceId };
      });
    } catch (error) {
      const proofCode = (error && error.details && error.details.proofCode) || null;
      safeLogger.info("KAMOME_BILLING_OS_GATE", { event: "OS_GATE_2_TRANSACTION_ABORT", osGateTraceId: safeTrace(request.data?.osGateTraceId), path: "ownership_transfer", transactionResult: "aborted", activeDeviceChanged: false, ownershipChanged: false, notificationChanged: false, oldDeviceStopIssued: false, effectsScope: "this_transaction_only", errorCode: codeOf(error), endedAt: new Date().toISOString() });
      log("warn", "transaction_rejected", { code: codeOf(error), proofCode });
      // Refused proofs and unknown series count as failures (not network / conflict / device-consent errors).
      if (proofCode) await recordFailure("PROOF_REFUSED");
      else await recordFailure(codeOf(error));
      throw error;
    }
    safeLogger.info("KAMOME_BILLING_OS_GATE", { event: "OS_GATE_2_COMMIT", osGateTraceId: safeTrace(request.data?.osGateTraceId), path: "ownership_transfer", transactionResult: "committed", activeDeviceChanged: result.activeDeviceChanged, ownershipChanged: result.transferred, oldDeviceStopStatus: result.replacedPreviousDevice ? "awaiting_client_observation" : "not_required" });
    await clearFailures();

    stage = "committed";
    log("info", "transaction_committed", { transferred: result.transferred, deviceRegistered: result.deviceRegistered,
      replacedPreviousDevice: result.replacedPreviousDevice, proofCode: result.proofCode, idempotentRetry: !result.transferred,
      ownershipMoved: result.transferred, previousOwnerUpdated: result.previousOwnerUpdated, contractWritten: true });
    return { success: true, transferred: result.transferred, deviceRegistered: result.deviceRegistered,
      replacedPreviousDevice: result.replacedPreviousDevice };
  };
}

// ------------------------------------------------------------------------------------------------
// Android adapter (case 3)
// ------------------------------------------------------------------------------------------------
function createAndroidAdapter({ admin, verifyGoogle = null }) {
  const googlePlay = () => require("./googlePlaySubscriptionNotifications");
  return {
    platform: "android",
    // Same per-UID failure limiter as the iPhone adapter (the purchase token is the only evidence on Android).
    failureLimit: true,
    countedFailureCodes: new Set([CODES.notActive, CODES.notApplicable, "PROOF_REFUSED"]),
    parse(data) {
      const purchaseToken = String(data.purchaseToken || "").trim();
      if (!purchaseToken) throw new HttpsError("invalid-argument", "purchaseToken is required.");
      const { GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_PLAY_MONTHLY_PRODUCT_ID } = googlePlay();
      if (String(data.productId || "").trim() !== GOOGLE_PLAY_MONTHLY_PRODUCT_ID) throw new HttpsError("invalid-argument", "Unexpected product ID.");
      if (String(data.packageName || GOOGLE_PLAY_PACKAGE_NAME).trim() !== GOOGLE_PLAY_PACKAGE_NAME) throw new HttpsError("invalid-argument", "Unexpected package name.");
      return { identity: purchaseToken };
    },
    async verify({ identity: purchaseToken, nowMs, log }) {
      const { GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_PLAY_MONTHLY_PRODUCT_ID, deriveGooglePlayEntitlement,
        syncGooglePlaySubscriptionByPurchaseToken } = googlePlay();
      const observed = await (verifyGoogle ? verifyGoogle(purchaseToken) : syncGooglePlaySubscriptionByPurchaseToken(GOOGLE_PLAY_PACKAGE_NAME, purchaseToken));
      const subscription = observed.subscription || {};
      const matchedLineItem = observed.matchedLineItem;
      const storeObservedAtMs = observed.storeObservedAtMs || nowMs();
      const derived = deriveGooglePlayEntitlement({ subscription, matchedLineItem, now: new Date(nowMs()) });
      if (googleState(subscription, matchedLineItem, nowMs()) !== "active" || derived.status !== "active") {
        log("warn", "rejected", { reason: "contract_not_active", subscriptionState: subscription.subscriptionState || "" });
        throw refuse(CODES.notActive);
      }
      const linkedToken = String(subscription.linkedPurchaseToken || "").trim();
      if (linkedToken && linkedToken !== purchaseToken) {
        log("warn", "rejected", { reason: "linked_token_unsupported" });
        throw refuse(CODES.linkedUnsupported);
      }
      const accountTag = String(subscription.externalAccountIdentifiers?.obfuscatedExternalAccountId || "");
      const expiryTime = matchedLineItem.expiryTime || null;
      const ownershipId = buildAndroidOwnershipId(purchaseToken);
      const subscriptionState = subscription.subscriptionState || "";
      return {
        ownershipId,
        accountTag,
        uidBoundOf: (uid) => accountTag !== "" && accountTag === sha256Hex(`kamome-account:${uid}`),
        yPrimaryOwnershipId: (yData) => {
          const primary = String(yData.subscriptions?.android?.primaryPurchaseToken || yData.googlePlayPrimaryPurchaseToken || "").trim();
          return primary ? buildAndroidOwnershipId(primary) : "";
        },
        ownershipFields: { productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID, googlePurchaseTokenHash: hashIdentifier(purchaseToken), googleLinkedPurchaseTokenHash: "" },
        boundSeries: {},
        detachPreviousOwner: (update) => update, // expiredPreviousOwnerUpdate already detaches Android tokens
        async writeYContract({ tx, uid, now, log: dualLog }) {
          const legacyUpdate = {
            subscriptionStatus: "active",
            subscriptionProductId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
            subscriptionExpiryTime: expiryTime,
            subscriptionPlatform: "android",
            activePurchaseTokens: admin.FieldValue.arrayUnion(purchaseToken),
            googlePlayPrimaryPurchaseToken: purchaseToken,
            lastSubscriptionSource: "ownership_transfer",
            lastSubscriptionCheckedAt: now,
            updatedAt: now,
            googlePlaySubscriptionState: subscriptionState,
            googlePlayLinkedPurchaseToken: "",
            googlePlayAcknowledgementState: subscription.acknowledgementState || "unknown",
          };
          const storeState = buildAndroidStoreState({
            expirySource: derived.expirySource, normalExpiryTime: derived.normalExpiryTime, graceExpiryTime: derived.graceExpiryTime,
            storeObservedAtMs, status: "active", expiryTime,
            autoRenewing: inferAndroidAutoRenewing({ status: "active", subscriptionState }),
            primaryPurchaseToken: purchaseToken, subscriptionState, source: "google_play_ownership_transfer", updatedAt: now,
          });
          Object.assign(storeState, verifiedStoreMetadata("android", { subscription }, now));
          storeState.activePurchaseTokens = [purchaseToken];
          return commitUserSubscriptionDualWrite({ db: admin.getDb(), admin, uid, source: "ownership_transfer", platform: "android",
            storeState, legacyUpdate, log: dualLog, meta: { purchaseToken }, externalTx: tx });
        },
      };
    },
  };
}

// ------------------------------------------------------------------------------------------------
// iOS adapter (case 9)
// ------------------------------------------------------------------------------------------------
// verifyApple(originalTransactionId) -> entries (signature-verified App Store Server API data, same shape as
// preChatBillingConfirmation.verifyAppleSeries). buildActiveUpdate is the iOS verification handler's own
// builder (injected, so the contract record is built exactly like a normal Apple verification).
function createIosAdapter({ admin, verifyApple, buildActiveUpdate }) {
  const common = () => require("./appStoreServerCommon");
  return {
    platform: "ios",
    failureLimit: true,
    // Case 10: also accept the requester's own new purchase when the previous owner's contract had ended before it.
    ownPurchaseRecovery: true,
    countedFailureCodes: new Set([CODES.seriesMismatch, CODES.proofMissing, CODES.proofMismatch, CODES.notPurchased, CODES.notApplicable, "PROOF_REFUSED"]),
    parse(data) {
      const { APP_STORE_PRODUCT_ID } = common();
      const originalTransactionId = String(data.originalTransactionId || "").trim();
      if (!originalTransactionId) throw new HttpsError("invalid-argument", "originalTransactionId is required.");
      if (String(data.productId || "").trim() !== APP_STORE_PRODUCT_ID) throw new HttpsError("invalid-argument", "Unexpected product ID.");
      // The StoreKit appAccountToken reported by THIS device (never logged). A bare transaction number is not enough.
      return { identity: originalTransactionId, proof: { clientTag: String(data.appAccountToken || "").trim().toLowerCase() } };
    },
    async verify({ identity, proof, nowMs, log }) {
      const { APP_STORE_PRODUCT_ID, deriveSubscriptionState } = common();
      const clientTag = proof && proof.clientTag ? proof.clientTag : "";
      if (!clientTag) {
        log("warn", "rejected", { reason: "device_proof_missing", clientTagPresent: false });
        throw refuse(CODES.proofMissing);
      }
      const appleStartedAt = nowMs();
      const entries = await verifyApple(identity);
      log("info", "apple_call", { elapsedMs: nowMs() - appleStartedAt, entries: Array.isArray(entries) ? entries.length : -1 });
      const mine = (Array.isArray(entries) ? entries : []).filter((e) => String(e?.originalTransactionId || e?.transaction?.originalTransactionId || "") === identity);
      if (!mine.length) {
        log("warn", "rejected", { reason: "series_mismatch" });
        throw refuse(CODES.seriesMismatch);
      }
      const entry = mine.reduce((a, b) => (Number(a.expiryMs) >= Number(b.expiryMs) ? a : b));
      const transaction = entry.transaction || {};
      if (entry.state !== "active" || transaction.productId !== APP_STORE_PRODUCT_ID || Number(transaction.revocationDate) > 0) {
        log("warn", "rejected", { reason: "contract_not_active", appleState: entry.state || "" });
        throw refuse(CODES.notActive);
      }
      const derived = deriveSubscriptionState(transaction, nowMs(), { appleStatus: entry.appleStatus, renewalInfo: entry.renewal });
      if (derived.status !== "active") {
        log("warn", "rejected", { reason: "contract_not_active", derivedStatus: derived.status || "" });
        throw refuse(CODES.notActive);
      }
      derived.environment = transaction.environment || derived.environment || "";
      derived.storeObservedAtMs = nowMs();
      log("info", "apple_series", { appleState: entry.state || "", appleStatus: Number(entry.appleStatus) || null, derivedStatus: derived.status || "",
        revoked: Number(transaction.revocationDate) > 0, purchaseAgeSec: Math.round((nowMs() - Number(transaction.purchaseDate)) / 1000),
        expiresInSec: Math.round((Number(transaction.expiresDate) - nowMs()) / 1000) });
      const accountTag = String(transaction.appAccountToken || "").trim().toLowerCase();
      const ownershipType = String(transaction.inAppOwnershipType || "").trim().toUpperCase();
      // Three-way check, part 1: the device's StoreKit tag must equal Apple's signed tag (part 2, the owner's record, runs in the transaction).
      const clientMatchesApple = accountTag !== "" && clientTag === accountTag;
      log("info", "verify_proof", { clientTagPresent: true, appleTagPresent: accountTag !== "", clientMatchesApple, ownershipType: ownershipType || "unknown" });
      if (!clientMatchesApple) throw refuse(CODES.proofMismatch);
      if (ownershipType !== "PURCHASED") throw refuse(CODES.notPurchased);
      const originalTransactionId = String(transaction.originalTransactionId || identity);
      const ownershipId = buildIosOwnershipId(originalTransactionId);
      const update = buildActiveUpdate({ derived, environment: derived.environment, transactionInfo: transaction, lookupTransactionId: transaction.transactionId });
      return {
        ownershipId,
        accountTag,
        // The requester's own tag never authorises moving someone else's ACTIVE contract (the owner-tag proof above).
        // It only marks the purchase as the requester's own, which the case-10 recovery combines with Proof A/B.
        uidBoundOf: (_uid, yData) => accountTag !== "" && accountTag === String(yData?.appStoreAppAccountToken || "").trim().toLowerCase(),
        proofFacts: { proofVerified: true, ownershipType, purchasedAt: Number(transaction.purchaseDate) },
        yPrimaryOwnershipId: (yData) => {
          const raw = String(yData.subscriptions?.ios?.originalTransactionId || yData.appStoreOriginalTransactionId || "").trim();
          return raw ? buildIosOwnershipId(raw) : "";
        },
        ownershipFields: { productId: APP_STORE_PRODUCT_ID, appStoreOriginalTransactionId: originalTransactionId,
          appStoreTransactionId: String(update.appStoreTransactionId || transaction.transactionId || ""), appAccountToken: accountTag },
        boundSeries: { originalTransactionId },
        // X keeps no pointer to the moved series (a later Y request must not see X as "another owner" of it).
        detachPreviousOwner: (xUpdate, xData) => {
          const next = { ...xUpdate, appStoreOriginalTransactionId: admin.FieldValue.delete(), appStoreTransactionId: admin.FieldValue.delete() };
          if (next.subscriptions && next.subscriptions.ios) {
            next.subscriptions = { ...next.subscriptions, ios: { ...next.subscriptions.ios, originalTransactionId: admin.FieldValue.delete(), transactionIds: [] } };
          }
          if (Array.isArray(xData.activePurchaseTokens)) {
            const ids = new Set([String(xData.appStoreTransactionId || ""), String(xData.subscriptions?.ios?.transactionId || "")].filter(Boolean));
            next.activePurchaseTokens = xData.activePurchaseTokens.filter((token) => !ids.has(String(token)));
          }
          return next;
        },
        async writeYContract({ tx, uid, now, log: dualLog }) {
          const storeState = buildIosStoreState({
            ...update._storeDeadlines,
            status: update.subscriptionStatus,
            expiryTime: update.subscriptionExpiryTime || null,
            autoRenewing: null,
            originalTransactionId: update.appStoreOriginalTransactionId || "",
            transactionId: update.appStoreTransactionId || "",
            environment: update.appStoreEnvironment || "",
            source: "app_store_ownership_transfer",
            updatedAt: now,
          });
          Object.assign(storeState, update.appStoreVerifiedMetadata || {});
          storeState.transactionIds = [update.appStoreTransactionId].filter(Boolean);
          const { appStoreVerifiedMetadata: _metadata, _storeDeadlines, ...legacyUpdate } = update;
          legacyUpdate.lastSubscriptionSource = "ownership_transfer";
          return commitUserSubscriptionDualWrite({ db: admin.getDb(), admin, uid, source: "ownership_transfer", platform: "ios", storeState,
            legacyUpdate, log: dualLog, meta: { transactionId: update.appStoreTransactionId || "", originalTransactionId: update.appStoreOriginalTransactionId || "" },
            externalTx: tx });
        },
      };
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Public factories
// ------------------------------------------------------------------------------------------------
// Case 3 (Android). Kept with its original signature.
function createTransferActiveContractOwnershipHandler({ admin, logger = console, verifyGoogle = null, nowMs = () => Date.now() }) {
  return createTransferHandler({ admin, logger, nowMs, adapter: createAndroidAdapter({ admin, verifyGoogle }) });
}

// Case 9 (iPhone).
function createTransferActiveContractOwnershipIosHandler({ admin, logger = console, verifyApple, buildActiveUpdate, nowMs = () => Date.now() }) {
  return createTransferHandler({ admin, logger, nowMs, adapter: createIosAdapter({ admin, verifyApple, buildActiveUpdate }) });
}

// One callable for both OSs: the OS is taken from the verified App Check app id, never from the request body.
function createTransferActiveContractOwnershipDispatcher({ android, ios }) {
  return async (request) => {
    const platform = platformFromAppCheckAppId(request && request.app && request.app.appId);
    if (platform === "ios") return ios(request);
    if (platform === "android") return android(request);
    throw new HttpsError("failed-precondition", "UNKNOWN_APP_ID", { code: "UNKNOWN_APP_ID" });
  };
}

module.exports = {
  createTransferActiveContractOwnershipHandler,
  createTransferActiveContractOwnershipIosHandler,
  createTransferActiveContractOwnershipDispatcher,
  OWNERSHIP_TRANSFER_CODES: CODES,
};
