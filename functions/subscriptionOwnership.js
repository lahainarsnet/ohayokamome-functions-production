const { HttpsError } = require("firebase-functions/v2/https");

const SUBSCRIPTION_ALREADY_LINKED_CODE = "SUBSCRIPTION_ALREADY_LINKED";

function identifierSuffix(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "empty";
  return normalized.length <= 6 ? normalized : normalized.slice(-6);
}

async function queryOtherOwnerUids(db, { uid, field, op, value, match }) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return [];
  }

  const snapshot = await db
    .collection("users")
    .where(field, op, normalized)
    .limit(2)
    .get();

  const matches = [];
  for (const doc of snapshot.docs) {
    if (doc.id === uid) {
      continue;
    }
    matches.push({
      uid: doc.id,
      match,
      identifierSuffix: identifierSuffix(normalized),
    });
  }
  return matches;
}

async function assertSubscriptionNotLinkedToOtherUser(
  db,
  { uid, platform, identifiers, log }
) {
  const queries = [];

  if (platform === "ios") {
    const originalTransactionId = String(
      identifiers?.originalTransactionId || ""
    ).trim();
    const transactionId = String(identifiers?.transactionId || "").trim();

    if (originalTransactionId) {
      queries.push({
        field: "appStoreOriginalTransactionId",
        op: "==",
        value: originalTransactionId,
        match: "appStoreOriginalTransactionId",
      });
    }
    if (transactionId) {
      queries.push({
        field: "appStoreTransactionId",
        op: "==",
        value: transactionId,
        match: "appStoreTransactionId",
      });
      queries.push({
        field: "activePurchaseTokens",
        op: "array-contains",
        value: transactionId,
        match: "activePurchaseTokens",
      });
    }
  } else if (platform === "android") {
    const purchaseToken = String(identifiers?.purchaseToken || "").trim();
    if (purchaseToken) {
      queries.push({
        field: "activePurchaseTokens",
        op: "array-contains",
        value: purchaseToken,
        match: "activePurchaseTokens",
      });
    }
  } else {
    throw new Error(`Unsupported subscription ownership platform: ${platform}`);
  }

  const ownerMatches = [];
  const ownerUids = new Set();

  for (const query of queries) {
    const matches = await queryOtherOwnerUids(db, { uid, ...query });
    for (const match of matches) {
      ownerUids.add(match.uid);
      ownerMatches.push(match);
    }
  }

  if (ownerUids.size === 0) {
    return;
  }

  const ownerUidList = [...ownerUids];
  const logPayload = {
    platform,
    requestUid: uid,
    ownerUidCount: ownerUidList.length,
    ownerUids: ownerUidList,
    matches: ownerMatches,
  };

  if (typeof log === "function") {
    log.warn("Subscription ownership conflict.", logPayload);
  }

  throw new HttpsError(
    "failed-precondition",
    SUBSCRIPTION_ALREADY_LINKED_CODE,
    {
      code: SUBSCRIPTION_ALREADY_LINKED_CODE,
      platform,
      ownerUidCount: ownerUidList.length,
    }
  );
}

function ownershipIdentifiersFromAppStoreUpdate(update) {
  return {
    originalTransactionId: update?.appStoreOriginalTransactionId || "",
    transactionId: update?.appStoreTransactionId || "",
  };
}

module.exports = {
  SUBSCRIPTION_ALREADY_LINKED_CODE,
  assertSubscriptionNotLinkedToOtherUser,
  ownershipIdentifiersFromAppStoreUpdate,
  identifierSuffix,
};
