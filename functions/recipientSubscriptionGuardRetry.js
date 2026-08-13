"use strict";

const DEFAULT_GRACE_MS = 30_000;
const DEFAULT_RETRY_INTERVAL_MS = 3_000;
const DEFAULT_MAX_RETRIES = 3;

function computeEntitlementExpiryDeltaMs(entitlementExpiry, now = new Date()) {
  if (
    entitlementExpiry == null ||
    !(entitlementExpiry instanceof Date) ||
    Number.isNaN(entitlementExpiry.getTime())
  ) {
    return null;
  }
  return entitlementExpiry.getTime() - now.getTime();
}

function shouldRetryRecipientEntitlementExpiryLag({
  usability,
  subscriptionStatus,
  entitlementExpiry,
  now = new Date(),
  graceMs = DEFAULT_GRACE_MS,
}) {
  if (!usability || usability.subscriptionUsable) {
    return false;
  }
  if (usability.decisionSource !== "entitlement") {
    return false;
  }
  if (usability.entitlementUsable !== true) {
    return false;
  }
  if (usability.denyReason !== "expiry_expired") {
    return false;
  }

  const normalized = (subscriptionStatus || "").trim().toLowerCase();
  if (normalized !== "active" && normalized !== "trial") {
    return false;
  }

  const entitlementExpiryDeltaMs = computeEntitlementExpiryDeltaMs(
    entitlementExpiry,
    now,
  );
  if (entitlementExpiryDeltaMs === null) {
    return false;
  }
  if (entitlementExpiryDeltaMs >= 0) {
    return false;
  }
  if (entitlementExpiryDeltaMs < -graceMs) {
    return false;
  }

  return true;
}

async function resolveRecipientSubscriptionWithExpiryLagRetry({
  recipientData,
  usability,
  subscriptionStatus,
  now = new Date(),
  fetchRecipientData,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  getNow = () => new Date(),
  describeUsability,
  parseExpiryWithMeta,
  log = () => {},
  graceMs = DEFAULT_GRACE_MS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
}) {
  const entitlementExpiry = usability?.entitlementExpiry ?? null;
  const initialEntitlementExpiryDeltaMs = computeEntitlementExpiryDeltaMs(
    entitlementExpiry,
    now,
  );

  if (
    !shouldRetryRecipientEntitlementExpiryLag({
      usability,
      subscriptionStatus,
      entitlementExpiry,
      now,
      graceMs,
    })
  ) {
    return {
      retried: false,
      recipientData,
      usability,
      retryCount: 0,
      entitlementExpiryDeltaMs: initialEntitlementExpiryDeltaMs,
      resolved: usability.subscriptionUsable,
    };
  }

  log({
    event: "retryStart",
    entitlementExpiryDeltaMs: initialEntitlementExpiryDeltaMs,
    maxRetries,
    retryIntervalMs,
  });

  let currentData = recipientData;
  let currentUsability = usability;
  let retryCount = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    await sleep(retryIntervalMs);
    retryCount = attempt;

    let fetchedData;
    try {
      fetchedData = await fetchRecipientData();
    } catch (error) {
      log({
        event: "fetchError",
        retryCount: attempt,
        errorType: error?.constructor?.name || typeof error,
      });
      return {
        retried: true,
        recipientData: currentData,
        usability: currentUsability,
        retryCount,
        entitlementExpiryDeltaMs: initialEntitlementExpiryDeltaMs,
        fetchError: true,
        resolved: false,
      };
    }

    currentData = fetchedData;
    const retryNow = getNow();
    currentUsability = describeUsability(currentData, retryNow, {
      parseExpiryWithMeta,
    });
    const retryEntitlementExpiryDeltaMs = computeEntitlementExpiryDeltaMs(
      currentUsability.entitlementExpiry,
      retryNow,
    );

    log({
      event: "retryAttempt",
      retryCount: attempt,
      entitlementExpiryDeltaMs: retryEntitlementExpiryDeltaMs,
      subscriptionUsable: currentUsability.subscriptionUsable,
    });

    if (currentUsability.subscriptionUsable) {
      log({
        event: "retryAllow",
        retryCount: attempt,
        entitlementExpiryDeltaMs: retryEntitlementExpiryDeltaMs,
      });
      return {
        retried: true,
        recipientData: currentData,
        usability: currentUsability,
        retryCount,
        entitlementExpiryDeltaMs: retryEntitlementExpiryDeltaMs,
        resolved: true,
      };
    }
  }

  const finalEntitlementExpiryDeltaMs = computeEntitlementExpiryDeltaMs(
    currentUsability.entitlementExpiry,
    getNow(),
  );
  log({
    event: "retryBlock",
    retryCount,
    entitlementExpiryDeltaMs: finalEntitlementExpiryDeltaMs,
  });

  return {
    retried: true,
    recipientData: currentData,
    usability: currentUsability,
    retryCount,
    entitlementExpiryDeltaMs: finalEntitlementExpiryDeltaMs,
    resolved: false,
  };
}

module.exports = {
  DEFAULT_GRACE_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_MAX_RETRIES,
  computeEntitlementExpiryDeltaMs,
  shouldRetryRecipientEntitlementExpiryLag,
  resolveRecipientSubscriptionWithExpiryLagRetry,
};
