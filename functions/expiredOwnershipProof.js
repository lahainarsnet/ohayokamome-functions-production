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
function getExpiredReassignmentProof({ userData, platform, purchase, ownershipId, ownerUid, ownerSnapshot, ownerUserSnapshot, kind = "subscription_ownership", now = Date.now() }) {
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
function permitsExpiredReassignment(args) { return Boolean(getExpiredReassignmentProof(args)); }
module.exports = { permitsExpiredReassignment, getExpiredReassignmentProof, fingerprint };
