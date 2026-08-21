"use strict";

function normalizeSubscriptionPlatform(value) {
  return (value || "").trim().toLowerCase();
}

function parseOptionalBool(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return null;
}

function defaultParseSubscriptionExpiryTimeWithMeta(value) {
  if (value == null) {
    return { expiry: null, parsePath: "null" };
  }
  if (value instanceof Date) {
    return { expiry: value, parsePath: "date" };
  }
  if (typeof value.toDate === "function") {
    return { expiry: value.toDate(), parsePath: "timestampLike" };
  }
  if (typeof value === "number") {
    const millis = Math.trunc(value);
    if (millis <= 0) {
      return { expiry: null, parsePath: "numberInvalid" };
    }
    return { expiry: new Date(millis), parsePath: "number" };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { expiry: null, parsePath: "emptyString" };
    }
    if (/^\d+$/.test(trimmed)) {
      const millis = Number(trimmed);
      if (Number.isFinite(millis) && millis > 0) {
        return { expiry: new Date(millis), parsePath: "numericString" };
      }
      return { expiry: null, parsePath: "numericStringInvalid" };
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return { expiry: new Date(parsed), parsePath: "isoString" };
    }
    return { expiry: null, parsePath: "stringUnparsed" };
  }
  return { expiry: null, parsePath: "unsupportedType" };
}

function describeLegacySubscriptionUsability(
  subscriptionStatus,
  subscriptionExpiryTime,
  now = new Date()
) {
  const normalized = (subscriptionStatus || "").trim().toLowerCase();
  const statusAllowsAccess = normalized === "active" || normalized === "trial";
  const expiryIsFuture =
    subscriptionExpiryTime != null &&
    subscriptionExpiryTime instanceof Date &&
    !Number.isNaN(subscriptionExpiryTime.getTime()) &&
    subscriptionExpiryTime.getTime() > now.getTime();
  return {
    statusAllowsAccess,
    expiryIsFuture,
    subscriptionUsable: statusAllowsAccess && expiryIsFuture,
  };
}

function describeAccountAccessUsability(userData, now = new Date(), options = {}) {
  const parseExpiryWithMeta =
    options.parseExpiryWithMeta || defaultParseSubscriptionExpiryTimeWithMeta;
  const data = userData || {};

  const entitlementUsable = parseOptionalBool(data.entitlementUsable);
  const { expiry: entitlementExpiry, parsePath: entitlementParsePath } =
    parseExpiryWithMeta(data.entitlementExpiryTime);
  const entitlementExpiryIsFuture =
    entitlementExpiry instanceof Date &&
    !Number.isNaN(entitlementExpiry.getTime()) &&
    entitlementExpiry.getTime() > now.getTime();

  const subscriptionStatus = data.subscriptionStatus;
  const subscriptionPlatform = data.subscriptionPlatform;
  const { expiry: legacyExpiry, parsePath: legacyParsePath } = parseExpiryWithMeta(
    data.subscriptionExpiryTime
  );
  const legacyUsability = describeLegacySubscriptionUsability(
    subscriptionStatus,
    legacyExpiry,
    now
  );

  const baseResult = {
    legacyStatusAllowsAccess: legacyUsability.statusAllowsAccess,
    legacyExpiryIsFuture: legacyUsability.expiryIsFuture,
    statusAllowsAccess: legacyUsability.statusAllowsAccess,
    expiryIsFuture: legacyUsability.expiryIsFuture,
    subscriptionStatus,
    subscriptionPlatform,
    legacyExpiry,
    entitlementExpiry,
    parsePath: legacyParsePath,
    entitlementParsePath,
  };

  if (entitlementUsable !== null) {
    if (entitlementUsable !== true) {
      return {
        ...baseResult,
        subscriptionUsable: false,
        decisionSource: "entitlement",
        entitlementUsable: false,
        entitlementExpiryIsFuture,
        denyReason: "entitlement_false",
      };
    }
    if (entitlementExpiry == null) {
      return {
        ...baseResult,
        subscriptionUsable: false,
        decisionSource: "entitlement",
        entitlementUsable: true,
        entitlementExpiryIsFuture: false,
        denyReason: "expiry_missing",
      };
    }
    if (!entitlementExpiryIsFuture) {
      return {
        ...baseResult,
        subscriptionUsable: false,
        decisionSource: "entitlement",
        entitlementUsable: true,
        entitlementExpiryIsFuture: false,
        denyReason: "expiry_expired",
      };
    }
    return {
      ...baseResult,
      subscriptionUsable: true,
      decisionSource: "entitlement",
      entitlementUsable: true,
      entitlementExpiryIsFuture: true,
      denyReason: null,
    };
  }

  let denyReason = null;
  if (!legacyUsability.subscriptionUsable) {
    const normalized = (subscriptionStatus || "").trim().toLowerCase();
    if (!normalized) {
      denyReason = "data_missing";
    } else if (!legacyUsability.statusAllowsAccess) {
      denyReason = "status_inactive";
    } else if (legacyExpiry == null) {
      denyReason = "expiry_missing";
    } else {
      denyReason = "expiry_expired";
    }
  }

  return {
    ...baseResult,
    subscriptionUsable: legacyUsability.subscriptionUsable,
    decisionSource: "legacyFallback",
    entitlementUsable: null,
    entitlementExpiryIsFuture,
    denyReason,
  };
}

function isActiveSubscriptionOnOtherPlatform({
  subscriptionStatus,
  subscriptionExpiryTime,
  subscriptionPlatform,
  expectedPlatform,
  now = new Date(),
}) {
  const legacyUsability = describeLegacySubscriptionUsability(
    subscriptionStatus,
    subscriptionExpiryTime,
    now
  );
  if (!legacyUsability.subscriptionUsable) {
    return false;
  }
  const normalizedPlatform = normalizeSubscriptionPlatform(subscriptionPlatform);
  const normalizedExpected = normalizeSubscriptionPlatform(expectedPlatform);
  if (!normalizedExpected) {
    return false;
  }
  return normalizedPlatform !== normalizedExpected;
}

function evaluateCrossPlatformPurchaseGuard({
  userData,
  purchasingPlatform,
  now = new Date(),
  parseExpiryWithMeta = defaultParseSubscriptionExpiryTimeWithMeta,
}) {
  const data = userData || {};
  const normalizedPurchasing = normalizeSubscriptionPlatform(purchasingPlatform);
  const entitlementUsable = parseOptionalBool(data.entitlementUsable);
  const { expiry: entitlementExpiry } = parseExpiryWithMeta(data.entitlementExpiryTime);
  const source = normalizeSubscriptionPlatform(data.entitlementSource);
  const entitlementExpiryIsFuture =
    entitlementExpiry instanceof Date &&
    !Number.isNaN(entitlementExpiry.getTime()) &&
    entitlementExpiry.getTime() > now.getTime();
  const accessUsability = describeAccountAccessUsability(data, now, {
    parseExpiryWithMeta,
  });
  const legacyPlatform = normalizeSubscriptionPlatform(data.subscriptionPlatform);

  return {
    entitlementUsable,
    entitlementExpiryIsFuture,
    entitlementSource: source,
    legacyStatusAllowsAccess: accessUsability.legacyStatusAllowsAccess,
    legacyExpiryIsFuture: accessUsability.legacyExpiryIsFuture,
    legacyPlatform,
    otherPlatformActive: false,
    denyReason: null,
    block: false,
    reason: "allow_x_policy",
    decisionSource: "x_policy",
    purchasingPlatform: normalizedPurchasing,
  };
}

module.exports = {
  parseOptionalBool,
  normalizeSubscriptionPlatform,
  describeLegacySubscriptionUsability,
  describeAccountAccessUsability,
  isActiveSubscriptionOnOtherPlatform,
  evaluateCrossPlatformPurchaseGuard,
};
