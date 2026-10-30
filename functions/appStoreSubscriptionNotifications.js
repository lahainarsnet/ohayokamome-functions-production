/**
 * App Store Server Notifications V2 handler (phase 1).
 */
const {
  Environment,
  SignedDataVerifier,
} = require("@apple/app-store-server-library");
const {
  APP_STORE_BUNDLE_ID,
  APP_STORE_PRODUCT_ID,
  peekJwsPayload,
  fetchAppStoreAllSubscriptionStatusesWithRetry,
  loadAppleRootCertificates,
  deriveSubscriptionState,
  pickLatestTransactionEntry,
} = require("./appStoreServerCommon");
const {
  buildIosStoreState,
  commitUserSubscriptionDualWrite,
} = require("./subscriptionEntitlement");
const { normalizeUuid, tokenSuffix } = require("./billingFinalTrace");
const { safeErrorLogFields, safeLookupErrorsForLog, redactLogText } = require("./logSafeError");
const {
  readTrustedIosOwnershipOwner,
  detachStaleAppleIdentifiersFromOtherUsers,
  isTrustedIosOwnershipStatus,
  buildIosOwnershipId,
  SUBSCRIPTION_OWNERSHIP_COLLECTION,
} = require("./subscriptionOwnership");

const NOTIFICATION_TRACE = "APP_STORE_NOTIFICATION_TRACE";
const PROCESSING_STALE_MS = 10 * 60 * 1000;

function normalizeEnvironment(value) {
  const normalized = String(value || "").trim();
  if (normalized === "Sandbox") {
    return "Sandbox";
  }
  if (normalized === "Production") {
    return "Production";
  }
  return "";
}

function resolveNotificationEnvironment(decodedOrPeeked, fallback = "") {
  return (
    normalizeEnvironment(decodedOrPeeked?.data?.environment) ||
    normalizeEnvironment(decodedOrPeeked?.environment) ||
    normalizeEnvironment(fallback) ||
    ""
  );
}

function toLibraryEnvironment(environment) {
  return environment === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
}

function parseAppAppleId(raw) {
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readAppAppleId(getAppAppleId) {
  const raw =
    typeof getAppAppleId === "function"
      ? getAppAppleId()
      : process.env.APP_STORE_CONNECT_APP_APPLE_ID;
  return parseAppAppleId(raw);
}

function createSignedDataVerifier(environment, getAppAppleId) {
  const appAppleId = readAppAppleId(getAppAppleId);
  if (environment === "Production" && appAppleId === undefined) {
    throw new Error("APP_STORE_CONNECT_APP_APPLE_ID_REQUIRED_FOR_PRODUCTION");
  }
  return new SignedDataVerifier(
    loadAppleRootCertificates(),
    true,
    toLibraryEnvironment(environment),
    APP_STORE_BUNDLE_ID,
    appAppleId
  );
}

function buildVerifierForSignedPayload(signedPayload, getAppAppleId) {
  const peeked = peekJwsPayload(signedPayload);
  const environment = resolveNotificationEnvironment(peeked);
  if (!environment) {
    return {
      verifier: createSignedDataVerifier("Production", getAppAppleId),
      environment: "Production",
      fallbackVerifier: createSignedDataVerifier("Sandbox", getAppAppleId),
    };
  }
  return {
    verifier: createSignedDataVerifier(environment, getAppAppleId),
    environment,
    fallbackVerifier:
      environment === "Production"
        ? createSignedDataVerifier("Sandbox", getAppAppleId)
        : createSignedDataVerifier("Production", getAppAppleId),
  };
}

async function verifyNotificationPayload(signedPayload, getAppAppleId) {
  const { verifier, environment, fallbackVerifier } =
    buildVerifierForSignedPayload(signedPayload, getAppAppleId);
  try {
    const decoded = await verifier.verifyAndDecodeNotification(signedPayload);
    return { decoded, environment: resolveNotificationEnvironment(decoded, environment) };
  } catch (primaryError) {
    try {
      const decoded = await fallbackVerifier.verifyAndDecodeNotification(
        signedPayload
      );
      return {
        decoded,
        environment: resolveNotificationEnvironment(decoded, environment),
      };
    } catch (fallbackError) {
      const error = new Error("JWS_VERIFICATION_FAILED");
      error.primaryMessage = primaryError?.message;
      error.fallbackMessage = fallbackError?.message;
      throw error;
    }
  }
}

async function decodeSignedTransaction(verifier, signedTransactionInfo) {
  if (!signedTransactionInfo) {
    return null;
  }
  return verifier.verifyAndDecodeTransaction(signedTransactionInfo);
}

async function decodeSignedRenewal(verifier, signedRenewalInfo) {
  if (!signedRenewalInfo) {
    return null;
  }
  return verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo);
}

function eventBaseFields(decodedNotification, environment) {
  return {
    notificationUUID: decodedNotification?.notificationUUID || "",
    notificationType: decodedNotification?.notificationType || "",
    subtype: decodedNotification?.subtype || "",
    environment: resolveNotificationEnvironment(decodedNotification, environment),
    receivedAt: new Date(),
  };
}

const { recordSubscriptionEventActivity } = require("./dailyReport/increment");

async function writeSubscriptionEvent(db, notificationUUID, fields) {
  if (!notificationUUID) {
    return;
  }
  const ref = db.collection("subscription_events").doc(notificationUUID);
  await ref.set(
    {
      ...fields,
      processedAt: fields.processedAt || new Date(),
    },
    { merge: true }
  );
  recordSubscriptionEventActivity(fields);
}

async function beginNotificationProcessing(db, notificationUUID, baseFields) {
  return db.runTransaction(async (tx) => {
    const ref = db.collection("subscription_events").doc(notificationUUID);
    const snap = await tx.get(ref);
    if (snap.exists) {
      const existingStatus = snap.get("status");
      const receivedAt = snap.get("receivedAt");
      const receivedMillis =
        receivedAt && typeof receivedAt.toDate === "function"
          ? receivedAt.toDate().getTime()
          : 0;
      if (existingStatus === "processed") {
        return { action: "skip", reason: "already_processed" };
      }
      if (existingStatus === "processing") {
        const stale =
          receivedMillis > 0 && Date.now() - receivedMillis > PROCESSING_STALE_MS;
        if (!stale) {
          return { action: "skip", reason: "processing_in_flight" };
        }
      }
      if (existingStatus !== "failed" && existingStatus !== "processing") {
        if (
          existingStatus === "rejected" ||
          existingStatus === "ambiguous" ||
          existingStatus === "unlinked" ||
          existingStatus === "deferred_token_mismatch"
        ) {
          return { action: "skip", reason: existingStatus };
        }
      }
    }

    tx.set(
      ref,
      {
        ...baseFields,
        status: "processing",
        receivedAt: baseFields.receivedAt,
        processedAt: new Date(),
      },
      { merge: true }
    );
    return { action: "continue" };
  });
}

async function findTargetUser(db, originalTransactionId, transactionId) {
  const users = db.collection("users");
  const originalId = String(originalTransactionId || "").trim();
  const latestTransactionId = String(transactionId || "").trim();

  if (originalId) {
    const byOriginal = await users
      .where("appStoreOriginalTransactionId", "==", originalId)
      .limit(2)
      .get();
    if (byOriginal.size === 1) {
      return { kind: "single", uid: byOriginal.docs[0].id, match: "appStoreOriginalTransactionId" };
    }
    if (byOriginal.size > 1) {
      return { kind: "ambiguous", uids: byOriginal.docs.map((doc) => doc.id) };
    }
  }

  const tokenCandidates = [latestTransactionId, originalId].filter(Boolean);
  for (const token of tokenCandidates) {
    const byToken = await users
      .where("activePurchaseTokens", "array-contains", token)
      .limit(2)
      .get();
    if (byToken.size === 1) {
      return { kind: "single", uid: byToken.docs[0].id, match: "activePurchaseTokens" };
    }
    if (byToken.size > 1) {
      return { kind: "ambiguous", uids: byToken.docs.map((doc) => doc.id) };
    }
  }

  if (latestTransactionId) {
    const byTransaction = await users
      .where("appStoreTransactionId", "==", latestTransactionId)
      .limit(2)
      .get();
    if (byTransaction.size === 1) {
      return { kind: "single", uid: byTransaction.docs[0].id, match: "appStoreTransactionId" };
    }
    if (byTransaction.size > 1) {
      return { kind: "ambiguous", uids: byTransaction.docs.map((doc) => doc.id) };
    }
  }

  return { kind: "unlinked" };
}

async function resolveAppStoreNotificationUser(
  db,
  originalTransactionId,
  transactionId
) {
  const usersLookup = await findTargetUser(
    db,
    originalTransactionId,
    transactionId
  );
  const legacyUids =
    usersLookup.kind === "ambiguous"
      ? usersLookup.uids || []
      : usersLookup.kind === "single" && usersLookup.uid
        ? [usersLookup.uid]
        : [];
  const legacyCandidateCount = legacyUids.length;

  const ownership = await readTrustedIosOwnershipOwner(
    db,
    originalTransactionId
  );
  if (ownership.kind === "trusted") {
    return {
      kind: "single",
      uid: ownership.uid,
      match: "ownership_document",
      resolution: "ownership_document",
      resolutionReason: ownership.reason,
      legacyCandidateCount,
      legacyKind: usersLookup.kind,
      legacyUids,
    };
  }

  return {
    ...usersLookup,
    resolution: "users_query",
    resolutionReason: ownership.reason || "ownership_missing",
    legacyCandidateCount,
    legacyKind: usersLookup.kind,
    legacyUids,
  };
}

function logNotificationUserResolved(logger, fields) {
  if (!logger || typeof logger.info !== "function") {
    return;
  }
  logger.info(`${NOTIFICATION_TRACE} user_resolved`, {
    notificationUUID: fields.notificationUUID || null,
    resolution: fields.resolution || null,
    resolutionReason: fields.resolutionReason || null,
    ownerUidSuffix: tokenSuffix(fields.uid || ""),
    originalTransactionIdSuffix: tokenSuffix(fields.originalTransactionId || ""),
    notificationType: fields.notificationType || "",
    subtype: fields.subtype || "",
    legacyCandidateCount:
      typeof fields.legacyCandidateCount === "number"
        ? fields.legacyCandidateCount
        : null,
    legacyKind: fields.legacyKind || fields.kind || null,
  });
}

async function findUsersByAppAccountToken(db, appAccountToken) {
  const token = normalizeUuid(appAccountToken);
  if (!token) {
    return { kind: "none", uids: [] };
  }
  const snap = await db
    .collection("users")
    .where("appStoreAppAccountToken", "==", token)
    .limit(2)
    .get();
  if (snap.size === 1) {
    return { kind: "single", uid: snap.docs[0].id, uids: [snap.docs[0].id] };
  }
  if (snap.size > 1) {
    return { kind: "ambiguous", uids: snap.docs.map((doc) => doc.id) };
  }
  return { kind: "none", uids: [] };
}

function decideAppStoreNotificationApply({
  originalOwnerUid,
  appAccountToken,
  tokenOwnerUids = [],
  // Optional result of evaluateRecordedTransferProof(). Only a proven formal ownership transfer can turn the
  // "token owner differs from current owner" deferral into an apply; everything else keeps the old decision.
  transferProof = null,
}) {
  const originalUid = String(originalOwnerUid || "").trim();
  const token = normalizeUuid(appAccountToken);
  if (!token) {
    return { action: "apply", reason: "legacy_missing_token" };
  }
  const owners = [
    ...new Set(
      (Array.isArray(tokenOwnerUids) ? tokenOwnerUids : [])
        .map((uid) => String(uid || "").trim())
        .filter(Boolean)
    ),
  ];
  if (owners.length === 1 && originalUid && owners[0] === originalUid) {
    return {
      action: "apply",
      reason: "token_matches_original_owner",
      tokenOwnerUid: owners[0],
    };
  }
  if (owners.length === 1 && originalUid && owners[0] !== originalUid) {
    if (transferProof && transferProof.ok === true) {
      return {
        action: "apply",
        reason: "token_matches_recorded_ownership_transfer",
        tokenOwnerUid: owners[0],
        transferProof: transferProof.reason || "recorded_ownership_transfer",
      };
    }
    return {
      action: "defer",
      reason: "deferred_token_mismatch",
      tokenOwnerUid: owners[0],
    };
  }
  if (owners.length > 1) {
    return { action: "defer", reason: "deferred_token_ambiguous" };
  }
  return { action: "apply", reason: "legacy_token_unlinked" };
}

/**
 * Proof that the current owner holds this contract series through a FORMAL ownership transfer, so that an Apple
 * notification carrying the previous owner's appAccountToken may be applied to the current owner.
 *
 * Every condition must hold (any failure keeps the old "deferred_token_mismatch" behaviour):
 *  1. the notification token (Apple-signed, verified by the handler) is present;
 *  2. the series' ownership record names the current owner, is trusted, belongs to this series, and its recorded
 *     appAccountToken (saved by the server when the purchase/transfer was verified) equals the notification token;
 *  3. the current owner's own record is bound to this very series (boundSubscriptionSeries.ios.ownershipId);
 *  4. the token's owner holds the formal transfer record written by the ownership-transfer transaction
 *     (subscriptions.ios.source === "ownership_transferred" with transferredAt), owns this token, and no longer
 *     holds the series.
 * The notification token alone never proves a transfer. Nothing here ever selects the token owner as the target.
 */
function evaluateRecordedTransferProof({
  appAccountToken,
  originalTransactionId,
  currentOwnerUid,
  tokenOwnerUid,
  ownershipRecord,
  ownerUser,
  tokenOwnerUser,
}) {
  const reject = (reason) => ({ ok: false, reason });
  const token = normalizeUuid(appAccountToken);
  const originalId = String(originalTransactionId || "").trim();
  const currentUid = String(currentOwnerUid || "").trim();
  const previousUid = String(tokenOwnerUid || "").trim();
  if (!token) return reject("notification_token_missing");
  if (!originalId || !currentUid || !previousUid) return reject("identity_missing");
  if (currentUid === previousUid) return reject("same_uid");
  let ownershipId;
  try {
    ownershipId = buildIosOwnershipId(originalId);
  } catch (error) {
    return reject("series_id_invalid");
  }

  // 2. ownership record of this series
  if (!ownershipRecord) return reject("ownership_record_missing");
  if (String(ownershipRecord.ownerUid || "").trim() !== currentUid) return reject("ownership_owner_mismatch");
  if (!isTrustedIosOwnershipStatus(ownershipRecord.status)) return reject("ownership_status_untrusted");
  const recordedOriginalId = String(ownershipRecord.appStoreOriginalTransactionId || "").trim();
  if (recordedOriginalId && recordedOriginalId !== originalId) return reject("series_mismatch");
  if (normalizeUuid(ownershipRecord.appAccountToken) !== token) return reject("recorded_token_mismatch");

  // 3. current owner is bound to this series
  const bound = ownerUser?.boundSubscriptionSeries?.ios;
  if (!bound || String(bound.ownershipId || "").trim() !== ownershipId) return reject("owner_not_bound_to_series");

  // 4. previous owner (the token's owner) carries the formal transfer record
  if (!tokenOwnerUser) return reject("token_owner_record_missing");
  if (normalizeUuid(tokenOwnerUser.appStoreAppAccountToken) !== token) return reject("token_owner_record_mismatch");
  const previousIos = tokenOwnerUser.subscriptions?.ios;
  if (!previousIos || String(previousIos.source || "") !== "ownership_transferred") return reject("transfer_record_missing");
  if (!previousIos.transferredAt) return reject("transfer_time_missing");
  const previousStillHolds = [previousIos.originalTransactionId, tokenOwnerUser.appStoreOriginalTransactionId]
    .some((value) => String(value || "").trim() === originalId);
  if (previousStillHolds) return reject("previous_owner_still_holds_series");

  return { ok: true, reason: "recorded_ownership_transfer", ownershipId };
}

function snapshotToData(snap) {
  if (!snap || snap.exists === false) return null;
  if (typeof snap.data === "function") return snap.data() || {};
  return null;
}

// Reads the three records the proof needs. `reader` is db (plain reads) or a transaction (tx.get).
async function loadTransferProofRecords(reader, db, { originalTransactionId, currentOwnerUid, tokenOwnerUid }) {
  const ownershipId = buildIosOwnershipId(originalTransactionId);
  const get = (ref) => (typeof reader.get === "function" && reader !== db ? reader.get(ref) : ref.get());
  const ownershipSnap = await get(db.collection(SUBSCRIPTION_OWNERSHIP_COLLECTION).doc(ownershipId));
  const ownerSnap = await get(db.collection("users").doc(currentOwnerUid));
  const tokenOwnerSnap = await get(db.collection("users").doc(tokenOwnerUid));
  return {
    ownershipRecord: snapshotToData(ownershipSnap),
    ownerUser: snapshotToData(ownerSnap),
    tokenOwnerUser: snapshotToData(tokenOwnerSnap),
  };
}

async function evaluateTransferProofFromDb(reader, db, args) {
  const records = await loadTransferProofRecords(reader, db, args);
  return evaluateRecordedTransferProof({ ...args, ...records });
}

/**
 * Applies a notification to the current owner while the transfer proof is re-verified INSIDE the write transaction.
 * If the ownership records changed since the proof was first evaluated, nothing is written and
 * TRANSFER_PROOF_CHANGED is thrown (the caller defers the notification like any unproven mismatch).
 */
async function applyUserSubscriptionUpdateWithTransferGuard(db, admin, uid, derived, source, options, transferProofArgs) {
  if (!transferProofArgs || String(transferProofArgs.currentOwnerUid || "") !== String(uid || "")) {
    const mismatch = new Error("TRANSFER_PROOF_CHANGED");
    mismatch.code = "TRANSFER_PROOF_CHANGED";
    mismatch.reason = "target_is_not_current_owner";
    throw mismatch;
  }
  return db.runTransaction(async (tx) => {
    const recheck = await evaluateTransferProofFromDb(tx, db, transferProofArgs);
    if (!recheck.ok) {
      const changed = new Error("TRANSFER_PROOF_CHANGED");
      changed.code = "TRANSFER_PROOF_CHANGED";
      changed.reason = recheck.reason;
      throw changed;
    }
    return applyUserSubscriptionUpdate(db, admin, uid, derived, source, { ...options, externalTx: tx });
  });
}

function autoRenewingFromRenewalInfo(renewalInfo) {
  if (
    renewalInfo == null ||
    renewalInfo.autoRenewStatus === undefined ||
    renewalInfo.autoRenewStatus === null
  ) {
    return null;
  }
  return Number(renewalInfo.autoRenewStatus) === 1;
}

async function applyUserSubscriptionUpdate(
  db,
  admin,
  uid,
  derived,
  source,
  options = {}
) {
  const update = {
    subscriptionStatus: derived.status,
    subscriptionProductId: APP_STORE_PRODUCT_ID,
    subscriptionPlatform: "ios",
    appStoreOriginalTransactionId: derived.originalTransactionId,
    appStoreTransactionId: derived.latestTransactionId,
    appStoreEnvironment: derived.environment,
    appStoreValidationCode: derived.validationCode,
    activePurchaseTokens: derived.latestTransactionId
      ? [derived.latestTransactionId]
      : [],
    lastSubscriptionSource: source,
    lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
    updatedAt: admin.FieldValue.serverTimestamp(),
  };

  let expiryTime = null;
  if (derived.expiresDate > 0) {
    expiryTime = admin.Timestamp.fromMillis(derived.expiresDate);
    update.subscriptionExpiryTime = expiryTime;
  }

  const storeState = buildIosStoreState({
    status: derived.status,
    expirySource: derived.expirySource,
    normalExpiryTime: derived.normalExpiresDate > 0 ? admin.Timestamp.fromMillis(derived.normalExpiresDate) : null,
    graceExpiryTime: derived.graceExpiresDate > 0 ? admin.Timestamp.fromMillis(derived.graceExpiresDate) : null,
    storeObservedAtMs: derived.storeObservedAtMs,
    storeTransactionTimeMs: derived.storeTransactionTimeMs,
    expiryTime,
    autoRenewing:
      typeof options.autoRenewing === "boolean" ? options.autoRenewing : null,
    originalTransactionId: derived.originalTransactionId || "",
    transactionId: derived.latestTransactionId || "",
    environment: derived.environment || "",
    source,
    updatedAt: admin.FieldValue.serverTimestamp(),
  });

  const dualWriteResult = await commitUserSubscriptionDualWrite({
    db,
    admin,
    uid,
    source: options.dualWriteSource || "apple_notification",
    platform: "ios",
    storeState,
    legacyUpdate: update,
    log: options.logger || console,
    meta: {
      eventId: options.notificationUUID || "",
      transactionId: derived.latestTransactionId || "",
      originalTransactionId: derived.originalTransactionId || "",
    },
    writeGuard: options.writeGuard || null,
    // Optional caller-owned transaction (used to re-verify an ownership transfer atomically with this write).
    externalTx: options.externalTx || null,
  });
  if (dualWriteResult?.reconcileWriteSkipped) {
    return {
      applied: false,
      skipReason: dualWriteResult.skipReason || "write_guard_skip",
    };
  }
  return { applied: true };
}

function isTestNotification(decodedNotification) {
  const type = String(decodedNotification?.notificationType || "").trim();
  return type === "TEST";
}

function createAppStoreNotificationHandler({
  getDb,
  admin,
  logger,
  secrets,
  getAppAppleId,
}) {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const signedPayload =
      typeof req.body?.signedPayload === "string" ? req.body.signedPayload : "";
    if (!signedPayload) {
      res.status(400).send("Missing signedPayload");
      return;
    }

    const db = getDb();

    try {
      const { decoded, environment } = await verifyNotificationPayload(
        signedPayload,
        getAppAppleId
      );
      const notificationUUID = decoded?.notificationUUID || "";
      const baseFields = eventBaseFields(decoded, environment);
      logger.info(`${NOTIFICATION_TRACE} received`, {
        operationId: notificationUUID || "missing-notification-id",
        platform: "ios",
        notificationType: baseFields.notificationType,
        subtype: baseFields.subtype,
        environment: baseFields.environment,
      });

      if (!notificationUUID) {
        await writeSubscriptionEvent(db, `missing-uuid-${Date.now()}`, {
          ...baseFields,
          status: "rejected",
          errorCode: "MISSING_NOTIFICATION_UUID",
        });
        res.status(200).send("OK");
        return;
      }

      const gate = await beginNotificationProcessing(db, notificationUUID, baseFields);
      if (gate.action === "skip") {
        logger.info(`${NOTIFICATION_TRACE} skipped`, {
          notificationUUID,
          reason: gate.reason,
        });
        res.status(200).send("OK");
        return;
      }

      if (isTestNotification(decoded)) {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          status: "processed",
          result: "test_notification",
        });
        logger.info(`${NOTIFICATION_TRACE} test notification processed`, {
          notificationUUID,
        });
        res.status(200).send("OK");
        return;
      }

      const verifier = createSignedDataVerifier(
        environment === "Sandbox" ? "Sandbox" : "Production",
        getAppAppleId
      );
      const signedTransactionInfo = decoded?.data?.signedTransactionInfo || null;
      const signedRenewalInfo = decoded?.data?.signedRenewalInfo || null;

      let transactionInfo = null;
      let renewalInfo = null;
      if (signedTransactionInfo) {
        transactionInfo = await decodeSignedTransaction(
          verifier,
          signedTransactionInfo
        );
      }
      if (signedRenewalInfo) {
        renewalInfo = await decodeSignedRenewal(verifier, signedRenewalInfo);
      }

      const originalTransactionId =
        transactionInfo?.originalTransactionId ||
        renewalInfo?.originalTransactionId ||
        "";
      const transactionId = transactionInfo?.transactionId || "";

      if (!originalTransactionId) {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId: "",
          transactionId,
          status: "rejected",
          errorCode: "MISSING_ORIGINAL_TRANSACTION_ID",
        });
        res.status(200).send("OK");
        return;
      }

      const precheck = deriveSubscriptionState(transactionInfo || {});
      if (precheck.validationCode === "BUNDLE_ID_MISMATCH" || precheck.validationCode === "PRODUCT_ID_MISMATCH") {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          status: "rejected",
          errorCode: precheck.validationCode,
        });
        res.status(200).send("OK");
        return;
      }

      const userLookup = await resolveAppStoreNotificationUser(
        db,
        originalTransactionId,
        transactionId
      );
      logNotificationUserResolved(logger, {
        notificationUUID,
        uid: userLookup.uid,
        originalTransactionId,
        notificationType: baseFields.notificationType,
        subtype: baseFields.subtype,
        resolution: userLookup.resolution,
        resolutionReason: userLookup.resolutionReason,
        legacyCandidateCount: userLookup.legacyCandidateCount,
        legacyKind: userLookup.legacyKind,
        kind: userLookup.kind,
      });

      if (userLookup.kind === "ambiguous") {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          status: "ambiguous",
          errorCode: "MULTIPLE_USERS_MATCHED",
          errorMessage: userLookup.uids.join(","),
        });
        res.status(200).send("OK");
        return;
      }

      if (userLookup.kind === "unlinked") {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          status: "unlinked",
          errorCode: "USER_NOT_FOUND",
        });
        res.status(200).send("OK");
        return;
      }

      const userSnap = await db.collection("users").doc(userLookup.uid).get();
      const userData = userSnap.exists ? userSnap.data() || {} : {};
      const storedEnvironment = normalizeEnvironment(userData.appStoreEnvironment);
      const notificationEnvironment = normalizeEnvironment(
        transactionInfo?.environment || environment
      );
      if (
        storedEnvironment &&
        notificationEnvironment &&
        storedEnvironment !== notificationEnvironment
      ) {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          uid: userLookup.uid,
          status: "rejected",
          errorCode: "ENVIRONMENT_MISMATCH",
          errorMessage: `${storedEnvironment}!=${notificationEnvironment}`,
        });
        res.status(200).send("OK");
        return;
      }

      const appleToken = normalizeUuid(transactionInfo?.appAccountToken);
      const tokenLookup = appleToken
        ? await findUsersByAppAccountToken(db, appleToken)
        : { kind: "none", uids: [] };
      let applyDecision = decideAppStoreNotificationApply({
        originalOwnerUid: userLookup.uid,
        appAccountToken: appleToken,
        tokenOwnerUids: tokenLookup.uids || [],
      });
      let transferProofArgs = null;
      if (
        applyDecision.action === "defer" &&
        applyDecision.reason === "deferred_token_mismatch" &&
        userLookup.resolution === "ownership_document" &&
        applyDecision.tokenOwnerUid
      ) {
        // The token's owner differs from the current (ownership-record) owner. Apply only if a FORMAL ownership
        // transfer is proven from the server-saved records; otherwise keep deferring exactly as before.
        transferProofArgs = {
          appAccountToken: appleToken,
          originalTransactionId,
          currentOwnerUid: userLookup.uid,
          tokenOwnerUid: applyDecision.tokenOwnerUid,
        };
        let proof;
        try {
          proof = await evaluateTransferProofFromDb(db, db, transferProofArgs);
        } catch (proofError) {
          proof = { ok: false, reason: "proof_read_failed" };
        }
        logger.info(`${NOTIFICATION_TRACE} transfer_proof`, {
          notificationUUID,
          ok: proof.ok === true,
          reason: proof.reason || null,
          ownerUidSuffix: tokenSuffix(userLookup.uid),
          tokenOwnerUidSuffix: tokenSuffix(applyDecision.tokenOwnerUid),
          originalTransactionIdSuffix: tokenSuffix(originalTransactionId),
          notificationType: baseFields.notificationType,
          subtype: baseFields.subtype,
        });
        applyDecision = decideAppStoreNotificationApply({
          originalOwnerUid: userLookup.uid,
          appAccountToken: appleToken,
          tokenOwnerUids: tokenLookup.uids || [],
          transferProof: proof,
        });
      }
      const guardedByTransferProof =
        applyDecision.action === "apply" &&
        applyDecision.reason === "token_matches_recorded_ownership_transfer";
      if (applyDecision.action === "defer") {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          uid: userLookup.uid,
          status: "deferred_token_mismatch",
          errorCode: applyDecision.reason,
          tokenOwnerUid: applyDecision.tokenOwnerUid || null,
          userMatch: userLookup.match,
        });
        logger.info(`${NOTIFICATION_TRACE} deferred_token_mismatch`, {
          notificationUUID,
          reason: applyDecision.reason,
          oldOwnerUidSuffix: tokenSuffix(userLookup.uid),
          tokenOwnerUidSuffix: tokenSuffix(applyDecision.tokenOwnerUid || ""),
          originalTransactionIdSuffix: tokenSuffix(originalTransactionId),
          transactionIdSuffix: tokenSuffix(transactionId),
          notificationType: baseFields.notificationType,
          subtype: baseFields.subtype,
        });
        res.status(200).send("OK");
        return;
      }

      const apiStartedAt = Date.now();
      logger.info(`${NOTIFICATION_TRACE} app_store_api.begin`, {
        operationId: notificationUUID,
        notificationType: baseFields.notificationType,
        environment: notificationEnvironment,
      });
      let apiResult;
      try {
        apiResult = await fetchAppStoreAllSubscriptionStatusesWithRetry(
          originalTransactionId,
          notificationEnvironment,
          secrets,
          {
            maxHttpAttempts: 6,
            deadlineMs: 45_000,
            httpTimeoutMs: 8_000,
            retryBackoffMs: 1_000,
            trace: {
              logger,
              operationId: notificationUUID || "missing-notification-id",
            },
          }
        );
        logger.info(`${NOTIFICATION_TRACE} app_store_api.end`, {
          operationId: notificationUUID,
          elapsedMs: Date.now() - apiStartedAt,
          outcome: "success",
          groupCount: apiResult.body?.data?.length || 0,
          httpAttempts: apiResult.httpAttempts || null,
        });
      } catch (apiError) {
        logger.warn(`${NOTIFICATION_TRACE} app_store_api.end`, {
          operationId: notificationUUID,
          elapsedMs: Date.now() - apiStartedAt,
          outcome: "error",
          errorType: apiError?.constructor?.name || "Error",
          errorCode: apiError?.status || apiError?.code || "unknown",
          lookupErrors: apiError?.lookupErrors || null,
          httpAttempts: apiError?.httpAttempts || null,
        });
        throw apiError;
      }
      const latestEntry = await pickLatestTransactionEntry(
        apiResult.body,
        (signedInfo) => verifier.verifyAndDecodeTransaction(signedInfo),
        { decodeRenewal: (signedInfo) => verifier.verifyAndDecodeRenewalInfo(signedInfo) }
      );

      if (!latestEntry?.transactionInfo) {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          uid: userLookup.uid,
          status: "failed",
          errorCode: "SUBSCRIPTION_STATUS_NOT_FOUND",
        });
        res.status(200).send("OK");
        return;
      }

      const derived = deriveSubscriptionState(latestEntry.transactionInfo, Date.now(), { appleStatus: latestEntry.appleStatus, renewalInfo: latestEntry.renewalInfo, storeObservedAtMs: apiResult.storeObservedAtMs });
      if (derived.validationCode === "BUNDLE_ID_MISMATCH" || derived.validationCode === "PRODUCT_ID_MISMATCH") {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          uid: userLookup.uid,
          status: "rejected",
          errorCode: derived.validationCode,
        });
        res.status(200).send("OK");
        return;
      }

      derived.environment =
        normalizeEnvironment(latestEntry.transactionInfo?.environment) ||
        apiResult.environment ||
        notificationEnvironment;

      let latestRenewalInfo = renewalInfo;
      if (!latestRenewalInfo && latestEntry.renewalInfoSigned) {
        try {
          latestRenewalInfo = await decodeSignedRenewal(
            verifier,
            latestEntry.renewalInfoSigned
          );
        } catch (renewalError) {
          logger.warn(`${NOTIFICATION_TRACE} renewal decode failed`, {
            uidSuffix: tokenSuffix(userLookup.uid),
            notificationUUID,
            ...safeErrorLogFields(renewalError, "renewal_decode"),
          });
        }
      }

      const firestoreUpdateStartedAt = Date.now();
      logger.info(`${NOTIFICATION_TRACE} firestore_update.begin`, {
        operationId: notificationUUID,
        uidSuffix: tokenSuffix(userLookup.uid),
        platform: "ios",
        storeStatus: derived.status,
      });
      try {
        const applyOptions = {
          autoRenewing: autoRenewingFromRenewalInfo(latestRenewalInfo),
          notificationUUID,
          logger,
        };
        if (guardedByTransferProof) {
          // The owner may change while this notification is processed: re-verify the proof inside the same
          // transaction as the write (Firestore retries on a conflicting ownership change), and abort otherwise.
          await applyUserSubscriptionUpdateWithTransferGuard(
            db,
            admin,
            userLookup.uid,
            derived,
            "app_store_notification_v2",
            applyOptions,
            transferProofArgs
          );
        } else {
          await applyUserSubscriptionUpdate(
            db,
            admin,
            userLookup.uid,
            derived,
            "app_store_notification_v2",
            applyOptions
          );
        }
        logger.info(`${NOTIFICATION_TRACE} firestore_update.end`, {
          operationId: notificationUUID,
          uidSuffix: tokenSuffix(userLookup.uid),
          elapsedMs: Date.now() - firestoreUpdateStartedAt,
          outcome: "success",
          storeStatus: derived.status,
        });
      } catch (writeError) {
        if (writeError && writeError.code === "TRANSFER_PROOF_CHANGED") {
          // Ownership changed under us: nothing was written. Defer exactly like an unproven mismatch.
          await writeSubscriptionEvent(db, notificationUUID, {
            ...baseFields,
            originalTransactionId,
            transactionId,
            uid: userLookup.uid,
            status: "deferred_token_mismatch",
            errorCode: "deferred_transfer_proof_changed",
            tokenOwnerUid: applyDecision.tokenOwnerUid || null,
            userMatch: userLookup.match,
          });
          logger.info(`${NOTIFICATION_TRACE} deferred_token_mismatch`, {
            notificationUUID,
            reason: "deferred_transfer_proof_changed",
            proofReason: writeError.reason || null,
            oldOwnerUidSuffix: tokenSuffix(userLookup.uid),
            tokenOwnerUidSuffix: tokenSuffix(applyDecision.tokenOwnerUid || ""),
            originalTransactionIdSuffix: tokenSuffix(originalTransactionId),
            notificationType: baseFields.notificationType,
            subtype: baseFields.subtype,
          });
          res.status(200).send("OK");
          return;
        }
        logger.warn(`${NOTIFICATION_TRACE} firestore_update.end`, {
          operationId: notificationUUID,
          uidSuffix: tokenSuffix(userLookup.uid),
          elapsedMs: Date.now() - firestoreUpdateStartedAt,
          outcome: "error",
          errorType: writeError?.constructor?.name || "Error",
          errorCode: typeof writeError?.code === "string" ? writeError.code : "unknown",
        });
        throw writeError;
      }

      if (userLookup.resolution === "ownership_document") {
        try {
          await detachStaleAppleIdentifiersFromOtherUsers(db, admin, {
            ownerUid: userLookup.uid,
            originalTransactionId:
              derived.originalTransactionId || originalTransactionId,
            transactionId: derived.latestTransactionId || transactionId,
            logger,
          });
        } catch (cleanupError) {
          logger.warn(`${NOTIFICATION_TRACE} detach_stale_failed`, {
            ownerUidSuffix: tokenSuffix(userLookup.uid),
            originalTransactionIdSuffix: tokenSuffix(originalTransactionId),
            ...safeErrorLogFields(cleanupError, "detach_stale"),
          });
        }
      }

      await writeSubscriptionEvent(db, notificationUUID, {
        ...baseFields,
        originalTransactionId: derived.originalTransactionId || originalTransactionId,
        transactionId: derived.latestTransactionId || transactionId,
        uid: userLookup.uid,
        status: "processed",
        result: derived.validationCode,
        subscriptionStatus: derived.status,
        userMatch: userLookup.match,
        resolution: userLookup.resolution || null,
        ...(guardedByTransferProof ? { transferProof: applyDecision.transferProof, tokenOwnerUid: applyDecision.tokenOwnerUid || null } : {}),
      });

      logger.info(`${NOTIFICATION_TRACE} processed`, {
        notificationUUID,
        uidSuffix: tokenSuffix(userLookup.uid),
        notificationType: baseFields.notificationType,
        subtype: baseFields.subtype,
        validationCode: derived.validationCode,
        subscriptionStatus: derived.status,
        resolution: userLookup.resolution || null,
        resolutionReason: userLookup.resolutionReason || null,
        transferProof: guardedByTransferProof ? applyDecision.transferProof : null,
        originalTransactionIdSuffix: tokenSuffix(originalTransactionId),
        legacyCandidateCount:
          typeof userLookup.legacyCandidateCount === "number"
            ? userLookup.legacyCandidateCount
            : null,
      });

      res.status(200).send("OK");
    } catch (error) {
      const peeked = peekJwsPayload(signedPayload);
      const notificationUUID = peeked?.notificationUUID || "";
      logger.error(`${NOTIFICATION_TRACE} failed`, {
        notificationUUID: notificationUUID || null,
        ...safeErrorLogFields(error, "notification_handle"),
        primaryMessage: error?.primaryMessage == null ? undefined : redactLogText(error.primaryMessage),
        fallbackMessage: error?.fallbackMessage == null ? undefined : redactLogText(error.fallbackMessage),
        lookupErrors: safeLookupErrorsForLog(error?.lookupErrors),
      });

      if (notificationUUID) {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...eventBaseFields(
            peeked || {},
            resolveNotificationEnvironment(peeked)
          ),
          status: "failed",
          errorCode: error?.message || "UNKNOWN_ERROR",
          errorMessage: error?.message || String(error),
        });
      }

      res.status(200).send("OK");
    }
  };
}

module.exports = {
  createAppStoreNotificationHandler,
  decideAppStoreNotificationApply,
  evaluateRecordedTransferProof,
  evaluateTransferProofFromDb,
  applyUserSubscriptionUpdateWithTransferGuard,
  findUsersByAppAccountToken,
  findTargetUser,
  resolveAppStoreNotificationUser,
  applyUserSubscriptionUpdate,
  NOTIFICATION_TRACE,
};
