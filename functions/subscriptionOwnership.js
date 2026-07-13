const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");

const SUBSCRIPTION_ALREADY_LINKED_CODE = "SUBSCRIPTION_ALREADY_LINKED";
const SUBSCRIPTION_TOKEN_MISMATCH_CODE = "SUBSCRIPTION_TOKEN_MISMATCH";
const SUBSCRIPTION_OWNERSHIP_COLLECTION = "subscription_ownership";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function identifierSuffix(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "empty";
  return normalized.length <= 6 ? normalized : normalized.slice(-6);
}

function hashIdentifier(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "").trim())
    .digest("hex");
}

function normalizeUuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  return UUID_PATTERN.test(normalized) ? normalized : "";
}

function buildIosOwnershipId(originalTransactionId) {
  const normalized = String(originalTransactionId || "").trim();
  if (!normalized) {
    throw new HttpsError(
      "failed-precondition",
      "App Store originalTransactionId is required for ownership claim."
    );
  }
  return `ios_${normalized}`;
}

function buildAndroidOwnershipId(purchaseToken) {
  const normalized = String(purchaseToken || "").trim();
  if (!normalized) {
    throw new HttpsError(
      "failed-precondition",
      "Google Play purchaseToken is required for ownership claim."
    );
  }
  return `android_${hashIdentifier(normalized)}`;
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

function throwSubscriptionAlreadyLinked({
  platform,
  ownerUid,
  ownershipId,
  log,
  traceId,
  rejectCode = SUBSCRIPTION_ALREADY_LINKED_CODE,
  rejectReason = "ownership_claim_rejected",
}) {
  const payload = {
    platform,
    ownerUid: ownerUid || null,
    ownershipId: ownershipId || null,
    ownershipIdSuffix: identifierSuffix(ownershipId),
    billingTraceId: traceId || null,
    rejectCode,
    rejectReason,
  };
  if (typeof log === "function") {
    log.warn("subscription_ownership.claim_rejected", payload);
  }
  throw new HttpsError("failed-precondition", rejectCode, {
    code: rejectCode,
    platform,
    ownerUid: ownerUid || null,
    ownershipIdSuffix: identifierSuffix(ownershipId),
  });
}

function throwSubscriptionTokenMismatch({ uid, ownershipId, log, traceId }) {
  const payload = {
    platform: "ios",
    requestUid: uid,
    ownershipId: ownershipId || null,
    ownershipIdSuffix: identifierSuffix(ownershipId),
    billingTraceId: traceId || null,
    rejectCode: SUBSCRIPTION_TOKEN_MISMATCH_CODE,
    rejectReason: "app_account_token_mismatch",
  };
  if (typeof log === "function") {
    log.warn("subscription_ownership.token_mismatch", payload);
  }
  throw new HttpsError(
    "failed-precondition",
    SUBSCRIPTION_TOKEN_MISMATCH_CODE,
    {
      code: SUBSCRIPTION_TOKEN_MISMATCH_CODE,
      platform: "ios",
    }
  );
}

async function readOwnershipDoc(tx, db, ownershipId) {
  const ref = db.collection(SUBSCRIPTION_OWNERSHIP_COLLECTION).doc(ownershipId);
  const snap = await tx.get(ref);
  return { ref, snap };
}

async function claimOwnershipDocument(
  db,
  admin,
  {
    uid,
    ownershipId,
    platform,
    ownershipFields,
    linkedOwnershipId = "",
    log,
    traceId,
  }
) {
  const now = admin.FieldValue.serverTimestamp();
  const linkedId = String(linkedOwnershipId || "").trim();

  if (typeof log === "function") {
    log.info("subscription_ownership.claim.start", {
      billingTraceId: traceId || null,
      platform,
      requestUid: uid,
      ownershipId,
      ownershipIdSuffix: identifierSuffix(ownershipId),
      linkedOwnershipId: linkedId || null,
    });
  }

  await db.runTransaction(async (tx) => {
    const { ref, snap } = await readOwnershipDoc(tx, db, ownershipId);

    if (!snap.exists && linkedId) {
      const linked = await readOwnershipDoc(tx, db, linkedId);
      if (linked.snap.exists) {
        const linkedOwnerUid = String(linked.snap.get("ownerUid") || "").trim();
        if (linkedOwnerUid && linkedOwnerUid !== uid) {
          throwSubscriptionAlreadyLinked({
            platform,
            ownerUid: linkedOwnerUid,
            ownershipId: linkedId,
            log,
            traceId,
            rejectReason: "linked_ownership_conflict",
          });
        }
        if (linkedOwnerUid === uid) {
          tx.set(
            ref,
            {
              ownerUid: uid,
              platform,
              status: "active",
              claimedAt: now,
              updatedAt: now,
              linkedFromOwnershipId: linkedId,
              ...ownershipFields,
            },
            { merge: true }
          );
          tx.set(
            linked.ref,
            {
              updatedAt: now,
              latestOwnershipId: ownershipId,
            },
            { merge: true }
          );
          if (typeof log === "function") {
            log.info("Subscription ownership claimed via linked token.", {
              platform,
              requestUid: uid,
              ownershipIdSuffix: identifierSuffix(ownershipId),
              linkedOwnershipIdSuffix: identifierSuffix(linkedId),
            });
          }
          return;
        }
      }
    }

    if (!snap.exists) {
      tx.set(ref, {
        ownerUid: uid,
        platform,
        status: "active",
        claimedAt: now,
        updatedAt: now,
        ...ownershipFields,
      });
      if (typeof log === "function") {
        log.info("Subscription ownership created.", {
          platform,
          requestUid: uid,
          ownershipIdSuffix: identifierSuffix(ownershipId),
        });
      }
      return;
    }

    const existingOwnerUid = String(snap.get("ownerUid") || "").trim();
    if (!existingOwnerUid || existingOwnerUid === uid) {
      tx.set(
        ref,
        {
          ownerUid: uid,
          platform,
          status: "active",
          updatedAt: now,
          ...ownershipFields,
        },
        { merge: true }
      );
      if (typeof log === "function") {
        log.info("Subscription ownership reused.", {
          platform,
          requestUid: uid,
          ownershipIdSuffix: identifierSuffix(ownershipId),
        });
      }
      return;
    }

    throwSubscriptionAlreadyLinked({
      platform,
      ownerUid: existingOwnerUid,
      ownershipId,
      log,
      traceId,
      rejectReason: "existing_owner_conflict",
    });
  });
}

async function assertSubscriptionNotLinkedToOtherUser(
  db,
  { uid, platform, identifiers, log, traceId }
) {
  const queries = [];

  if (platform === "ios") {
    const originalTransactionId = String(
      identifiers?.originalTransactionId || ""
    ).trim();
    const transactionId = String(identifiers?.transactionId || "").trim();

    if (typeof log === "function") {
      log.info("subscription_ownership.users_search.start", {
        billingTraceId: traceId || null,
        platform,
        requestUid: uid,
        originalTransactionId: originalTransactionId || null,
        transactionId: transactionId || null,
      });
    }

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
    if (typeof log === "function") {
      log.info("subscription_ownership.users_search.allow", {
        billingTraceId: traceId || null,
        platform,
        requestUid: uid,
        hitCount: 0,
      });
    }
    return;
  }

  const ownerUidList = [...ownerUids];
  if (typeof log === "function") {
    log.warn("subscription_ownership.users_search.reject", {
      billingTraceId: traceId || null,
      platform,
      requestUid: uid,
      ownerUidCount: ownerUidList.length,
      ownerUids: ownerUidList,
      matches: ownerMatches,
      rejectCode: SUBSCRIPTION_ALREADY_LINKED_CODE,
      rejectReason: "users_collection_conflict",
    });
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

async function ensureAppStoreAppAccountTokenForUser(
  db,
  admin,
  { uid, randomUuid, log, traceId }
) {
  const userRef = db.collection("users").doc(uid);
  let resolvedToken = "";
  let tokenAction = "unknown";

  if (typeof log === "function") {
    log.info("ensure_app_account_token.enter", {
      billingTraceId: traceId || null,
      uid,
    });
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const docExists = snap.exists;
    const existing = normalizeUuid(
      snap.exists ? snap.get("appStoreAppAccountToken") : ""
    );
    if (typeof log === "function") {
      log.info("ensure_app_account_token.transaction.read", {
        billingTraceId: traceId || null,
        uid,
        usersDocExists: docExists,
        hasExistingToken: Boolean(existing),
        existingTokenSuffix: identifierSuffix(existing),
      });
    }
    if (existing) {
      resolvedToken = existing;
      tokenAction = "reused";
      return;
    }
    resolvedToken = normalizeUuid(randomUuid());
    if (!resolvedToken) {
      throw new HttpsError("internal", "Failed to generate app account token.");
    }
    tokenAction = "generated";
    tx.set(
      userRef,
      {
        appStoreAppAccountToken: resolvedToken,
        updatedAt: admin.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  if (typeof log === "function") {
    log.info("ensure_app_account_token.success", {
      billingTraceId: traceId || null,
      uid,
      tokenAction,
      tokenSuffix: identifierSuffix(resolvedToken),
    });
  }

  return resolvedToken;
}

async function loadUserAppStoreAppAccountToken(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) {
    return "";
  }
  return normalizeUuid(snap.get("appStoreAppAccountToken"));
}

async function assertIosAppAccountTokenPolicy(
  db,
  {
    uid,
    transactionInfo,
    ownershipId,
    log,
    traceId,
  }
) {
  const appleToken = normalizeUuid(transactionInfo?.appAccountToken);
  if (!appleToken) {
    if (typeof log === "function") {
      log.info("subscription_ownership.token_policy.legacy_route", {
        billingTraceId: traceId || null,
        uid,
        ownershipId,
        ownershipIdSuffix: identifierSuffix(ownershipId),
        appleHasToken: false,
        usersHasToken: false,
      });
    }
    return { legacyRoute: true, appleToken: "" };
  }

  const userToken = await loadUserAppStoreAppAccountToken(db, uid);
  const matched = Boolean(userToken) && appleToken === userToken;
  if (typeof log === "function") {
    log.info("subscription_ownership.token_policy.compare", {
      billingTraceId: traceId || null,
      uid,
      ownershipId,
      ownershipIdSuffix: identifierSuffix(ownershipId),
      appleHasToken: true,
      usersHasToken: Boolean(userToken),
      appleTokenSuffix: identifierSuffix(appleToken),
      usersTokenSuffix: identifierSuffix(userToken),
      matched,
    });
  }
  if (!userToken || appleToken !== userToken) {
    throwSubscriptionTokenMismatch({ uid, ownershipId, log, traceId });
  }

  if (typeof log === "function") {
    log.info("subscription_ownership.token_policy.match", {
      billingTraceId: traceId || null,
      uid,
      ownershipIdSuffix: identifierSuffix(ownershipId),
      tokenSuffix: identifierSuffix(appleToken),
    });
  }

  return { legacyRoute: false, appleToken };
}

async function claimIosSubscriptionOwnership(
  db,
  admin,
  {
    uid,
    update,
    transactionInfo,
    productId,
    log,
    traceId,
  }
) {
  const originalTransactionId = String(
    update?.appStoreOriginalTransactionId ||
      transactionInfo?.originalTransactionId ||
      ""
  ).trim();
  const ownershipId = buildIosOwnershipId(originalTransactionId);
  const tokenPolicy = await assertIosAppAccountTokenPolicy(db, {
    uid,
    transactionInfo,
    ownershipId,
    log,
    traceId,
  });

  await claimOwnershipDocument(db, admin, {
    uid,
    ownershipId,
    platform: "ios",
    ownershipFields: {
      productId: productId || update?.subscriptionProductId || "",
      appStoreOriginalTransactionId: originalTransactionId,
      appStoreTransactionId: String(update?.appStoreTransactionId || "").trim(),
      appAccountToken: tokenPolicy.appleToken || "",
    },
    log,
    traceId,
  });

  return ownershipId;
}

async function claimAndroidSubscriptionOwnership(
  db,
  admin,
  {
    uid,
    purchaseToken,
    linkedPurchaseToken = "",
    productId,
    log,
  }
) {
  const ownershipId = buildAndroidOwnershipId(purchaseToken);
  const linkedOwnershipId = linkedPurchaseToken
    ? buildAndroidOwnershipId(linkedPurchaseToken)
    : "";

  await claimOwnershipDocument(db, admin, {
    uid,
    ownershipId,
    platform: "android",
    linkedOwnershipId,
    ownershipFields: {
      productId: productId || "",
      googlePurchaseTokenHash: hashIdentifier(purchaseToken),
      googleLinkedPurchaseTokenHash: linkedPurchaseToken
        ? hashIdentifier(linkedPurchaseToken)
        : "",
    },
    log,
  });

  return ownershipId;
}

function ownershipIdentifiersFromAppStoreUpdate(update) {
  return {
    originalTransactionId: update?.appStoreOriginalTransactionId || "",
    transactionId: update?.appStoreTransactionId || "",
  };
}

module.exports = {
  SUBSCRIPTION_ALREADY_LINKED_CODE,
  SUBSCRIPTION_TOKEN_MISMATCH_CODE,
  SUBSCRIPTION_OWNERSHIP_COLLECTION,
  assertSubscriptionNotLinkedToOtherUser,
  ownershipIdentifiersFromAppStoreUpdate,
  identifierSuffix,
  hashIdentifier,
  normalizeUuid,
  buildIosOwnershipId,
  buildAndroidOwnershipId,
  ensureAppStoreAppAccountTokenForUser,
  claimIosSubscriptionOwnership,
  claimAndroidSubscriptionOwnership,
  claimOwnershipDocument,
};
