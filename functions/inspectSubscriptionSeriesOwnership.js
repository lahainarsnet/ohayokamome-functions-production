"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { inspectSubscriptionSeriesOwnership } = require("./subscriptionOwnership");

function createInspectSubscriptionSeriesOwnershipHandler({ admin, logger, secrets, getAppAppleId,
  verifySeriesState = async ({ platform, purchaseToken, linkedPurchaseToken, originalTransactionId, conflictingOwnershipIds }) => {
    const { googleState, verifyAppleSeries } = require("./preChatBillingConfirmation");
    if (platform === "android") {
      const { syncGooglePlaySubscriptionByPurchaseToken, GOOGLE_PLAY_PACKAGE_NAME } = require("./googlePlaySubscriptionNotifications");
      const { subscription, matchedLineItem } = await syncGooglePlaySubscriptionByPurchaseToken(GOOGLE_PLAY_PACKAGE_NAME, purchaseToken);
      if (linkedPurchaseToken && linkedPurchaseToken !== subscription.linkedPurchaseToken) return "unknown";
      const { buildAndroidOwnershipId } = require("./subscriptionOwnership");
      const statesById = new Map([[buildAndroidOwnershipId(purchaseToken), googleState(subscription, matchedLineItem)]]);
      if (subscription.linkedPurchaseToken && subscription.linkedPurchaseToken !== purchaseToken) {
        const linked = await syncGooglePlaySubscriptionByPurchaseToken(GOOGLE_PLAY_PACKAGE_NAME, subscription.linkedPurchaseToken);
        statesById.set(buildAndroidOwnershipId(subscription.linkedPurchaseToken), googleState(linked.subscription, linked.matchedLineItem));
      }
      const states = (conflictingOwnershipIds || [...statesById.keys()]).map((id) => statesById.get(id) || "unknown");
      if (states.includes("active")) return "active";
      return states.every((state) => state === "ended") ? "ended" : "unknown";
    }
    const entries = await verifyAppleSeries(originalTransactionId, { secrets, getAppAppleId });
    if (entries.some((entry) => entry.state === "active")) return "active";
    return entries.length && entries.every((entry) => entry.state === "ended") ? "ended" : "unknown";
  } }) {
  return async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }

    const data = request.data || {};
    const platform = String(data.platform || "").trim();
    if (platform !== "android" && platform !== "ios") {
      throw new HttpsError("invalid-argument", "platform is required.");
    }

    try {
      const deviceSwitchTraceId = /^ds-[0-9]{1,20}-[0-9]{1,8}$/.test(String(data.deviceSwitchTraceId || ""))
        ? String(data.deviceSwitchTraceId)
        : null;
      const ownershipLogger = {
        info: (message, fields = {}) => logger.info(message, { ...fields, deviceSwitchTraceId }),
        warn: (message, fields = {}) => logger.warn(message, { ...fields, deviceSwitchTraceId }),
      };
      const result = await inspectSubscriptionSeriesOwnership(admin.getDb(), {
        uid,
        platform,
        purchaseToken: data.purchaseToken,
        linkedPurchaseToken: data.linkedPurchaseToken,
        originalTransactionId: data.originalTransactionId,
        log: ownershipLogger,
        traceId: data.billingTraceId,
        verifySeriesState,
      });
      return {
        ok: true,
        decision: result.decision,
        reason: result.reason || "",
        storeStatus: ["active", "expired", "unknown"].includes(result.storeStatus) ? result.storeStatus : "unknown",
        platform,
      };
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      if (typeof logger?.error === "function") {
        logger.error("inspectSubscriptionSeriesOwnership failed", {
          message: error?.message || null,
        });
      }
      throw new HttpsError(
        "unavailable",
        "Could not inspect subscription series."
      );
    }
  };
}

module.exports = {
  createInspectSubscriptionSeriesOwnershipHandler,
};
