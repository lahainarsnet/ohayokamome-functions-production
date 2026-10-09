/**
 * Chat-session Google Play entitlement probe (lightweight, auth-only).
 *
 * Reads purchaseToken from Firestore for the authenticated UID only.
 * Does NOT accept purchaseToken / UID from the client payload.
 */
const { HttpsError } = require("firebase-functions/v2/https");
const {
  GOOGLE_PLAY_PACKAGE_NAME,
  deriveGooglePlayEntitlement,
  isUsableGooglePlayEntitlement,
  syncGooglePlaySubscriptionByPurchaseToken,
  applyGoogleSubscriptionUpdateToUser,
  evaluateAndroidStaleReconcileApply,
  evaluateAndroidStaleActiveUpdate,
  tokenSuffix,
  ANDROID_STALE_TRACE,
} = require("./googlePlaySubscriptionNotifications");

const PROBE_TRACE = "SUBSCRIPTION_ACK_GOOGLE_PLAY_PROBE";

const ALLOWED_CLIENT_KEYS = new Set([
  "purpose",
  "phase",
  "clientTraceId",
]);

function uidTail(uid) {
  const normalized = String(uid || "").trim();
  if (!normalized) {
    return "none";
  }
  if (normalized.length <= 4) {
    return normalized;
  }
  return normalized.slice(-4);
}

function resolveStoredPrimaryPurchaseToken(userData) {
  const primary = String(userData?.googlePlayPrimaryPurchaseToken || "").trim();
  if (primary) {
    return primary;
  }
  const nested = String(
    userData?.subscriptions?.android?.primaryPurchaseToken || "",
  ).trim();
  if (nested) {
    return nested;
  }
  for (const token of Array.isArray(userData?.activePurchaseTokens)
    ? userData.activePurchaseTokens
    : []) {
    const normalized = String(token || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function parseProbeRequest(data) {
  const payload = data && typeof data === "object" ? data : {};
  const purpose = String(payload.purpose || "").trim().toLowerCase();
  const phase = String(payload.phase || "").trim().toLowerCase();
  const clientTraceId = String(payload.clientTraceId || "").trim();
  return {
    reconcileMode: purpose === "reconcile",
    phase: phase === "pre_chat" || phase === "in_chat" ? phase : "",
    clientTraceId,
  };
}

function isRetryableGooglePlayApiError(error) {
  const status = Number(error?.code || error?.response?.status || 0);
  return status === 429 || status >= 500;
}

async function syncSubscriptionWithOptionalRetry(
  syncSubscriptionByPurchaseToken,
  packageName,
  purchaseToken,
  { reconcileMode },
) {
  let lastError;
  const maxAttempts = reconcileMode ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await syncSubscriptionByPurchaseToken(
        packageName,
        purchaseToken,
      );
      return { result, apiAttempts: attempt };
    } catch (error) {
      lastError = error;
      if (
        reconcileMode &&
        attempt < maxAttempts &&
        isRetryableGooglePlayApiError(error)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function logStaleTrace(logger, fields) {
  logger.info(ANDROID_STALE_TRACE, fields);
}

function createGooglePlaySubscriptionProbeHandler({
  getDb,
  admin,
  logger,
  syncSubscriptionByPurchaseToken = syncGooglePlaySubscriptionByPurchaseToken,
  deriveEntitlement = deriveGooglePlayEntitlement,
  isUsableEntitlement = isUsableGooglePlayEntitlement,
  applySubscriptionUpdateToUser = applyGoogleSubscriptionUpdateToUser,
}) {
  return async (request) => {
    const uid = request.auth && request.auth.uid;
    const uidSuffix = uidTail(uid || "");
    if (!uid) {
      logger.warn(`${PROBE_TRACE} unauthenticated`);
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }

    if (request.data && typeof request.data === "object") {
      const forbiddenKeys = [
        "purchaseToken",
        "uid",
        "transactionId",
        "serverVerificationData",
      ];
      for (const key of forbiddenKeys) {
        if (Object.prototype.hasOwnProperty.call(request.data, key)) {
          logger.warn(`${PROBE_TRACE} rejected client-supplied identifier`, {
            uidSuffix,
            key,
          });
          throw new HttpsError(
            "invalid-argument",
            "Client-supplied subscription identifiers are not allowed.",
          );
        }
      }
      for (const key of Object.keys(request.data)) {
        if (!ALLOWED_CLIENT_KEYS.has(key)) {
          logger.warn(`${PROBE_TRACE} rejected unknown payload key`, {
            uidSuffix,
            key,
          });
          throw new HttpsError("invalid-argument", "Unknown request field.");
        }
      }
    }

    const { reconcileMode, phase, clientTraceId } = parseProbeRequest(
      request.data,
    );

    logger.info(`${PROBE_TRACE} start`, {
      uidSuffix,
      reconcileMode,
      phase: phase || "unspecified",
      clientTraceId: clientTraceId || "",
    });

    const db = getDb();
    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      logger.info(`${PROBE_TRACE} skipped`, {
        uidSuffix,
        reason: "user_not_found",
        reconcileMode,
        phase: phase || "",
      });
      return { outcome: "skipped", reason: "user_not_found" };
    }

    const userData = userSnap.data() || {};
    const purchaseToken = resolveStoredPrimaryPurchaseToken(userData);
    if (!purchaseToken) {
      logger.info(`${PROBE_TRACE} skipped`, {
        uidSuffix,
        reason: "no_purchase_token",
        reconcileMode,
        phase: phase || "",
      });
      return { outcome: "skipped", reason: "no_purchase_token" };
    }

    const baselinePrimaryToken = purchaseToken;

    logger.info(`${PROBE_TRACE} google_play_api start`, {
      uidSuffix,
      tokenSuffix: tokenSuffix(purchaseToken),
      reconcileMode,
      phase: phase || "",
    });

    let apiAttempts = 0;
    try {
      const { result: syncResult, apiAttempts: attemptsUsed } =
        await syncSubscriptionWithOptionalRetry(
          syncSubscriptionByPurchaseToken,
          GOOGLE_PLAY_PACKAGE_NAME,
          purchaseToken,
          { reconcileMode },
        );
      apiAttempts = attemptsUsed;
      const { subscription, matchedLineItem } = syncResult;

      logger.info(`${PROBE_TRACE} google_play_api end`, {
        uidSuffix,
        reconcileMode,
        phase: phase || "",
        apiAttempts,
        subscriptionState: subscription?.subscriptionState || "",
      });

      if (!matchedLineItem) {
        logger.info(`${PROBE_TRACE} inactive`, {
          uidSuffix,
          reason: "no_matched_line_item",
          subscriptionState: subscription?.subscriptionState || "",
          reconcileMode,
          phase: phase || "",
          apiAttempts,
        });
        return {
          outcome: "inactive",
          reason: "no_matched_line_item",
          subscriptionState: subscription?.subscriptionState || "",
          apiAttempts,
        };
      }

      const derived = deriveEntitlement({
        subscription,
        matchedLineItem,
      });

      const freshSnap = await userRef.get();
      const freshData = freshSnap.exists ? freshSnap.data() || {} : {};

      if (isUsableEntitlement(derived)) {
        const evaluation = reconcileMode
          ? evaluateAndroidStaleReconcileApply(freshData, derived, {
              baselinePrimaryToken,
            })
          : evaluateAndroidStaleActiveUpdate(freshData, derived);

        logStaleTrace(logger, {
          step: reconcileMode ? "reconcile_stale_evaluate" : "probe_stale_evaluate",
          source: reconcileMode ? "google_probe_reconcile" : "google_probe",
          uidSuffix,
          derivedStatus: derived.status || "",
          skipped: evaluation.skipped,
          reason: evaluation.reason || "",
        });

        if (evaluation.skipped) {
          logger.info(`${PROBE_TRACE} active`, {
            uidSuffix,
            tokenSuffix: tokenSuffix(purchaseToken),
            expiryTime: derived.expiryTime || null,
            subscriptionState: derived.subscriptionState || "",
            firestoreApplied: false,
            skipReason: evaluation.reason || "stale_skip",
            reconcileMode,
            phase: phase || "",
            apiAttempts,
          });
          return {
            outcome: "active",
            subscriptionStatus: derived.status,
            expiryTime: derived.expiryTime || null,
            subscriptionState: derived.subscriptionState || "",
            firestoreApplied: false,
            skipReason: evaluation.reason || "stale_skip",
            apiAttempts,
          };
        }

        const applyResult = await applySubscriptionUpdateToUser(
          db,
          admin,
          uid,
          derived,
          purchaseToken,
          {
            logger,
            subscriptionSource: reconcileMode
              ? "google_play_reconcile"
              : "google_play_probe",
            dualWriteSource: reconcileMode
              ? "google_probe_reconcile"
              : "google_probe",
            primaryPurchaseToken: purchaseToken,
            baselinePrimaryToken,
          },
        );

        logger.info(`${PROBE_TRACE} active`, {
          uidSuffix,
          tokenSuffix: tokenSuffix(purchaseToken),
          expiryTime: derived.expiryTime || null,
          subscriptionState: derived.subscriptionState || "",
          firestoreApplied: applyResult.applied === true,
          skipReason: applyResult.reason || "",
          reconcileMode,
          phase: phase || "",
          apiAttempts,
        });
        logStaleTrace(logger, {
          step: "probe_processed",
          source: reconcileMode ? "google_probe_reconcile" : "google_probe",
          uidSuffix,
          result: applyResult.applied ? "user_updated" : applyResult.reason || "",
          expiryTime: derived.expiryTime || null,
        });

        return {
          outcome: "active",
          subscriptionStatus: derived.status,
          expiryTime: derived.expiryTime || null,
          subscriptionState: derived.subscriptionState || "",
          firestoreApplied: applyResult.applied === true,
          skipReason: applyResult.reason || "",
          apiAttempts,
        };
      }

      if (!reconcileMode) {
        logger.info(`${PROBE_TRACE} inactive`, {
          uidSuffix,
          reason: "google_play_not_active",
          subscriptionState: derived.subscriptionState || "",
          status: derived.status || "",
          expiryTime: derived.expiryTime || null,
          apiAttempts,
        });
        return {
          outcome: "inactive",
          reason: "google_play_not_active",
          subscriptionState: derived.subscriptionState || "",
          status: derived.status || "",
          expiryTime: derived.expiryTime || null,
          apiAttempts,
        };
      }

      const evaluation = evaluateAndroidStaleReconcileApply(freshData, derived, {
        baselinePrimaryToken,
      });

      logStaleTrace(logger, {
        step: "reconcile_stale_evaluate",
        source: "google_probe_reconcile",
        uidSuffix,
        derivedStatus: derived.status || "",
        skipped: evaluation.skipped,
        reason: evaluation.reason || "",
      });

      if (evaluation.skipped) {
        logger.info(`${PROBE_TRACE} inactive`, {
          uidSuffix,
          reason: "reconcile_stale_skip",
          subscriptionState: derived.subscriptionState || "",
          status: derived.status || "",
          expiryTime: derived.expiryTime || null,
          firestoreApplied: false,
          skipReason: evaluation.reason || "",
          reconcileMode,
          phase: phase || "",
          apiAttempts,
        });
        return {
          outcome: "inactive",
          reason: "google_play_not_active",
          subscriptionState: derived.subscriptionState || "",
          status: derived.status || "",
          expiryTime: derived.expiryTime || null,
          firestoreApplied: false,
          skipReason: evaluation.reason || "",
          apiAttempts,
        };
      }

      const applyResult = await applySubscriptionUpdateToUser(
        db,
        admin,
        uid,
        derived,
        purchaseToken,
        {
          logger,
          subscriptionSource: "google_play_reconcile",
          dualWriteSource: "google_probe_reconcile",
          primaryPurchaseToken: purchaseToken,
          baselinePrimaryToken,
        },
      );

      logger.info(`${PROBE_TRACE} inactive`, {
        uidSuffix,
        reason: "google_play_not_active",
        subscriptionState: derived.subscriptionState || "",
        status: derived.status || "",
        expiryTime: derived.expiryTime || null,
        firestoreApplied: applyResult.applied === true,
        skipReason: applyResult.reason || "",
        reconcileMode,
        phase: phase || "",
        apiAttempts,
      });
      logStaleTrace(logger, {
        step: "reconcile_processed",
        source: "google_probe_reconcile",
        uidSuffix,
        result: applyResult.applied ? "user_updated" : applyResult.reason || "",
        expiryTime: derived.expiryTime || null,
      });

      return {
        outcome: "inactive",
        reason: "google_play_not_active",
        subscriptionState: derived.subscriptionState || "",
        status: derived.status || "",
        expiryTime: derived.expiryTime || null,
        firestoreApplied: applyResult.applied === true,
        skipReason: applyResult.reason || "",
        apiAttempts,
      };
    } catch (error) {
      logger.warn(`${PROBE_TRACE} failed`, {
        uidSuffix,
        tokenSuffix: tokenSuffix(purchaseToken),
        reason: error?.message || String(error),
        errorType: error?.constructor?.name || typeof error,
        reconcileMode,
        phase: phase || "",
        apiAttempts,
      });
      return {
        outcome: "failed",
        reason: "google_api_error",
        apiAttempts,
      };
    }
  };
}

module.exports = {
  createGooglePlaySubscriptionProbeHandler,
  resolveStoredPrimaryPurchaseToken,
  PROBE_TRACE,
  syncSubscriptionWithOptionalRetry,
  parseProbeRequest,
};
