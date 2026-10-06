/** PRE-CHAT billing checks. READ paths never claim, acknowledge, restore or write. */
const crypto = require("node:crypto");
const { HttpsError } = require("firebase-functions/v2/https");
const { SignedDataVerifier, Environment } = require("@apple/app-store-server-library");
const { inspectSubscriptionSeriesOwnership, buildIosOwnershipId, buildAndroidOwnershipId } = require("./subscriptionOwnership");
const { syncGooglePlaySubscriptionByPurchaseToken, GOOGLE_PLAY_PACKAGE_NAME,
  GOOGLE_PLAY_MONTHLY_PRODUCT_ID } = require("./googlePlaySubscriptionNotifications");
const { fetchAppStoreAllSubscriptionStatuses, loadAppleRootCertificates,
  APP_STORE_PRODUCT_ID, APP_STORE_BUNDLE_ID } = require("./appStoreServerCommon");
const { buildAndroidStoreState, buildIosStoreState, computeAccountEntitlement,
  deriveLegacyAccountFields } = require("./subscriptionEntitlement");
const { normalizeSubscriptionPlatform } = require("./accountAccessUsability");
const COVERAGE = "auth_creation_managed_v1";
const STORE_COVERAGE = "verified_current_series_v1";
const MAX_SERIES = 20;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const seriesIdentity = (platform, value) => hash(`${platform}:${value}`);
function stable(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value === undefined ? null : value;
}
function billingRevision(data) {
  const fields = ["billingRevision", "billingConfirmation", "subscriptions",
    "subscriptionStatus", "subscriptionPlatform", "subscriptionExpiryTime",
    "entitlementUsable", "entitlementExpiryTime", "activePurchaseTokens",
    "googlePlayPrimaryPurchaseToken", "appStoreOriginalTransactionId",
    "appStoreTransactionId", "appStoreAppAccountToken", "boundSubscriptionSeries",
    "accountDeletionState"];
  return hash(JSON.stringify(stable(Object.fromEntries(fields.map((key) => [key, data[key]])))));
}
function platformBillingRevision(data, platform) {
  const target = data.subscriptions?.[platform] || null;
  const confirmation = data.billingConfirmation?.[platform] || null;
  const legacyApplies = data.subscriptionPlatform === platform;
  const platformFields = platform === "android" ? {
    googlePlayPrimaryPurchaseToken: data.googlePlayPrimaryPurchaseToken,
    activePurchaseTokens: data.subscriptionPlatform === "ios" ? null : data.activePurchaseTokens,
  } : {
    appStoreOriginalTransactionId: data.appStoreOriginalTransactionId,
    appStoreTransactionId: data.appStoreTransactionId,
    appStoreAppAccountToken: data.appStoreAppAccountToken,
  };
  return hash(JSON.stringify(stable({
    platform, accountDeletionState: data.accountDeletionState || null,
    subscription: target, confirmation, platformFields,
    legacy: legacyApplies ? {
      subscriptionStatus: data.subscriptionStatus,
      subscriptionPlatform: data.subscriptionPlatform,
      subscriptionExpiryTime: data.subscriptionExpiryTime,
      entitlementUsable: data.entitlementUsable,
      entitlementExpiryTime: data.entitlementExpiryTime,
    } : null,
    boundSeries: data.boundSubscriptionSeries?.[platform] || null,
  })));
}
function historyPlatform(data) {
  const value = data?.platform;
  if (value === "google_play") return "android";
  if (value === "ios" || value === "android") return value;
  if (data?.notificationUUID || data?.originalTransactionId || data?.transactionId) return "ios";
  if (data?.purchaseToken || data?.purchaseTokenHash || data?.linkedPurchaseToken) return "android";
  return "unknown";
}
function platformQueryFingerprint(snap, platform) {
  const rows = snap.docs.map((doc) => [doc.id, doc.data()])
    .filter(([, data]) => historyPlatform(data) === platform || historyPlatform(data) === "unknown")
    .map(([id, data]) => [id, stable(data)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return hash(JSON.stringify(rows));
}
function candidatesFor(platform, data, supplied = [], history = []) {
  const found = new Set();
  const add = (value) => { if (typeof value === "string" && value.trim()) found.add(value.trim()); };
  const store = data.subscriptions?.[platform] || {};
  if (platform === "android") {
    add(data.googlePlayPrimaryPurchaseToken); add(store.primaryPurchaseToken);
    for (const token of Array.isArray(store.activePurchaseTokens) ? store.activePurchaseTokens : []) add(token);
    if (data.subscriptionPlatform !== "ios") {
      for (const token of Array.isArray(data.activePurchaseTokens) ? data.activePurchaseTokens : []) add(token);
    }
    for (const item of supplied) add(item.purchaseToken);
    for (const item of history) { add(item.purchaseToken); add(item.linkedPurchaseToken); }
  } else {
    add(data.appStoreOriginalTransactionId); add(store.originalTransactionId);
    // Prefer original series identities; latest transaction IDs are only fallback lookup candidates.
    if (!data.appStoreOriginalTransactionId && !store.originalTransactionId) {
      add(data.appStoreTransactionId); add(store.transactionId);
    }
    for (const item of supplied) add(item.originalTransactionId || item.transactionId);
    for (const item of history) add(item.originalTransactionId || item.transactionId);
  }
  return [...found];
}
function verifiedActivePointer(data, platform) {
  const store = data.subscriptions?.[platform];
  const confirmation = data.billingConfirmation?.[platform];
  const expectedProduct = platform === "android" ? GOOGLE_PLAY_MONTHLY_PRODUCT_ID : APP_STORE_PRODUCT_ID;
  const identity = platform === "android" ? store?.primaryPurchaseToken : store?.originalTransactionId;
  const expectedVerifier = platform === "android" ? "google_play_subscriptions_v2" : "app_store_signed_status";
  const appIdentityMatches = platform === "android"
    ? store?.packageId === GOOGLE_PLAY_PACKAGE_NAME
    : store?.bundleId === APP_STORE_BUNDLE_ID;
  return Boolean(identity && store?.status === "active" && store.productId === expectedProduct &&
    appIdentityMatches && store.verificationSource === expectedVerifier && store.verifiedAt &&
    confirmation?.state === "active" && confirmation.schemaVersion === 1 &&
    [COVERAGE, STORE_COVERAGE].includes(confirmation.coverage));
}
function candidateSources(platform, data, supplied = []) {
  const sources = new Map();
  const add = (identity, source) => {
    if (typeof identity !== "string" || !identity.trim()) return;
    const normalized = identity.trim();
    const labels = sources.get(normalized) || new Set();
    labels.add(source);
    sources.set(normalized, labels);
  };
  if (platform === "android") {
    add(data.googlePlayPrimaryPurchaseToken, "legacy_primary");
    add(data.subscriptions?.android?.primaryPurchaseToken, "platform_primary");
    for (const token of data.subscriptions?.android?.activePurchaseTokens || []) add(token, "platform_token_history");
    if (data.subscriptionPlatform !== "ios") for (const token of data.activePurchaseTokens || []) add(token, "legacy_token_history");
    for (const item of supplied) add(item.purchaseToken, "device_store_query");
  } else {
    add(data.appStoreOriginalTransactionId, "legacy_primary");
    add(data.subscriptions?.ios?.originalTransactionId, "platform_primary");
    if (!data.appStoreOriginalTransactionId && !data.subscriptions?.ios?.originalTransactionId) {
      add(data.appStoreTransactionId, "legacy_transaction_fallback");
      add(data.subscriptions?.ios?.transactionId, "platform_transaction_fallback");
    }
    for (const item of supplied) add(item.originalTransactionId || item.transactionId, "device_store_query");
  }
  return sources;
}
function googleState(subscription, item, now = Date.now()) {
  if (!item || item.productId !== GOOGLE_PLAY_MONTHLY_PRODUCT_ID) return "unknown";
  const state = subscription.subscriptionState;
  const expiry = Date.parse(item.expiryTime);
  if (["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
    "SUBSCRIPTION_STATE_CANCELED"].includes(state) && expiry > now) return "active";
  if (["SUBSCRIPTION_STATE_PENDING", "SUBSCRIPTION_STATE_ON_HOLD",
    "SUBSCRIPTION_STATE_PAUSED"].includes(state)) return "blocked";
  if (state === "SUBSCRIPTION_STATE_EXPIRED" && Number.isFinite(expiry) && expiry <= now) return "ended";
  return "unknown";
}
function appleState(status, transaction, renewal, now = Date.now()) {
  if (transaction.bundleId !== APP_STORE_BUNDLE_ID || transaction.productId !== APP_STORE_PRODUCT_ID) return "unknown";
  const expires = Number(transaction.expiresDate);
  if (status === 1 && expires > now && !transaction.revocationDate) return "active";
  if (status === 4 && Number(renewal?.gracePeriodExpiresDate) > now && !transaction.revocationDate) return "active";
  if (status === 3) return "blocked";
  if (status === 2 && Number.isFinite(expires) && expires > 0 && expires <= now) return "ended";
  if (status === 5 && Number(transaction.revocationDate) > 0 && expires > 0) return "ended";
  return "unknown";
}
function activeSeriesRepresentatives(entries, observed = []) {
  const groups = [];
  for (const entry of entries) {
    const group = new Set(entry.identities);
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      if ([...groups[i]].some((id) => group.has(id))) {
        for (const id of groups[i]) group.add(id);
        groups.splice(i, 1);
      }
    }
    groups.push(group);
  }
  return groups.map((group) => observed.find((id) => group.has(id)) || [...group].sort()[0]);
}
function metadataMatches(platform, stored, entry) {
  if (!stored?.verifiedAt) return false;
  if (platform === "android") return stored.packageId === GOOGLE_PLAY_PACKAGE_NAME &&
    stored.linkedPurchaseToken === (entry.subscription?.linkedPurchaseToken || "") &&
    stored.acknowledgementState === (entry.subscription?.acknowledgementState || "unknown");
  return stored.bundleId === APP_STORE_BUNDLE_ID &&
    stored.appAccountToken === (entry.transaction?.appAccountToken || "") &&
    stored.environment === (entry.transaction?.environment || "") &&
    (stored.revocationDate || null) === (entry.transaction?.revocationDate || null);
}
function resultFor({ data, platform, entries, overflow = false, unresolvedHistory = false, observed = [] }) {
  const record = data.billingConfirmation?.[platform];
  const coverage = record?.coverage === COVERAGE && record.schemaVersion === 1 ? COVERAGE : "unknown";
  const base = { revision: billingRevision(data), coverage, series: [], syncRequired: false, storeVerified: false, storeStatus: "unknown" };
  if (data.accountDeletionState) return { ...base, state: "blocked", reason: "account_deleted" };
  if (entries.some((entry) => entry.owner === "mismatch")) return { ...base, state: "blocked", reason: "owner_mismatch", storeStatus: entries.some((entry) => entry.owner === "mismatch" && entry.state === "active") ? "active" : "unknown" };
  if (entries.some((entry) => (entry.owner !== "match" && !(entry.owner === "foreign_ended" && entry.state === "ended")) || entry.state === "unknown"))
    return { ...base, state: "unknown", reason: "unverified_series_or_owner" };
  if (entries.some((entry) => entry.state === "blocked")) return { ...base, state: "blocked", reason: "store_payment_pending_or_retry" };
  if (entries.some((entry) => !Number.isFinite(entry.expiryMs))) return { ...base, state: "unknown", reason: "store_expiry_unverified" };
  const active = entries.filter((entry) => entry.state === "active");
  const stored = data.subscriptions?.[platform];
  if (active.length) {
    const newest = active.reduce((a, b) => a.expiryMs >= b.expiryMs ? a : b);
    const currentIdentity = platform === "android" ? stored?.primaryPurchaseToken : stored?.originalTransactionId;
    const coherent = stored?.status === "active" && currentIdentity &&
      newest.identities.includes(seriesIdentity(platform, currentIdentity)) &&
      stable(stored.expiryTime) === newest.expiryMs &&
      stored.productId === (platform === "android" ? GOOGLE_PLAY_MONTHLY_PRODUCT_ID : APP_STORE_PRODUCT_ID);
    return { ...base, state: "active", storeStatus: "active", reason: "verified_owned_active",
      coverage: coverage === COVERAGE ? COVERAGE : STORE_COVERAGE, storeVerified: true,
      series: activeSeriesRepresentatives(active, observed), syncRequired: !coherent || record?.state !== "active" ||
        active.some((entry) => entry.recoverableOwner) || !metadataMatches(platform, stored, newest) };
  }
  // Historical RTDN absence/coverage is not a prerequisite for a verified current series.
  // All concrete candidate series must still be verified and owned; an empty query is never proof.
  if (overflow) return { ...base, state: "unknown", reason: "candidate_overflow" };
  const legacyApplies = data.subscriptionPlatform === platform;
  const suspicious = stored?.status === "active" || (legacyApplies && data.subscriptionStatus === "active") ||
    (!data.subscriptionPlatform && data.entitlementUsable === true);
  if (suspicious && entries.length && entries.every((entry) => entry.owner === "foreign_ended"))
    return { ...base, state: "unknown", reason: "current_uid_active_series_unverified" };
  if (!entries.length) {
    if (coverage !== COVERAGE || unresolvedHistory || suspicious) return { ...base, state: "unknown", reason: "no_verified_store_series" };
    return { ...base, state: "eligible", storeStatus: "expired", storeVerified: true, reason: "managed_new_account_no_purchase",
      syncRequired: record?.state !== "eligible" };
  }
  if (unresolvedHistory) return { ...base, state: "unknown", reason: "unresolved_current_series" };
  const newest = entries.reduce((a, b) => a.expiryMs >= b.expiryMs ? a : b);
  const foreignOnly = entries.every((entry) => entry.owner === "foreign_ended");
  const coherent = stored?.status === "expired" && stable(stored.expiryTime) === newest.expiryMs && stored.productId === APP_STORE_PRODUCT_ID;
  const verifiedMetadata = foreignOnly ? stored?.source === "prechat_foreign_series_ended" : metadataMatches(platform, stored, newest);
  return { ...base, state: "eligible", storeStatus: "expired", storeVerified: true,
    coverage: coverage === COVERAGE ? COVERAGE : STORE_COVERAGE,
    reason: "verified_current_series_ended", syncRequired: !coherent || record?.state !== "eligible" ||
      entries.some((entry) => entry.recoverableOwner) || !verifiedMetadata, series: [] };
}
async function verifyAppleSeries(identity, { secrets, getAppAppleId }) {
  const response = await fetchAppStoreAllSubscriptionStatuses(identity, "", secrets);
  const environment = response.environment === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
  const appAppleId = Number(getAppAppleId());
  if (environment === Environment.PRODUCTION && !(appAppleId > 0)) throw new Error("apple_app_id_missing");
  const verifier = new SignedDataVerifier(loadAppleRootCertificates(), true, environment,
    APP_STORE_BUNDLE_ID, appAppleId > 0 ? appAppleId : undefined);
  const entries = [];
  for (const group of response.body.data || []) {
    for (const item of group.lastTransactions || []) {
      // One failed signature makes the observation unknown; never silently skip an unverified transaction.
      const transaction = await verifier.verifyAndDecodeTransaction(item.signedTransactionInfo);
      if (transaction.productId !== APP_STORE_PRODUCT_ID) continue;
      const renewal = item.signedRenewalInfo ? await verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo) : null;
      if (renewal && renewal.originalTransactionId !== transaction.originalTransactionId) throw new Error("renewal_series_mismatch");
      entries.push({ state: appleState(Number(item.status), transaction, renewal), transaction, renewal,
        originalTransactionId: transaction.originalTransactionId,
        expiryMs: Number(item.status) === 4 ? Number(renewal?.gracePeriodExpiresDate) : Number(transaction.expiresDate) });
    }
  }
  if (!entries.length) throw new Error("apple_no_verified_product");
  return entries;
}
function authAndPayload(request) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign-in is required.");
  const data = request.data || {};
  if (!["android", "ios"].includes(data.platform) || typeof data.attemptId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(data.attemptId)) throw new HttpsError("invalid-argument", "Invalid confirmation request.");
  const expected = data.platform === "android" ? GOOGLE_PLAY_MONTHLY_PRODUCT_ID : APP_STORE_PRODUCT_ID;
  if (data.productId && data.productId !== expected) throw new HttpsError("invalid-argument", "Invalid product.");
  if (data.storeCandidates && (!Array.isArray(data.storeCandidates) || data.storeCandidates.length > MAX_SERIES))
    throw new HttpsError("invalid-argument", "Too many store candidates.");
  for (const item of data.storeCandidates || []) {
    if (!item || typeof item !== "object" || Object.values(item).some((value) => typeof value !== "string" || value.length > 8192))
      throw new HttpsError("invalid-argument", "Invalid store candidate.");
  }
  return { uid, data };
}
function operationRef(db, uid, attemptId) {
  return db.collection("preChatBillingOperations").doc(hash(`${uid}:${attemptId}`));
}
function loggedAuthAndPayload(request, logger, stage) {
  try {
    return authAndPayload(request);
  } catch (error) {
    diagnosticLog(logger, "warn", "PRECHAT_BILLING request.reject", {
      stage, ...diagnosticErrorFields(error),
    });
    throw error;
  }
}
function uidDiagnosticId(uid) { return hash("diagnostic:" + uid).slice(-8); }
function diagnosticLog(logger, level, message, fields) {
  const writer = typeof logger?.[level] === "function" ? logger[level] : logger?.info;
  if (typeof writer === "function") writer.call(logger, message, fields);
}
const DIAGNOSTIC_HEADER_ALLOWLIST = new Set([
  "content-type", "date", "retry-after", "www-authenticate",
  "x-goog-request-id", "x-guploader-uploadid", "x-request-id",
]);
const DIAGNOSTIC_SECRET_KEY = /(authorization|cookie|credential|private|secret|receipt|purchase.?token|linked.?token|access.?token|refresh.?token|app.?account.?token|email|owner.?uid|firebase.?uid)/i;
const MAX_DIAGNOSTIC_VALUE_LENGTH = 6000;
function scrubDiagnosticString(value) {
  return String(value)
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]")
    .replace(/\/users\/[^/\s?]+/g, "/users/[UID_REDACTED]")
    .replace(/\b(?:GPA\.[A-Za-z0-9._~-]{12,}|[A-Za-z0-9_-]{48,})\b/g, "[OPAQUE_TOKEN_REDACTED]")
    .slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH);
}
function sanitizeDiagnosticValue(value, key = "", depth = 0, seen = new WeakSet()) {
  if (DIAGNOSTIC_SECRET_KEY.test(key)) return "[REDACTED]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return scrubDiagnosticString(value);
  if (depth >= 5) return "[MAX_DEPTH]";
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeDiagnosticValue(item, "", depth + 1, seen));
  if (typeof value !== "object") return scrubDiagnosticString(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const output = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 50)) {
    output[childKey] = sanitizeDiagnosticValue(childValue, childKey, depth + 1, seen);
  }
  seen.delete(value);
  return output;
}
function diagnosticErrorFields(error) {
  const response = error?.response;
  const headers = {};
  const rawHeaders = response?.headers;
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const name of DIAGNOSTIC_HEADER_ALLOWLIST) {
      const value = typeof rawHeaders.get === "function" ? rawHeaders.get(name) : rawHeaders[name];
      if (value != null) headers[name] = scrubDiagnosticString(value);
    }
  }
  const responseData = response?.data;
  let responseBody = responseData == null ? null : sanitizeDiagnosticValue(responseData);
  if (responseBody != null) {
    try {
      const serialized = JSON.stringify(responseBody);
      responseBody = serialized.length > MAX_DIAGNOSTIC_VALUE_LENGTH
        ? serialized.slice(0, MAX_DIAGNOSTIC_VALUE_LENGTH) + "[TRUNCATED]" : responseBody;
    } catch (_) {
      responseBody = "[UNSERIALIZABLE]";
    }
  }
  const code = error?.code;
  return {
    errorType: error?.constructor?.name || "Error",
    errorCode: typeof code === "string" || typeof code === "number" ? code : "unknown",
    httpStatus: response?.status != null && Number.isFinite(Number(response.status)) ? Number(response.status) : null,
    httpStatusText: response?.statusText ? scrubDiagnosticString(response.statusText) : null,
    errorMessage: error?.message ? scrubDiagnosticString(error.message) : null,
    responseHeaders: headers,
    responseBody,
    stack: error?.stack ? scrubDiagnosticString(error.stack) : null,
    cause: error?.cause ? {
      errorType: error.cause?.constructor?.name || "Error",
      errorCode: typeof error.cause?.code === "string" || typeof error.cause?.code === "number" ? error.cause.code : "unknown",
      errorMessage: error.cause?.message ? scrubDiagnosticString(error.cause.message) : null,
    } : null,
  };
}
async function diagnosticAwait(logger, operationId, stage, work, extra = {}) {
  const startedAt = Date.now();
  diagnosticLog(logger, "info", "PRECHAT_BILLING await.begin", { operationId, stage, ...extra });
  try {
    const value = await work();
    diagnosticLog(logger, "info", "PRECHAT_BILLING await.end", { operationId, stage, elapsedMs: Date.now() - startedAt, ...extra });
    return value;
  } catch (error) {
    diagnosticLog(logger, "warn", "PRECHAT_BILLING await.error", {
      operationId, stage, elapsedMs: Date.now() - startedAt,
      ...diagnosticErrorFields(error),
      ...extra,
    });
    throw error;
  }
}
function bounded(read, millis) {
  let timer;
  return Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("confirmation_read_timeout")), millis); })])
    .finally(() => clearTimeout(timer));
}
function observationRevision(data, historyReads, ownerReads, platform) {
  return hash(JSON.stringify([platformBillingRevision(data, platform), historyReads.map((read) => read.fingerprint),
    ownerReads.map((read) => [read.id, read.fingerprint]).sort((a, b) => a[0].localeCompare(b[0]))]));
}
function summarizeAppleVerification(entries = []) {
  if (!entries.length) return "skipped";
  if (entries.some((entry) => entry.state === "active")) return "active";
  if (entries.length && entries.every((entry) => entry.state === "ended")) return "expired";
  if (entries.some((entry) => entry.state === "blocked")) return "blocked";
  return "unknown";
}
const snapshotFingerprint = (snap) => hash(JSON.stringify(stable({ exists: snap.exists, data: snap.exists ? snap.data() : null })));
function createPreChatBillingHandlers({ getDb, admin, secrets, getAppAppleId, currentContractOnly = false, assertRequestAllowed = async () => {}, assertSyncAllowed = async () => {},
  verifyGoogle = syncGooglePlaySubscriptionByPurchaseToken, verifyApple = verifyAppleSeries,
  inspectOwner = inspectSubscriptionSeriesOwnership, logger = console }) {
  async function evaluate(uid, input, operationId) {
    const diagnostic = { uidHash: uidDiagnosticId(uid), platform: input.platform };
    const db = await diagnosticAwait(logger, operationId, "firestore.client.initialize", () => getDb(), diagnostic);
    const snap = await diagnosticAwait(logger, operationId, "firestore.user.read", () =>
      db.collection("users").doc(uid).get(), diagnostic);
    if (!snap.exists) return { result: { state: "unknown", reason: "user_missing", revision: "", coverage: "unknown", series: [], syncRequired: false }, entries: [], data: {}, ownerReads: [], historyReads: [] };
    const data = snap.data() || {};
    const ownerReads = [];
    const currentOnly = input.selectionMode === "current_contract_only";
    let currentContractSelectionReason = "";
    let currentContractPointerConflict = false;
    let activePointer = !currentOnly && verifiedActivePointer(data, input.platform);
    if (activePointer) {
      const identity = input.platform === "android"
        ? data.subscriptions.android.primaryPurchaseToken : data.subscriptions.ios.originalTransactionId;
      const id = input.platform === "android" ? buildAndroidOwnershipId(identity) : buildIosOwnershipId(identity);
      const ref = db.collection("subscription_ownership").doc(id);
      const owner = await diagnosticAwait(logger, operationId, "firestore.current_pointer_owner.read", () => ref.get(), diagnostic);
      const fingerprint = snapshotFingerprint(owner);
      ownerReads.push({ ref, fingerprint, id, ownerUid: owner.exists ? owner.get("ownerUid") : "" });
      activePointer = owner.exists && owner.get("ownerUid") === uid;
      diagnosticLog(logger, activePointer ? "info" : "warn", "PRECHAT_BILLING current_pointer.decision", {
        ...diagnostic, decision: activePointer ? "verified_active_owned_pointer" : "pointer_owner_unconfirmed",
        currentPointerRef: seriesIdentity(input.platform, identity).slice(0, 16),
      });
    }
    const ownedIds = [];
    const eventIdentities = [];
    const historyReads = [];
    let overflow = false;
    const historyCollections = currentOnly || activePointer ? [] : [["subscription_events", "uid"], ["subscription_ownership", "ownerUid"]];
    for (const [collection, field] of historyCollections) {
      const query = db.collection(collection).where(field, "==", uid).limit(MAX_SERIES + 1);
      const found = await diagnosticAwait(logger, operationId, `firestore.${collection}.query`, () => query.get(), diagnostic);
      historyReads.push({ query, collection, fingerprint: platformQueryFingerprint(found, input.platform) });
      if (collection === "subscription_ownership" && found.docs.length > MAX_SERIES) overflow = true;
      for (const doc of found.docs) {
        const entry = doc.data();
        const eventPlatform = entry.platform === "google_play" ? "android" : entry.platform || (entry.notificationUUID ? "ios" : "unknown");
        if (eventPlatform === input.platform || eventPlatform === "unknown") {
          if (collection === "subscription_ownership") ownedIds.push(doc.id);
          else eventIdentities.push(input.platform === "android" ? entry.purchaseTokenHash || "" : entry.originalTransactionId || entry.transactionId || "");
        }
      }
    }
    // Production uses only the current identity. Legacy collection is retained
    // for historical fixtures, never as a production fallback.
    const allCandidates = currentOnly ? [] : candidatesFor(input.platform, data, input.storeCandidates || []);
    const candidateOrigins = currentOnly ? new Map() : candidateSources(input.platform, data, input.storeCandidates || []);
    const activeIdentity = input.platform === "android"
      ? data.subscriptions?.android?.primaryPurchaseToken
      : data.subscriptions?.ios?.originalTransactionId;
    let candidates = activePointer ? [String(activeIdentity).trim()] : allCandidates;
    if (currentOnly) {
      const supplied = [...new Set((input.storeCandidates || []).map((item) => input.platform === "android"
        ? item.purchaseToken : item.originalTransactionId).filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
      const platformPrimary = input.platform === "android" ? data.subscriptions?.android?.primaryPurchaseToken
        : data.subscriptions?.ios?.originalTransactionId;
      const legacyPrimary = input.platform === "android" ? data.googlePlayPrimaryPurchaseToken : data.appStoreOriginalTransactionId;
      const primary = String(platformPrimary || legacyPrimary || "").trim();
      const contradictoryPointers = platformPrimary && legacyPrimary && platformPrimary !== legacyPrimary;
      const storedTokenEvidence = input.platform === "android"
        ? Boolean((data.subscriptions?.android?.activePurchaseTokens || []).length || (data.activePurchaseTokens || []).length)
        : Boolean(data.appStoreTransactionId || data.subscriptions?.ios?.transactionId);
      let selectionReason = "";
      if (supplied.length > 1) selectionReason = "multiple_current_store_contracts";
      else if (contradictoryPointers || (supplied.length === 1 && primary && supplied[0] !== primary)) {
        selectionReason = "current_contract_pointer_conflict";
        currentContractPointerConflict = true;
      } else if (!supplied.length && !primary && storedTokenEvidence) selectionReason = "current_contract_pointer_missing";
      currentContractSelectionReason = selectionReason;
      candidates = supplied.length === 1 ? supplied : primary ? [primary] : [];
      const blockBeforeAppleVerify = selectionReason === "multiple_current_store_contracts" ||
        selectionReason === "current_contract_pointer_missing" ||
        (selectionReason && candidates.length === 0);
      diagnosticLog(logger, selectionReason ? "warn" : "info", "PURCHASE_CURRENT_CONTRACT selection", {
        ...diagnostic, operationId, candidateCount: candidates.length,
        selection: supplied.length ? "native_current_contract" : primary ? "firebase_current_pointer" : "managed_no_contract",
        reason: selectionReason || "single_current_contract", historicalFallback: false,
        pointerConflict: selectionReason === "current_contract_pointer_conflict",
        continueToAppleVerify: Boolean(selectionReason === "current_contract_pointer_conflict" && candidates.length),
        blockBeforeAppleVerify,
        currentSeriesCandidateRef: candidates[0] ? seriesIdentity(input.platform, candidates[0]).slice(0, 16) : null,
      });
      if (blockBeforeAppleVerify) return { result: { state: "unknown", reason: selectionReason,
        revision: platformBillingRevision(data, input.platform), series: [], syncRequired: false,
        storeVerified: false, storeStatus: "unknown" }, entries: [], data, ownerReads, historyReads,
        selectionReason: currentContractSelectionReason, pointerConflict: currentContractPointerConflict };
    }
    diagnosticLog(logger, "info", "PRECHAT_BILLING candidate.plan", {
      operationId, platform: input.platform,
      selection: currentOnly ? "current_contract_only" : activePointer ? "verified_active_platform_pointer" : "legacy_fail_closed_candidates",
      candidateCount: candidates.length,
      historicalCandidatesSuppressed: activePointer ? Math.max(0, allCandidates.length - candidates.length) : 0,
      currentPointerRef: activePointer ? seriesIdentity(input.platform, activeIdentity).slice(0, 16) : null,
    });
    if (activePointer) for (const identity of allCandidates) {
      if (identity === String(activeIdentity).trim()) continue;
      diagnosticLog(logger, "info", "PRECHAT_BILLING candidate.excluded", {
        operationId, platform: input.platform,
        purchaseSeriesRef: seriesIdentity(input.platform, identity).slice(0, 16),
        candidateSources: [...(candidateOrigins.get(identity) || [])].sort(),
        decision: "historical_candidate_omitted_after_verified_active_pointer",
      });
    }
    overflow = overflow || candidates.length > MAX_SERIES;
    const entries = [];
    async function checkedOwner(args, uidProof = false, verifiedState = "unknown", linkedState = "unknown", verifyConflicts = null) {
      const ids = input.platform === "android" ? [args.purchaseToken, args.linkedPurchaseToken].filter(Boolean).map(buildAndroidOwnershipId) : [buildIosOwnershipId(args.originalTransactionId)];
      const reads = await Promise.all(ids.map(async (id) => {
        const ref = db.collection("subscription_ownership").doc(id);
        const owner = await diagnosticAwait(logger, operationId, "firestore.ownership.read", () => ref.get(), diagnostic);
        const checked = { ref, fingerprint: snapshotFingerprint(owner), id, ownerUid: owner.exists ? owner.get("ownerUid") : "" };
        ownerReads.push(checked);
        return owner;
      }));
      const inspected = await diagnosticAwait(logger, operationId, "ownership.inspect", () =>
        inspectOwner(db, { uid, platform: input.platform, ...args, verifySeriesState: async ({ conflictingOwnershipIds }) => {
          if (verifyConflicts) return verifyConflicts(conflictingOwnershipIds || ids);
          const states = (conflictingOwnershipIds || ids).map((id) => id === ids[0] ? verifiedState : linkedState);
          return states.includes("active") ? "active" : states.every((state) => state === "ended") ? "ended" : "unknown";
        } }), diagnostic);
      if (reads[0]?.exists && reads[0].get("ownerUid") === uid && inspected.decision === "match") return "match";
      if (inspected.decision === "mismatch") return "mismatch";
      if (inspected.decision === "ambiguous") return "unknown";
      if (inspected.reason === "verified_other_owner_series_ended" && verifiedState === "ended") {
        const historicalOwners = new Set([...(inspected.otherUserOwners || []),
          ...reads.filter((owner) => owner.exists && owner.get("ownerUid") !== uid).map((owner) => owner.get("ownerUid"))]);
        for (const otherUid of historicalOwners) {
          const ref = db.collection("users").doc(otherUid);
          const owner = await diagnosticAwait(logger, operationId, "firestore.legacy_owner.read", () => ref.get(), diagnostic);
          ownerReads.push({ ref, fingerprint: snapshotFingerprint(owner), id: `user:${otherUid}`,
            ownershipId: ids[0], ownerUid: otherUid, kind: "users" });
        }
        return "foreign_ended";
      }
      if (reads.some((owner) => owner.exists && owner.get("ownerUid") !== uid)) return "unknown";
      // Only an exact persisted series owner establishes ownership. No automatic claim.
      if (reads.some((owner) => owner.exists && owner.get("ownerUid") === uid) && inspected.decision === "match") return "match";
      if (inspected.decision === "mismatch") return "mismatch";
      // Server-verified account binding can recover a failed first save. READ never claims.
      return uidProof && reads.every((owner) => !owner.exists) && inspected.decision === "none" ? "recoverable" : "none";
    }
    if (candidates.length <= MAX_SERIES) {
      for (const identity of candidates) {
        if (input.platform === "android") {
          const candidateRef = hash("google-play:" + identity).slice(0, 16);
          const googleApiContext = { ...diagnostic, packageName: GOOGLE_PLAY_PACKAGE_NAME,
            productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
            purchaseSeriesRef: candidateRef,
            candidateRole: currentOnly ? "current_contract" : activePointer ? "verified_active_platform_pointer" : "legacy_or_store_candidate",
            candidateSources: [...(candidateOrigins.get(identity) || [])].sort() };
          const { subscription, matchedLineItem } = await diagnosticAwait(logger, operationId, "google_play.developer_api.verify", () =>
            verifyGoogle(GOOGLE_PLAY_PACKAGE_NAME, identity), googleApiContext);
          const accountId = subscription.externalAccountIdentifiers?.obfuscatedExternalAccountId;
          const uidProof = typeof accountId === "string" && accountId === hash(`kamome-account:${uid}`);
          const ownershipState = googleState(subscription, matchedLineItem);
          let linkedState = "unknown";
          if (!currentOnly && subscription.linkedPurchaseToken && subscription.linkedPurchaseToken !== identity) {
            const linked = await diagnosticAwait(logger, operationId, "google_play.linked_api.verify", () =>
              verifyGoogle(GOOGLE_PLAY_PACKAGE_NAME, subscription.linkedPurchaseToken), {
                ...diagnostic, packageName: GOOGLE_PLAY_PACKAGE_NAME,
                productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
                purchaseSeriesRef: hash("google-play:" + subscription.linkedPurchaseToken).slice(0, 16),
                candidateRole: "linked_series_required_for_ownership",
              });
            linkedState = googleState(linked.subscription, linked.matchedLineItem);
          }
          const owner = await checkedOwner({ purchaseToken: identity, linkedPurchaseToken: subscription.linkedPurchaseToken || "" }, uidProof, ownershipState, linkedState);
          entries.push({ state: googleState(subscription, matchedLineItem), owner: owner === "recoverable" ? "match" : owner,
            recoverableOwner: owner === "recoverable", identity,
            identities: [identity, subscription.linkedPurchaseToken].filter(Boolean).map((id) => seriesIdentity("android", id)),
            expiryMs: Date.parse(matchedLineItem?.expiryTime), subscription, matchedLineItem });
        } else {
          for (const entry of await diagnosticAwait(logger, operationId, "app_store.server_api.verify", () =>
            verifyApple(identity, { secrets, getAppAppleId }), {
              ...diagnostic, purchaseSeriesRef: seriesIdentity("ios", identity).slice(0, 16),
              candidateRole: currentOnly ? "current_contract" : activePointer ? "verified_active_platform_pointer" : "legacy_or_store_candidate",
              candidateSources: [...(candidateOrigins.get(identity) || [])].sort(),
            })) {
            // The Apple response may include other subscription groups. This entry
            // must belong to the requested original series; do not adopt siblings.
            if (currentOnly && String(entry.originalTransactionId) !== String(identity)) continue;
            const incomingToken = String(entry.transaction.appAccountToken || "").toLowerCase();
            const expectedToken = String(data.appStoreAppAccountToken || "").toLowerCase();
            const tokenMismatch = incomingToken && (!expectedToken || incomingToken !== expectedToken);
            const owner = await checkedOwner({ originalTransactionId: entry.originalTransactionId }, Boolean(incomingToken && incomingToken === expectedToken), entry.state);
            entries.push({ ...entry, owner: tokenMismatch ? (owner === "unknown" ? "unknown" : entry.state === "ended" ? "foreign_ended" : entry.state === "active" ? "mismatch" : "none") : owner === "recoverable" ? "match" : owner,
              recoverableOwner: !tokenMismatch && owner === "recoverable",
              identity: entry.originalTransactionId, identities: [seriesIdentity("ios", entry.originalTransactionId)] });
          }
        }
      }
    }
    if (!currentOnly && activePointer && entries.length) {
      // A verified server pointer makes persisted token arrays history candidates, but
      // a fresh Store query can still reveal a second independent current entitlement.
      // Never suppress that evidence based only on the existence of a primary pointer.
      const represented = new Set(entries.flatMap((entry) => entry.identities || []));
      for (const identity of allCandidates) {
        const sources = candidateOrigins.get(identity) || new Set();
        if (!sources.has("device_store_query") || identity === String(activeIdentity).trim() ||
            represented.has(seriesIdentity(input.platform, identity))) continue;
        const ref = seriesIdentity(input.platform, identity).slice(0, 16);
        let storeState = "unknown";
        let owner = "unknown";
        if (input.platform === "android") {
          const context = { ...diagnostic, packageName: GOOGLE_PLAY_PACKAGE_NAME,
            productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID, purchaseSeriesRef: ref,
            candidateRole: "additional_device_store_candidate" };
          const { subscription, matchedLineItem } = await diagnosticAwait(logger, operationId,
            "google_play.additional_store_candidate.verify", () => verifyGoogle(GOOGLE_PLAY_PACKAGE_NAME, identity), context);
          storeState = googleState(subscription, matchedLineItem);
          const linked = String(subscription.linkedPurchaseToken || "").trim();
          let linkedState = "unknown";
          if (linked && linked !== identity) {
            const linkedResult = await diagnosticAwait(logger, operationId, "google_play.additional_store_candidate.linked_verify",
              () => verifyGoogle(GOOGLE_PLAY_PACKAGE_NAME, linked), { ...context,
                purchaseSeriesRef: hash("google-play:" + linked).slice(0, 16),
                candidateRole: "linked_series_required_for_ownership" });
            linkedState = googleState(linkedResult.subscription, linkedResult.matchedLineItem);
          }
          owner = await checkedOwner({ purchaseToken: identity, linkedPurchaseToken: linked }, false, storeState, linkedState);
        } else {
          const verified = await diagnosticAwait(logger, operationId, "app_store.additional_store_candidate.verify",
            () => verifyApple(identity, { secrets, getAppAppleId }), { ...diagnostic,
              purchaseSeriesRef: ref, candidateRole: "additional_device_store_candidate" });
          const states = verified.map((entry) => entry.state);
          storeState = states.includes("active") ? "active" : states.length && states.every((state) => state === "ended") ? "ended" : "unknown";
          const incomingToken = String(verified.find((entry) => entry.transaction?.appAccountToken)?.transaction?.appAccountToken || "").toLowerCase();
          const expectedToken = String(data.appStoreAppAccountToken || "").toLowerCase();
          owner = await checkedOwner({ originalTransactionId: identity }, Boolean(incomingToken && incomingToken === expectedToken), storeState);
        }
        const ownerUid = ownerReads.findLast((candidate) => candidate.id === (input.platform === "android"
          ? buildAndroidOwnershipId(identity) : buildIosOwnershipId(identity)))?.ownerUid || "";
        const decision = storeState === "ended" ? "verified_ended_additional_store_candidate_ignored" :
          storeState === "active" && owner === "mismatch" ? "other_owner_active" :
          storeState === "active" ? "independent_active_store_candidate_unknown" : "store_candidate_state_unknown";
        diagnosticLog(logger, decision === "other_owner_active" || decision.endsWith("unknown") ? "warn" : "info",
          "PRECHAT_BILLING additional_store_candidate.decision", {
            ...diagnostic, purchaseSeriesRef: ref, candidateSources: [...sources].sort(),
            storeState, ownerUidRelation: ownerUid === uid ? "same_uid" : ownerUid ? "other_uid" : "unrecorded",
            decision,
          });
        if (decision === "other_owner_active") entries.push({ state: "active", owner: "mismatch", expiryMs: NaN, identities: [] });
        else if (decision.endsWith("unknown")) entries.push({ state: "unknown", owner: "unknown", expiryMs: NaN, identities: [] });
      }
    }
    const representedOwners = new Set(ownerReads.map((owner) => owner.id));
    const representedEventIds = input.platform === "android" ? new Set(entries.flatMap((entry) =>
      [entry.identity, entry.subscription?.linkedPurchaseToken].filter(Boolean).map(hash))) : new Set(entries.flatMap((entry) =>
      [entry.originalTransactionId, entry.transaction?.transactionId].filter(Boolean)));
    const unresolvedHistory = (currentOnly && candidates.length > 0 && entries.length === 0) || ownedIds.some((id) => !representedOwners.has(id)) ||
      eventIdentities.some((id) => id && !representedEventIds.has(id)) ||
      (!entries.length && eventIdentities.length > 0);
    const latest = await diagnosticAwait(logger, operationId, "firestore.user.recheck", () => snap.ref.get(), diagnostic);
    const ownersFresh = await diagnosticAwait(logger, operationId, "firestore.ownership.recheck", () =>
      Promise.all(ownerReads.map(async (owner) => snapshotFingerprint(await owner.ref.get()) === owner.fingerprint)), diagnostic);
    const historyFresh = await diagnosticAwait(logger, operationId, "firestore.history.recheck", () =>
      Promise.all(historyReads.map(async (read) => platformQueryFingerprint(await read.query.get(), input.platform) === read.fingerprint)), diagnostic);
    if (!latest.exists || platformBillingRevision(latest.data(), input.platform) !== platformBillingRevision(data, input.platform) || ownersFresh.includes(false) || historyFresh.includes(false))
      return { result: { state: "unknown", reason: "revision_changed", revision: latest.exists ? platformBillingRevision(latest.data(), input.platform) : "", coverage: "unknown", series: [], syncRequired: false, storeStatus: "unknown" }, entries: [], data, ownerReads: [], historyReads: [] };
    const observed = (input.storeCandidates || []).map((item) => input.platform === "android" ? item.purchaseToken : item.originalTransactionId || item.transactionId).filter(Boolean).map((id) => seriesIdentity(input.platform, id));
    const result = resultFor({ data, platform: input.platform, entries, overflow, unresolvedHistory, observed });
    if (currentOnly && !entries.length && (!['none', 'expired', 'revoked'].includes(input.storeState) || candidates.length)) {
      Object.assign(result, { state: "unknown", reason: "current_store_contract_unconfirmed", syncRequired: false,
        storeVerified: false, storeStatus: "unknown" });
    }
    result.revision = observationRevision(data, historyReads, ownerReads, input.platform);
    return { result, entries, data, ownerReads, historyReads,
      selectionReason: currentContractSelectionReason,
      pointerConflict: currentContractPointerConflict };
  }
  async function read(request) {
    const parsed = loggedAuthAndPayload(request, logger, "read");
    const uid = parsed.uid;
    // Normalize old callers too: the deployed endpoint never executes history
    // fallback. Missing current evidence remains Unknown, never eligible.
    const data = currentContractOnly ? { ...parsed.data, selectionMode: "current_contract_only" } : parsed.data;
    const operationId = data.diagnosticOperationId || data.attemptId;
    const budget = Math.max(1, Math.min(10000, Number(data.remainingMs) || 10000));
    const startedAt = Date.now();
    const diagnostic = { operationId, uidHash: uidDiagnosticId(uid), platform: data.platform,
      deviceSwitchTraceId: /^ds-[0-9]{1,20}-[0-9]{1,8}$/.test(String(data.deviceSwitchTraceId || "")) ? String(data.deviceSwitchTraceId) : null, attemptId: data.attemptId, remainingMs: budget };
    diagnosticLog(logger, "info", "PRECHAT_BILLING read.begin", diagnostic);
    try {
      let readEvaluation = null;
      const observe = async () => {
        await diagnosticAwait(logger, operationId, "request.guard", () => assertRequestAllowed(request, data.platform), diagnostic);
        const evaluation = await evaluate(uid, data, operationId);
        readEvaluation = evaluation;
        const op = await diagnosticAwait(logger, operationId, "firestore.operation.read", () =>
          operationRef(getDb(), uid, data.attemptId).get(), diagnostic);
        return { ...evaluation.result, firestoreRevision: Number(evaluation.data.billingRevision || 0),
          syncOperation: op.exists ? op.get("state") : "none" };
      };
      // A raced timeout would leave the underlying Store API running and allow
      // the next purchase READ to overlap it. Keep this response pending until
      // observation settles; the client bounds its UI and retains the READ gate.
      const result = data.selectionMode === "current_contract_only"
        ? await observe() : await bounded(observe, budget);
      diagnosticLog(logger, "info", "PRECHAT_BILLING read.end", { ...diagnostic, elapsedMs: Date.now() - startedAt,
        state: result.state, reason: result.reason || "none", revision: result.revision, storeStatus: result.storeStatus || "unknown",
        syncRequired: result.syncRequired, storeVerified: result.storeVerified,
        appleVerificationOutcome: summarizeAppleVerification(readEvaluation?.entries),
        pointerConflict: Boolean(readEvaluation?.pointerConflict ||
          readEvaluation?.selectionReason === "current_contract_pointer_conflict"),
        currentSeriesCandidateCount: (data.storeCandidates || []).length });
      return result;
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      // Definitive access denial is not a transient 60-second polling case.
      const code = String(error?.code || error?.status || "").toLowerCase().replaceAll("_", "-");
      const fatalReason = ["permission-denied", "7", "403"].includes(code) ? "permission_denied"
        : ["unauthenticated", "16", "401"].includes(code) ? "unauthenticated" : null;
      if (fatalReason) return { state: "unknown", reason: fatalReason, revision: "",
        series: [], syncRequired: false, storeVerified: false, storeStatus: "unknown" };
      diagnosticLog(logger, "warn", "PRECHAT_BILLING read.end", { ...diagnostic, elapsedMs: Date.now() - startedAt,
        state: "unknown", reason: error?.message === "confirmation_read_timeout" ? "deadline_timeout" : "server_read_unavailable",
        ...diagnosticErrorFields(error) });
      return { state: "unknown", reason: "server_read_unavailable", revision: "", coverage: "unknown", series: [], syncRequired: false, storeStatus: "unknown" };
    }
  }
  async function sync(request) {
    const parsed = loggedAuthAndPayload(request, logger, "sync");
    const uid = parsed.uid;
    const input = currentContractOnly ? { ...parsed.data, selectionMode: "current_contract_only" } : parsed.data;
    const operationId = input.diagnosticOperationId || input.attemptId;
    const syncStartedAt = Date.now();
    const diagnostic = { operationId, uidHash: uidDiagnosticId(uid), platform: input.platform,
      deviceSwitchTraceId: /^ds-[0-9]{1,20}-[0-9]{1,8}$/.test(String(input.deviceSwitchTraceId || "")) ? String(input.deviceSwitchTraceId) : null, attemptId: input.attemptId, expectedRevision: input.expectedRevision || "missing" };
    diagnosticLog(logger, "info", "PRECHAT_BILLING sync.begin", diagnostic);
    await diagnosticAwait(logger, operationId, "request.guard", () =>
      assertRequestAllowed(request, input.platform), diagnostic);
    await diagnosticAwait(logger, operationId, "active_device.guard", () =>
      assertSyncAllowed(request, input.platform), diagnostic);
    if (typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
      const error = new HttpsError("invalid-argument", "Expected revision required.");
      diagnosticLog(logger, "warn", "PRECHAT_BILLING request.reject", {
        ...diagnostic, stage: "expected_revision", ...diagnosticErrorFields(error),
      });
      throw error;
    }
    const db = await diagnosticAwait(logger, operationId, "firestore.client.initialize", () => getDb(), diagnostic);
    const ref = operationRef(db, uid, input.attemptId);
    const fingerprint = hash(JSON.stringify(stable({ platform: input.platform, revision: input.expectedRevision, selectionMode: input.selectionMode || "legacy", candidates: input.storeCandidates || [] })));
    const reserved = await diagnosticAwait(logger, operationId, "firestore.operation.reserve", () => db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) return { started: false, state: existing.get("state"), fingerprint: existing.get("fingerprint") };
      tx.create(ref, { state: "processing", fingerprint, platform: input.platform, createdAt: admin.FieldValue.serverTimestamp() });
      return { started: true };
    }), diagnostic);
    if (!reserved.started) {
      diagnosticLog(logger, "info", "PRECHAT_BILLING sync.end", { ...diagnostic, elapsedMs: Date.now() - syncStartedAt,
        outcome: "repeated", operationState: reserved.state || "unknown" });
      if (reserved.fingerprint !== fingerprint) throw new HttpsError("failed-precondition", "Operation identity cannot be reused.");
      return { state: reserved.state, repeated: true };
    }
    try {
      const budget = Math.max(1, Math.min(10000, Number(input.remainingMs) || 10000));
      const currentOnly = input.selectionMode === "current_contract_only";
      const syncDeadline = Date.now() + budget;
      const evaluation = currentOnly ? await evaluate(uid, input, operationId)
        : await bounded(() => evaluate(uid, input, operationId), budget);
      if (currentOnly && Date.now() >= syncDeadline) {
        await ref.update({ state: "not_applied", reason: "sync_deadline" });
        return { state: "not_applied" };
      }
      const { result, entries, ownerReads, historyReads } = evaluation;
      if (result.revision !== input.expectedRevision || !["active", "eligible"].includes(result.state)) {
        await ref.update({ state: "not_applied", reason: "verification_or_revision_changed" });
        diagnosticLog(logger, "info", "PRECHAT_BILLING sync.end", { ...diagnostic, elapsedMs: Date.now() - syncStartedAt,
          outcome: "not_applied", actualRevision: result.revision, state: result.state, reason: result.reason });
        return { state: "not_applied" };
      }
      const committed = await diagnosticAwait(logger, operationId, "firestore.sync.transaction", () => db.runTransaction(async (tx) => {
        const userRef = db.collection("users").doc(uid);
        const snap = await tx.get(userRef);
        const ownership = await Promise.all(ownerReads.map((owner) => tx.get(owner.ref)));
        const histories = await Promise.all(historyReads.map((read) => tx.get(read.query)));
        const freshOwners = ownerReads.map((read, index) => ({ ...read, fingerprint: snapshotFingerprint(ownership[index]) }));
        const freshHistory = historyReads.map((read, index) => ({ ...read, fingerprint: platformQueryFingerprint(histories[index], input.platform) }));
        if (!snap.exists || observationRevision(snap.data(), freshHistory, freshOwners, input.platform) !== input.expectedRevision) {
          tx.update(ref, { state: "not_applied", reason: "revision_changed" });
          return { state: "not_applied" };
        }
        if (currentOnly && Date.now() >= syncDeadline) {
          tx.update(ref, { state: "not_applied", reason: "sync_deadline" });
          return { state: "not_applied" };
        }
        const stored = snap.data();
        const now = admin.FieldValue.serverTimestamp();
        const confirmation = { state: result.state, reason: result.reason, checkedAt: now,
          schemaVersion: 1, coverage: result.coverage, revision: Number(stored.billingRevision || 0) + 1,
          expiredForeignSeries: result.state === "eligible" ? ownerReads.filter((owner) => owner.ownerUid && owner.ownerUid !== uid &&
            entries.some((entry) => entry.owner === "foreign_ended" && entry.state === "ended" &&
              (input.platform === "ios" ? buildIosOwnershipId(entry.originalTransactionId) === (owner.ownershipId || owner.id) :
                [entry.identity, entry.subscription?.linkedPurchaseToken].filter(Boolean).map(buildAndroidOwnershipId).includes(owner.ownershipId || owner.id))))
            .map((owner) => {
              const ownershipId = owner.ownershipId || owner.id;
              const entry = entries.find((entry) => input.platform === "ios" ? buildIosOwnershipId(entry.originalTransactionId) === ownershipId :
                [entry.identity, entry.subscription?.linkedPurchaseToken].filter(Boolean).map(buildAndroidOwnershipId).includes(ownershipId));
              const ownerUser = ownerReads.find((read) => read.kind === "users" && read.ownerUid === owner.ownerUid);
              return { ownershipId, ownerUid: owner.ownerUid, kind: owner.kind || "subscription_ownership", fingerprint: owner.fingerprint,
                ownerUserFingerprint: ownerUser?.fingerprint || "", expiryMs: entry.expiryMs };
            }) : [],
        };
        const payload = { billingRevision: confirmation.revision, billingConfirmation: {
          ...(stored.billingConfirmation || {}), [input.platform]: confirmation } };
        const ownedEntries = entries.filter((entry) => entry.owner === "match");
        if (ownedEntries.length) {
          const eligibleEntries = ownedEntries.filter((entry) => result.state === "active" ? entry.state === "active" : entry.state === "ended");
          const newest = eligibleEntries.reduce((a, b) => a.expiryMs >= b.expiryMs ? a : b);
          const storeState = input.platform === "android" ? buildAndroidStoreState({
            status: result.state === "active" ? "active" : "expired", expiryTime: admin.Timestamp.fromMillis(newest.expiryMs),
            primaryPurchaseToken: newest.identity, activePurchaseTokens: [...new Set(ownedEntries.map((entry) => entry.identity))],
            subscriptionState: newest.subscription.subscriptionState, source: "prechat_verified_sync", updatedAt: now,
          }) : buildIosStoreState({ status: result.state === "active" ? "active" : "expired",
            expiryTime: admin.Timestamp.fromMillis(newest.expiryMs), originalTransactionId: newest.originalTransactionId,
            transactionId: newest.transaction.transactionId, environment: newest.transaction.environment,
            source: "prechat_verified_sync", updatedAt: now });
          Object.assign(storeState, verifiedStoreMetadata(input.platform, newest, now));
          if (input.platform === "android") {
            storeState.activePurchaseTokens = [...new Set([
              ...(stored.subscriptions?.android?.activePurchaseTokens || []),
              ...ownedEntries.flatMap((entry) => [entry.identity, entry.subscription?.linkedPurchaseToken]).filter(Boolean),
            ])];
            Object.assign(payload, { googlePlayPrimaryPurchaseToken: newest.identity,
              googlePlayLinkedPurchaseToken: newest.subscription.linkedPurchaseToken || "",
              googlePlayAcknowledgementState: newest.subscription.acknowledgementState || "unknown",
              activePurchaseTokens: [...new Set([...(stored.activePurchaseTokens || []), ...storeState.activePurchaseTokens])] });
          } else {
            storeState.transactionIds = [...new Set([...(stored.subscriptions?.ios?.transactionIds || []),
              ...ownedEntries.map((entry) => entry.transaction.transactionId).filter(Boolean)])];
            Object.assign(payload, { appStoreOriginalTransactionId: newest.originalTransactionId,
              appStoreTransactionId: newest.transaction.transactionId, appStoreEnvironment: newest.transaction.environment });
          }
          const stores = { ...(stored.subscriptions || {}), [input.platform]: storeState };
          const entitlement = computeAccountEntitlement(stores.ios, stores.android);
          Object.assign(payload, deriveLegacyAccountFields(stores.ios, stores.android, stored, input.platform), {
            subscriptions: stores, entitlementUsable: entitlement.entitlementUsable,
            entitlementSource: entitlement.entitlementSource, entitlementUpdatedAt: now,
            entitlementExpiryTime: entitlement.entitlementExpiryTime ? admin.Timestamp.fromDate(entitlement.entitlementExpiryTime) : null,
          });
        }
        if (!ownedEntries.length && entries.length && result.state === "eligible") {
          const newest = entries.reduce((a, b) => a.expiryMs >= b.expiryMs ? a : b);
          // Record verified inactivity, never attach another UID's Store IDs/token.
          const stores = { ...(stored.subscriptions || {}), [input.platform]: {
            status: "expired", expiryTime: admin.Timestamp.fromMillis(newest.expiryMs),
            productId: APP_STORE_PRODUCT_ID, source: "prechat_foreign_series_ended", updatedAt: now,
          } };
          const otherPlatform = input.platform === "ios" ? "android" : "ios";
          if (!stored.subscriptions?.[otherPlatform] && normalizeSubscriptionPlatform(stored.subscriptionPlatform) === otherPlatform) {
            // Preserve the other OS's legacy-only contract; target inactivity
            // is explicit in subscriptions and never grants cross-OS access.
            payload.subscriptions = stores;
          } else {
            const entitlement = computeAccountEntitlement(stores.ios, stores.android);
            Object.assign(payload, deriveLegacyAccountFields(stores.ios, stores.android, stored, input.platform), {
              subscriptions: stores, entitlementUsable: entitlement.entitlementUsable,
              entitlementSource: entitlement.entitlementSource, entitlementUpdatedAt: now,
              entitlementExpiryTime: entitlement.entitlementExpiryTime ? admin.Timestamp.fromDate(entitlement.entitlementExpiryTime) : null,
            });
          }
        }
        const recoveredOwnerIds = new Set();
        for (const entry of entries.filter((candidate) => candidate.recoverableOwner)) {
          const ownerId = input.platform === "android" ? buildAndroidOwnershipId(entry.identity) : buildIosOwnershipId(entry.originalTransactionId);
          if (recoveredOwnerIds.has(ownerId)) continue;
          recoveredOwnerIds.add(ownerId);
          const ownerRef = db.collection("subscription_ownership").doc(ownerId);
          const ownerFields = input.platform === "android" ? {
            googlePurchaseTokenHash: hash(entry.identity),
            googleLinkedPurchaseTokenHash: entry.subscription.linkedPurchaseToken ? hash(entry.subscription.linkedPurchaseToken) : "",
          } : { appStoreOriginalTransactionId: entry.originalTransactionId,
            appStoreTransactionId: entry.transaction.transactionId, appAccountToken: entry.transaction.appAccountToken };
          tx.create(ownerRef, { ownerUid: uid, platform: input.platform, productId: APP_STORE_PRODUCT_ID,
            status: "active", ...ownerFields, claimedAt: now, updatedAt: now });
          payload.boundSubscriptionSeries = { ...(stored.boundSubscriptionSeries || {}),
            [input.platform]: { ownershipId: ownerId, boundAt: now,
              ...(input.platform === "ios" ? { originalTransactionId: entry.originalTransactionId } : {}) } };
        }
        tx.set(userRef, payload, { merge: true });
        tx.update(ref, { state: "completed", completedAt: now, verificationFingerprint: hash(JSON.stringify(stable(result))) });
        return { state: "completed" };
      }), diagnostic);
      diagnosticLog(logger, "info", "PRECHAT_BILLING sync.end", { ...diagnostic, elapsedMs: Date.now() - syncStartedAt,
        outcome: committed.state, revision: result.revision, storeState: result.state, reason: result.reason || "none",
        expiredForeignSeriesCount: entries.filter((entry) => entry.owner === "foreign_ended" && entry.state === "ended").length });
      return committed;
    } catch (error) {
      // This operation stays consumed; the client READs the result instead of replaying the write.
      diagnosticLog(logger, "warn", "PRECHAT_BILLING sync.end", { ...diagnostic, elapsedMs: Date.now() - syncStartedAt,
        outcome: "failed", ...diagnosticErrorFields(error) });
      await diagnosticAwait(logger, operationId, "firestore.operation.mark_failed", () =>
        ref.update({ state: "failed", reason: "verification_unavailable" }), diagnostic);
      const code = String(error?.code || error?.status || "").toLowerCase().replaceAll("_", "-");
      if (["permission-denied", "7", "403"].includes(code)) throw new HttpsError("permission-denied", "Confirmation access denied.");
      if (["unauthenticated", "16", "401"].includes(code)) throw new HttpsError("unauthenticated", "Sign-in is required.");
      return { state: "failed" };
    }
  }
  return { read, sync };
}
function verifiedStoreMetadata(platform, entry, checkedAt) {
  if (platform === "android") return {
    packageId: GOOGLE_PLAY_PACKAGE_NAME, productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
    linkedPurchaseToken: entry.subscription.linkedPurchaseToken || "",
    acknowledgementState: entry.subscription.acknowledgementState || "unknown",
    verifiedAt: checkedAt, verificationSource: "google_play_subscriptions_v2",
  };
  return { bundleId: APP_STORE_BUNDLE_ID, productId: APP_STORE_PRODUCT_ID,
    appAccountToken: entry.transaction.appAccountToken || "", environment: entry.transaction.environment || "",
    revocationDate: entry.transaction.revocationDate || null, revocationReason: entry.transaction.revocationReason ?? null,
    finishState: "unknown", verifiedAt: checkedAt, verificationSource: "app_store_signed_status",
  };
}
function hasPurchaseEvidence(data) {
  return Boolean(data.accountDeletionState || data.billingRevision || data.billingConfirmation || data.subscriptions ||
    data.subscriptionStatus || data.subscriptionPlatform || data.subscriptionExpiryTime ||
    data.entitlementUsable != null || data.googlePlayPrimaryPurchaseToken ||
    data.appStoreOriginalTransactionId || data.appStoreTransactionId || (data.activePurchaseTokens || []).length);
}
async function seedInitializedAccount({ db, admin, uid, creationTime }) {
  return db.runTransaction(async (tx) => {
    const userRef = db.collection("users").doc(uid);
    const proofRef = db.collection("preChatBillingCreationProof").doc(uid);
    const [user, proof] = await Promise.all([tx.get(userRef), tx.get(proofRef)]);
    const data = user.exists ? user.data() : {};
    const proofCreationTime = proof.exists ? proof.get("creationTime") : null;
    const proofCreated = typeof proofCreationTime === "string" && proofCreationTime.trim() ? Date.parse(proofCreationTime) : NaN;
    const authCreated = typeof creationTime === "string" && creationTime.trim() ? Date.parse(creationTime) : NaN;
    // Auth event ISO and Admin SDK UTC strings may represent the same instant.
    // Compare exact milliseconds; missing/invalid dates and precision differences fail closed.
    if (!proof.exists || !Number.isFinite(proofCreated) || !Number.isFinite(authCreated) ||
      proofCreated !== authCreated || !data.accountId || !data.email || hasPurchaseEvidence(data)) return false;
    const timestamp = admin.FieldValue.serverTimestamp();
    const record = { state: "eligible", reason: "server_auth_creation_and_initialization",
      checkedAt: timestamp, schemaVersion: 1, coverage: COVERAGE, revision: 1 };
    tx.set(userRef, { billingConfirmation: { android: record, ios: record }, billingRevision: 1 }, { merge: true });
    return true;
  });
}
async function recordNewAuthCreation({ db, admin, user, now = Date.now() }) {
  const creationTime = user.metadata?.creationTime;
  const created = Date.parse(creationTime);
  // A delayed old event is not used as proof of no purchase. Existing contract data always wins.
  if (!Number.isFinite(created) || now < created || now - created > 10 * 60 * 1000) return false;
  const ref = db.collection("preChatBillingCreationProof").doc(user.uid);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (!existing.exists) tx.create(ref, { creationTime, source: "auth_on_create_v1", recordedAt: admin.FieldValue.serverTimestamp() });
  });
  return seedInitializedAccount({ db, admin, uid: user.uid, creationTime });
}
module.exports = { COVERAGE, STORE_COVERAGE, verifiedStoreMetadata, seriesIdentity, billingRevision, candidatesFor, googleState, appleState,
  verifyAppleSeries, resultFor, activeSeriesRepresentatives, platformBillingRevision, platformQueryFingerprint, observationRevision, createPreChatBillingHandlers, recordNewAuthCreation, seedInitializedAccount, hasPurchaseEvidence };
