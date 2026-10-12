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
const { buildAndroidOwnershipId } = require("./subscriptionOwnership");

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
  // 旧形式の activePurchaseTokens は iPhone の取引番号も入る（両OSで共有）。Android の旧形式の記録
  // （subscriptionPlatform が android）のときだけ使う。Apple の取引番号を Google Play へ送らない。
  if (String(userData?.subscriptionPlatform || "").trim().toLowerCase() !== "android") {
    return "";
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

// Google Play Developer API の公式仕様（purchases.subscriptionsv2 のエラー表）で、購入トークンがもう使えないことを
// 明確に示す 410 の理由。
//   subscriptionNoLongerAvailable: 期限切れから長く経ち（60日超）、照会できない。
//   purchaseTokenNoLongerValid: 購入トークンが恒久的に無効（アカウント削除・購入記録なし）。
// HTTP 410 と、この理由の両方が確認できたときだけ「有効な契約ではない」とみなす。理由が読み取れない 410、
// ほかの状態コード、一時的な障害は、従来どおり失敗（安全側の停止）のままにする。
const GOOGLE_PLAY_TOKEN_GONE_REASONS = new Set([
  "subscriptionNoLongerAvailable",
  "purchaseTokenNoLongerValid",
]);

function googlePlayTokenGoneReason(error) {
  try {
    const status = Number(error?.code || error?.response?.status || error?.status || 0);
    if (status !== 410) {
      return "";
    }
    const reasons = [
      ...(Array.isArray(error?.errors) ? error.errors : []),
      ...(Array.isArray(error?.response?.data?.error?.errors) ? error.response.data.error.errors : []),
    ].map((item) => String(item?.reason || ""));
    return reasons.find((reason) => GOOGLE_PLAY_TOKEN_GONE_REASONS.has(reason)) || "";
  } catch (_) {
    return "";
  }
}

// 保留（ON_HOLD）・一時停止（PAUSED）は、今は利用できないが、支払いの修復や再開で有効に戻る。
// 呼び出し側が「期限切れ」と区別できるよう、理由を分けて返す。
function isGooglePlaySuspended(derived) {
  return (
    derived?.status === "paused" ||
    derived?.subscriptionState === "SUBSCRIPTION_STATE_ON_HOLD" ||
    derived?.subscriptionState === "SUBSCRIPTION_STATE_PAUSED"
  );
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
    // 対策①: 問い合わせ開始時（ストアを呼ぶ前）の更新番号。書き込みのトランザクション内で照合する。
    const baselineBillingRevision = Number(userData.billingRevision || 0);

    // 別のUIDが所有する購入トークンの契約を、このUIDの契約として同期しない。
    // 所有権の記録がない（旧形式）場合は、従来どおり通す。
    try {
      const ownerSnap = await db
        .collection("subscription_ownership")
        .doc(buildAndroidOwnershipId(purchaseToken))
        .get();
      const ownerUid = ownerSnap && ownerSnap.exists
        ? String(
            (typeof ownerSnap.get === "function"
              ? ownerSnap.get("ownerUid")
              : (ownerSnap.data() || {}).ownerUid) || "",
          ).trim()
        : "";
      if (ownerUid && ownerUid !== uid) {
        logger.warn(`${PROBE_TRACE} ownership mismatch`, {
          uidSuffix,
          tokenSuffix: tokenSuffix(purchaseToken),
          reconcileMode,
          phase: phase || "",
        });
        return {
          outcome: "failed",
          reason: "ownership_mismatch",
          billingRevisionBefore: baselineBillingRevision,
          billingRevisionAfter: baselineBillingRevision,
        };
      }
    } catch (ownershipError) {
      logger.warn(`${PROBE_TRACE} ownership check failed`, {
        uidSuffix,
        errorType: ownershipError?.constructor?.name || typeof ownershipError,
      });
      return {
        outcome: "failed",
        reason: "ownership_check_failed",
        billingRevisionBefore: baselineBillingRevision,
        billingRevisionAfter: baselineBillingRevision,
      };
    }

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
          storeState: "unknown",
          billingRevisionBefore: baselineBillingRevision,
          billingRevisionAfter: baselineBillingRevision,
          apiAttempts,
        };
      }

      const derived = deriveEntitlement({
        subscription,
        matchedLineItem,
      });

      derived.storeObservedAtMs = syncResult.storeObservedAtMs;
      const suspended = isGooglePlaySuspended(derived);
      const inactiveReason = suspended ? "google_play_suspended" : "google_play_not_active";
      const freshSnap = await userRef.get();
      const freshData = freshSnap.exists ? freshSnap.data() || {} : {};
      // A・C1へ返す結果。ストアの状態を4分類へ確定できるものだけを expired とし、それ以外は unknown / suspended とする。
      const freshRevision = Number(freshData.billingRevision || 0);
      const revisionInfo = (after) => ({
        billingRevisionBefore: baselineBillingRevision,
        billingRevisionAfter: Number.isFinite(after) ? after : freshRevision,
      });
      const storeState = isUsableEntitlement(derived)
        ? "active"
        : derived.status === "expired"
          ? "expired"
          : suspended
            ? "suspended"
            : "unknown";

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
            storeState,
            ...revisionInfo(freshRevision),
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
            baselineBillingRevision,
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
          storeState,
          ...revisionInfo(applyResult.billingRevisionAfter),
          apiAttempts,
        };
      }

      // 契約状態を確定できない応答（状態不明など）では、Firebase の契約情報を変更しない。
      if (derived.status === "unknown") {
        logger.info(`${PROBE_TRACE} inactive`, {
          uidSuffix,
          reason: "google_play_unknown_state",
          subscriptionState: derived.subscriptionState || "",
          reconcileMode,
          phase: phase || "",
          apiAttempts,
        });
        return {
          outcome: "inactive",
          reason: "google_play_unknown_state",
          subscriptionState: derived.subscriptionState || "",
          status: derived.status || "",
          expiryTime: derived.expiryTime || null,
          firestoreApplied: false,
          skipReason: "unknown_state_not_applied",
          storeState,
          ...revisionInfo(freshRevision),
          apiAttempts,
        };
      }

      if (!reconcileMode) {
        logger.info(`${PROBE_TRACE} inactive`, {
          uidSuffix,
          reason: inactiveReason,
          subscriptionState: derived.subscriptionState || "",
          status: derived.status || "",
          expiryTime: derived.expiryTime || null,
          apiAttempts,
        });
        return {
          outcome: "inactive",
          reason: inactiveReason,
          subscriptionState: derived.subscriptionState || "",
          status: derived.status || "",
          expiryTime: derived.expiryTime || null,
          storeState,
          ...revisionInfo(freshRevision),
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
          reason: inactiveReason,
          subscriptionState: derived.subscriptionState || "",
          status: derived.status || "",
          expiryTime: derived.expiryTime || null,
          firestoreApplied: false,
          skipReason: evaluation.reason || "",
          storeState,
          ...revisionInfo(freshRevision),
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
          baselineBillingRevision,
        },
      );

      logger.info(`${PROBE_TRACE} inactive`, {
        uidSuffix,
        reason: inactiveReason,
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
        reason: inactiveReason,
        subscriptionState: derived.subscriptionState || "",
        status: derived.status || "",
        expiryTime: derived.expiryTime || null,
        firestoreApplied: applyResult.applied === true,
        skipReason: applyResult.reason || "",
        storeState,
        ...revisionInfo(applyResult.billingRevisionAfter),
        apiAttempts,
      };
    } catch (error) {
      // 購入トークンがもう使えないと、公式仕様で明確に分かる 410 だけ「有効な契約ではない」。Firestore は変えない。
      const goneReason = googlePlayTokenGoneReason(error);
      if (goneReason) {
        logger.info(`${PROBE_TRACE} inactive`, {
          uidSuffix,
          reason: "google_play_token_no_longer_available",
          tokenGoneReason: goneReason,
          tokenSuffix: tokenSuffix(purchaseToken),
          reconcileMode,
          phase: phase || "",
          apiAttempts,
        });
        return {
          outcome: "inactive",
          reason: "google_play_token_no_longer_available",
          tokenGoneReason: goneReason,
          storeState: "token_gone",
          billingRevisionBefore: baselineBillingRevision,
          billingRevisionAfter: baselineBillingRevision,
          apiAttempts,
        };
      }
      logger.warn(`${PROBE_TRACE} failed`, {
        uidSuffix,
        tokenSuffix: tokenSuffix(purchaseToken),
        reason: "google_api_error",
        clientTraceId: clientTraceId || "",
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
