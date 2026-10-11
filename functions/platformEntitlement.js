"use strict";

const {
  isStoreEntitlementUsable,
  parseExpiryToDate,
} = require("./subscriptionEntitlement");
const {
  describeLegacySubscriptionUsability,
  normalizeSubscriptionPlatform,
  parseOptionalBool,
} = require("./accountAccessUsability");

function hasStoreMap(subscriptions, platform) {
  if (subscriptions == null || typeof subscriptions !== "object") {
    return false;
  }
  const storeState = subscriptions[platform];
  return storeState != null && typeof storeState === "object";
}

function legacyDenyReason(subscriptionStatus, legacyUsability, legacyExpiry) {
  const normalized = (subscriptionStatus || "").trim().toLowerCase();
  if (!normalized) {
    return "data_missing";
  }
  if (!legacyUsability.statusAllowsAccess) {
    return "status_inactive";
  }
  if (legacyExpiry == null) {
    return "expiry_missing";
  }
  return "expiry_expired";
}

/**
 * ケース⑬（Android → iPhone）・ケース⑭（iPhone → Android）: 同じUIDの、他OSの有効な契約を引き継ぐ向き。
 * キー = 利用するOS、値 = 契約を引き継げる他のOS。
 */
const CROSS_PLATFORM_CARRY = Object.freeze({ ios: "android", android: "ios" });

/**
 * 指定OSのストア契約で利用権を判定する。現在のOSの契約が利用できないときだけ、
 * [CROSS_PLATFORM_CARRY] の他OSの契約が現在利用できるかを見る（同じ判定を他OSに対して行うだけで、
 * 記録のコピーはしない）。引き継いだ場合の判定元は `cross_platform`。
 * `options.crossPlatform === false` で、他OSを見ない従来の判定になる。
 */
function evaluatePlatformEntitlement(
  userData,
  platform,
  now = new Date(),
  options = {}
) {
  const own = evaluateSinglePlatformEntitlement(userData, platform, now, options);
  if (own.usable || options.crossPlatform === false) {
    return own;
  }
  const carry = CROSS_PLATFORM_CARRY[own.platform];
  if (!carry) {
    return own;
  }
  const other = evaluateSinglePlatformEntitlement(userData, carry, now, options);
  if (!other.usable) {
    return own;
  }
  return {
    ...other,
    usable: true,
    subscriptionUsable: true,
    decisionSource: "cross_platform",
    denyReason: null,
    platform: own.platform,
    sourcePlatform: carry,
  };
}

/**
 * X案: 指定OSのストア契約だけを利用権として判定する。
 *
 * 正本: subscriptions.{ios|android}
 * fallback: そのOSの store map が無い場合のみ、subscriptionPlatform が
 * 同じOSのときに legacy status+expiry を使う。他OSへは fallback しない。
 *
 * entitlementUsable / entitlementSource は見ない。
 */
function evaluateSinglePlatformEntitlement(
  userData,
  platform,
  now = new Date(),
  options = {}
) {
  const requested = normalizeSubscriptionPlatform(platform);
  if (requested !== "ios" && requested !== "android") {
    return {
      usable: false,
      subscriptionUsable: false,
      decisionSource: "invalid_platform",
      denyReason: "invalid_platform",
      platform: requested,
      status: null,
      expiryDate: null,
      autoRenewing: null,
    };
  }

  const data = userData || {};
  if (hasStoreMap(data.subscriptions, requested)) {
    const storeState = data.subscriptions[requested];
    const result = isStoreEntitlementUsable(storeState, now);
    return {
      usable: result.usable,
      subscriptionUsable: result.usable,
      decisionSource: "store",
      denyReason: result.usable ? null : result.reason,
      platform: requested,
      status: result.status,
      expiryDate: result.expiryDate,
      autoRenewing: parseOptionalBool(storeState.autoRenewing),
    };
  }

  const legacyPlatform = normalizeSubscriptionPlatform(data.subscriptionPlatform);
  if (legacyPlatform !== requested) {
    return {
      usable: false,
      subscriptionUsable: false,
      decisionSource: "legacyFallback",
      denyReason: legacyPlatform
        ? "legacy_other_platform"
        : "legacy_platform_mismatch",
      platform: requested,
      status: data.subscriptionStatus || null,
      expiryDate: null,
      autoRenewing: null,
    };
  }

  const parseExpiryWithMeta = options.parseExpiryWithMeta;
  let legacyExpiry;
  if (typeof parseExpiryWithMeta === "function") {
    legacyExpiry = parseExpiryWithMeta(data.subscriptionExpiryTime).expiry;
  } else {
    legacyExpiry = parseExpiryToDate(data.subscriptionExpiryTime);
  }
  const legacyUsability = describeLegacySubscriptionUsability(
    data.subscriptionStatus,
    legacyExpiry,
    now
  );
  return {
    usable: legacyUsability.subscriptionUsable,
    subscriptionUsable: legacyUsability.subscriptionUsable,
    decisionSource: "legacyFallback",
    denyReason: legacyUsability.subscriptionUsable
      ? null
      : legacyDenyReason(data.subscriptionStatus, legacyUsability, legacyExpiry),
    platform: requested,
    status: data.subscriptionStatus || null,
    expiryDate: legacyExpiry instanceof Date ? legacyExpiry : null,
    autoRenewing: parseOptionalBool(data.autoRenewing),
  };
}

module.exports = {
  CROSS_PLATFORM_CARRY,
  hasStoreMap,
  evaluatePlatformEntitlement,
};
