"use strict";
const crypto = require("node:crypto");
function stable(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value === undefined ? null : value;
}
function fingerprint(snapshot) {
  return crypto.createHash("sha256").update(JSON.stringify(stable({ exists: snapshot.exists,
    data: snapshot.exists ? snapshot.data() : null }))).digest("hex");
}
// Proof A (pre-purchase): the PRE-CHAT confirmation recorded on the requesting user.
function getClientConfirmedProof({ userData, platform, purchase, ownershipId, ownerUid, ownerSnapshot, ownerUserSnapshot, kind = "subscription_ownership", now = Date.now() }) {
  const confirmation = userData?.billingConfirmation?.[platform];
  const checkedAt = stable(confirmation?.checkedAt);
  const purchasedAt = purchase?.purchasedAt;
  if (platform === "android" && purchase?.linkedOwnershipId === ownershipId && purchase?.linkedState !== "ended") return null;
  if (confirmation?.state !== "eligible" || confirmation.reason !== "verified_current_series_ended" ||
      purchase?.uidBound !== true || purchase?.active !== true || !Number.isFinite(checkedAt) || !Number.isFinite(purchasedAt) ||
      purchasedAt < checkedAt || purchasedAt > now || now - checkedAt < 0 || now - checkedAt > 15 * 60 * 1000 ||
      !ownerUid || !ownerSnapshot?.exists) return null;
  return Array.isArray(confirmation.expiredForeignSeries) && confirmation.expiredForeignSeries.find((proof) =>
    proof.ownershipId === ownershipId && proof.ownerUid === ownerUid && (proof.kind || "subscription_ownership") === kind &&
    proof.fingerprint === fingerprint(ownerSnapshot) && Number.isFinite(proof.expiryMs) && proof.expiryMs <= checkedAt &&
    (kind === "users" || (ownerUserSnapshot && proof.ownerUserFingerprint === fingerprint(ownerUserSnapshot)))) || null;
}
function toMs(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : Date.parse(value);
  }
  return NaN;
}
function snapshotData(snapshot) {
  return snapshot && typeof snapshot.data === "function" ? snapshot.data() || {} : {};
}
// Statuses whose recorded deadline decides the outcome. "none", "paused", "refunded", "revoked" and
// unknown values carry no usable end time and are never treated as ended.
const END_BY_DEADLINE_STATUSES = new Set(["expired", "active", "trial", "grace", "canceled", "cancelled"]);
// Latest end of the owner's recorded Store period (normal or grace), or NaN when unusable as evidence.
function ownerRecordedEndMs(ownerData, platform) {
  let store = ownerData?.subscriptions?.[platform];
  // Records written before the per-OS format only carry the account-level legacy fields for their own OS.
  if ((!store || typeof store !== "object") && String(ownerData?.subscriptionPlatform || "").trim().toLowerCase() === platform) {
    store = { status: ownerData.subscriptionStatus, expiryTime: ownerData.subscriptionExpiryTime };
  }
  if (!store || typeof store !== "object") return NaN;
  if (!END_BY_DEADLINE_STATUSES.has(String(store.status || "").trim().toLowerCase())) return NaN;
  const ends = [store.expiryTime, store.normalExpiryTime, store.graceExpiryTime].map(toMs).filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : NaN;
}
// Proof B (post-purchase, server-derived): the previous owner's series had ended strictly BEFORE this
// purchase began. Evidence is read from data the caller already holds (inside the claim transaction),
// so no pre-purchase record or time window is needed. Anything unconfirmed is rejected (fail closed).
// Returns { proof, code, facts }; `code` is a fixed identifier explaining the decision.
function evaluateServerDerivedEndedProof({ platform, purchase, ownershipId, ownerUid, ownerSnapshot, ownerUserSnapshot, kind = "subscription_ownership", now = Date.now() }) {
  const { buildIosOwnershipId, isSubscriptionOwnerCurrentlyUsable } = require("./subscriptionOwnership");
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const purchasedAt = purchase?.purchasedAt;
  const facts = { nowAt: iso(now), purchaseStartedAt: iso(purchasedAt), purchaseBoundToUid: purchase?.uidBound === true,
    purchaseActive: purchase?.active === true, evidenceKind: kind };
  const reject = (code, extra = {}) => ({ proof: null, code, facts: { ...facts, ...extra } });
  if (purchase?.uidBound !== true) return reject("REJECT_PURCHASE_NOT_BOUND_TO_UID");
  if (purchase?.active !== true) return reject("REJECT_PURCHASE_NOT_ACTIVE");
  if (!Number.isFinite(purchasedAt) || purchasedAt > now) return reject("REJECT_PURCHASE_TIME_INVALID");
  if (!ownerUid || !ownerSnapshot?.exists) return reject("REJECT_OWNER_RECORD_MISSING");
  if (kind !== "users") {
    const ownerOfRecord = snapshotData(ownerSnapshot).ownerUid ?? (typeof ownerSnapshot.get === "function" ? ownerSnapshot.get("ownerUid") : undefined);
    if (ownerOfRecord !== ownerUid) return reject("REJECT_OWNER_RECORD_CHANGED");
  }
  const ownerUser = kind === "users" ? ownerSnapshot : ownerUserSnapshot;
  if (!ownerUser?.exists) return reject("REJECT_OWNER_USER_MISSING");
  const ownerData = snapshotData(ownerUser);
  const ownerStore = ownerData?.subscriptions?.[platform];
  facts.ownerRecordedStatus = typeof ownerStore?.status === "string" ? ownerStore.status : null;
  // The previous owner must not hold a usable contract on this OS right now.
  const usability = isSubscriptionOwnerCurrentlyUsable(ownerData, platform, new Date(now));
  facts.ownerUsableNow = Boolean(usability.ownerCurrentlyUsable);
  facts.ownerUsabilitySource = usability.decisionSource || null;
  if (usability.ownerCurrentlyUsable) return reject("REJECT_OWNER_STILL_USABLE");
  if (platform === "android") {
    // Google links a new token to an older one only through linkedPurchaseToken; the old token must have
    // been verified with Google as ended, with its end strictly before this purchase started.
    const expiryMs = Number(purchase.linkedExpiryMs);
    facts.googleLinkedState = purchase.linkedState || null;
    facts.googleLinkedEndedAt = iso(expiryMs);
    if (purchase.linkedOwnershipId !== ownershipId) return reject("REJECT_ANDROID_NOT_LINKED_SERIES");
    if (purchase.linkedState !== "ended") return reject("REJECT_ANDROID_LINKED_NOT_ENDED");
    if (!Number.isFinite(expiryMs)) return reject("REJECT_ANDROID_LINKED_END_UNKNOWN");
    if (expiryMs >= purchasedAt) return reject("REJECT_ANDROID_LINKED_END_NOT_BEFORE_PURCHASE");
    return { proof: { expiryMs, source: "server_derived_google_linked" }, code: "ALLOW_SERVER_DERIVED_GOOGLE_LINKED", facts };
  }
  if (platform === "ios") {
    // Apple continues the same originalTransactionId after expiry. The owner's Store-sourced record must
    // refer to this same series and show it ended strictly before the new transaction was purchased.
    const rawIdentity = ownerStore?.originalTransactionId || ownerData?.appStoreOriginalTransactionId;
    if (!rawIdentity || buildIosOwnershipId(rawIdentity) !== ownershipId) return reject("REJECT_IOS_OWNER_SERIES_UNCONFIRMED");
    const endMs = ownerRecordedEndMs(ownerData, "ios");
    facts.ownerRecordedEndedAt = iso(endMs);
    if (!Number.isFinite(endMs)) return reject("REJECT_IOS_OWNER_END_UNCONFIRMED");
    if (endMs >= purchasedAt) return reject("REJECT_IOS_OWNER_END_NOT_BEFORE_PURCHASE");
    if (endMs > now) return reject("REJECT_IOS_OWNER_END_IN_FUTURE");
    return { proof: { expiryMs: endMs, source: "server_derived_ios_owner_record" }, code: "ALLOW_SERVER_DERIVED_IOS_OWNER_RECORD", facts };
  }
  return reject("REJECT_PLATFORM_UNSUPPORTED");
}
// Proof C ("latest holder wins"): a Store-verified ACTIVE contract may move to the requesting UID when it is
// the same genuine series: the purchase is tagged for the requester, or carries the tag the current owner's
// record holds (a restore of the owner's own purchase). Identity of the Store account is never known.
function ownerAccountTagMatches({ platform, purchase, ownerUid, ownerSnapshot, ownerUserSnapshot }) {
  const tag = String(purchase?.accountTag || "").trim().toLowerCase();
  if (!tag) return false;
  if (platform === "android") {
    return crypto.createHash("sha256").update(`kamome-account:${ownerUid}`).digest("hex") === tag;
  }
  return [snapshotData(ownerSnapshot).appAccountToken, snapshotData(ownerUserSnapshot).appStoreAppAccountToken]
    .map((value) => String(value || "").trim().toLowerCase()).filter(Boolean).includes(tag);
}
function evaluateOwnershipTransferProof({ platform, purchase, ownerUid, ownerSnapshot, ownerUserSnapshot, kind = "subscription_ownership", now = Date.now() }) {
  const facts = { evidenceKind: kind, purchaseActive: purchase?.active === true, purchaseBoundToUid: purchase?.uidBound === true };
  const reject = (code) => ({ proof: null, code, facts });
  if (kind !== "subscription_ownership") return reject("REJECT_TRANSFER_EVIDENCE_KIND");
  if (platform !== "ios" && platform !== "android") return reject("REJECT_PLATFORM_UNSUPPORTED");
  if (purchase?.active !== true) return reject("REJECT_TRANSFER_PURCHASE_NOT_ACTIVE");
  if (!ownerUid || !ownerSnapshot?.exists || snapshotData(ownerSnapshot).ownerUid !== ownerUid) return reject("REJECT_TRANSFER_OWNER_RECORD_UNCONFIRMED");
  if (platform === "ios") {
    // iPhone: the requester's own tag is NOT a proof (it only shows the requester bought a different period). Required:
    // the device's StoreKit tag == Apple's signed tag (checked by the caller -> proofVerified), the contract is a
    // PURCHASED (not family-shared) one, and the tag equals the tag recorded for the CURRENT owner.
    if (purchase.proofVerified !== true) return reject("REJECT_TRANSFER_DEVICE_PROOF_MISSING");
    if (purchase.ownershipType !== "PURCHASED") return reject("REJECT_TRANSFER_NOT_PURCHASED");
    if (!ownerAccountTagMatches({ platform, purchase, ownerUid, ownerSnapshot, ownerUserSnapshot })) return reject("REJECT_TRANSFER_ACCOUNT_TAG_MISMATCH");
  } else if (purchase.uidBound !== true && !ownerAccountTagMatches({ platform, purchase, ownerUid, ownerSnapshot, ownerUserSnapshot })) return reject("REJECT_TRANSFER_ACCOUNT_TAG_MISMATCH");
  return { proof: { expiryMs: now, source: "ownership_transferred_active" }, code: "ALLOW_OWNERSHIP_TRANSFER_ACTIVE", facts };
}
function getServerDerivedEndedProof(args) { return evaluateServerDerivedEndedProof(args).proof; }
// Full decision with an identifier and safe facts for diagnostics.
function evaluateExpiredReassignment(args) {
  const confirmed = getClientConfirmedProof(args);
  if (confirmed) return { proof: confirmed, code: "ALLOW_CLIENT_CONFIRMED_PROOF", source: "client_confirmed", facts: {} };
  const derived = evaluateServerDerivedEndedProof(args);
  // iOS: moving an ACTIVE contract between UIDs is only done by the dedicated transfer path (client-side StoreKit proof).
  if (!derived.proof && args.platform !== "ios") {
    const transfer = evaluateOwnershipTransferProof(args);
    if (transfer.proof) return { ...transfer, source: transfer.proof.source, facts: { ...derived.facts, ...transfer.facts, clientConfirmedProof: "absent_or_invalid" } };
  }
  return { ...derived, source: derived.proof ? derived.proof.source : null, facts: { ...derived.facts, clientConfirmedProof: "absent_or_invalid" } };
}
function getExpiredReassignmentProof(args) {
  return evaluateExpiredReassignment(args).proof;
}
function permitsExpiredReassignment(args) { return Boolean(getExpiredReassignmentProof(args)); }
module.exports = { permitsExpiredReassignment, getExpiredReassignmentProof, evaluateExpiredReassignment, evaluateServerDerivedEndedProof, evaluateOwnershipTransferProof, getServerDerivedEndedProof, fingerprint };
