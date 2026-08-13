/**
 * Chat-session Google Play entitlement probe (lightweight, auth-only).
 *
 * Reads purchaseToken from Firestore for the authenticated UID only.
 * Does NOT accept purchaseToken / UID from the client payload.
 */
const { HttpsError } = require("firebase-functions/v2/https");
const { uidTail } = require("./kamomeIdTrace");
const {
  GOOGLE_PLAY_PACKAGE_NAME,
  deriveGooglePlayEntitlement,
  isUsableGooglePlayEntitlement,
  syncGooglePlaySubscriptionByPurchaseToken,
  applyGoogleSubscriptionUpdateToUser,
  tokenSuffix,
} = require("./googlePlaySubscriptionNotifications");

const PROBE_TRACE = "SUBSCRIPTION_ACK_GOOGLE_PLAY_PROBE";

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
    }

    logger.info(`${PROBE_TRACE} start`, { uidSuffix });

    const db = getDb();
    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      logger.info(`${PROBE_TRACE} skipped`, {
        uidSuffix,
        reason: "user_not_found",
      });
      return { outcome: "skipped", reason: "user_not_found" };
    }

    const userData = userSnap.data() || {};
    const purchaseToken = resolveStoredPrimaryPurchaseToken(userData);
    if (!purchaseToken) {
      logger.info(`${PROBE_TRACE} skipped`, {
        uidSuffix,
        reason: "no_purchase_token",
      });
      return { outcome: "skipped", reason: "no_purchase_token" };
    }

    logger.info(`${PROBE_TRACE} google_play_api start`, {
      uidSuffix,
      tokenSuffix: tokenSuffix(purchaseToken),
    });

    try {
      const { subscription, matchedLineItem } =
        await syncSubscriptionByPurchaseToken(
          GOOGLE_PLAY_PACKAGE_NAME,
          purchaseToken,
        );

      if (!matchedLineItem) {
        logger.info(`${PROBE_TRACE} inactive`, {
          uidSuffix,
          reason: "no_matched_line_item",
          subscriptionState: subscription?.subscriptionState || "",
        });
        return {
          outcome: "inactive",
          reason: "no_matched_line_item",
          subscriptionState: subscription?.subscriptionState || "",
        };
      }

      const derived = deriveEntitlement({
        subscription,
        matchedLineItem,
      });

      if (!isUsableEntitlement(derived)) {
        logger.info(`${PROBE_TRACE} inactive`, {
          uidSuffix,
          reason: "google_play_not_active",
          subscriptionState: derived.subscriptionState || "",
          status: derived.status || "",
          expiryTime: derived.expiryTime || null,
        });
        return {
          outcome: "inactive",
          reason: "google_play_not_active",
          subscriptionState: derived.subscriptionState || "",
          status: derived.status || "",
          expiryTime: derived.expiryTime || null,
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
          subscriptionSource: "google_play_probe",
          dualWriteSource: "google_probe",
          primaryPurchaseToken: purchaseToken,
        },
      );

      logger.info(`${PROBE_TRACE} active`, {
        uidSuffix,
        tokenSuffix: tokenSuffix(purchaseToken),
        expiryTime: derived.expiryTime || null,
        subscriptionState: derived.subscriptionState || "",
        firestoreApplied: applyResult.applied === true,
        skipReason: applyResult.reason || "",
      });

      return {
        outcome: "active",
        subscriptionStatus: derived.status,
        expiryTime: derived.expiryTime || null,
        subscriptionState: derived.subscriptionState || "",
        firestoreApplied: applyResult.applied === true,
        skipReason: applyResult.reason || "",
      };
    } catch (error) {
      logger.warn(`${PROBE_TRACE} failed`, {
        uidSuffix,
        tokenSuffix: tokenSuffix(purchaseToken),
        reason: error?.message || String(error),
        errorType: error?.constructor?.name || typeof error,
      });
      return {
        outcome: "failed",
        reason: "google_api_error",
      };
    }
  };
}

module.exports = {
  createGooglePlaySubscriptionProbeHandler,
  resolveStoredPrimaryPurchaseToken,
  PROBE_TRACE,
};
