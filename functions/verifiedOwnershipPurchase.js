"use strict";
const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const { fingerprint } = require("./expiredOwnershipProof");
async function verifiedGoogleOwnershipFacts({ db, uid, purchaseToken, subscription, matchedLineItem, verifyLinked }) {
  const { buildAndroidOwnershipId, SUBSCRIPTION_ALREADY_LINKED_CODE } = require("./subscriptionOwnership");
  const { googleState } = require("./preChatBillingConfirmation");
  const expected = crypto.createHash("sha256").update(`kamome-account:${uid}`).digest("hex");
  const facts = { uidBound: subscription.externalAccountIdentifiers?.obfuscatedExternalAccountId === expected,
    purchasedAt: Date.parse(subscription.startTime), active: googleState(subscription, matchedLineItem) === "active" };
  const linkedToken = String(subscription.linkedPurchaseToken || "").trim();
  if (!linkedToken || linkedToken === purchaseToken) return facts;
  const linked = await verifyLinked(linkedToken);
  facts.linkedState = googleState(linked.subscription, linked.matchedLineItem);
  const ownershipId = buildAndroidOwnershipId(linkedToken);
  facts.linkedOwnershipId = ownershipId;
  const owner = await db.collection("subscription_ownership").doc(ownershipId).get();
  const ownerUid = owner.exists ? String(owner.get("ownerUid") || "") : "";
  facts.linkedLegacyOwners = [];
  if (!ownerUid) {
    const owners = new Set();
    for (const [field, op] of [["activePurchaseTokens", "array-contains"], ["googlePlayPrimaryPurchaseToken", "=="],
      ["subscriptions.android.primaryPurchaseToken", "=="], ["subscriptions.android.activePurchaseTokens", "array-contains"]]) {
      const found = await db.collection("users").where(field, op, linkedToken).limit(3).get();
      if (found.docs.length >= 3) throw new HttpsError("unavailable", "Linked ownership candidates are ambiguous.");
      for (const doc of found.docs) if (doc.id !== uid) owners.add(doc.id);
    }
    for (const otherUid of owners) {
      if (facts.linkedState === "active") throw new HttpsError("failed-precondition", SUBSCRIPTION_ALREADY_LINKED_CODE, {code: SUBSCRIPTION_ALREADY_LINKED_CODE});
      if (facts.linkedState !== "ended") throw new HttpsError("unavailable", "Linked legacy Store ownership is unconfirmed.");
      const user = await db.collection("users").doc(otherUid).get();
      facts.linkedLegacyOwners.push({ ownerUid: otherUid, fingerprint: fingerprint(user) });
    }
    facts.linkedExpiryMs = Date.parse(linked.matchedLineItem?.expiryTime);
  }
  if (ownerUid && ownerUid !== uid) {
    if (facts.linkedState === "active") throw new HttpsError("failed-precondition", SUBSCRIPTION_ALREADY_LINKED_CODE, {code: SUBSCRIPTION_ALREADY_LINKED_CODE});
    if (facts.linkedState !== "ended") throw new HttpsError("unavailable", "Linked Store ownership is unconfirmed.");
    const ownerUser = await db.collection("users").doc(ownerUid).get();
    facts.linkedObservation = { ownershipId, ownerUid, fingerprint: fingerprint(owner), ownerUserFingerprint: fingerprint(ownerUser) };
  }
  return facts;
}
module.exports = { verifiedGoogleOwnershipFacts };
