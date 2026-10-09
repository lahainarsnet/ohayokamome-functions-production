/**
 * Callable: reconcile iOS subscription from Apple when Firestore is stale.
 */
const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  Environment,
  SignedDataVerifier,
} = require("@apple/app-store-server-library");
const {
  APP_STORE_BUNDLE_ID,
  APP_STORE_PRODUCT_ID,
  fetchAppStoreAllSubscriptionStatusesWithRetry,
  loadAppleRootCertificates,
  deriveSubscriptionState,
  pickLatestTransactionEntry,
} = require("./appStoreServerCommon");
const { applyUserSubscriptionUpdate } = require("./appStoreSubscriptionNotifications");
const { tokenSuffix } = require("./billingFinalTrace");
const {
  parseExpiryToDate,
  USABLE_STORE_STATUSES,
} = require("./subscriptionEntitlement");

const RECONCILE_TRACE = "IOS_SUBSCRIPTION_RECONCILE_TRACE";
const LOCK_MS = 70_000;

function normalizeEnvironment(value) {
  const normalized = String(value || "").trim();
  if (normalized === "Sandbox" || normalized === "Production") {
    return normalized;
  }
  return "";
}

function resolveStoredOriginalTransactionId(userData) {
  const ios = userData?.subscriptions?.ios;
  const fromStore =
    typeof ios?.originalTransactionId === "string"
      ? ios.originalTransactionId.trim()
      : "";
  if (fromStore) {
    return fromStore;
  }
  return String(userData?.appStoreOriginalTransactionId || "").trim();
}

function resolveStoredEnvironment(userData) {
  return (
    normalizeEnvironment(userData?.appStoreEnvironment) ||
    normalizeEnvironment(userData?.subscriptions?.ios?.environment) ||
    ""
  );
}

function expiryMillisFromUserData(ios, userData) {
  const fromStore = parseExpiryToDate(ios?.expiryTime);
  if (fromStore) {
    return fromStore.getTime();
  }
  const legacy =
    String(userData?.subscriptionPlatform || "").toLowerCase() === "ios"
      ? parseExpiryToDate(userData?.subscriptionExpiryTime)
      : null;
  return legacy ? legacy.getTime() : 0;
}

function isUsableStoreStatus(status) {
  return USABLE_STORE_STATUSES.has(String(status || "").trim().toLowerCase());
}

function isSameAppleTransaction(storedTxn, appleTxn) {
  const stored = String(storedTxn || "").trim();
  const apple = String(appleTxn || "").trim();
  return Boolean(stored && apple && stored === apple);
}

function appleEventTimeMs(transactionInfo, derived) {
  const revocationDate = Number(transactionInfo?.revocationDate || 0);
  if (Number.isFinite(revocationDate) && revocationDate > 0) {
    return revocationDate;
  }
  const purchaseDate = Number(transactionInfo?.purchaseDate || 0);
  if (Number.isFinite(purchaseDate) && purchaseDate > 0) {
    return purchaseDate;
  }
  const expiresDate = Number(derived?.expiresDate || 0);
  if (Number.isFinite(expiresDate) && expiresDate > 0) {
    return expiresDate;
  }
  return 0;
}

/**
 * Decide whether Apple-derived state is too stale to overwrite current Firestore.
 * Does not use transactionId ordering (numeric or lexical).
 */
function evaluateReconcileWriteDecision({
  userData,
  derived,
  transactionInfo,
  beginSnapshot,
  nowMs = Date.now(),
}) {
  const ios = userData?.subscriptions?.ios || {};
  const storedTxn = String(
    ios.transactionId || userData?.appStoreTransactionId || ""
  ).trim();
  const appleTxn = String(derived.latestTransactionId || "").trim();
  const storedExpiryMs = expiryMillisFromUserData(ios, userData);
  const appleExpiryMs = Number(derived.expiresDate || 0);
  const storedStatus = String(ios.status || userData?.subscriptionStatus || "")
    .trim()
    .toLowerCase();
  const appleStatus = String(derived.status || "").trim().toLowerCase();
  const billingRevision = Number(userData?.billingRevision || 0);
  const sameTxn = isSameAppleTransaction(storedTxn, appleTxn);
  const appleRevoked =
    derived.validationCode === "TRANSACTION_REVOKED" ||
    Number(transactionInfo?.revocationDate || 0) > 0;
  const beginExpiryMs = Number(beginSnapshot.beginExpiryMs || 0);
  const revisionAdvanced = billingRevision > beginSnapshot.billingRevision;

  if (appleRevoked) {
    if (sameTxn) {
      return { skip: false, reason: "apply_revoked_same_transaction" };
    }
    if (
      storedExpiryMs > 0 &&
      appleExpiryMs > 0 &&
      storedExpiryMs > appleExpiryMs + 60_000 &&
      isUsableStoreStatus(storedStatus)
    ) {
      return { skip: true, reason: "revoked_apple_older_than_stored_contract" };
    }
    return { skip: false, reason: "apply_revoked" };
  }

  if (sameTxn) {
    if (
      isUsableStoreStatus(storedStatus) &&
      storedExpiryMs > 0 &&
      storedExpiryMs <= nowMs &&
      appleStatus === "expired"
    ) {
      return { skip: false, reason: "apply_same_txn_contradiction_expired" };
    }
    if (
      isUsableStoreStatus(storedStatus) &&
      storedExpiryMs > nowMs + 60_000 &&
      appleStatus === "expired" &&
      appleExpiryMs > 0 &&
      storedExpiryMs - appleExpiryMs > 60_000
    ) {
      return { skip: true, reason: "stored_expiry_newer_same_transaction" };
    }
    if (
      isUsableStoreStatus(storedStatus) &&
      appleStatus === "active" &&
      storedExpiryMs > nowMs &&
      appleExpiryMs > 0 &&
      appleExpiryMs < storedExpiryMs - 60_000
    ) {
      return { skip: true, reason: "ambiguous_apple_expiry_older_than_stored" };
    }
    if (
      appleRevoked &&
      isUsableStoreStatus(storedStatus) &&
      storedExpiryMs > nowMs + 60_000
    ) {
      return { skip: true, reason: "ambiguous_revoked_apple_vs_active_stored" };
    }
    return { skip: false, reason: "apply_same_transaction" };
  }

  if (storedTxn && appleTxn && storedTxn !== appleTxn) {
    if (appleExpiryMs > 0 && storedExpiryMs > 0 && appleExpiryMs > storedExpiryMs + 60_000) {
      return { skip: false, reason: "apply_newer_apple_expiry_different_txn" };
    }
    if (
      storedExpiryMs > 0 &&
      appleExpiryMs > 0 &&
      storedExpiryMs > appleExpiryMs + 60_000 &&
      isUsableStoreStatus(storedStatus)
    ) {
      return { skip: true, reason: "stored_contract_newer_by_expiry" };
    }
    if (revisionAdvanced) {
      const appleEventMs = appleEventTimeMs(transactionInfo, derived);
      if (
        beginExpiryMs > 0 &&
        storedExpiryMs > beginExpiryMs + 60_000 &&
        appleExpiryMs > 0 &&
        appleExpiryMs <= beginExpiryMs + 60_000
      ) {
        return { skip: true, reason: "concurrent_contract_newer_on_firestore" };
      }
      if (
        appleEventMs > 0 &&
        beginExpiryMs > 0 &&
        appleExpiryMs > storedExpiryMs + 60_000
      ) {
        return { skip: false, reason: "apply_apple_renewal_after_concurrent" };
      }
      return { skip: true, reason: "concurrent_contract_changed" };
    }
  }

  if (
    revisionAdvanced &&
    storedExpiryMs > 0 &&
    appleExpiryMs > 0 &&
    storedExpiryMs > appleExpiryMs + 60_000 &&
    isUsableStoreStatus(storedStatus)
  ) {
    return { skip: true, reason: "concurrent_revision_stored_ahead" };
  }

  return { skip: false, reason: "apply_default" };
}

function summarizeIosContractForLog(userData) {
  const ios = userData?.subscriptions?.ios || {};
  const expiryMs = expiryMillisFromUserData(ios, userData);
  return {
    status: String(ios.status || userData?.subscriptionStatus || "").trim() || null,
    expiryTimeIso: expiryMs > 0 ? new Date(expiryMs).toISOString() : null,
    transactionIdSuffix: tokenSuffix(
      ios.transactionId || userData?.appStoreTransactionId || ""
    ),
    billingRevision: Number(userData?.billingRevision || 0),
  };
}

function createReconcileWriteGuard(derived, transactionInfo, beginSnapshot) {
  return (userData) =>
    evaluateReconcileWriteDecision({
      userData,
      derived,
      transactionInfo,
      beginSnapshot,
    });
}

function createVerifier(environmentName, appAppleId) {
  const environment =
    environmentName === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
  if (environment === Environment.PRODUCTION && !(appAppleId > 0)) {
    throw new Error("APP_STORE_CONNECT_APP_APPLE_ID_REQUIRED_FOR_PRODUCTION");
  }
  return new SignedDataVerifier(
    loadAppleRootCertificates(),
    true,
    environment,
    APP_STORE_BUNDLE_ID,
    appAppleId > 0 ? appAppleId : undefined
  );
}

async function acquireReconcileLock(db, admin, uid) {
  const userRef = db.collection("users").doc(uid);
  const lockUntilMs = Date.now() + LOCK_MS;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const inFlightUntil = snap.get("iosReconcileInFlightUntil");
    const untilMs =
      inFlightUntil && typeof inFlightUntil.toMillis === "function"
        ? inFlightUntil.toMillis()
        : 0;
    if (untilMs > Date.now()) {
      return { acquired: false };
    }
    tx.set(
      userRef,
      {
        iosReconcileInFlightUntil: admin.Timestamp.fromMillis(lockUntilMs),
      },
      { merge: true }
    );
    return { acquired: true, lockUntilMs };
  });
}

async function releaseReconcileLock(db, admin, uid, lockUntilMs) {
  if (!lockUntilMs) {
    return;
  }
  const userRef = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const inFlightUntil = snap.get("iosReconcileInFlightUntil");
    const untilMs =
      inFlightUntil && typeof inFlightUntil.toMillis === "function"
        ? inFlightUntil.toMillis()
        : 0;
    if (untilMs !== lockUntilMs) {
      return;
    }
    tx.set(
      userRef,
      {
        iosReconcileInFlightUntil: admin.FieldValue.delete(),
      },
      { merge: true }
    );
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

function logReconcileReturn(logger, payload) {
  logger.info(RECONCILE_TRACE, {
    step: "return",
    ...payload,
  });
}

function createReconcileIosSubscriptionHandler({
  getDb,
  admin,
  logger,
  secrets,
  getAppAppleId,
}) {
  return async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }
    const uid = request.auth.uid;
    const db = getDb();
    const startedAt = Date.now();
    const reconcileTraceId =
      String(request.data?.clientTraceId || "").trim() ||
      crypto.randomUUID();
    let lockAcquired = false;
    let lockUntilMs = 0;

    const finish = (response) => {
      logReconcileReturn(logger, {
        reconcileTraceId,
        uidSuffix: tokenSuffix(uid),
        outcome: response.outcome,
        code: response.code || null,
        elapsedMs: Date.now() - startedAt,
      });
      return { ...response, reconcileTraceId, elapsedMs: Date.now() - startedAt };
    };

    try {
      const lock = await acquireReconcileLock(db, admin, uid);
      if (!lock.acquired) {
        logger.info(RECONCILE_TRACE, {
          step: "lock.conflict",
          reconcileTraceId,
          uidSuffix: tokenSuffix(uid),
        });
        return finish({
          outcome: "retryable_error",
          code: "RECONCILE_IN_FLIGHT",
        });
      }
      lockAcquired = true;
      lockUntilMs = lock.lockUntilMs;
      logger.info(RECONCILE_TRACE, {
        step: "lock.acquired",
        reconcileTraceId,
        uidSuffix: tokenSuffix(uid),
        lockUntilMs,
      });

      const userSnap = await db.collection("users").doc(uid).get();
      if (!userSnap.exists) {
        return finish({
          outcome: "permanent_error",
          code: "USER_NOT_FOUND",
        });
      }
      const userData = userSnap.data() || {};
      const iosAtBegin = userData?.subscriptions?.ios || {};
      const beginSnapshot = {
        billingRevision: Number(userData.billingRevision || 0),
        beginExpiryMs: expiryMillisFromUserData(iosAtBegin, userData),
        ...summarizeIosContractForLog(userData),
      };
      const originalTransactionId = resolveStoredOriginalTransactionId(userData);
      if (!originalTransactionId) {
        return finish({
          outcome: "permanent_error",
          code: "MISSING_ORIGINAL_TRANSACTION_ID",
        });
      }

      const environmentHint = resolveStoredEnvironment(userData);
      logger.info(RECONCILE_TRACE, {
        step: "begin",
        reconcileTraceId,
        uidSuffix: tokenSuffix(uid),
        originalTransactionIdSuffix: tokenSuffix(originalTransactionId),
        environmentHint: environmentHint || null,
        firestoreContract: beginSnapshot,
      });

      let apiResult;
      try {
        apiResult = await fetchAppStoreAllSubscriptionStatusesWithRetry(
          originalTransactionId,
          environmentHint,
          secrets,
          {
            maxHttpAttempts: 6,
            deadlineMs: 52_000,
            httpTimeoutMs: 8_000,
            retryBackoffMs: 1_000,
            trace: {
              logger,
              operationId: reconcileTraceId,
            },
          }
        );
      } catch (apiError) {
        logger.warn(RECONCILE_TRACE, {
          step: "apple_api.failed",
          reconcileTraceId,
          uidSuffix: tokenSuffix(uid),
          errorMessage: apiError?.message || String(apiError),
          lookupErrors: apiError?.lookupErrors || null,
          httpAttempts: apiError?.httpAttempts || null,
          elapsedMs: Date.now() - startedAt,
        });
        return finish({
          outcome: "retryable_error",
          code: apiError?.nonRetryable
            ? "APPLE_API_AUTH_FAILED"
            : "APPLE_API_UNAVAILABLE",
        });
      }

      logger.info(RECONCILE_TRACE, {
        step: "apple_api.success",
        reconcileTraceId,
        uidSuffix: tokenSuffix(uid),
        environment: apiResult.environment,
        httpAttempts: apiResult.httpAttempts || null,
        elapsedMs: apiResult.elapsedMs || null,
      });

      const appAppleId = Number(getAppAppleId());
      const verifier = createVerifier(apiResult.environment, appAppleId);
      const latestEntry = await pickLatestTransactionEntry(
        apiResult.body,
        (signedInfo) => verifier.verifyAndDecodeTransaction(signedInfo),
        { activeOnly: false }
      );

      if (!latestEntry?.transactionInfo) {
        return finish({
          outcome: "retryable_error",
          code: "SUBSCRIPTION_STATUS_NOT_FOUND",
        });
      }

      const derived = deriveSubscriptionState(latestEntry.transactionInfo);
      if (
        derived.validationCode === "BUNDLE_ID_MISMATCH" ||
        derived.validationCode === "PRODUCT_ID_MISMATCH"
      ) {
        return finish({
          outcome: "permanent_error",
          code: derived.validationCode,
        });
      }

      const derivedOriginal = String(derived.originalTransactionId || "").trim();
      if (derivedOriginal && derivedOriginal !== originalTransactionId) {
        logger.warn(RECONCILE_TRACE, {
          step: "rejected.series_mismatch",
          reconcileTraceId,
          uidSuffix: tokenSuffix(uid),
          expectedSuffix: tokenSuffix(originalTransactionId),
          actualSuffix: tokenSuffix(derivedOriginal),
        });
        return finish({
          outcome: "permanent_error",
          code: "ORIGINAL_TRANSACTION_ID_MISMATCH",
        });
      }

      derived.environment =
        normalizeEnvironment(latestEntry.transactionInfo?.environment) ||
        apiResult.environment ||
        environmentHint;

      let latestRenewalInfo = null;
      if (latestEntry.renewalInfoSigned) {
        try {
          latestRenewalInfo = await verifier.verifyAndDecodeRenewalInfo(
            latestEntry.renewalInfoSigned
          );
        } catch (renewalError) {
          logger.warn(RECONCILE_TRACE, {
            step: "renewal_decode_failed",
            reconcileTraceId,
            uidSuffix: tokenSuffix(uid),
            message: renewalError?.message || String(renewalError),
          });
        }
      }

      const txnInfo = latestEntry.transactionInfo || {};
      const storedTxnAtBegin = String(
        iosAtBegin.transactionId || userData.appStoreTransactionId || ""
      ).trim();
      const appleTxn = String(derived.latestTransactionId || "").trim();
      logger.info(RECONCILE_TRACE, {
        step: "firestore_update.begin",
        reconcileTraceId,
        uidSuffix: tokenSuffix(uid),
        appleSubscriptionStatus:
          derived.status === "active" ? "active" : "expired",
        validationCode: derived.validationCode,
        sameTransaction: isSameAppleTransaction(storedTxnAtBegin, appleTxn),
        storedTransactionIdSuffix: tokenSuffix(storedTxnAtBegin),
        appleTransactionIdSuffix: tokenSuffix(appleTxn),
        applePurchaseDateMs: Number(txnInfo.purchaseDate || 0) || null,
        appleExpiresDateMs: Number(derived.expiresDate || 0) || null,
        appleRevocationDateMs: Number(txnInfo.revocationDate || 0) || null,
      });

      const writeResult = await applyUserSubscriptionUpdate(
        db,
        admin,
        uid,
        derived,
        "ios_subscription_reconcile",
        {
          autoRenewing: autoRenewingFromRenewalInfo(latestRenewalInfo),
          notificationUUID: "",
          logger,
          dualWriteSource: "ios_subscription_reconcile",
          writeGuard: createReconcileWriteGuard(
            derived,
            latestEntry.transactionInfo,
            beginSnapshot
          ),
        }
      );

      if (writeResult?.applied === false) {
        logger.info(RECONCILE_TRACE, {
          step: "firestore_update.skipped",
          reconcileTraceId,
          uidSuffix: tokenSuffix(uid),
          skipReason: writeResult.skipReason || "write_guard_skip",
          writeDecision: writeResult.skipReason || "write_guard_skip",
          elapsedMs: Date.now() - startedAt,
        });
        return finish({
          outcome: "retryable_error",
          code: "RECONCILE_SUPERSEDED",
        });
      }

      const subscriptionStatus = derived.status === "active" ? "active" : "expired";
      logger.info(RECONCILE_TRACE, {
        step: "firestore_update.success",
        reconcileTraceId,
        uidSuffix: tokenSuffix(uid),
        subscriptionStatus,
        validationCode: derived.validationCode,
        httpAttempts: apiResult.httpAttempts || null,
        elapsedMs: Date.now() - startedAt,
      });

      return finish({
        outcome: subscriptionStatus,
        subscriptionStatus,
        validationCode: derived.validationCode,
        expiresDateMillis:
          derived.expiresDate > 0 ? derived.expiresDate : null,
        httpAttempts: apiResult.httpAttempts || null,
      });
    } finally {
      if (lockAcquired) {
        try {
          await releaseReconcileLock(db, admin, uid, lockUntilMs);
          logger.info(RECONCILE_TRACE, {
            step: "lock.released",
            reconcileTraceId,
            uidSuffix: tokenSuffix(uid),
          });
        } catch (releaseError) {
          logger.warn(RECONCILE_TRACE, {
            step: "lock_release_failed",
            reconcileTraceId,
            uidSuffix: tokenSuffix(uid),
            errorMessage: releaseError?.message || String(releaseError),
          });
        }
      }
    }
  };
}

module.exports = {
  RECONCILE_TRACE,
  evaluateReconcileWriteDecision,
  createReconcileWriteGuard,
  createReconcileIosSubscriptionHandler,
};
