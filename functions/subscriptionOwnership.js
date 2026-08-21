const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  describeAccountAccessUsability,
  normalizeSubscriptionPlatform,
} = require("./accountAccessUsability");
const { isStoreEntitlementUsable } = require("./subscriptionEntitlement");

const SUBSCRIPTION_ALREADY_LINKED_CODE = "SUBSCRIPTION_ALREADY_LINKED";
const SUBSCRIPTION_TOKEN_MISMATCH_CODE = "SUBSCRIPTION_TOKEN_MISMATCH";
const SUBSCRIPTION_OWNERSHIP_COLLECTION = "subscription_ownership";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function identifierSuffix(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "empty";
  if (normalized.length <= 4) {
    return `(short-id len=${normalized.length})`;
  }
  if (normalized.length <= 11) {
    const tailLen = normalized.length <= 7 ? 3 : 4;
    return normalized.slice(-tailLen);
  }
  return normalized.slice(-6);
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

function originalTransactionIdFromIosOwnership(ownershipId, ownershipFields = {}) {
  const fromFields = String(
    ownershipFields?.appStoreOriginalTransactionId || ""
  ).trim();
  if (fromFields) {
    return fromFields;
  }
  const id = String(ownershipId || "").trim();
  if (id.startsWith("ios_")) {
    return id.slice(4);
  }
  return "";
}

function isTrustedIosOwnershipStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "" || normalized === "active";
}

/**
 * Strip only Apple identifiers that would make a previous owner show up in
 * ASN `users` searches for this originalTransactionId series.
 * Leaves subscriptions.*, entitlement*, Android tokens, and audit fields intact.
 */
function buildDetachedAppleIdentifierUpdate(
  userData,
  { originalTransactionId, transactionId, admin }
) {
  const originalId = String(originalTransactionId || "").trim();
  const latestId = String(transactionId || "").trim();
  const idsToRemove = new Set([originalId, latestId].filter(Boolean));
  if (idsToRemove.size === 0 || !admin?.FieldValue?.delete) {
    return null;
  }

  const data = userData && typeof userData === "object" ? userData : {};
  const storedOriginal = String(data.appStoreOriginalTransactionId || "").trim();
  const originalMatches = Boolean(storedOriginal && storedOriginal === originalId);
  const storedTxn = String(data.appStoreTransactionId || "").trim();
  if (originalMatches && storedTxn) {
    idsToRemove.add(storedTxn);
  }

  const tokens = Array.isArray(data.activePurchaseTokens)
    ? data.activePurchaseTokens.map((token) => String(token || "").trim()).filter(Boolean)
    : [];
  const nextTokens = tokens.filter((token) => !idsToRemove.has(token));
  const tokensChanged = nextTokens.length !== tokens.length;

  if (!originalMatches && !tokensChanged) {
    return null;
  }

  const update = {};
  if (originalMatches) {
    update.appStoreOriginalTransactionId = admin.FieldValue.delete();
    update.appStoreTransactionId = admin.FieldValue.delete();
  }
  if (tokensChanged) {
    update.activePurchaseTokens = nextTokens;
  }
  return Object.keys(update).length > 0 ? update : null;
}

async function readTrustedIosOwnershipOwner(db, originalTransactionId) {
  const originalId = String(originalTransactionId || "").trim();
  if (!originalId) {
    return { kind: "none", reason: "missing_original_transaction_id" };
  }

  let ownershipId;
  try {
    ownershipId = buildIosOwnershipId(originalId);
  } catch (error) {
    return { kind: "none", reason: "missing_original_transaction_id" };
  }

  const snap = await db
    .collection(SUBSCRIPTION_OWNERSHIP_COLLECTION)
    .doc(ownershipId)
    .get();
  if (!snap.exists) {
    return { kind: "none", reason: "ownership_missing" };
  }

  const ownerUid = String(snap.get("ownerUid") || "").trim();
  if (!ownerUid) {
    return { kind: "untrusted", reason: "ownership_owner_uid_missing" };
  }
  if (!isTrustedIosOwnershipStatus(snap.get("status"))) {
    return {
      kind: "untrusted",
      reason: "ownership_status_untrusted",
      ownerUid,
    };
  }

  const userSnap = await db.collection("users").doc(ownerUid).get();
  if (!userSnap.exists) {
    return {
      kind: "untrusted",
      reason: "ownership_owner_user_missing",
      ownerUid,
    };
  }

  return {
    kind: "trusted",
    uid: ownerUid,
    reason: "ownership_document",
    status: String(snap.get("status") || "active"),
  };
}

async function detachStaleAppleIdentifiersFromOtherUsers(
  db,
  admin,
  { ownerUid, originalTransactionId, transactionId, logger }
) {
  const originalId = String(originalTransactionId || "").trim();
  const owner = String(ownerUid || "").trim();
  if (!originalId || !owner) {
    return { detachedCount: 0 };
  }

  const seen = new Set();
  const candidateDocs = [];
  const users = db.collection("users");
  const queries = [
    users.where("appStoreOriginalTransactionId", "==", originalId).limit(10),
    users.where("activePurchaseTokens", "array-contains", originalId).limit(10),
  ];
  const latestId = String(transactionId || "").trim();
  if (latestId && latestId !== originalId) {
    queries.push(
      users.where("activePurchaseTokens", "array-contains", latestId).limit(10)
    );
  }

  for (const query of queries) {
    const snap = await query.get();
    for (const doc of snap.docs || []) {
      if (!doc?.id || seen.has(doc.id) || doc.id === owner) {
        continue;
      }
      seen.add(doc.id);
      candidateDocs.push(doc);
    }
  }

  let detachedCount = 0;
  for (const doc of candidateDocs) {
    const update = buildDetachedAppleIdentifierUpdate(doc.data() || {}, {
      originalTransactionId: originalId,
      transactionId: latestId,
      admin,
    });
    if (!update) {
      continue;
    }
    await doc.ref.set(update, { merge: true });
    detachedCount += 1;
    if (logger && typeof logger.info === "function") {
      logger.info("APP_STORE_NOTIFICATION_TRACE detached_stale_apple_identifiers", {
        ownerUidSuffix: identifierSuffix(owner),
        previousOwnerUidSuffix: identifierSuffix(doc.id),
        originalTransactionIdSuffix: identifierSuffix(originalId),
      });
    }
  }
  return { detachedCount };
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

function isSubscriptionOwnerCurrentlyUsable(userData, platform, now = new Date()) {
  const normalizedPlatform = normalizeSubscriptionPlatform(platform);
  if (normalizedPlatform !== "ios" && normalizedPlatform !== "android") {
    return {
      ownerCurrentlyUsable: false,
      decisionSource: "unsupported_platform",
      reason: "unsupported_platform",
    };
  }

  const storeState = userData?.subscriptions?.[normalizedPlatform];
  const storeResult = isStoreEntitlementUsable(storeState, now);
  if (storeResult.usable) {
    return {
      ownerCurrentlyUsable: true,
      decisionSource: "store",
      reason: storeResult.reason,
    };
  }

  const access = describeAccountAccessUsability(userData, now);
  if (access.subscriptionUsable) {
    const entitlementSource = normalizeSubscriptionPlatform(
      userData?.entitlementSource
    );
    const legacyPlatform = normalizeSubscriptionPlatform(
      userData?.subscriptionPlatform
    );

    if (access.decisionSource === "entitlement") {
      if (
        entitlementSource === normalizedPlatform ||
        entitlementSource === "both"
      ) {
        return {
          ownerCurrentlyUsable: true,
          decisionSource: "entitlement",
          reason: null,
        };
      }
      return {
        ownerCurrentlyUsable: false,
        decisionSource: "entitlement",
        reason: "active_other_platform_only",
      };
    }

    if (
      access.decisionSource === "legacyFallback" &&
      legacyPlatform === normalizedPlatform
    ) {
      return {
        ownerCurrentlyUsable: true,
        decisionSource: "legacyFallback",
        reason: null,
      };
    }
  }

  return {
    ownerCurrentlyUsable: false,
    decisionSource: access.decisionSource,
    reason: access.denyReason || storeResult.reason || "inactive_owner",
  };
}

async function loadOwnerUserData(db, ownerUid) {
  const snap = await db.collection("users").doc(ownerUid).get();
  if (!snap.exists) {
    return null;
  }
  return snap.data() || null;
}

async function evaluateOwnerCandidates({
  db,
  platform,
  ownerUids,
  log,
  traceId,
}) {
  const activeOwners = [];
  const inactiveOwners = [];

  for (const ownerUid of ownerUids) {
    let ownerData = null;
    try {
      ownerData = await loadOwnerUserData(db, ownerUid);
    } catch (error) {
      if (typeof log === "function") {
        log.warn("subscription_ownership.owner_eval.load_failed", {
          billingTraceId: traceId || null,
          platform,
          ownerUidSuffix: identifierSuffix(ownerUid),
          message: error?.message || null,
          decision: "reject_active_owner",
        });
      }
      activeOwners.push({
        uid: ownerUid,
        ownerCurrentlyUsable: true,
        decisionSource: "load_failed",
        reason: "owner_load_failed",
      });
      continue;
    }

    if (ownerData == null) {
      inactiveOwners.push({
        uid: ownerUid,
        ownerCurrentlyUsable: false,
        decisionSource: "missing_owner_doc",
        reason: "owner_doc_missing",
      });
      if (typeof log === "function") {
        log.info("subscription_ownership.ownershipCandidateFound", {
          billingTraceId: traceId || null,
          platform,
          ownerUidSuffix: identifierSuffix(ownerUid),
          ownerCurrentlyUsable: false,
          decision: "allow_inactive_history",
          decisionSource: "missing_owner_doc",
        });
      }
      continue;
    }

    const usability = isSubscriptionOwnerCurrentlyUsable(
      ownerData,
      platform,
      new Date()
    );
    const candidate = {
      uid: ownerUid,
      ownerCurrentlyUsable: usability.ownerCurrentlyUsable,
      decisionSource: usability.decisionSource,
      reason: usability.reason,
    };
    if (usability.ownerCurrentlyUsable) {
      activeOwners.push(candidate);
    } else {
      inactiveOwners.push(candidate);
    }

    if (typeof log === "function") {
      log.info("subscription_ownership.ownershipCandidateFound", {
        billingTraceId: traceId || null,
        platform,
        ownerUidSuffix: identifierSuffix(ownerUid),
        ownerCurrentlyUsable: usability.ownerCurrentlyUsable,
        decision: usability.ownerCurrentlyUsable
          ? "reject_active_owner"
          : "allow_inactive_history",
        decisionSource: usability.decisionSource,
        reason: usability.reason,
      });
    }
  }

  return { activeOwners, inactiveOwners };
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
    ownerUidTail: identifierSuffix(ownerUid),
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
    requestUidSuffix: identifierSuffix(uid),
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
      requestUidSuffix: identifierSuffix(uid),
      ownershipIdSuffix: identifierSuffix(ownershipId),
      linkedOwnershipIdSuffix: linkedId ? identifierSuffix(linkedId) : null,
    });
  }

  await db.runTransaction(async (tx) => {
    const { ref, snap } = await readOwnershipDoc(tx, db, ownershipId);

    if (!snap.exists && linkedId) {
      const linked = await readOwnershipDoc(tx, db, linkedId);
      if (linked.snap.exists) {
        const linkedOwnerUid = String(linked.snap.get("ownerUid") || "").trim();
        if (linkedOwnerUid && linkedOwnerUid !== uid) {
          const linkedOwnerRef = db.collection("users").doc(linkedOwnerUid);
          const linkedOwnerSnap = await tx.get(linkedOwnerRef);
          const linkedOwnerUsability = linkedOwnerSnap.exists
            ? isSubscriptionOwnerCurrentlyUsable(
                linkedOwnerSnap.data() || {},
                platform,
                new Date()
              )
            : {
                ownerCurrentlyUsable: false,
                decisionSource: "missing_owner_doc",
              };
          if (typeof log === "function") {
            log.info("subscription_ownership.ownershipCandidateFound", {
              billingTraceId: traceId || null,
              platform,
              ownerUidSuffix: identifierSuffix(linkedOwnerUid),
              ownerCurrentlyUsable: linkedOwnerUsability.ownerCurrentlyUsable,
              decision: linkedOwnerUsability.ownerCurrentlyUsable
                ? "reject_active_owner"
                : "allow_inactive_history",
              decisionSource: linkedOwnerUsability.decisionSource,
              context: "linked_ownership_conflict",
            });
          }
          if (linkedOwnerUsability.ownerCurrentlyUsable) {
            throwSubscriptionAlreadyLinked({
              platform,
              ownerUid: linkedOwnerUid,
              ownershipId: linkedId,
              log,
              traceId,
              rejectReason: "linked_ownership_conflict",
            });
          }
        }
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
            requestUidSuffix: identifierSuffix(uid),
            ownershipIdSuffix: identifierSuffix(ownershipId),
            linkedOwnershipIdSuffix: identifierSuffix(linkedId),
          });
        }
        return;
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
          requestUidSuffix: identifierSuffix(uid),
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
          requestUidSuffix: identifierSuffix(uid),
          ownershipIdSuffix: identifierSuffix(ownershipId),
        });
      }
      return;
    }

    const existingOwnerRef = db.collection("users").doc(existingOwnerUid);
    const existingOwnerSnap = await tx.get(existingOwnerRef);
    const existingOwnerUsability = existingOwnerSnap.exists
      ? isSubscriptionOwnerCurrentlyUsable(
          existingOwnerSnap.data() || {},
          platform,
          new Date()
        )
      : { ownerCurrentlyUsable: false, decisionSource: "missing_owner_doc" };
    if (typeof log === "function") {
      log.info("subscription_ownership.ownershipCandidateFound", {
        billingTraceId: traceId || null,
        platform,
        ownerUidSuffix: identifierSuffix(existingOwnerUid),
        ownerCurrentlyUsable: existingOwnerUsability.ownerCurrentlyUsable,
        decision: existingOwnerUsability.ownerCurrentlyUsable
          ? "reject_active_owner"
          : "allow_inactive_history",
        decisionSource: existingOwnerUsability.decisionSource,
        context: "existing_owner_conflict",
      });
    }
    if (existingOwnerUsability.ownerCurrentlyUsable) {
      throwSubscriptionAlreadyLinked({
        platform,
        ownerUid: existingOwnerUid,
        ownershipId,
        log,
        traceId,
        rejectReason: "existing_owner_conflict",
      });
    }

    tx.set(
      ref,
      {
        ownerUid: uid,
        platform,
        status: "active",
        previousOwnerUid: existingOwnerUid,
        transferredAt: now,
        updatedAt: now,
        ...ownershipFields,
      },
      { merge: true }
    );

    if (normalizeSubscriptionPlatform(platform) === "ios") {
      const detachUpdate = buildDetachedAppleIdentifierUpdate(
        existingOwnerSnap.exists ? existingOwnerSnap.data() || {} : {},
        {
          originalTransactionId: originalTransactionIdFromIosOwnership(
            ownershipId,
            ownershipFields
          ),
          transactionId: String(ownershipFields?.appStoreTransactionId || "").trim(),
          admin,
        }
      );
      if (detachUpdate) {
        tx.set(existingOwnerRef, detachUpdate, { merge: true });
        if (log && typeof log.info === "function") {
          log.info("subscription_ownership.detached_previous_owner_identifiers", {
            platform,
            requestUidSuffix: identifierSuffix(uid),
            previousOwnerUidSuffix: identifierSuffix(existingOwnerUid),
            ownershipIdSuffix: identifierSuffix(ownershipId),
          });
        }
      }
    }

    if (typeof log === "function") {
      log.info("Subscription ownership transferred from inactive owner.", {
        platform,
        requestUidSuffix: identifierSuffix(uid),
        previousOwnerUidSuffix: identifierSuffix(existingOwnerUid),
        ownershipIdSuffix: identifierSuffix(ownershipId),
      });
    }
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
        requestUidSuffix: identifierSuffix(uid),
        originalTransactionIdSuffix: originalTransactionId
          ? identifierSuffix(originalTransactionId)
          : null,
        transactionIdSuffix: transactionId ? identifierSuffix(transactionId) : null,
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
        requestUidSuffix: identifierSuffix(uid),
        hitCount: 0,
      });
    }
    return;
  }

  const ownerUidList = [...ownerUids];
  const { activeOwners, inactiveOwners } = await evaluateOwnerCandidates({
    db,
    platform,
    ownerUids: ownerUidList,
    log,
    traceId,
  });

  if (activeOwners.length === 0) {
    if (typeof log === "function") {
      log.info("subscription_ownership.users_search.allow", {
        billingTraceId: traceId || null,
        platform,
        requestUidSuffix: identifierSuffix(uid),
        hitCount: ownerUidList.length,
        inactiveOwnerCount: inactiveOwners.length,
        matchCount: ownerMatches.length,
        matchFields: ownerMatches.map((match) => match.match),
        decision: "allow_inactive_history",
      });
    }
    return;
  }

  if (typeof log === "function") {
    log.warn("subscription_ownership.users_search.reject", {
      billingTraceId: traceId || null,
      platform,
      requestUidSuffix: identifierSuffix(uid),
      ownerUidCount: activeOwners.length,
      ownerUidTails: activeOwners.map((item) => identifierSuffix(item.uid)),
      inactiveOwnerCount: inactiveOwners.length,
      matchCount: ownerMatches.length,
      matchFields: ownerMatches.map((match) => match.match),
      rejectCode: SUBSCRIPTION_ALREADY_LINKED_CODE,
      rejectReason: "users_collection_active_owner",
      decision: "reject_active_owner",
    });
  }

  throw new HttpsError(
    "failed-precondition",
    SUBSCRIPTION_ALREADY_LINKED_CODE,
    {
      code: SUBSCRIPTION_ALREADY_LINKED_CODE,
      platform,
      ownerUidCount: activeOwners.length,
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
      uidSuffix: identifierSuffix(uid),
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
        uidSuffix: identifierSuffix(uid),
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
      uidSuffix: identifierSuffix(uid),
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
        uidSuffix: identifierSuffix(uid),
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
      uidSuffix: identifierSuffix(uid),
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
      uidSuffix: identifierSuffix(uid),
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
  isSubscriptionOwnerCurrentlyUsable,
  evaluateOwnerCandidates,
  isTrustedIosOwnershipStatus,
  readTrustedIosOwnershipOwner,
  buildDetachedAppleIdentifierUpdate,
  detachStaleAppleIdentifiersFromOtherUsers,
  originalTransactionIdFromIosOwnership,
};
