"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { tokenSuffix } = require("./billingFinalTrace");
const {
  validateRegisterDeviceUsageInput,
} = require("./registerDeviceUsage");
const {
  MAX_FCM_TOKEN_LENGTH,
  MIN_FCM_TOKEN_LENGTH,
} = require("./registerDeviceFcmToken");

const CLAIM_ACTIVE_DEVICE_TAG = "KAMOME_CLAIM_ACTIVE_DEVICE";
const CLAIM_ACTIVE_DEVICE_NEEDS_CONFIRMATION = "NEEDS_CONFIRMATION";
const CLAIM_ACTIVE_DEVICE_STALE_CLAIM = "STALE_ACTIVE_DEVICE_CLAIM";
const FCM_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalFcmToken(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (
    normalized.length < MIN_FCM_TOKEN_LENGTH ||
    normalized.length > MAX_FCM_TOKEN_LENGTH ||
    !FCM_TOKEN_PATTERN.test(normalized)
  ) {
    throw new HttpsError("invalid-argument", "fcmToken is invalid.");
  }
  return normalized;
}

function normalizeClaimReason(value) {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "auto" ||
    normalized === "confirmed" ||
    normalized === "retry" ||
    normalized === "reserve"
  ) {
    return normalized;
  }
  return null;
}

function normalizeClaimGeneration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return 0;
  }
  return parsed;
}

// auto | confirmed | reserve。不正・欠落は安全側の auto（既存activeを上書きしない）。
function normalizeClaimMode(data) {
  if (!isPlainObject(data)) {
    return "auto";
  }
  const mode = String(data.mode ?? "").trim();
  if (mode === "auto" || mode === "confirmed" || mode === "reserve") {
    return mode;
  }
  const reason = normalizeClaimReason(data.claimReason);
  if (reason === "confirmed" || reason === "retry") {
    return "confirmed";
  }
  if (reason === "reserve") {
    return "reserve";
  }
  return "auto";
}

function validateClaimActiveDeviceInput(data) {
  const deviceInput = validateRegisterDeviceUsageInput(data);
  if (!isPlainObject(data)) {
    throw new HttpsError("invalid-argument", "Request body must be an object.");
  }
  const fcmToken = Object.prototype.hasOwnProperty.call(data, "fcmToken")
    ? normalizeOptionalFcmToken(data.fcmToken)
    : "";
  return {
    ...deviceInput,
    fcmToken,
    claimReason: normalizeClaimReason(data.claimReason),
    claimGeneration: normalizeClaimGeneration(data.claimGeneration),
    mode: normalizeClaimMode(data),
  };
}

function createClaimActiveDeviceHandler({ admin, logger }) {
  return async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }
    if (!request.app) {
      throw new HttpsError("failed-precondition", "App Check required.");
    }

    const input = validateClaimActiveDeviceInput(request.data);
    const uidSuffix = tokenSuffix(uid);
    const newDeviceIdSuffix = tokenSuffix(input.deviceId);
    logger.info(CLAIM_ACTIVE_DEVICE_TAG, {
      event: "claim_active_device.start",
      uidSuffix,
      newDeviceIdSuffix,
      reason: input.claimReason,
      mode: input.mode,
      platform: input.platform,
      buildNumber: input.buildNumber,
      claimGenerationSuffix: input.claimGeneration
        ? String(input.claimGeneration).slice(-2)
        : null,
    });
    const db = admin.getDb();
    const userRef = db.collection("users").doc(uid);
    const deviceRef = userRef.collection("devices").doc(input.deviceId);
    const now = admin.FieldValue.serverTimestamp();

    const result = await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      const deviceSnap = await tx.get(deviceRef);
      const userData = userSnap.exists ? userSnap.data() || {} : {};
      const previousActiveDeviceId = String(userData.activeDeviceId || "").trim();
      const pendingActiveDeviceId = String(
        userData.pendingActiveDeviceId || ""
      ).trim();
      const pendingActiveClaimGeneration = normalizeClaimGeneration(
        userData.pendingActiveClaimGeneration
      );
      const created = !deviceSnap.exists;
      const switched =
        Boolean(previousActiveDeviceId) &&
        previousActiveDeviceId !== input.deviceId;

      if (input.mode === "reserve") {
        const nextClaimGeneration =
          normalizeClaimGeneration(userData.claimGenerationSequence) + 1;
        const userUpdate = {
          pendingActiveDeviceId: input.deviceId,
          pendingActiveDeviceUpdatedAt: now,
          pendingActiveClaimGeneration: nextClaimGeneration,
          claimGenerationSequence: nextClaimGeneration,
        };
        if (input.fcmToken) {
          userUpdate.fcmToken = input.fcmToken;
        }
        tx.set(userRef, userUpdate, { merge: true });
        const deviceUpdate = {
          deviceId: input.deviceId,
          platform: input.platform,
          modelName: input.modelName,
          appVersion: input.appVersion,
          buildNumber: input.buildNumber,
          lastUsedAt: now,
        };
        if (created) {
          deviceUpdate.firstUsedAt = now;
        }
        if (input.fcmToken) {
          deviceUpdate.fcmToken = input.fcmToken;
          deviceUpdate.fcmUpdatedAt = now;
        }
        tx.set(deviceRef, deviceUpdate, { merge: true });
        return {
          denied: false,
          created,
          switched: false,
          reserved: true,
          previousActiveDeviceId,
          claimGeneration: nextClaimGeneration,
        };
      }

      if (input.mode === "auto" && switched) {
        logger.info(CLAIM_ACTIVE_DEVICE_TAG, {
          event: "claim_active_device.needs_confirmation",
          uidSuffix,
          newDeviceIdSuffix,
          previousDeviceIdSuffix: tokenSuffix(previousActiveDeviceId),
          mode: input.mode,
          reason: input.claimReason,
        });
        return {
          denied: true,
          previousActiveDeviceId,
        };
      }

      if (input.mode === "confirmed") {
        const sameDeviceRefresh =
          previousActiveDeviceId === input.deviceId && !pendingActiveDeviceId;
        const pendingMatches =
          pendingActiveDeviceId === input.deviceId &&
          input.claimGeneration > 0 &&
          input.claimGeneration === pendingActiveClaimGeneration;
        if (!sameDeviceRefresh && !pendingMatches) {
          logger.info(CLAIM_ACTIVE_DEVICE_TAG, {
            event: "claim_active_device.confirmed_rejected_stale",
            uidSuffix,
            newDeviceIdSuffix,
            previousDeviceIdSuffix: previousActiveDeviceId
              ? tokenSuffix(previousActiveDeviceId)
              : null,
            pendingDeviceIdSuffix: pendingActiveDeviceId
              ? tokenSuffix(pendingActiveDeviceId)
              : null,
            pendingClaimGenerationSuffix: pendingActiveClaimGeneration
              ? String(pendingActiveClaimGeneration).slice(-2)
              : null,
            inputClaimGenerationSuffix: input.claimGeneration
              ? String(input.claimGeneration).slice(-2)
              : null,
          });
          return {
            denied: true,
            stale: true,
            previousActiveDeviceId,
          };
        }
      }

      const userUpdate = {
        activeDeviceId: input.deviceId,
        activeDeviceUpdatedAt: now,
        pendingActiveDeviceId: "",
        pendingActiveClaimGeneration: 0,
      };
      if (input.fcmToken) {
        userUpdate.fcmToken = input.fcmToken;
      }
      tx.set(userRef, userUpdate, { merge: true });

      const deviceUpdate = {
        deviceId: input.deviceId,
        platform: input.platform,
        modelName: input.modelName,
        appVersion: input.appVersion,
        buildNumber: input.buildNumber,
        lastUsedAt: now,
      };
      if (created) {
        deviceUpdate.firstUsedAt = now;
      }
      if (input.fcmToken) {
        deviceUpdate.fcmToken = input.fcmToken;
        deviceUpdate.fcmUpdatedAt = now;
      }
      tx.set(deviceRef, deviceUpdate, { merge: true });

      return {
        denied: false,
        created,
        switched,
        previousActiveDeviceId,
        confirmedAccepted: input.mode === "confirmed",
      };
    });

    if (result.denied) {
      if (result.stale) {
        throw new HttpsError(
          "failed-precondition",
          CLAIM_ACTIVE_DEVICE_STALE_CLAIM,
          {
            code: CLAIM_ACTIVE_DEVICE_STALE_CLAIM,
            previousDeviceIdSuffix: tokenSuffix(result.previousActiveDeviceId),
          }
        );
      }
      throw new HttpsError(
        "failed-precondition",
        CLAIM_ACTIVE_DEVICE_NEEDS_CONFIRMATION,
        {
          code: CLAIM_ACTIVE_DEVICE_NEEDS_CONFIRMATION,
          previousDeviceIdSuffix: tokenSuffix(result.previousActiveDeviceId),
        }
      );
    }

    if (result.reserved) {
      logger.info(CLAIM_ACTIVE_DEVICE_TAG, {
        event: "claim_active_device.reserve_accepted",
        uidSuffix,
        newDeviceIdSuffix,
        previousDeviceIdSuffix: result.previousActiveDeviceId
          ? tokenSuffix(result.previousActiveDeviceId)
          : null,
        claimGenerationSuffix: String(result.claimGeneration).slice(-2),
        reason: input.claimReason,
        mode: input.mode,
        platform: input.platform,
        buildNumber: input.buildNumber,
      });
    }
    if (result.confirmedAccepted) {
      logger.info(CLAIM_ACTIVE_DEVICE_TAG, {
        event: "claim_active_device.confirmed_accepted",
        uidSuffix,
        newDeviceIdSuffix,
        previousDeviceIdSuffix: result.previousActiveDeviceId
          ? tokenSuffix(result.previousActiveDeviceId)
          : null,
        claimGenerationSuffix: input.claimGeneration
          ? String(input.claimGeneration).slice(-2)
          : null,
        reason: input.claimReason,
        mode: input.mode,
        platform: input.platform,
        buildNumber: input.buildNumber,
      });
    }

    logger.info(CLAIM_ACTIVE_DEVICE_TAG, {
      event: "claim_active_device.success",
      uidSuffix,
      newDeviceIdSuffix,
      previousDeviceIdSuffix: result.previousActiveDeviceId
        ? tokenSuffix(result.previousActiveDeviceId)
        : null,
      reason: input.claimReason,
      mode: input.mode,
      platform: input.platform,
      buildNumber: input.buildNumber,
      created: result.created,
      switched: result.switched,
      hasFcmToken: Boolean(input.fcmToken),
      claimGenerationSuffix: result.claimGeneration
        ? String(result.claimGeneration).slice(-2)
        : input.claimGeneration
          ? String(input.claimGeneration).slice(-2)
          : null,
    });

    return {
      ok: true,
      created: result.created,
      switched: result.switched,
      claimGeneration: result.claimGeneration ?? null,
    };
  };
}

module.exports = {
  CLAIM_ACTIVE_DEVICE_TAG,
  CLAIM_ACTIVE_DEVICE_NEEDS_CONFIRMATION,
  CLAIM_ACTIVE_DEVICE_STALE_CLAIM,
  validateClaimActiveDeviceInput,
  normalizeClaimReason,
  normalizeClaimMode,
  normalizeClaimGeneration,
  createClaimActiveDeviceHandler,
};
