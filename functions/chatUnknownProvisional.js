"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { evaluatePlatformEntitlement } = require("./platformEntitlement");
const {
  assertActiveDeviceAllowed,
  evaluateActiveDeviceGate,
} = require("./activeDeviceGate");

const CHAT_UNKNOWN_PROVISIONAL_UNTIL = "chatUnknownProvisionalUntil";
const CHAT_UNKNOWN_PROVISIONAL_STREAK = "chatUnknownProvisionalUnknownStreak";
const CHAT_UNKNOWN_PROVISIONAL_UPDATED_AT = "chatUnknownProvisionalUpdatedAt";

const PROVISIONAL_MS = 24 * 60 * 60 * 1000;
const LOG_TAG = "KAMOME_CHAT_UNKNOWN_PROVISIONAL";

const CHAT_CONTRACT_OUTCOME = {
  active: "active",
  expired: "expired",
  noPurchase: "noPurchase",
  unknown: "unknown",
  unknownRecorded: "unknownRecorded",
  dedicatedStop: "dedicatedStop",
};

const EXPIRED_DENY_REASONS = new Set([
  "unusable_status:expired",
  "unusable_status:paused",
  "unusable_status:refunded",
  "unusable_status:revoked",
  "expiry_not_future",
  "expiry_expired",
]);

const NO_PURCHASE_DENY_REASONS = new Set(["unusable_status:none"]);

const DEDICATED_STOP_DENY_REASONS = new Set([
  "invalid_platform",
  "legacy_other_platform",
  "legacy_platform_mismatch",
  "entitlement_false",
  "inconsistent_store_data",
  "inconsistent_legacy_data",
]);

const UNKNOWN_ELIGIBLE_DENY_REASONS = new Set([
  "data_missing",
  "empty_status",
  "missing_store_state",
  "expiry_missing",
]);

function uidTail(uid) {
  const value = String(uid || "").trim();
  if (!value) return "none";
  return value.length <= 6 ? value : value.slice(-6);
}

function parseChatUnknownProvisionalUntil(value) {
  if (value == null || value === "") {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value.toDate === "function") {
    try {
      const date = value.toDate();
      return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
    } catch (_) {
      return null;
    }
  }
  if (typeof value === "object" && typeof value.seconds === "number") {
    const ms =
      value.seconds * 1000 +
      Math.floor((value.nanoseconds || 0) / 1e6);
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function isChatUnknownProvisionalActive(userData, now = new Date()) {
  const until = parseChatUnknownProvisionalUntil(
    userData && userData[CHAT_UNKNOWN_PROVISIONAL_UNTIL],
  );
  if (!until) {
    return { active: false, until: null };
  }
  if (until.getTime() > now.getTime()) {
    return { active: true, until };
  }
  return { active: false, until, expired: true };
}

/**
 * evaluatePlatformEntitlement の denyReason / status からチャット契約4状態を分類。
 * 部分一致・推測は使わない。
 */
function classifyLegacyStatusInactive(status) {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "expired") {
    return CHAT_CONTRACT_OUTCOME.expired;
  }
  if (normalizedStatus === "none") {
    return CHAT_CONTRACT_OUTCOME.noPurchase;
  }
  return CHAT_CONTRACT_OUTCOME.unknown;
}

/**
 * evaluatePlatformEntitlement の denyReason / status からチャット契約状態を分類。
 * 未分類は Unknown に落とさず dedicatedStop（安全側）とする。
 */
function classifyChatContractDenyReason(denyReason, status) {
  if (!denyReason) {
    return CHAT_CONTRACT_OUTCOME.dedicatedStop;
  }
  const reason = String(denyReason);
  if (DEDICATED_STOP_DENY_REASONS.has(reason)) {
    return CHAT_CONTRACT_OUTCOME.dedicatedStop;
  }
  if (EXPIRED_DENY_REASONS.has(reason)) {
    return CHAT_CONTRACT_OUTCOME.expired;
  }
  if (NO_PURCHASE_DENY_REASONS.has(reason)) {
    return CHAT_CONTRACT_OUTCOME.noPurchase;
  }
  if (reason.startsWith("unusable_status:")) {
    const storeStatus = reason.slice("unusable_status:".length);
    if (
      storeStatus === "expired" ||
      storeStatus === "paused" ||
      storeStatus === "refunded" ||
      storeStatus === "revoked"
    ) {
      return CHAT_CONTRACT_OUTCOME.expired;
    }
    if (storeStatus === "none") {
      return CHAT_CONTRACT_OUTCOME.noPurchase;
    }
    return CHAT_CONTRACT_OUTCOME.dedicatedStop;
  }
  if (reason.startsWith("unknown_status:")) {
    return CHAT_CONTRACT_OUTCOME.unknown;
  }
  if (UNKNOWN_ELIGIBLE_DENY_REASONS.has(reason)) {
    return CHAT_CONTRACT_OUTCOME.unknown;
  }
  if (reason === "status_inactive") {
    return classifyLegacyStatusInactive(status);
  }
  return CHAT_CONTRACT_OUTCOME.dedicatedStop;
}

function classifyChatPlatformEntitlement(userData, platform, now = new Date(), options = {}) {
  const evaluated = evaluatePlatformEntitlement(userData, platform, now, options);
  // expiry_not_future は「期限切れ」と「期限を読めない」を兼ねる。
  // 実際の日時が無い場合は期限切れを推測せず、チャットではUnknownにする。
  const decision = evaluated.denyReason === "expiry_not_future" && evaluated.expiryDate == null
    ? { ...evaluated, denyReason: "expiry_missing" }
    : evaluated;
  if (decision.usable) {
    return {
      contractState: CHAT_CONTRACT_OUTCOME.active,
      decision,
    };
  }
  return {
    contractState: classifyChatContractDenyReason(
      decision.denyReason,
      decision.status,
    ),
    decision,
  };
}

function isDefinitiveExpiredOrNoPurchaseDeny(denyReason, status) {
  const state = classifyChatContractDenyReason(denyReason, status);
  return (
    state === CHAT_CONTRACT_OUTCOME.expired ||
    state === CHAT_CONTRACT_OUTCOME.noPurchase
  );
}

function resolveChatEntitlementWithUnknownProvisional(
  userData,
  platform,
  now = new Date(),
  options = {},
) {
  const classified = classifyChatPlatformEntitlement(
    userData,
    platform,
    now,
    options,
  );
  const decision = classified.decision;
  if (classified.contractState === CHAT_CONTRACT_OUTCOME.active) {
    return {
      allowed: true,
      decision,
      provisionalUsed: false,
      contractState: classified.contractState,
      decisionSource: decision.decisionSource,
    };
  }
  if (classified.contractState === CHAT_CONTRACT_OUTCOME.dedicatedStop) {
    return {
      allowed: false,
      decision,
      provisionalUsed: false,
      dedicatedStop: true,
      contractState: classified.contractState,
      denyReason: decision.denyReason,
    };
  }
  if (
    classified.contractState === CHAT_CONTRACT_OUTCOME.expired ||
    classified.contractState === CHAT_CONTRACT_OUTCOME.noPurchase
  ) {
    return {
      allowed: false,
      decision,
      provisionalUsed: false,
      definitiveDeny: true,
      contractState: classified.contractState,
      denyReason: decision.denyReason,
    };
  }
  const provisional = isChatUnknownProvisionalActive(userData, now);
  if (provisional.active) {
    return {
      allowed: true,
      decision,
      provisionalUsed: true,
      contractState: CHAT_CONTRACT_OUTCOME.unknown,
      provisionalUntil: provisional.until,
      denyReason: decision.denyReason,
    };
  }
  return {
    allowed: false,
    decision,
    provisionalUsed: false,
    contractState: CHAT_CONTRACT_OUTCOME.unknown,
    denyReason: decision.denyReason,
  };
}

function rejectClientControlledProvisionalFields(data) {
  if (!data || typeof data !== "object") {
    return;
  }
  const forbidden = [
    CHAT_UNKNOWN_PROVISIONAL_UNTIL,
    CHAT_UNKNOWN_PROVISIONAL_STREAK,
    "until",
    "untilMillis",
    "provisionalUntil",
    "subscriptions",
    "subscriptionStatus",
    "subscriptionExpiryTime",
    "entitlementUsable",
    "outcome",
    "contractState",
    "clientContractState",
  ];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      throw new HttpsError(
        "invalid-argument",
        "Client must not supply provisional or subscription fields.",
      );
    }
  }
}

function provisionalClearPatch(admin) {
  return {
    [CHAT_UNKNOWN_PROVISIONAL_UNTIL]: admin.FieldValue.delete(),
    [CHAT_UNKNOWN_PROVISIONAL_STREAK]: admin.FieldValue.delete(),
    [CHAT_UNKNOWN_PROVISIONAL_UPDATED_AT]:
      admin.FieldValue.serverTimestamp(),
  };
}

function createRecordChatUnknownProvisionalHandler({
  admin,
  logger,
  platformFromAppCheckAppId,
  parseExpiryWithMeta,
}) {
  return async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }
    rejectClientControlledProvisionalFields(request.data);
    const platform = platformFromAppCheckAppId(request.app && request.app.appId);
    if (platform !== "ios" && platform !== "android") {
      throw new HttpsError("failed-precondition", "UNKNOWN_APP_ID", { code: "UNKNOWN_APP_ID" });
    }
    const userRef = admin.getDb().collection("users").doc(uid);
    const entitlementOptions = typeof parseExpiryWithMeta === "function" ? { parseExpiryWithMeta } : {};
    // 同じtransaction snapshotで端末・契約を確認してから、仮期限だけを書き込む。
    const result = await admin.getDb().runTransaction(async (transaction) => {
      const snap = await transaction.get(userRef);
      if (!snap.exists) throw new HttpsError("not-found", "User document not found.");
      const data = snap.data() || {};
      const deviceGate = await evaluateActiveDeviceGate({
        uid, data: request.data, getUserData: async () => data,
      });
      if (!deviceGate.ok) throw deviceGate.httpsError;
      const now = new Date();
      const classified = classifyChatPlatformEntitlement(data, platform, now, entitlementOptions);
      const metadata = {
        contractState: classified.contractState,
        denyReason: classified.decision.denyReason || null,
        decisionSource: classified.decision.decisionSource,
      };
      if (classified.contractState !== CHAT_CONTRACT_OUTCOME.unknown) {
        transaction.set(userRef, provisionalClearPatch(admin), { merge: true });
        return {
          ...metadata, outcome: classified.contractState, recorded: false,
          ...(classified.contractState === CHAT_CONTRACT_OUTCOME.dedicatedStop
            ? { stopReason: classified.decision.denyReason || null } : {}),
        };
      }
      const until = new Date(now.getTime() + PROVISIONAL_MS);
      const prev = Number(data[CHAT_UNKNOWN_PROVISIONAL_STREAK] || 0);
      const unknownStreak = Number.isFinite(prev) && prev > 0 ? prev + 1 : 1;
      transaction.set(userRef, {
        [CHAT_UNKNOWN_PROVISIONAL_UNTIL]: admin.Timestamp.fromDate(until),
        [CHAT_UNKNOWN_PROVISIONAL_STREAK]: unknownStreak,
        [CHAT_UNKNOWN_PROVISIONAL_UPDATED_AT]: admin.FieldValue.serverTimestamp(),
      }, { merge: true });
      return {
        ...metadata, outcome: CHAT_CONTRACT_OUTCOME.unknownRecorded,
        recorded: true, untilMillis: until.getTime(), unknownStreak,
      };
    });
    try {
      logger.info(LOG_TAG, {
        action: result.recorded ? "record" : "recordRejected",
        uidSuffix: uidTail(uid), platform, contractState: result.contractState,
        denyReason: result.denyReason, decisionSource: result.decisionSource,
        ...(result.recorded ? {
          unknownStreak: result.unknownStreak,
          provisionalUntilIso: new Date(result.untilMillis).toISOString(),
        } : {}),
      });
    } catch (_) { /* logging must not block */ }
    const { contractState, denyReason, decisionSource, ...response } = result;
    return response;
  };
}

function createClearChatUnknownProvisionalHandler({ admin, logger }) {
  return async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }
    rejectClientControlledProvisionalFields(request.data);
    await assertActiveDeviceAllowed({
      admin,
      uid,
      data: request.data,
    });

    const userRef = admin.getDb().collection("users").doc(uid);
    await userRef.set(provisionalClearPatch(admin), { merge: true });

    try {
      logger.info(LOG_TAG, {
        action: "clear",
        uidSuffix: uidTail(uid),
      });
    } catch (_) {
      // logging must not block
    }

    return { ok: true, outcome: "cleared" };
  };
}

module.exports = {
  CHAT_UNKNOWN_PROVISIONAL_UNTIL,
  CHAT_UNKNOWN_PROVISIONAL_STREAK,
  CHAT_CONTRACT_OUTCOME,
  LOG_TAG,
  uidTail,
  parseChatUnknownProvisionalUntil,
  isChatUnknownProvisionalActive,
  classifyChatContractDenyReason,
  classifyChatPlatformEntitlement,
  isDefinitiveExpiredOrNoPurchaseDeny,
  resolveChatEntitlementWithUnknownProvisional,
  createRecordChatUnknownProvisionalHandler,
  createClearChatUnknownProvisionalHandler,
};
