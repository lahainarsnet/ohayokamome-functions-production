"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { inspectSubscriptionSeriesOwnership } = require("./subscriptionOwnership");

function createInspectSubscriptionSeriesOwnershipHandler({ admin, logger }) {
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
      const result = await inspectSubscriptionSeriesOwnership(admin.getDb(), {
        uid,
        platform,
        purchaseToken: data.purchaseToken,
        linkedPurchaseToken: data.linkedPurchaseToken,
        originalTransactionId: data.originalTransactionId,
        log: logger,
        traceId: data.billingTraceId,
      });
      return {
        ok: true,
        decision: result.decision,
        reason: result.reason || "",
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
