"use strict";
// Build 495 (owner decision 2026-10-31: anyone who can use the same Apple Account is treated as the same person).
// iPhone purchase verification: when the Apple series still belongs to another UID whose contract had ENDED before
// this purchase began, the requester's OWN purchase takes the series over right here, instead of being refused and
// recovered later through re-login + approval (transferActiveContractOwnership's case-10 recovery).
// The decision is the same Proof A / Proof B (evaluateExpiredReassignment) that the approved recovery uses, so a
// contract that is still usable is never moved. Without a proof nothing is written: the caller keeps the existing
// refusal (SUBSCRIPTION_ALREADY_LINKED) and the approval recovery stays available.
const { buildIosOwnershipId, expiredPreviousOwnerUpdate, identifierSuffix, SUBSCRIPTION_OWNERSHIP_COLLECTION } = require("./subscriptionOwnership");
const { evaluateExpiredReassignment } = require("./expiredOwnershipProof");

// Same detachment as the iPhone adapter of ownershipTransferAtomic.js (detachPreviousOwner): the previous owner keeps
// no pointer to the moved series, so a later request does not see them as "another owner" of it.
function detachIosSeries(update, previousData, admin) {
  const next = { ...update, appStoreOriginalTransactionId: admin.FieldValue.delete(), appStoreTransactionId: admin.FieldValue.delete() };
  if (next.subscriptions && next.subscriptions.ios) {
    next.subscriptions = { ...next.subscriptions, ios: { ...next.subscriptions.ios, originalTransactionId: admin.FieldValue.delete(), transactionIds: [] } };
  }
  if (Array.isArray(previousData.activePurchaseTokens)) {
    const ids = new Set([String(previousData.appStoreTransactionId || ""), String(previousData.subscriptions?.ios?.transactionId || "")].filter(Boolean));
    next.activePurchaseTokens = previousData.activePurchaseTokens.filter((token) => !ids.has(String(token)));
  }
  return next;
}

function safeLog(log, level, message, fields) {
  try { if (log && typeof log[level] === "function") log[level](message, fields); } catch (_) { /* diagnostics only */ }
}

async function reassignEndedIosSeriesToOwnPurchase(db, admin, { uid, transactionInfo, purchase, log, traceId, now = Date.now() }) {
  const original = String(transactionInfo?.originalTransactionId || "").trim();
  if (!uid || !original || purchase?.uidBound !== true || purchase?.active !== true) return { reassigned: false, code: "NOT_APPLICABLE" };
  const ownershipId = buildIosOwnershipId(original);
  const ownRef = db.collection(SUBSCRIPTION_OWNERSHIP_COLLECTION).doc(ownershipId);
  let result;
  try {
    result = await reassignInTransaction(db, admin, { uid, ownershipId, ownRef, purchase, now });
  } catch (error) {
    // e.g. the previous owner's record changed to another Active series meanwhile: keep the existing refusal.
    result = { reassigned: false, code: "REASSIGNMENT_NOT_APPLIED", errorType: error?.constructor?.name || typeof error };
  }
  safeLog(log, result.reassigned ? "info" : "warn", "subscription_ownership.own_purchase_reassignment", {
    event: "ownership.own_purchase_reassignment", occurredAt: new Date().toISOString(), billingTraceId: traceId || null,
    platform: "ios", requestUidSuffix: identifierSuffix(uid), ownershipIdSuffix: identifierSuffix(ownershipId),
    previousOwnerUidSuffix: result.ownerUid ? identifierSuffix(result.ownerUid) : null,
    reassigned: result.reassigned, code: result.code || null, evidence: result.evidence || null, errorType: result.errorType || null,
  });
  return { reassigned: result.reassigned, code: result.code || null };
}

function reassignInTransaction(db, admin, { uid, ownershipId, ownRef, purchase, now }) {
  return db.runTransaction(async (tx) => {
    const ownSnap = await tx.get(ownRef);
    const ownerUid = ownSnap.exists ? String(ownSnap.get("ownerUid") || "").trim() : "";
    if (!ownerUid || ownerUid === uid) return { reassigned: false, code: "NOT_APPLICABLE" };
    const yRef = db.collection("users").doc(uid);
    const xRef = db.collection("users").doc(ownerUid);
    const ySnap = await tx.get(yRef);
    const xSnap = await tx.get(xRef);
    const verdict = evaluateExpiredReassignment({
      userData: ySnap.exists ? ySnap.data() || {} : {}, platform: "ios",
      purchase: { active: true, accountTag: String(purchase.accountTag || ""), uidBound: true, purchasedAt: Number(purchase.purchasedAt) },
      ownershipId, ownerUid, ownerSnapshot: ownSnap, ownerUserSnapshot: xSnap, now,
    });
    if (!verdict.proof) return { reassigned: false, code: verdict.code || null, ownerUid };
    tx.set(ownRef, { ownerUid: uid, platform: "ios", status: "active", updatedAt: admin.FieldValue.serverTimestamp() }, { merge: true });
    if (xSnap.exists) {
      const xData = xSnap.data() || {};
      tx.set(xRef, detachIosSeries(expiredPreviousOwnerUpdate(xData, "ios", ownershipId, verdict.proof.expiryMs, admin, { transferred: false }), xData, admin),
        { merge: true });
    }
    return { reassigned: true, code: verdict.code, evidence: verdict.source || null, ownerUid };
  });
}

module.exports = { reassignEndedIosSeriesToOwnPurchase };
