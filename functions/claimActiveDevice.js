"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { tokenSuffix } = require("./billingFinalTrace");
const { evaluatePlatformEntitlement } = require("./platformEntitlement");
const {
  validateRegisterDeviceUsageInput,
} = require("./registerDeviceUsage");
const {
  resolveVerifiedClientPlatform,
  verifiedDevicePlatformFields,
} = require("./devicePlatformAppCheck");
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
    deviceSwitchTraceId: /^ds-[0-9]{1,20}-[0-9]{1,8}$/.test(String(data.deviceSwitchTraceId || ""))
      ? String(data.deviceSwitchTraceId)
      : null,
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

    // Bind newer clients' captured UID before any transaction/write. Older
    // clients remain supported and still operate only on request.auth.uid.
    if (request.data && request.data.expectedUid != null && request.data.expectedUid !== uid) {
      throw new HttpsError("failed-precondition", "DEVICE_SWITCH_UID_CHANGED", {code:"DEVICE_SWITCH_UID_CHANGED"});
    }
    const input = validateClaimActiveDeviceInput(request.data);
    const verifiedPlatform = resolveVerifiedClientPlatform(
      request,
      input.platform,
    );
    const platformFields = verifiedDevicePlatformFields(verifiedPlatform);
    const uidSuffix = String(uid).length <= 6 ? "(short-id)" : tokenSuffix(uid);
    const newDeviceIdSuffix = tokenSuffix(input.deviceId);
    logger.info(CLAIM_ACTIVE_DEVICE_TAG, {
      event: "claim_active_device.start",
      deviceSwitchTraceId: input.deviceSwitchTraceId,
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
      // Source OS is diagnostic only; entitlement always uses verified destination OS.
      const sourceDeviceSnap = previousActiveDeviceId
        ? await tx.get(userRef.collection("devices").doc(previousActiveDeviceId)) : null;
      const sourceData = sourceDeviceSnap && sourceDeviceSnap.exists ? sourceDeviceSnap.data() || {} : {};
      const sourcePlatform = ["ios", "android"].includes(sourceData.platform) ? sourceData.platform : "unresolved";
      logger.info(CLAIM_ACTIVE_DEVICE_TAG, { event: "claim_active_device.transfer_context",
        uidSuffix, newDeviceIdSuffix, sourcePlatform, targetPlatform: verifiedPlatform,
        deviceSwitchTraceId: input.deviceSwitchTraceId, mode: input.mode });
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
          ...platformFields,
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
          deviceSwitchTraceId: input.deviceSwitchTraceId,
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
        // Final claim uses this authenticated UID's destination-OS contract.
        // Chat-only provisional access never authorizes device transfer.
        if (switched) {
          const entitlement = evaluatePlatformEntitlement(userData, verifiedPlatform, new Date());
          logger.info(CLAIM_ACTIVE_DEVICE_TAG, {
            event: "claim_active_device.contract_checked",
            uidSuffix, newDeviceIdSuffix, platform: verifiedPlatform,
            deviceSwitchTraceId: input.deviceSwitchTraceId,
            usable: entitlement.usable, decisionSource: entitlement.decisionSource,
            contractState: entitlement.usable ? "active"
              : ["legacy_other_platform", "invalid_platform", "legacy_platform_mismatch"].includes(entitlement.denyReason) ? "dedicatedStop"
              : entitlement.status === "none" ? "noPurchase"
              : ["expired", "paused", "refunded", "revoked"].includes(entitlement.status) ||
                ["expiry_not_future", "expiry_expired"].includes(entitlement.denyReason) ? "expired" : "unknown",
          });
          if (!entitlement.usable) {
            throw new HttpsError("failed-precondition", "DEVICE_SWITCH_CONTRACT_NOT_ACTIVE", {
              code: "DEVICE_SWITCH_CONTRACT_NOT_ACTIVE",
            });
          }
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
        ...platformFields,
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
        deviceSwitchTraceId: input.deviceSwitchTraceId,
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
        deviceSwitchTraceId: input.deviceSwitchTraceId,
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
      outcome: "success",
      deviceSwitchTraceId: input.deviceSwitchTraceId,
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
