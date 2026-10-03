const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  describeAccountAccessUsability,
  normalizeSubscriptionPlatform,
} = require("./accountAccessUsability");
const { isStoreEntitlementUsable, computeAccountEntitlement, deriveLegacyAccountFields } = require("./subscriptionEntitlement");
const { permitsExpiredReassignment, getExpiredReassignmentProof, fingerprint } = require("./expiredOwnershipProof");

const SUBSCRIPTION_ALREADY_LINKED_CODE = "SUBSCRIPTION_ALREADY_LINKED";
const SUBSCRIPTION_TOKEN_MISMATCH_CODE = "SUBSCRIPTION_TOKEN_MISMATCH";
const SUBSCRIPTION_SERIES_AMBIGUOUS_CODE = "SUBSCRIPTION_SERIES_AMBIGUOUS";
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
          decision: "reject_other_owner",
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
          : "reject_other_owner",
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

function throwSubscriptionSeriesAmbiguous({ platform, uid, log, traceId }) {
  const payload = {
    platform,
    requestUidSuffix: identifierSuffix(uid),
    billingTraceId: traceId || null,
    rejectCode: SUBSCRIPTION_SERIES_AMBIGUOUS_CODE,
    rejectReason: "same_uid_multiple_series",
  };
  if (typeof log === "function") {
    log.warn("subscription_ownership.series_ambiguous", payload);
  }
  throw new HttpsError("unavailable", SUBSCRIPTION_SERIES_AMBIGUOUS_CODE, {
    code: SUBSCRIPTION_SERIES_AMBIGUOUS_CODE,
    platform,
  });
}

function incomingAndroidSeriesIds(purchaseToken, linkedPurchaseToken) {
  const ids = [];
  const current = String(purchaseToken || "").trim();
  const linked = String(linkedPurchaseToken || "").trim();
  if (current) {
    ids.push(buildAndroidOwnershipId(current));
  }
  if (linked) {
    ids.push(buildAndroidOwnershipId(linked));
  }
  return [...new Set(ids)];
}

function boundSeriesIds(bound) {
  if (!bound || typeof bound !== "object") {
    return [];
  }
  return [bound.ownershipId, bound.linkedOwnershipId]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function seriesIntersects(left, right) {
  const rightSet = new Set(right);
  return left.some((id) => rightSet.has(id));
}

async function assertUidSeriesAllowed(
  db,
  {
    uid,
    platform,
    incomingIds,
    incomingOriginalTransactionId = "",
    log,
    traceId,
  }
) {
  const snap = await db.collection("users").doc(uid).get();
  const userData = snap.exists ? snap.data() || {} : {};
  const bound = userData.boundSubscriptionSeries?.[platform] || {};
  const boundIds = boundSeriesIds(bound);
  const sameOsActive = isSubscriptionOwnerCurrentlyUsable(
    userData,
    platform
  ).ownerCurrentlyUsable;

  if (boundIds.length > 0) {
    if (seriesIntersects(boundIds, incomingIds)) {
      return { action: "reuse", userData };
    }
    if (sameOsActive) {
      throwSubscriptionAlreadyLinked({
        platform,
        ownerUid: uid,
        ownershipId: incomingIds[0] || "",
        log,
        traceId,
        rejectReason: "same_uid_other_series",
      });
    }
  }

  if (sameOsActive) {
    if (platform === "android") {
      const primary = String(
        userData.googlePlayPrimaryPurchaseToken || ""
      ).trim();
      if (primary) {
        const primaryId = buildAndroidOwnershipId(primary);
        if (!incomingIds.includes(primaryId)) {
          throwSubscriptionSeriesAmbiguous({
            platform,
            uid,
            log,
            traceId,
          });
        }
      }
    } else if (platform === "ios") {
      const storedOriginal = String(
        userData.appStoreOriginalTransactionId || ""
      ).trim();
      const incomingOriginal = String(
        incomingOriginalTransactionId || ""
      ).trim();
      if (
        storedOriginal &&
        incomingOriginal &&
        storedOriginal !== incomingOriginal
      ) {
        throwSubscriptionSeriesAmbiguous({
          platform,
          uid,
          log,
          traceId,
        });
      }
    }
  }

  return { action: "bind", userData };
}

async function readOwnershipOwnerUid(db, ownershipId) {
  const id = String(ownershipId || "").trim();
  if (!id) {
    return "";
  }
  const snap = await db
    .collection(SUBSCRIPTION_OWNERSHIP_COLLECTION)
    .doc(id)
    .get();
  if (!snap.exists) {
    return "";
  }
  return String(snap.get("ownerUid") || "").trim();
}

async function collectUsersOtherOwnerUids(
  db,
  { uid, platform, purchaseToken, linkedPurchaseToken, originalTransactionId }
) {
  const queries = [];
  if (platform === "android") {
    for (const token of [purchaseToken, linkedPurchaseToken]) {
      const normalized = String(token || "").trim();
      if (!normalized) {
        continue;
      }
      queries.push({
        field: "activePurchaseTokens",
        op: "array-contains",
        value: normalized,
        match: "activePurchaseTokens",
      });
    }
  } else if (platform === "ios") {
    const originalId = String(originalTransactionId || "").trim();
    if (originalId) {
      queries.push({
        field: "appStoreOriginalTransactionId",
        op: "==",
        value: originalId,
        match: "appStoreOriginalTransactionId",
      });
    }
  }

  const ownerUids = new Set();
  for (const query of queries) {
    const matches = await queryOtherOwnerUids(db, { uid, ...query });
    for (const match of matches) {
      ownerUids.add(match.uid);
    }
  }
  return [...ownerUids];
}

async function inspectSubscriptionSeriesOwnership(
  db,
  {
    uid,
    platform,
    purchaseToken = "",
    linkedPurchaseToken = "",
    originalTransactionId = "",
    log,
    traceId,
    verifySeriesState,
  }
) {
  const normalizedPlatform = String(platform || "").trim();
  if (normalizedPlatform !== "android" && normalizedPlatform !== "ios") {
    throw new HttpsError("invalid-argument", "platform is required.");
  }

  let incomingIds = [];
  let incomingOriginal = "";
  if (normalizedPlatform === "android") {
    incomingIds = incomingAndroidSeriesIds(purchaseToken, linkedPurchaseToken);
  } else {
    incomingOriginal = String(originalTransactionId || "").trim();
    if (incomingOriginal) {
      incomingIds = [buildIosOwnershipId(incomingOriginal)];
    }
  }

  if (incomingIds.length === 0) {
    return { decision: "none", reason: "no_store_series", storeStatus: "unknown" };
  }

  const ownershipOwners = [];
  const otherOwnershipIds = [];
  for (const ownershipId of incomingIds) {
    const ownerUid = await readOwnershipOwnerUid(db, ownershipId);
    if (ownerUid) {
      ownershipOwners.push(ownerUid);
      if (ownerUid !== uid) otherOwnershipIds.push(ownershipId);
    }
  }
  const otherOwnershipOwners = [
    ...new Set(ownershipOwners.filter((ownerUid) => ownerUid !== uid)),
  ];
  const primaryOwner = await readOwnershipOwnerUid(db, incomingIds[0]);
  // Exact current ownership supersedes former users' historical identifiers.
  const otherUserOwners = primaryOwner === uid ? [] : await collectUsersOtherOwnerUids(db, {
    uid, platform: normalizedPlatform, purchaseToken, linkedPurchaseToken,
    originalTransactionId: incomingOriginal,
  });
  if (otherOwnershipOwners.length || otherUserOwners.length) {
    // Historical ownership is not proof of a current entitlement. Only a
    // server-verified terminal Store state permits purchasing under another UID.
    // This READ never deletes, reassigns or claims the historical series.
    let state = "unknown";
    try {
      if (typeof verifySeriesState === "function") state = await verifySeriesState({
        platform: normalizedPlatform, purchaseToken, linkedPurchaseToken,
        originalTransactionId: incomingOriginal,
        conflictingOwnershipIds: otherOwnershipIds.length ? otherOwnershipIds : incomingIds,
      });
    } catch (_) { /* Store uncertainty must remain fail-closed. */ }
    if (state === "ended") return primaryOwner === uid ? { decision: "match", reason: "same_uid_series_expired_link_history", storeStatus: "expired" } :
      { decision: "none", reason: "verified_other_owner_series_ended", otherUserOwners, storeStatus: "expired" };
    if (state === "active") return { decision: "mismatch", reason: "other_owner_active", storeStatus: "active" };
    return { decision: "ambiguous", reason: "other_owner_store_unconfirmed", storeStatus: "unknown" };
  }

  if (ownershipOwners.includes(uid)) {
    return { decision: "match", reason: "same_uid_series", storeStatus: "unknown" };
  }

  return { decision: "none", reason: "unrecorded_store_series", storeStatus: "unknown" };
}

async function persistBoundSubscriptionSeries(
  db,
  admin,
  {
    uid,
    platform,
    ownershipId,
    linkedOwnershipId = "",
    originalTransactionId = "",
  }
) {
  await db.runTransaction(async (tx) => {
    const ref = db.collection("users").doc(uid);
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() || {} : {};
    const current = { ...(data.boundSubscriptionSeries || {}) };
    const nextBound = {
      ownershipId,
      boundAt: admin.FieldValue.serverTimestamp(),
    };
    const linked = String(linkedOwnershipId || "").trim();
    if (linked) {
      nextBound.linkedOwnershipId = linked;
    }
    const originalId = String(originalTransactionId || "").trim();
    if (originalId) {
      nextBound.originalTransactionId = originalId;
    }
    current[platform] = {
      ...(current[platform] || {}),
      ...nextBound,
    };
    tx.set(ref, { boundSubscriptionSeries: current }, { merge: true });
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

function expiredPreviousOwnerUpdate(userData, platform, ownershipId, expiryMs, admin) {
  const store = userData.subscriptions?.[platform] || {};
  const rawIdentity = platform === "ios" ? store.originalTransactionId || userData.appStoreOriginalTransactionId :
    store.primaryPurchaseToken || userData.googlePlayPrimaryPurchaseToken;
  const identity = rawIdentity ? (platform === "ios" ? buildIosOwnershipId(rawIdentity) : buildAndroidOwnershipId(rawIdentity)) : "";
  const active = store.status === "active" || (userData.subscriptionPlatform === platform && userData.subscriptionStatus === "active");
  if (identity !== ownershipId && active) throw new HttpsError("unavailable", "Previous owner series changed or unconfirmed.");
  const stores = { ...(userData.subscriptions || {}), [platform]: identity === ownershipId ? { ...store, status: "expired",
    expiryTime: admin.Timestamp.fromMillis(expiryMs), source: "verified_expired_owner_reassigned", updatedAt: admin.FieldValue.serverTimestamp() } : { ...store } };
  const detach = {};
  if (platform === "android") {
    const belongs = (token) => typeof token === "string" && token.trim() && buildAndroidOwnershipId(token) === ownershipId;
    if (belongs(store.primaryPurchaseToken)) stores.android.primaryPurchaseToken = admin.FieldValue.delete();
    if (Array.isArray(store.activePurchaseTokens)) stores.android.activePurchaseTokens = store.activePurchaseTokens.filter((token) => !belongs(token));
    for (const field of ["googlePlayPrimaryPurchaseToken", "googlePlayLinkedPurchaseToken", "googlePlayPurchaseToken"]) {
      if (belongs(userData[field])) detach[field] = admin.FieldValue.delete();
    }
    if (Array.isArray(userData.activePurchaseTokens)) detach.activePurchaseTokens = userData.activePurchaseTokens.filter((token) => !belongs(token));
  }
  const otherPlatform = platform === "ios" ? "android" : "ios";
  if (!userData.subscriptions?.[otherPlatform] && normalizeSubscriptionPlatform(userData.subscriptionPlatform) === otherPlatform) {
    // The other OS still uses its legacy record. This action only expires the
    // exact target series; it must not replace that unrelated legacy access.
    return { ...detach, subscriptions: stores, billingRevision: Number(userData.billingRevision || 0) + 1 };
  }
  const entitlement = computeAccountEntitlement(stores.ios, stores.android);
  return { ...deriveLegacyAccountFields(stores.ios, stores.android, userData, platform), ...detach, subscriptions: stores,
    entitlementUsable: entitlement.entitlementUsable, entitlementSource: entitlement.entitlementSource,
    entitlementExpiryTime: entitlement.entitlementExpiryTime ? admin.Timestamp.fromDate(entitlement.entitlementExpiryTime) : null,
    entitlementUpdatedAt: admin.FieldValue.serverTimestamp(), billingRevision: Number(userData.billingRevision || 0) + 1 };
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
    verifiedPurchase,
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
    const requestUserSnap = await tx.get(db.collection("users").doc(uid));
    const requestUser = requestUserSnap.exists ? requestUserSnap.data() || {} : {};
    const linkedLegacyUpdates = [];
    for (const observed of verifiedPurchase?.linkedLegacyOwners || []) {
      const ownerRef = db.collection("users").doc(observed.ownerUid);
      const owner = await tx.get(ownerRef);
      if (verifiedPurchase?.linkedState !== "ended" || verifiedPurchase?.linkedOwnershipId !== linkedId ||
          observed.fingerprint !== fingerprint(owner)) throw new HttpsError("unavailable", "Linked legacy ownership changed or is unconfirmed.");
      if (!snap.exists || snap.get("ownerUid") !== uid || verifiedPurchase?.uidBound !== true) {
        if (!getExpiredReassignmentProof({ userData: requestUser, platform, purchase: verifiedPurchase,
          ownershipId: linkedId, ownerUid: observed.ownerUid, ownerSnapshot: owner, kind: "users" }))
          throw new HttpsError("unavailable", "Linked legacy purchase requires confirmed expired ownership.");
      }
      const update = expiredPreviousOwnerUpdate(owner.data() || {}, platform, linkedId, verifiedPurchase.linkedExpiryMs, admin);
      if (update) linkedLegacyUpdates.push({ ref: ownerRef, update });
    }
    const assertLinkedObservation = (owner, ownerUser) => {
      const observed = verifiedPurchase?.linkedObservation;
      if (verifiedPurchase?.linkedState !== "ended" || observed?.ownershipId !== linkedId ||
          observed.ownerUid !== owner.get("ownerUid") || observed.fingerprint !== fingerprint(owner) ||
          observed.ownerUserFingerprint !== fingerprint(ownerUser)) throw new HttpsError("unavailable", "Linked ownership changed or is unconfirmed.");
    };
    if (snap.exists && linkedId) {
      const linked = await readOwnershipDoc(tx, db, linkedId);
      const linkedOwnerUid = linked.snap.exists ? String(linked.snap.get("ownerUid") || "") : "";
      if (linkedOwnerUid && linkedOwnerUid !== uid) {
        const linkedUser = await tx.get(db.collection("users").doc(linkedOwnerUid));
        assertLinkedObservation(linked.snap, linkedUser);
        if (snap.get("ownerUid") !== uid || linked.snap.get("latestOwnershipId") !== ownershipId || verifiedPurchase?.uidBound !== true)
          throw new HttpsError("unavailable", "Existing primary has conflicting linked ownership.");
      }
    }

    if (!snap.exists && linkedId) {
      const linked = await readOwnershipDoc(tx, db, linkedId);
      if (linked.snap.exists) {
        const linkedOwnerUid = String(linked.snap.get("ownerUid") || "").trim();
        if (linkedOwnerUid && linkedOwnerUid !== uid) {
          const linkedOwnerRef = db.collection("users").doc(linkedOwnerUid);
          const linkedOwnerSnap = await tx.get(linkedOwnerRef);
          assertLinkedObservation(linked.snap, linkedOwnerSnap);
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
          const proof = getExpiredReassignmentProof({ userData: requestUser, platform, purchase: verifiedPurchase,
            ownershipId: linkedId, ownerUid: linkedOwnerUid, ownerSnapshot: linked.snap, ownerUserSnapshot: linkedOwnerSnap });
          if (!proof) {
            if (typeof log === "function") {
              log.info("subscription_ownership.ownershipCandidateFound", {
                billingTraceId: traceId || null,
                platform,
                ownerUidSuffix: identifierSuffix(linkedOwnerUid),
                ownerCurrentlyUsable: linkedOwnerUsability.ownerCurrentlyUsable,
                decision: "reject_active_owner",
                decisionSource: linkedOwnerUsability.decisionSource,
                context: "linked_ownership_conflict",
              });
            }
            throwSubscriptionAlreadyLinked({
              platform,
              ownerUid: linkedOwnerUid,
              ownershipId: linkedId,
              log,
              traceId,
              rejectReason: "linked_ownership_conflict",
            });
          }
          if (linkedOwnerSnap.exists) {
            const update = expiredPreviousOwnerUpdate(linkedOwnerSnap.data() || {}, platform, linkedId, proof.expiryMs, admin);
            if (update) tx.set(linkedOwnerRef, update, { merge: true });
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
      const legacyUpdates = [];
      for (const entry of requestUser.billingConfirmation?.[platform]?.expiredForeignSeries || []) {
        if (entry.kind !== "users" || ![ownershipId, linkedId].includes(entry.ownershipId)) continue;
        const ownerRef = db.collection("users").doc(entry.ownerUid);
        const owner = await tx.get(ownerRef);
        const proof = getExpiredReassignmentProof({ userData: requestUser, platform, purchase: verifiedPurchase,
          ownershipId: entry.ownershipId, ownerUid: entry.ownerUid, ownerSnapshot: owner, kind: "users" });
        if (!proof) throw new HttpsError("unavailable", "Previous owner changed after expiry confirmation.");
        if (entry.ownershipId === linkedId && verifiedPurchase?.linkedState !== "ended") throw new HttpsError("unavailable", "Linked legacy ownership is unconfirmed.");
        const update = expiredPreviousOwnerUpdate(owner.data() || {}, platform, entry.ownershipId, proof.expiryMs, admin);
        if (update) legacyUpdates.push({ ref: ownerRef, update });
      }
      for (const previous of legacyUpdates) tx.set(previous.ref, previous.update, { merge: true });
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
      for (const previous of linkedLegacyUpdates) tx.set(previous.ref, previous.update, { merge: true });
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
      : {
          ownerCurrentlyUsable: false,
          decisionSource: "missing_owner_doc",
        };

    const proof = getExpiredReassignmentProof({ userData: requestUser, platform, purchase: verifiedPurchase,
      ownershipId, ownerUid: existingOwnerUid, ownerSnapshot: snap, ownerUserSnapshot: existingOwnerSnap });
    if (!proof) {
      if (typeof log === "function") {
        log.info("subscription_ownership.ownershipCandidateFound", {
          billingTraceId: traceId || null,
          platform,
          ownerUidSuffix: identifierSuffix(existingOwnerUid),
          ownerCurrentlyUsable: existingOwnerUsability.ownerCurrentlyUsable,
          decision: "reject_active_owner",
          decisionSource: existingOwnerUsability.decisionSource,
          context: "existing_owner_conflict",
        });
      }
      throwSubscriptionAlreadyLinked({
        platform,
        ownerUid: existingOwnerUid,
        ownershipId,
        log,
        traceId,
        rejectReason: "existing_owner_conflict",
      });
    }

    if (existingOwnerSnap.exists) {
      const update = expiredPreviousOwnerUpdate(existingOwnerSnap.data() || {}, platform, ownershipId, proof.expiryMs, admin);
      if (update) tx.set(existingOwnerRef, update, { merge: true });
    }
    for (const previous of linkedLegacyUpdates) tx.set(previous.ref, previous.update, { merge: true });

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
      log.info("Subscription ownership reassigned from inactive owner.", {
        platform,
        requestUidSuffix: identifierSuffix(uid),
        previousOwnerUidSuffix: identifierSuffix(existingOwnerUid),
        ownershipIdSuffix: identifierSuffix(ownershipId),
      });
    }
    return;
  });
}

async function assertSubscriptionNotLinkedToOtherUser(
  db,
  { uid, platform, identifiers, log, traceId, verifiedPurchase }
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
    for (const purchaseToken of [...new Set([identifiers?.purchaseToken, identifiers?.linkedPurchaseToken].map((value) => String(value || "").trim()).filter(Boolean))]) {
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

  const primaryId = platform === "ios" ? buildIosOwnershipId(identifiers.originalTransactionId || identifiers.transactionId) :
    buildAndroidOwnershipId(identifiers.purchaseToken);
  const primaryOwner = await db.collection(SUBSCRIPTION_OWNERSHIP_COLLECTION).doc(primaryId).get();
  // A server-verified UID-bound purchase already assigned to this UID may be
  // reobserved after confirmation/proof expiry. Former users' IDs are history.
  if (verifiedPurchase?.uidBound === true && primaryOwner.exists && primaryOwner.get("ownerUid") === uid) return;

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

  const userSnap = await db.collection("users").doc(uid).get();
  const userData = userSnap.exists ? userSnap.data() || {} : {};
  const proofIds = platform === "ios" ? [buildIosOwnershipId(identifiers.originalTransactionId || identifiers.transactionId)] :
    incomingAndroidSeriesIds(identifiers.purchaseToken, identifiers.linkedPurchaseToken);
  const ownerUidList = [];
  for (const ownerUid of ownerUids) {
    let permitted = false;
    for (const id of proofIds) {
      const owner = await db.collection(SUBSCRIPTION_OWNERSHIP_COLLECTION).doc(id).get();
      const legacyOwner = await db.collection("users").doc(ownerUid).get();
      if (owner.exists && owner.get("ownerUid") === ownerUid && permitsExpiredReassignment({
        userData, platform, purchase: verifiedPurchase, ownershipId: id, ownerUid, ownerSnapshot: owner, ownerUserSnapshot: legacyOwner,
      })) permitted = true;
      if (!owner.exists) {
        if (permitsExpiredReassignment({ userData, platform, purchase: verifiedPurchase, ownershipId: id,
          ownerUid, ownerSnapshot: legacyOwner, kind: "users" })) permitted = true;
      }
    }
    if (!permitted) ownerUidList.push(ownerUid);
  }
  if (!ownerUidList.length) return;
  if (typeof log === "function") {
    log.warn("subscription_ownership.users_search.reject", {
      billingTraceId: traceId || null,
      platform,
      requestUidSuffix: identifierSuffix(uid),
      ownerUidCount: ownerUidList.length,
      ownerUidTails: ownerUidList.map((item) => identifierSuffix(item)),
      matchCount: ownerMatches.length,
      matchFields: ownerMatches.map((match) => match.match),
      rejectCode: SUBSCRIPTION_ALREADY_LINKED_CODE,
      rejectReason: "users_collection_other_owner",
      decision: "reject_other_owner",
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
    verifiedPurchase,
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

  await assertUidSeriesAllowed(db, {
    uid,
    platform: "ios",
    incomingIds: [ownershipId],
    incomingOriginalTransactionId: originalTransactionId,
    log,
    traceId,
  });

  await claimOwnershipDocument(db, admin, {
    uid,
    ownershipId,
    platform: "ios",
    verifiedPurchase: { ...verifiedPurchase, active: Number(transactionInfo?.expiresDate) > Date.now() && !transactionInfo?.revocationDate,
      uidBound: !tokenPolicy.legacyRoute && Boolean(tokenPolicy.appleToken) && verifiedPurchase?.uidBound === true },
    ownershipFields: {
      productId: productId || update?.subscriptionProductId || "",
      appStoreOriginalTransactionId: originalTransactionId,
      appStoreTransactionId: String(update?.appStoreTransactionId || "").trim(),
      appAccountToken: tokenPolicy.appleToken || "",
    },
    log,
    traceId,
  });

  await persistBoundSubscriptionSeries(db, admin, {
    uid,
    platform: "ios",
    ownershipId,
    originalTransactionId,
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
    verifiedPurchase,
  }
) {
  const ownershipId = buildAndroidOwnershipId(purchaseToken);
  const linkedOwnershipId = linkedPurchaseToken
    ? buildAndroidOwnershipId(linkedPurchaseToken)
    : "";

  await assertUidSeriesAllowed(db, {
    uid,
    platform: "android",
    incomingIds: incomingAndroidSeriesIds(purchaseToken, linkedPurchaseToken),
    log,
  });

  await claimOwnershipDocument(db, admin, {
    uid,
    ownershipId,
    platform: "android",
    linkedOwnershipId,
    verifiedPurchase,
    ownershipFields: {
      productId: productId || "",
      googlePurchaseTokenHash: hashIdentifier(purchaseToken),
      googleLinkedPurchaseTokenHash: linkedPurchaseToken
        ? hashIdentifier(linkedPurchaseToken)
        : "",
    },
    log,
  });

  await persistBoundSubscriptionSeries(db, admin, {
    uid,
    platform: "android",
    ownershipId,
    linkedOwnershipId,
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
  SUBSCRIPTION_SERIES_AMBIGUOUS_CODE,
  SUBSCRIPTION_OWNERSHIP_COLLECTION,
  assertSubscriptionNotLinkedToOtherUser,
  assertUidSeriesAllowed,
  persistBoundSubscriptionSeries,
  incomingAndroidSeriesIds,
  ownershipIdentifiersFromAppStoreUpdate,
  identifierSuffix,
  hashIdentifier,
  normalizeUuid,
  buildIosOwnershipId,
  buildAndroidOwnershipId,
  ensureAppStoreAppAccountTokenForUser,
  claimIosSubscriptionOwnership,
  claimAndroidSubscriptionOwnership,
  inspectSubscriptionSeriesOwnership,
  claimOwnershipDocument,
  isSubscriptionOwnerCurrentlyUsable,
  evaluateOwnerCandidates,
  isTrustedIosOwnershipStatus,
  readTrustedIosOwnershipOwner,
  buildDetachedAppleIdentifierUpdate,
  detachStaleAppleIdentifiersFromOtherUsers,
  originalTransactionIdFromIosOwnership,
};
