/**
 * Cross-platform subscription dual-write helpers (Phase 1).
 *
 * - Writes store-specific state under users/{uid}.subscriptions.{ios|android}
 * - Recomputes account entitlement from BOTH stored store states
 * - Continues writing legacy top-level fields via caller-supplied legacyUpdate
 *
 * Does NOT change Flutter / purchase-reject behavior. Flutter still reads legacy fields.
 */

const ENTITLEMENT_TRACE = "KAMOME_ENTITLEMENT_TRACE";

const USABLE_STORE_STATUSES = new Set([
  "active",
  "trial",
  "grace",
  "canceled",
  "cancelled",
]);

const UNUSABLE_STORE_STATUSES = new Set([
  "expired",
  "none",
  "paused",
  "refunded",
  "revoked",
]);

function uidTail(uid) {
  const value = String(uid || "");
  if (!value) return "empty";
  return value.length <= 6 ? value : value.slice(-6);
}

function idTail(value) {
  const text = String(value || "");
  if (!text) return "empty";
  return text.length <= 6 ? text : text.slice(-6);
}

function normalizeStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase();
}

function parseExpiryToDate(value) {
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
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber) && asNumber > 0 && /^\d+$/.test(trimmed)) {
      return new Date(asNumber);
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (
    typeof value === "object" &&
    value._seconds != null &&
    Number.isFinite(Number(value._seconds))
  ) {
    return new Date(Number(value._seconds) * 1000);
  }
  return null;
}

function toFirestoreExpiryValue(admin, value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value.toDate === "function") {
    return value;
  }
  const date = parseExpiryToDate(value);
  if (!date) {
    return null;
  }
  return admin.Timestamp.fromDate(date);
}

function isStoreEntitlementUsable(storeState, now = new Date()) {
  if (!storeState || typeof storeState !== "object") {
    return {
      usable: false,
      reason: "missing_store_state",
      status: null,
      expiryDate: null,
    };
  }
  const status = normalizeStatus(storeState.status);
  const expiryDate = parseExpiryToDate(storeState.expiryTime);
  const expiryIsFuture =
    expiryDate instanceof Date && expiryDate.getTime() > now.getTime();

  if (!status) {
    return {
      usable: false,
      reason: "empty_status",
      status,
      expiryDate,
    };
  }
  if (UNUSABLE_STORE_STATUSES.has(status)) {
    return {
      usable: false,
      reason: `unusable_status:${status}`,
      status,
      expiryDate,
    };
  }
  if (!USABLE_STORE_STATUSES.has(status)) {
    return {
      usable: false,
      reason: `unknown_status:${status}`,
      status,
      expiryDate,
    };
  }
  if (!expiryIsFuture) {
    return {
      usable: false,
      reason: "expiry_not_future",
      status,
      expiryDate,
    };
  }
  return {
    usable: true,
    reason: "usable",
    status,
    expiryDate,
  };
}

/**
 * Recompute account entitlement from BOTH store snapshots.
 * Order-independent: same inputs → same result.
 */
function computeAccountEntitlement(iosState, androidState, now = new Date()) {
  const ios = isStoreEntitlementUsable(iosState, now);
  const android = isStoreEntitlementUsable(androidState, now);

  if (ios.usable && android.usable) {
    const iosMs = ios.expiryDate.getTime();
    const androidMs = android.expiryDate.getTime();
    const later = iosMs >= androidMs ? ios.expiryDate : android.expiryDate;
    return {
      entitlementUsable: true,
      entitlementExpiryTime: later,
      entitlementSource: "both",
      ios,
      android,
    };
  }
  if (ios.usable) {
    return {
      entitlementUsable: true,
      entitlementExpiryTime: ios.expiryDate,
      entitlementSource: "ios",
      ios,
      android,
    };
  }
  if (android.usable) {
    return {
      entitlementUsable: true,
      entitlementExpiryTime: android.expiryDate,
      entitlementSource: "android",
      ios,
      android,
    };
  }
  const fallbackExpiry =
    ios.expiryDate && android.expiryDate
      ? ios.expiryDate.getTime() >= android.expiryDate.getTime()
        ? ios.expiryDate
        : android.expiryDate
      : ios.expiryDate || android.expiryDate || null;
  return {
    entitlementUsable: false,
    entitlementExpiryTime: fallbackExpiry,
    entitlementSource: "none",
    ios,
    android,
  };
}

function summarizeStoreState(storeState) {
  if (!storeState || typeof storeState !== "object") {
    return null;
  }
  const expiryDate = parseExpiryToDate(storeState.expiryTime);
  return {
    status: normalizeStatus(storeState.status) || null,
    expiryTime: expiryDate ? expiryDate.toISOString() : null,
    autoRenewing:
      typeof storeState.autoRenewing === "boolean"
        ? storeState.autoRenewing
        : null,
    source: storeState.source || null,
  };
}

function summarizeLegacyUpdate(legacyUpdate) {
  if (!legacyUpdate || typeof legacyUpdate !== "object") {
    return null;
  }
  const expiryDate = parseExpiryToDate(legacyUpdate.subscriptionExpiryTime);
  return {
    subscriptionStatus: legacyUpdate.subscriptionStatus || null,
    subscriptionPlatform: legacyUpdate.subscriptionPlatform || null,
    subscriptionExpiryTime: expiryDate ? expiryDate.toISOString() : null,
    lastSubscriptionSource: legacyUpdate.lastSubscriptionSource || null,
  };
}

function buildIosStoreState({
  status,
  expiryTime,
  autoRenewing = null,
  originalTransactionId = "",
  transactionId = "",
  environment = "",
  source,
  updatedAt,
}) {
  const state = {
    status: normalizeStatus(status) || "none",
    originalTransactionId: String(originalTransactionId || ""),
    transactionId: String(transactionId || ""),
    environment: String(environment || ""),
    source: String(source || ""),
    updatedAt,
  };
  if (expiryTime != null && expiryTime !== "") {
    state.expiryTime = expiryTime;
  }
  if (typeof autoRenewing === "boolean") {
    state.autoRenewing = autoRenewing;
  } else {
    state.autoRenewing = null;
  }
  return state;
}

function buildAndroidStoreState({
  status,
  expiryTime,
  autoRenewing = null,
  primaryPurchaseToken = "",
  activePurchaseTokens = null,
  subscriptionState = "",
  source,
  updatedAt,
}) {
  const state = {
    status: normalizeStatus(status) || "none",
    primaryPurchaseToken: String(primaryPurchaseToken || ""),
    subscriptionState: String(subscriptionState || ""),
    source: String(source || ""),
    updatedAt,
  };
  if (expiryTime != null && expiryTime !== "") {
    state.expiryTime = expiryTime;
  }
  if (typeof autoRenewing === "boolean") {
    state.autoRenewing = autoRenewing;
  } else {
    state.autoRenewing = null;
  }
  if (Array.isArray(activePurchaseTokens)) {
    state.activePurchaseTokens = activePurchaseTokens
      .map((token) => String(token || "").trim())
      .filter(Boolean);
  }
  return state;
}

function inferAndroidAutoRenewing({ status, subscriptionState }) {
  const normalizedStatus = normalizeStatus(status);
  const state = String(subscriptionState || "").trim();
  if (state === "SUBSCRIPTION_STATE_CANCELED") {
    return false;
  }
  if (
    state === "SUBSCRIPTION_STATE_EXPIRED" ||
    state === "SUBSCRIPTION_STATE_ON_HOLD" ||
    state === "SUBSCRIPTION_STATE_PAUSED"
  ) {
    return false;
  }
  if (
    state === "SUBSCRIPTION_STATE_ACTIVE" ||
    state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"
  ) {
    return true;
  }
  if (normalizedStatus === "active" || normalizedStatus === "trial") {
    return null;
  }
  if (
    normalizedStatus === "expired" ||
    normalizedStatus === "paused" ||
    normalizedStatus === "none"
  ) {
    return false;
  }
  return null;
}

function mergeAndroidActiveTokens(existingAndroid, purchaseToken) {
  const existing = Array.isArray(existingAndroid?.activePurchaseTokens)
    ? existingAndroid.activePurchaseTokens
        .map((token) => String(token || "").trim())
        .filter(Boolean)
    : [];
  const next = String(purchaseToken || "").trim();
  if (!next) {
    return existing;
  }
  if (existing.includes(next)) {
    return existing;
  }
  return existing.concat([next]);
}

/**
 * Atomically:
 * 1) apply legacyUpdate (unchanged compatibility fields)
 * 2) update only the target store under subscriptions.{ios|android}
 * 3) recompute entitlement from BOTH store states after merge
 */
async function commitUserSubscriptionDualWrite({
  db,
  admin,
  uid,
  source,
  platform,
  storeState,
  legacyUpdate,
  log = console,
  meta = {},
}) {
  const normalizedPlatform = String(platform || "")
    .trim()
    .toLowerCase();
  if (normalizedPlatform !== "ios" && normalizedPlatform !== "android") {
    throw new Error(`Invalid dual-write platform: ${platform}`);
  }
  if (!uid) {
    throw new Error("uid is required for dual-write");
  }
  if (!legacyUpdate || typeof legacyUpdate !== "object") {
    throw new Error("legacyUpdate is required for dual-write");
  }

  const userRef = db.collection("users").doc(uid);
  const startedAt = Date.now();

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.exists ? snap.data() || {} : {};
      const subscriptions =
        data.subscriptions && typeof data.subscriptions === "object"
          ? data.subscriptions
          : {};
      const beforeIos = subscriptions.ios || null;
      const beforeAndroid = subscriptions.android || null;

      let nextIos = beforeIos;
      let nextAndroid = beforeAndroid;
      let nextStoreState = { ...storeState };

      if (normalizedPlatform === "android") {
        if (!Array.isArray(nextStoreState.activePurchaseTokens)) {
          nextStoreState.activePurchaseTokens = mergeAndroidActiveTokens(
            beforeAndroid,
            meta.purchaseToken || nextStoreState.primaryPurchaseToken || ""
          );
        }
        if (
          nextStoreState.primaryPurchaseToken === undefined ||
          nextStoreState.primaryPurchaseToken === null
        ) {
          nextStoreState.primaryPurchaseToken =
            beforeAndroid?.primaryPurchaseToken || "";
        }
        nextAndroid = nextStoreState;
      } else {
        nextIos = nextStoreState;
      }

      const entitlement = computeAccountEntitlement(nextIos, nextAndroid);
      const entitlementExpiryTime = entitlement.entitlementExpiryTime
        ? toFirestoreExpiryValue(admin, entitlement.entitlementExpiryTime)
        : null;

      const writePayload = {
        ...legacyUpdate,
        [`subscriptions.${normalizedPlatform}`]: nextStoreState,
        entitlementUsable: entitlement.entitlementUsable,
        entitlementSource: entitlement.entitlementSource,
        entitlementUpdatedAt: admin.FieldValue.serverTimestamp(),
      };
      if (entitlementExpiryTime) {
        writePayload.entitlementExpiryTime = entitlementExpiryTime;
      } else {
        writePayload.entitlementExpiryTime = null;
      }

      tx.set(userRef, writePayload, { merge: true });

      return {
        beforeIos,
        beforeAndroid,
        afterIos: nextIos,
        afterAndroid: nextAndroid,
        entitlement,
        entitlementExpiryTime,
      };
    });

    const logPayload = {
      step: "dual_write.success",
      source: String(source || ""),
      platform: normalizedPlatform,
      uidTail: uidTail(uid),
      eventIdTail: idTail(meta.eventId),
      transactionIdTail: idTail(meta.transactionId),
      originalTransactionIdTail: idTail(meta.originalTransactionId),
      purchaseTokenTail: idTail(meta.purchaseToken),
      beforeIos: summarizeStoreState(result.beforeIos),
      afterIos: summarizeStoreState(result.afterIos),
      beforeAndroid: summarizeStoreState(result.beforeAndroid),
      afterAndroid: summarizeStoreState(result.afterAndroid),
      entitlementUsable: result.entitlement.entitlementUsable,
      entitlementExpiryTime: result.entitlement.entitlementExpiryTime
        ? result.entitlement.entitlementExpiryTime.toISOString()
        : null,
      entitlementSource: result.entitlement.entitlementSource,
      legacyWritten: summarizeLegacyUpdate(legacyUpdate),
      elapsedMs: Date.now() - startedAt,
    };
    if (typeof log.info === "function") {
      log.info(ENTITLEMENT_TRACE, logPayload);
    } else {
      console.info(ENTITLEMENT_TRACE, logPayload);
    }
    return result;
  } catch (error) {
    const errorPayload = {
      step: "dual_write.error",
      source: String(source || ""),
      platform: normalizedPlatform,
      uidTail: uidTail(uid),
      eventIdTail: idTail(meta.eventId),
      transactionIdTail: idTail(meta.transactionId),
      originalTransactionIdTail: idTail(meta.originalTransactionId),
      purchaseTokenTail: idTail(meta.purchaseToken),
      errorMessage: error?.message || String(error),
      elapsedMs: Date.now() - startedAt,
    };
    if (typeof log.error === "function") {
      log.error(ENTITLEMENT_TRACE, errorPayload);
    } else {
      console.error(ENTITLEMENT_TRACE, errorPayload);
    }
    throw error;
  }
}

/**
 * Recompute entitlement from already-stored store states (no store overwrite).
 * Used by admin upsert so entitlement stays derived from both stores.
 */
async function recomputeEntitlementFromStoredStores({
  db,
  admin,
  uid,
  source = "recompute",
  log = console,
}) {
  const userRef = db.collection("users").doc(uid);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const data = snap.exists ? snap.data() || {} : {};
    const subscriptions =
      data.subscriptions && typeof data.subscriptions === "object"
        ? data.subscriptions
        : {};
    const ios = subscriptions.ios || null;
    const android = subscriptions.android || null;
    const entitlement = computeAccountEntitlement(ios, android);
    const entitlementExpiryTime = entitlement.entitlementExpiryTime
      ? toFirestoreExpiryValue(admin, entitlement.entitlementExpiryTime)
      : null;
    tx.set(
      userRef,
      {
        entitlementUsable: entitlement.entitlementUsable,
        entitlementExpiryTime,
        entitlementSource: entitlement.entitlementSource,
        entitlementUpdatedAt: admin.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { ios, android, entitlement, entitlementExpiryTime };
  });

  if (typeof log.info === "function") {
    log.info(ENTITLEMENT_TRACE, {
      step: "recompute.success",
      source: String(source || ""),
      uidTail: uidTail(uid),
      beforeIos: summarizeStoreState(result.ios),
      beforeAndroid: summarizeStoreState(result.android),
      entitlementUsable: result.entitlement.entitlementUsable,
      entitlementExpiryTime: result.entitlement.entitlementExpiryTime
        ? result.entitlement.entitlementExpiryTime.toISOString()
        : null,
      entitlementSource: result.entitlement.entitlementSource,
    });
  }
  return result;
}

module.exports = {
  ENTITLEMENT_TRACE,
  USABLE_STORE_STATUSES,
  UNUSABLE_STORE_STATUSES,
  uidTail,
  idTail,
  normalizeStatus,
  parseExpiryToDate,
  toFirestoreExpiryValue,
  isStoreEntitlementUsable,
  computeAccountEntitlement,
  summarizeStoreState,
  summarizeLegacyUpdate,
  buildIosStoreState,
  buildAndroidStoreState,
  inferAndroidAutoRenewing,
  mergeAndroidActiveTokens,
  commitUserSubscriptionDualWrite,
  recomputeEntitlementFromStoredStores,
};
