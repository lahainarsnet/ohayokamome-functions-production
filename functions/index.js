// functions/index.js
// 正本リポジトリ: github.com/lahainars/ohayou-kamome（cloud_functions 配下）※ Flutter リポジトリと混同しないこと。
//
// トップレベルは軽量に保ち、Firestore / FieldValue 等は firebaseAdmin 経由で
// 初回実行時まで遅延（デプロイ時のコードロードタイムアウト対策）。

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const crypto = require("node:crypto");
const { google } = require("googleapis");
const admin = require("./firebaseAdmin");
const { transcribeExperiment } = require("./transcribeExperiment");
const {
  createAppStoreNotificationHandler,
} = require("./appStoreSubscriptionNotifications");
const {
  createGooglePlayRtdnHandler,
} = require("./googlePlaySubscriptionNotifications");
const {
  createGooglePlaySubscriptionProbeHandler,
} = require("./googlePlaySubscriptionProbe");
const {
  createRegisterDeviceUsageHandler,
} = require("./registerDeviceUsage");
const {
  fetchAppStoreAllSubscriptionStatuses,
  pickLatestTransactionEntry,
  deriveSubscriptionState,
} = require("./appStoreServerCommon");
const {
  assertSubscriptionNotLinkedToOtherUser,
  ownershipIdentifiersFromAppStoreUpdate,
  ensureAppStoreAppAccountTokenForUser,
  claimIosSubscriptionOwnership,
  claimAndroidSubscriptionOwnership,
} = require("./subscriptionOwnership");
const {
  extractBillingTraceId,
  tokenSuffix: billingTokenSuffix,
  createBillingFinalLogger,
  summarizeTransactionInfo,
  payloadKeys,
  summarizeHttpsError,
} = require("./billingFinalTrace");
const {
  buildIosStoreState,
  buildAndroidStoreState,
  commitUserSubscriptionDualWrite,
  inferAndroidAutoRenewing,
  recomputeEntitlementFromStoredStores,
} = require("./subscriptionEntitlement");
const {
  RECIPIENT_SUBSCRIPTION_UNAVAILABLE,
  SENDER_SUBSCRIPTION_UNAVAILABLE,
} = require("./sendMessageGuardCodes");
const {
  describeAccountAccessUsability,
  evaluateCrossPlatformPurchaseGuard,
} = require("./accountAccessUsability");
const {
  computeEntitlementExpiryDeltaMs,
  resolveRecipientSubscriptionWithExpiryLagRetry,
} = require("./recipientSubscriptionGuardRetry");
const {
  resolveAccountIdForUpsert,
  resolveGetUserInfoByAccountIdLookup,
} = require("./accountIdGuard");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const {
  CHAT_MESSAGE_LIMIT,
  computeMessagesToDeleteCount,
} = require("./deleteOldMessagesLib");

const { randomUUID } = crypto;

const APP_STORE_CONNECT_ISSUER_ID = defineSecret("APP_STORE_CONNECT_ISSUER_ID");
const APP_STORE_CONNECT_KEY_ID = defineSecret("APP_STORE_CONNECT_KEY_ID");
const APP_STORE_CONNECT_PRIVATE_KEY = defineSecret("APP_STORE_CONNECT_PRIVATE_KEY");
const APP_STORE_CONNECT_APP_APPLE_ID = defineString("APP_STORE_CONNECT_APP_APPLE_ID", {
  default: "6782558611",
});

const APP_STORE_PRODUCT_ID = "ohayo_kamome_monthly";
const APP_STORE_BUNDLE_ID = "com.lahainarsnet.ohayokamome.live";
const APP_STORE_API_PRODUCTION_BASE_URL = "https://api.storekit.itunes.apple.com";
const APP_STORE_API_SANDBOX_BASE_URL = "https://api.storekit-sandbox.itunes.apple.com";
const GOOGLE_PLAY_PACKAGE_NAME = "com.lahainarsnet.ohayokamome.live";
const GOOGLE_PLAY_MONTHLY_PRODUCT_ID = "ohayo_kamome_monthly";
const GOOGLE_PLAY_ACTIVE_STATES = new Set([
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
]);
const GOOGLE_PLAY_BILLING_TRACE = "KAMOME_BILLING_TRACE";

/* =========================================================
 * ユーティリティ：JST の日付キー (YYYY-MM-DD) を得る
 *  - Cloud Functions のサーバ時刻を基準
 * =======================================================*/
function getJstDateKey(baseDate = new Date()) {
  // UTC → JST (+9h)
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jst = new Date(baseDate.getTime() + JST_OFFSET_MS);
  // "YYYY-MM-DD" を取り出す
  return jst.toISOString().slice(0, 10);
}

/* =========================================================
 * 共通：config/app を読み込み
 *  - dailyLimit: 1日の送信上限（デフォルト120）
 *  - accessMode: "normal" | "block_all"
 * =======================================================*/
/**
 * 受信者の contacts に送信者が登録されているか（双方向登録の受信者側）。
 * - stableId === senderId（現行 Flutter 想定）
 * - stableId が空/欠損かつ partnerId === senderId（旧 Kotlin レガシー）
 */
function recipientContactAcceptsSender(data, senderId) {
  const stableRaw = data.stableId;
  const stableId =
    typeof stableRaw === "string" ? stableRaw.trim() : "";
  const partnerId =
    typeof data.partnerId === "string" ? data.partnerId.trim() : "";
  if (stableId === senderId) {
    return true;
  }
  if (stableId === "" && partnerId === senderId) {
    return true;
  }
  return false;
}

async function getQueryCount(query) {
  if (typeof query.count === "function") {
    const countSnap = await query.count().get();
    return countSnap.data().count || 0;
  }
  const snap = await query.get();
  return snap.size;
}

async function countUnreadMessagesForRecipient(recipientId) {
  if (!recipientId) return 1;

  const db = admin.getDb();
  const chatsSnap = await db
    .collection("chats")
    .where("participants", "array-contains", recipientId)
    .get();

  let total = 0;
  for (const chatDoc of chatsSnap.docs) {
    const unreadQuery = chatDoc.ref
      .collection("messages")
      .where("recipientId", "==", recipientId)
      .where("isRead", "==", false);
    total += await getQueryCount(unreadQuery);
  }
  return total;
}

async function fetchLatestFcmTokenForRecipient(recipientId, fallbackToken = "") {
  if (!recipientId) return fallbackToken;

  try {
    const recipientDoc = await admin.getDb().collection("users").doc(recipientId).get();
    const latestToken = recipientDoc.get("fcmToken") || "";
    return latestToken || fallbackToken;
  } catch (e) {
    logger.warn("Failed to fetch recipient FCM token; falling back to embedded token.", {
      recipientIdSuffix: uidTailForLog(recipientId),
      e,
    });
    return fallbackToken;
  }
}

const { loadAppConfig, assertAccessNotBlocked } = require("./appConfig");

function logIdentifierSuffix(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "empty";
  if (normalized.length <= 4) {
    return `(short-id len=${normalized.length})`;
  }
  if (normalized.length <= 11) {
    const tailLen = normalized.length <= 7 ? 3 : 4;
    return normalized.slice(-tailLen);
  }
  return normalized.slice(-6);
}

function uidTailForLog(uid) {
  if (typeof uid !== "string" || uid.length === 0) {
    return "(empty)";
  }
  return logIdentifierSuffix(uid);
}

function tokenSuffix(token) {
  return logIdentifierSuffix(token);
}

function fcmTokenMetaForLog(token) {
  const normalized = String(token || "").trim();
  if (!normalized) {
    return { hasToken: false, tokenLength: 0 };
  }
  return {
    hasToken: true,
    tokenLength: normalized.length,
    tokenTail: tokenSuffix(normalized),
  };
}

function logIdTailForLog(value) {
  return logIdentifierSuffix(String(value || ""));
}

function previewExpiryRawForLog(value) {
  if (value == null) {
    return "(null)";
  }
  if (value instanceof admin.Timestamp) {
    return "timestamp";
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 28);
  }
  if (typeof value === "number") {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length <= 28) {
      return trimmed;
    }
    return `${trimmed.slice(0, 28)}…`;
  }
  return typeof value;
}

function rawExpiryTypeForLog(value) {
  if (value == null) {
    return "null";
  }
  if (value instanceof admin.Timestamp) {
    return "timestamp";
  }
  if (value instanceof Date) {
    return "date";
  }
  if (typeof value.toDate === "function") {
    return "timestampLike";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "string") {
    return "string";
  }
  return typeof value;
}

function parseSubscriptionExpiryTimeWithMeta(value) {
  if (value == null) {
    return { expiry: null, parsePath: "null" };
  }
  if (value instanceof admin.Timestamp) {
    return { expiry: value.toDate(), parsePath: "timestamp" };
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

function parseSubscriptionExpiryTime(value) {
  return parseSubscriptionExpiryTimeWithMeta(value).expiry;
}

function describeSubscriptionUsability(subscriptionStatus, subscriptionExpiryTime, now = new Date()) {
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

function isSubscriptionUsable(subscriptionStatus, subscriptionExpiryTime, now = new Date()) {
  return describeSubscriptionUsability(
    subscriptionStatus,
    subscriptionExpiryTime,
    now,
  ).subscriptionUsable;
}

function normalizeSubscriptionPlatform(value) {
  return (value || "").trim().toLowerCase();
}

const SUBSCRIPTION_PLATFORM_MISMATCH_MESSAGE = "SUBSCRIPTION_PLATFORM_MISMATCH";

function logCrossPlatformPurchaseGuardTrace({
  uidTail,
  traceId,
  purchasingPlatform,
  guard,
}) {
  const tracePayload = {
    step: guard.block ? "platform_mismatch.reject" : "platform_mismatch.allow",
    billingTraceId: traceId,
    uidTail,
    purchasingPlatform,
    decisionSource: guard.decisionSource,
    entitlementUsable: guard.entitlementUsable,
    entitlementExpiryIsFuture: guard.entitlementExpiryIsFuture,
    entitlementSource: guard.entitlementSource || "(empty)",
    legacyStatusAllowsAccess: guard.legacyStatusAllowsAccess,
    legacyExpiryIsFuture: guard.legacyExpiryIsFuture,
    legacyPlatform: guard.legacyPlatform || "(empty)",
    otherPlatformActive: guard.otherPlatformActive,
    denyReason: guard.denyReason || guard.reason || "none",
    rejectCode: guard.block ? SUBSCRIPTION_PLATFORM_MISMATCH_MESSAGE : null,
  };
  if (guard.block) {
    logger.warn("KAMOME_BILLING_FINAL_TRACE", tracePayload);
    logger.warn(
      `[CrossPlatformPurchaseGuard] uidTail=${uidTail} purchasingPlatform=${purchasingPlatform} ` +
        `decisionSource=${guard.decisionSource} entitlementUsable=${guard.entitlementUsable ?? "null"} ` +
        `entitlementExpiryIsFuture=${guard.entitlementExpiryIsFuture} ` +
        `entitlementSource=${guard.entitlementSource || "(empty)"} ` +
        `legacyStatusAllowsAccess=${guard.legacyStatusAllowsAccess} ` +
        `legacyExpiryIsFuture=${guard.legacyExpiryIsFuture} ` +
        `legacyPlatform=${guard.legacyPlatform || "(empty)"} ` +
        `otherPlatformActive=${guard.otherPlatformActive} denyReason=${guard.denyReason ?? guard.reason} ` +
        `code=${SUBSCRIPTION_PLATFORM_MISMATCH_MESSAGE}`,
    );
    return;
  }
  logger.info("KAMOME_BILLING_FINAL_TRACE", tracePayload);
  logger.info(
    `[CrossPlatformPurchaseGuard] uidTail=${uidTail} purchasingPlatform=${purchasingPlatform} ` +
      `decisionSource=${guard.decisionSource} entitlementUsable=${guard.entitlementUsable ?? "null"} ` +
      `entitlementExpiryIsFuture=${guard.entitlementExpiryIsFuture} ` +
      `entitlementSource=${guard.entitlementSource || "(empty)"} ` +
      `legacyStatusAllowsAccess=${guard.legacyStatusAllowsAccess} ` +
      `legacyExpiryIsFuture=${guard.legacyExpiryIsFuture} ` +
      `legacyPlatform=${guard.legacyPlatform || "(empty)"} ` +
      `otherPlatformActive=${guard.otherPlatformActive} denyReason=${guard.denyReason ?? guard.reason} ` +
      `action=allowPurchase`,
  );
}

async function assertPurchasingPlatformAllowed(
  uid,
  purchasingPlatform,
  traceId = null
) {
  const normalizedPurchasing = normalizeSubscriptionPlatform(purchasingPlatform);
  if (normalizedPurchasing !== "ios" && normalizedPurchasing !== "android") {
    throw new HttpsError("internal", "Invalid purchasing platform.");
  }

  const uidTail = uidTailForLog(uid);
  const userSnap = await admin.getDb().collection("users").doc(uid).get();
  if (!userSnap.exists) {
    logger.info("KAMOME_BILLING_FINAL_TRACE", {
      step: "platform_mismatch.allow_no_user_doc",
      billingTraceId: traceId,
      uidTail,
      purchasingPlatform: normalizedPurchasing,
    });
    return;
  }

  const userData = userSnap.data() || {};
  const guard = evaluateCrossPlatformPurchaseGuard({
    userData,
    purchasingPlatform: normalizedPurchasing,
    now: new Date(),
    parseExpiryWithMeta: parseSubscriptionExpiryTimeWithMeta,
  });

  logCrossPlatformPurchaseGuardTrace({
    uidTail,
    traceId,
    purchasingPlatform: normalizedPurchasing,
    guard,
  });

  if (guard.block) {
    throw new HttpsError(
      "failed-precondition",
      SUBSCRIPTION_PLATFORM_MISMATCH_MESSAGE
    );
  }
}

function logRecipientSubscriptionGuard({
  recipientUidTail,
  decisionSource,
  entitlementUsable,
  entitlementExpiryIsFuture,
  subscriptionStatus,
  subscriptionPlatform,
  rawExpiryType,
  rawExpiryPreview,
  parsePath,
  expiry,
  parsedExpiryISO,
  nowISO,
  deltaMs,
  entitlementExpiryDeltaMs,
  statusAllowsAccess,
  expiryIsFuture,
  isSubscriptionUsable: subscriptionUsable,
  denyReason,
  action,
}) {
  const statusForLog =
    (subscriptionStatus || "").trim().length === 0
      ? "(empty)"
      : (subscriptionStatus || "").trim().toLowerCase();
  const platformForLog =
    (subscriptionPlatform || "").trim().length === 0
      ? "(empty)"
      : (subscriptionPlatform || "").trim().toLowerCase();
  logger.info(
    `[RecipientSubscriptionGuard] recipientUidTail=${recipientUidTail} ` +
      `decisionSource=${decisionSource} entitlementUsable=${entitlementUsable ?? "null"} ` +
      `entitlementExpiryIsFuture=${entitlementExpiryIsFuture} ` +
      `subscriptionStatus=${statusForLog} recipientPlatform=${platformForLog} ` +
      `rawExpiryType=${rawExpiryType} rawExpiryPreview=${rawExpiryPreview} parsePath=${parsePath} ` +
      `parsedExpiryISO=${parsedExpiryISO} nowISO=${nowISO} deltaMs=${deltaMs} ` +
      `entitlementExpiryDeltaMs=${entitlementExpiryDeltaMs ?? "null"} ` +
      `statusAllowsAccess=${statusAllowsAccess} expiryIsFuture=${expiryIsFuture} ` +
      `subscriptionUsable=${subscriptionUsable} denyReason=${denyReason ?? "none"} action=${action}`,
  );
}

function logSenderSubscriptionGuard({
  senderUidTail,
  decisionSource,
  entitlementUsable,
  entitlementExpiryIsFuture,
  subscriptionStatus,
  legacyStatusAllowsAccess,
  legacyExpiryIsFuture,
  subscriptionUsable,
  denyReason,
  action,
  code,
}) {
  const statusForLog =
    (subscriptionStatus || "").trim().length === 0
      ? "(empty)"
      : (subscriptionStatus || "").trim().toLowerCase();
  logger.info(
    `[SenderSubscriptionGuard] senderUidTail=${senderUidTail} ` +
      `decisionSource=${decisionSource} entitlementUsable=${entitlementUsable ?? "null"} ` +
      `entitlementExpiryIsFuture=${entitlementExpiryIsFuture} ` +
      `subscriptionStatus=${statusForLog} legacyStatusAllowsAccess=${legacyStatusAllowsAccess} ` +
      `legacyExpiryIsFuture=${legacyExpiryIsFuture} subscriptionUsable=${subscriptionUsable} ` +
      `denyReason=${denyReason ?? "none"} action=${action} code=${code}`,
  );
}

function readSecret(secret, envName) {
  try {
    const value = secret.value();
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  } catch (error) {
    // Local syntax checks and non-secret deployments can still use process.env.
  }

  const envValue = process.env[envName];
  return typeof envValue === "string" ? envValue.trim() : "";
}

function normalizePrivateKey(rawPrivateKey) {
  return rawPrivateKey.replace(/\\n/g, "\n");
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecodeJson(value) {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const json = Buffer.from(
    padded.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
  return JSON.parse(json);
}

function createAppStoreServerApiJwt() {
  const issuerId = readSecret(
    APP_STORE_CONNECT_ISSUER_ID,
    "APP_STORE_CONNECT_ISSUER_ID"
  );
  const keyId = readSecret(APP_STORE_CONNECT_KEY_ID, "APP_STORE_CONNECT_KEY_ID");
  const privateKey = normalizePrivateKey(
    readSecret(APP_STORE_CONNECT_PRIVATE_KEY, "APP_STORE_CONNECT_PRIVATE_KEY")
  );

  if (!issuerId || !keyId || !privateKey) {
    throw new HttpsError(
      "failed-precondition",
      "App Store Server API credentials are not configured."
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: nowSeconds,
    exp: nowSeconds + 20 * 60,
    aud: "appstoreconnect-v1",
    bid: APP_STORE_BUNDLE_ID,
  };

  const signingInput = [
    base64UrlEncode(JSON.stringify(header)),
    base64UrlEncode(JSON.stringify(payload)),
  ].join(".");

  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: crypto.createPrivateKey(privateKey),
    dsaEncoding: "ieee-p1363",
  });

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function extractAppStoreTransactionId(data) {
  const candidates = [
    data?.transactionId,
    data?.originalTransactionId,
    data?.purchaseId,
    data?.purchaseID,
    data?.serverVerificationData,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (/^\d{5,}$/.test(value)) {
      return value;
    }
    const parts = value.split(".");
    if (parts.length === 3) {
      try {
        const payload = base64UrlDecodeJson(parts[1]);
        if (typeof payload.transactionId === "string" && /^\d{5,}$/.test(payload.transactionId)) {
          return payload.transactionId;
        }
        if (
          typeof payload.originalTransactionId === "string" &&
          /^\d{5,}$/.test(payload.originalTransactionId)
        ) {
          return payload.originalTransactionId;
        }
      } catch (error) {
        // Not a StoreKit JWS; keep checking the remaining candidates.
      }
    }
  }

  return "";
}

function extractAppStoreEnvironmentHint(data) {
  const candidates = [
    data?.transactionId,
    data?.originalTransactionId,
    data?.purchaseId,
    data?.purchaseID,
    data?.serverVerificationData,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const parts = candidate.trim().split(".");
    if (parts.length !== 3) continue;

    try {
      const payload = base64UrlDecodeJson(parts[1]);
      if (payload.environment === "Sandbox") {
        return "Sandbox";
      }
      if (payload.environment === "Production") {
        return "Production";
      }
    } catch (error) {
      // Not a StoreKit JWS; keep checking the remaining candidates.
    }
  }

  return "";
}

function decodeSignedTransactionInfo(signedTransactionInfo) {
  if (typeof signedTransactionInfo !== "string") {
    throw new Error("MISSING_SIGNED_TRANSACTION_INFO");
  }

  const parts = signedTransactionInfo.split(".");
  if (parts.length !== 3) {
    throw new Error("INVALID_SIGNED_TRANSACTION_INFO");
  }

  return base64UrlDecodeJson(parts[1]);
}

async function fetchAppStoreTransactionInfo(transactionId, environmentHint = "") {
  const jwt = createAppStoreServerApiJwt();
  const path = `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`;
  const defaultEnvironments = [
    { name: "Production", baseUrl: APP_STORE_API_PRODUCTION_BASE_URL },
    { name: "Sandbox", baseUrl: APP_STORE_API_SANDBOX_BASE_URL },
  ];
  const environments =
    environmentHint === "Sandbox"
      ? [defaultEnvironments[1], defaultEnvironments[0]]
      : defaultEnvironments;

  const errors = [];
  for (const environment of environments) {
    const response = await fetch(`${environment.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
    });

    const responseText = await response.text();
    let responseBody = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch (error) {
        responseBody = { raw: responseText.slice(0, 500) };
      }
    }

    if (response.ok && responseBody?.signedTransactionInfo) {
      return {
        environment: environment.name,
        signedTransactionInfo: responseBody.signedTransactionInfo,
        transactionInfo: decodeSignedTransactionInfo(responseBody.signedTransactionInfo),
      };
    }

    const appleErrorCode = responseBody?.errorCode || null;
    errors.push({
      environment: environment.name,
      status: response.status,
      appleErrorCode,
      appleErrorMessage: responseBody?.errorMessage || null,
    });
  }

  const credentialsRejected =
    errors.length === environments.length &&
    errors.every((item) => item.status === 401 || item.status === 403);
  const error = new Error(
    credentialsRejected
      ? "APP_STORE_API_CREDENTIALS_REJECTED"
      : "APP_STORE_TRANSACTION_LOOKUP_FAILED"
  );
  error.lookupErrors = errors;
  error.credentialsRejected = credentialsRejected;
  throw error;
}

function validateAppStoreSubscription(transactionInfo) {
  const now = Date.now();
  const expiresDate = Number(transactionInfo?.expiresDate || 0);
  const productId = transactionInfo?.productId || "";
  const bundleId = transactionInfo?.bundleId || "";
  const revocationDate = Number(transactionInfo?.revocationDate || 0);

  if (bundleId !== APP_STORE_BUNDLE_ID) {
    return { active: false, code: "BUNDLE_ID_MISMATCH", expiresDate };
  }
  if (productId !== APP_STORE_PRODUCT_ID) {
    return { active: false, code: "PRODUCT_ID_MISMATCH", expiresDate };
  }
  if (revocationDate > 0) {
    return { active: false, code: "TRANSACTION_REVOKED", expiresDate };
  }
  if (!Number.isFinite(expiresDate) || expiresDate <= now) {
    return { active: false, code: "SUBSCRIPTION_EXPIRED", expiresDate };
  }

  return { active: true, code: "ACTIVE", expiresDate };
}

function buildAppStoreVerifySecrets() {
  return {
    issuerSecret: APP_STORE_CONNECT_ISSUER_ID,
    keyIdSecret: APP_STORE_CONNECT_KEY_ID,
    privateKeySecret: APP_STORE_CONNECT_PRIVATE_KEY,
  };
}

async function fetchLatestAppStoreSubscriptionState({
  lookupTransactionId,
  environmentHint = "",
}) {
  const apiResult = await fetchAppStoreAllSubscriptionStatuses(
    lookupTransactionId,
    environmentHint,
    buildAppStoreVerifySecrets()
  );
  const meta = {};
  const latestEntry = await pickLatestTransactionEntry(
    apiResult.body,
    (signedInfo) => Promise.resolve(decodeSignedTransactionInfo(signedInfo)),
    {
      activeOnly: true,
      now: Date.now(),
      meta,
    }
  );
  if (!latestEntry?.transactionInfo) {
    return {
      derived: null,
      environment: apiResult.environment,
      transactionInfo: null,
      meta,
    };
  }

  const derived = deriveSubscriptionState(latestEntry.transactionInfo);
  derived.environment =
    latestEntry.transactionInfo?.environment || apiResult.environment || "";
  return {
    derived,
    environment: apiResult.environment,
    transactionInfo: latestEntry.transactionInfo,
    meta,
  };
}

function buildAppStoreVerifyActiveUpdate({
  derived,
  environment,
  transactionInfo,
  lookupTransactionId,
}) {
  const latestTransactionId =
    derived.latestTransactionId ||
    transactionInfo?.transactionId ||
    lookupTransactionId;
  return {
    subscriptionStatus: "active",
    subscriptionProductId: APP_STORE_PRODUCT_ID,
    subscriptionBasePlanId: "",
    subscriptionOfferId: "",
    subscriptionExpiryTime: admin.Timestamp.fromMillis(derived.expiresDate),
    activePurchaseTokens: [latestTransactionId],
    lastSubscriptionSource: "app_store_server_api",
    lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
    subscriptionPlatform: "ios",
    appStoreEnvironment: derived.environment || environment || "",
    appStoreTransactionId: latestTransactionId,
    appStoreOriginalTransactionId: derived.originalTransactionId || "",
    appStoreWebOrderLineItemId: transactionInfo?.webOrderLineItemId || "",
    appStoreValidationCode: derived.validationCode || "ACTIVE",
  };
}

async function writeAppStoreVerifyUserUpdate({
  uid,
  update,
  autoRenewing = null,
  log = console,
  traceId = null,
}) {
  const storeState = buildIosStoreState({
    status: update.subscriptionStatus,
    expiryTime: update.subscriptionExpiryTime || null,
    autoRenewing,
    originalTransactionId: update.appStoreOriginalTransactionId || "",
    transactionId: update.appStoreTransactionId || "",
    environment: update.appStoreEnvironment || "",
    source: "app_store_server_api",
    updatedAt: admin.FieldValue.serverTimestamp(),
  });
  await commitUserSubscriptionDualWrite({
    db: admin.getDb(),
    admin,
    uid,
    source: "apple_verify",
    platform: "ios",
    storeState,
    legacyUpdate: update,
    log,
    meta: {
      eventId: traceId || "",
      transactionId: update.appStoreTransactionId || "",
      originalTransactionId: update.appStoreOriginalTransactionId || "",
    },
  });
}

function buildAppStoreVerifyInactiveUpdate({
  derived,
  environment,
  transactionInfo,
  lookupTransactionId,
  validationCode,
}) {
  const latestTransactionId =
    derived?.latestTransactionId ||
    transactionInfo?.transactionId ||
    lookupTransactionId;
  const code = validationCode || derived?.validationCode || "SUBSCRIPTION_EXPIRED";
  const inactiveUpdate = {
    subscriptionStatus: code === "SUBSCRIPTION_EXPIRED" ? "expired" : "none",
    subscriptionProductId: transactionInfo?.productId || APP_STORE_PRODUCT_ID,
    activePurchaseTokens: [],
    lastSubscriptionSource: "app_store_server_api",
    lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
    appStoreEnvironment:
      derived?.environment || transactionInfo?.environment || environment || "",
    appStoreTransactionId: latestTransactionId,
    appStoreOriginalTransactionId:
      derived?.originalTransactionId ||
      transactionInfo?.originalTransactionId ||
      "",
    appStoreValidationCode: code,
  };
  const expiresDate = Number(
    derived?.expiresDate || transactionInfo?.expiresDate || 0
  );
  if (expiresDate > 0) {
    inactiveUpdate.subscriptionExpiryTime = admin.Timestamp.fromMillis(expiresDate);
  }
  return inactiveUpdate;
}

/* =========================================================
 * プッシュ通知（Android 8+ は channelId 必須。未設定だと Miscellaneous＝サイレントになりやすい）
 * - chats/{chatId}/messages 作成をトリガに
 * - HIGH優先度 + notificationペイロード + android.notification.channelId
 * - チャネル ID はアプリ側 NotificationHelper.NEW_MESSAGE_CHANNEL_ID と同一文字列
 * =======================================================*/
exports.sendPushNotification = onDocumentCreated(
  "chats/{chatId}/messages/{messageId}",
  async (event) => {
    const message = event.data.data();
    const chatId = event.params.chatId;
    const messageId = event.params.messageId;

    // chatId は "uid1_uid2"（UID を辞書順でソートしたもの）
    // senderId からチャットの受信者 UID を特定し、Firestore から最新 FCM トークンを取得する。
    // これにより、連絡先登録後にトークンが更新されても正しく通知が届く。
    const senderId = message.senderId || "";
    const participants = chatId.split("_");
    const recipientId = participants.find((id) => id !== senderId) || "";

    let toToken = message.token || ""; // フォールバック（旧メッセージとの互換性）

    if (recipientId) {
      try {
        const recipientDoc = await admin.getDb().collection("users").doc(recipientId).get();
        const latestToken = recipientDoc.get("fcmToken") || "";
        if (latestToken) {
          toToken = latestToken;
          logger.info("Using latest FCM token from Firestore.", {
            recipientIdSuffix: uidTailForLog(recipientId),
          });
        } else {
          logger.warn("Recipient fcmToken is empty in Firestore; falling back to embedded token.", {
            recipientIdSuffix: uidTailForLog(recipientId),
          });
        }
      } catch (e) {
        logger.warn("Failed to fetch recipient FCM token; falling back to embedded token.", {
          recipientIdSuffix: uidTailForLog(recipientId),
          errorType: e?.constructor?.name || typeof e,
        });
      }
    } else {
      logger.warn("Could not determine recipientId from chatId.", {
        chatIdTail: logIdTailForLog(chatId),
        senderIdSuffix: uidTailForLog(senderId),
      });
    }

    if (!toToken || typeof toToken !== "string") {
      logger.warn("FCM token missing; skip send.", {
        chatIdTail: logIdTailForLog(chatId),
        messageIdTail: logIdTailForLog(messageId),
      });
      return { success: false, reason: "MISSING_TOKEN" };
    }

    let unreadTotal = 1;
    if (recipientId) {
      try {
        unreadTotal = await countUnreadMessagesForRecipient(recipientId);
      } catch (e) {
        logger.warn("[KAMOME_BADGE_V3] Failed to calculate unread total; using fallback.", {
          recipientIdSuffix: uidTailForLog(recipientId),
          chatIdTail: logIdTailForLog(chatId),
          messageIdTail: logIdTailForLog(messageId),
          unreadTotal,
          errorType: e?.constructor?.name || typeof e,
        });
      }
    }
    const badgeCount = unreadTotal;

    // 通知タイトル・本文（必要に応じて整形）
    const title = "新しいメッセージ";
    const body = "新しいメッセージがあります";

    // Admin SDK の send() フォーマット（channelId はアプリの NotificationChannel と一致させる）
    // ルートに notification を含めると FCM が全プラットフォームで「通知」として分類しやすく、
    // 特に iOS クライアントの RemoteMessage.notification の有無に影響する。
    const ANDROID_MESSAGE_CHANNEL_ID = "com.lahainars.tonikaku.new_message_alerts";
    const ANDROID_NOTIFICATION_TAG = "chat_unread_summary";
    const msg = {
      token: toToken,
      notification: {
        title,
        body,
      },
      android: {
        priority: "high",            // ★ Doze中の遅延を抑制
        ttl: 6 * 3600 * 1000,  // ★ 6時間（ミリ秒）

        collapseKey: "chat",         // ★ 連投時は上書き
        notification: {
          channelId: ANDROID_MESSAGE_CHANNEL_ID,
          title,
          body,
          tag: ANDROID_NOTIFICATION_TAG,
          notificationCount: badgeCount,
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
          "apns-push-type": "alert",
        },
        payload: {
          // content-available を付けたデータ＋アラート混在は端末によって優先順位が曖昧になることがあるため、
          // 通常のチャット通知（バナー・音）では aps はアラート中心にする。
          aps: {
            alert: {
              title,
              body,
            },
            sound: "default",
            badge: badgeCount,
          },
        },
      },
      // 既存アプリ側の処理互換のため data は維持
      data: {
        senderId: message.senderId || "",
        senderAccountId: message.senderAccountId || "",
        userName: message.userName || "",
        text: message.text || "",
        chatId: chatId,
        messageId: messageId,
        unreadTotal: String(unreadTotal),
      },
    };

    logger.info("[KAMOME_BADGE_V3] Badge payload prepared.", {
      recipientIdSuffix: uidTailForLog(recipientId),
      unreadTotal,
      iosBadge: msg.apns.payload.aps.badge,
      androidNotificationTag: msg.android.notification.tag,
      androidNotificationCount: msg.android.notification.notificationCount,
      chatIdTail: logIdTailForLog(chatId),
      messageIdTail: logIdTailForLog(messageId),
    });

    logger.info("Attempting to send notification message", {
      chatIdTail: logIdTailForLog(chatId),
      messageIdTail: logIdTailForLog(messageId),
      recipientIdSuffix: uidTailForLog(recipientId),
      ...fcmTokenMetaForLog(toToken),
      collapseKey: msg.android.collapseKey,
      ttlMs: msg.android.ttl,
      priority: msg.android.priority,
      channelId: ANDROID_MESSAGE_CHANNEL_ID,
      androidNotificationTag: msg.android.notification.tag,
    });

    try {
      const response = await admin.getMessagingClient().send(msg);
      logger.info("[KAMOME_BADGE_V3] Notification send success.", {
        recipientIdSuffix: uidTailForLog(recipientId),
        unreadTotal,
        iosBadge: msg.apns.payload.aps.badge,
        androidNotificationTag: msg.android.notification.tag,
        androidNotificationCount: msg.android.notification.notificationCount,
        chatIdTail: logIdTailForLog(chatId),
        messageIdTail: logIdTailForLog(messageId),
      });
      return { success: true };
    } catch (error) {
      logger.error("[KAMOME_BADGE_V3] Notification send failed.", {
        recipientIdSuffix: uidTailForLog(recipientId),
        unreadTotal,
        iosBadge: msg.apns.payload.aps.badge,
        androidNotificationTag: msg.android.notification.tag,
        androidNotificationCount: msg.android.notification.notificationCount,
        chatIdTail: logIdTailForLog(chatId),
        messageIdTail: logIdTailForLog(messageId),
        errorType: error?.constructor?.name || typeof error,
      });
      return { success: false };
    }
  }
);

/* =========================================================
 * 既読後のバッジ更新
 * - メッセージが画面表示され、isRead が false -> true になった時だけ
 * - Firestore の未読正本を再集計し、badge 更新用 push を送る
 * =======================================================*/
// sendBadgeRefreshOnRead は通常通知復旧を優先するため、一旦 export しない。

/* =========================================================
 * 既存機能：古いメッセージ自動削除
 * =======================================================*/
exports.deleteOldMessages = onDocumentCreated(
  "chats/{chatId}/messages/{messageId}",
  async (event) => {
    const chatId = event.params.chatId;
    logger.info(
      `[Auto-Delete] New message in chatTail=${logIdTailForLog(chatId)}. Checking message count.`
    );

    const MESSAGE_LIMIT = CHAT_MESSAGE_LIMIT;
    const messagesRef = admin.getDb().collection("chats").doc(chatId).collection("messages");

    try {
      const currentMessageCount = await getQueryCount(messagesRef);

      logger.info(
        `[Auto-Delete] Current message count in chatTail=${logIdTailForLog(chatId)} is ${currentMessageCount}. Limit is ${MESSAGE_LIMIT}.`
      );

      const messagesToDeleteCount = computeMessagesToDeleteCount(
        currentMessageCount,
        MESSAGE_LIMIT
      );

      if (messagesToDeleteCount > 0) {
        logger.info(
          `[Auto-Delete] Deleting ${messagesToDeleteCount} oldest message(s).`
        );

        const query = messagesRef.orderBy("timestamp", "asc").limit(messagesToDeleteCount);
        const messagesToDeleteSnapshot = await query.get();

        const batch = admin.getDb().batch();
        messagesToDeleteSnapshot.forEach((doc) => {
          batch.delete(doc.ref);
        });

        await batch.commit();
        logger.info(
          `[Auto-Delete] Deleted ${messagesToDeleteSnapshot.size} old message(s) from chatTail=${logIdTailForLog(chatId)}.`
        );
      } else {
        logger.info(`[Auto-Delete] No action needed.`);
      }

      return { success: true };
    } catch (error) {
      logger.error("[Auto-Delete] Error deleting old messages.", {
        chatIdTail: logIdTailForLog(chatId),
        errorType: error?.constructor?.name || typeof error,
      });
      return { success: false };
    }
  }
);

/* =========================================================
 * （参考）旧：送信前ブロック型
 * - 今回のUX方針（送信は即時）と異なるため未使用推奨
 * - 必要なら accessMode 等で分岐して使い分け可
 * =======================================================*/
exports.sendMessageWithLimit = onCall(
  { enforceAppCheck: true, maxInstances: 30 },
  async (request) => {
  const { senderId, recipientId, text, userName, token } = request.data || {};
  if (!senderId || !recipientId || !text) {
    return { success: false, code: "INVALID_REQUEST" };
  }
  if (!request.auth || request.auth.uid !== senderId) {
    logger.warn("sendMessageWithLimit: SENDER_AUTH_MISMATCH", {
      authUidTail: uidTailForLog(request.auth?.uid || ""),
      senderUidTail: uidTailForLog(senderId),
    });
    return { success: false, code: "SENDER_AUTH_MISMATCH" };
  }

  const accessGate = await assertAccessNotBlocked();
  if (accessGate.blocked) {
    return { success: false, code: accessGate.code };
  }

  const { dailyLimit: LIMIT } = await loadAppConfig();

  const contactsSnap = await admin
    .getDb()
    .collection("users")
    .doc(recipientId)
    .collection("contacts")
    .get();

  let recipientAllowsSender = false;
  for (const doc of contactsSnap.docs) {
    const data = doc.data() || {};
    if (recipientContactAcceptsSender(data, senderId)) {
      recipientAllowsSender = true;
      break;
    }
  }
  if (!recipientAllowsSender) {
    logger.warn("sendMessageWithLimit: RECIPIENT_CONTACT_MISSING", {
      recipientUidTail: uidTailForLog(recipientId),
      senderUidTail: uidTailForLog(senderId),
    });
    return { success: false, code: "RECIPIENT_CONTACT_MISSING" };
  }

  const recipientDoc = await admin
    .getDb()
    .collection("users")
    .doc(recipientId)
    .get();
  let recipientData = recipientDoc.exists ? recipientDoc.data() || {} : {};
  let subscriptionStatus = recipientData.subscriptionStatus;
  const subscriptionPlatform = recipientData.subscriptionPlatform;
  const rawExpiry = recipientData.subscriptionExpiryTime;
  const { expiry, parsePath } = parseSubscriptionExpiryTimeWithMeta(rawExpiry);
  const now = new Date();
  let usability = describeAccountAccessUsability(recipientData, now, {
    parseExpiryWithMeta: parseSubscriptionExpiryTimeWithMeta,
  });

  if (!usability.subscriptionUsable) {
    const retryResult = await resolveRecipientSubscriptionWithExpiryLagRetry({
      recipientData,
      usability,
      subscriptionStatus,
      now,
      fetchRecipientData: async () => {
        const retryDoc = await admin
          .getDb()
          .collection("users")
          .doc(recipientId)
          .get();
        return retryDoc.exists ? retryDoc.data() || {} : {};
      },
      describeUsability: describeAccountAccessUsability,
      parseExpiryWithMeta: parseSubscriptionExpiryTimeWithMeta,
      log: (entry) => {
        logger.info(
          `[RecipientSubscriptionGuardRetry] recipientUidTail=${uidTailForLog(recipientId)} ` +
            `event=${entry.event} retryCount=${entry.retryCount ?? 0} ` +
            `entitlementExpiryDeltaMs=${entry.entitlementExpiryDeltaMs ?? "null"} ` +
            (entry.maxRetries != null ? `maxRetries=${entry.maxRetries} ` : "") +
            (entry.retryIntervalMs != null ? `retryIntervalMs=${entry.retryIntervalMs} ` : "") +
            (entry.subscriptionUsable != null
              ? `subscriptionUsable=${entry.subscriptionUsable} `
              : "") +
            (entry.errorType != null ? `errorType=${entry.errorType} ` : ""),
        );
      },
    });
    if (retryResult.retried) {
      recipientData = retryResult.recipientData;
      usability = retryResult.usability;
      subscriptionStatus = recipientData.subscriptionStatus;
    }
  }

  const finalEntitlementExpiryDeltaMs = computeEntitlementExpiryDeltaMs(
    usability.entitlementExpiry,
    new Date(),
  );

  const parsedExpiryISO =
    expiry instanceof Date && !Number.isNaN(expiry.getTime())
      ? expiry.toISOString()
      : "null";
  const nowISO = now.toISOString();
  const deltaMs =
    expiry instanceof Date && !Number.isNaN(expiry.getTime())
      ? expiry.getTime() - now.getTime()
      : "null";
  const guardLogBase = {
    recipientUidTail: uidTailForLog(recipientId),
    decisionSource: usability.decisionSource,
    entitlementUsable: usability.entitlementUsable,
    entitlementExpiryIsFuture: usability.entitlementExpiryIsFuture,
    subscriptionStatus,
    subscriptionPlatform,
    rawExpiryType: rawExpiryTypeForLog(rawExpiry),
    rawExpiryPreview: previewExpiryRawForLog(rawExpiry),
    parsePath,
    expiry,
    parsedExpiryISO,
    nowISO,
    deltaMs,
    entitlementExpiryDeltaMs: finalEntitlementExpiryDeltaMs,
    statusAllowsAccess: usability.legacyStatusAllowsAccess,
    expiryIsFuture: usability.legacyExpiryIsFuture,
    isSubscriptionUsable: usability.subscriptionUsable,
    denyReason: usability.denyReason,
  };

  if (usability.subscriptionUsable) {
    logRecipientSubscriptionGuard({
      ...guardLogBase,
      action: "allowSend",
    });
  } else {
    logRecipientSubscriptionGuard({
      ...guardLogBase,
      action: "blockSend",
    });
    logger.info(
      `[sendMessageWithLimit] subscriptionGuardBlocked senderUidTail=${uidTailForLog(senderId)} ` +
        `recipientUidTail=${uidTailForLog(recipientId)} guardType=RecipientSubscriptionGuard ` +
        `returnedCode=${RECIPIENT_SUBSCRIPTION_UNAVAILABLE} action=blockSend ` +
        `entitlementExpiryDeltaMs=${finalEntitlementExpiryDeltaMs ?? "null"}`,
    );
    return { success: false, code: RECIPIENT_SUBSCRIPTION_UNAVAILABLE };
  }

  const today = getJstDateKey(new Date());
  const userRef = admin.getDb().collection("users").doc(senderId);
  let senderSubscriptionBlocked = false;

  try {
    await admin.getDb().runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      let dailyCount = 0;
      let lastSentDate = today;

      if (userDoc.exists) {
        const senderData = userDoc.data() || {};
        const senderSubscriptionStatus = senderData.subscriptionStatus;
        const senderUsability = describeAccountAccessUsability(senderData, new Date(), {
          parseExpiryWithMeta: parseSubscriptionExpiryTimeWithMeta,
        });
        if (!senderUsability.subscriptionUsable) {
          logSenderSubscriptionGuard({
            senderUidTail: uidTailForLog(senderId),
            decisionSource: senderUsability.decisionSource,
            entitlementUsable: senderUsability.entitlementUsable,
            entitlementExpiryIsFuture: senderUsability.entitlementExpiryIsFuture,
            subscriptionStatus: senderSubscriptionStatus,
            legacyStatusAllowsAccess: senderUsability.legacyStatusAllowsAccess,
            legacyExpiryIsFuture: senderUsability.legacyExpiryIsFuture,
            subscriptionUsable: senderUsability.subscriptionUsable,
            denyReason: senderUsability.denyReason,
            action: "blockSend",
            code: SENDER_SUBSCRIPTION_UNAVAILABLE,
          });
          senderSubscriptionBlocked = true;
          return;
        }

        dailyCount = userDoc.get("dailyCount") || 0;
        lastSentDate = userDoc.get("lastSentDate") || today;
        if (lastSentDate !== today) {
          dailyCount = 0;
          lastSentDate = today;
        }
      } else {
        throw new Error("SENDER_DOCUMENT_NOT_FOUND");
      }

      if (dailyCount >= LIMIT) {
        logger.warn("sendMessageWithLimit: DAILY_LIMIT_EXCEEDED", {
          senderUidTail: uidTailForLog(senderId),
          dailyCount,
          limit: LIMIT,
          dateKey: today,
        });
        const err = new Error("DAILY_LIMIT_EXCEEDED");
        err.limit = LIMIT;
        throw err;
      }

      const senderAccountId = userDoc.get("accountId");
      if (!senderAccountId) {
        throw new Error("SENDER_MISSING_ACCOUNT_ID");
      }

      // 送信カウント更新
      transaction.set(
        userRef,
        { dailyCount: dailyCount + 1, lastSentDate: today },
        { merge: true }
      );

      const chatRoomId = [senderId, recipientId].sort().join("_");
      const chatRef = admin.getDb().collection("chats").doc(chatRoomId);

      transaction.set(
        chatRef,
        { participants: admin.FieldValue.arrayUnion(senderId, recipientId) },
        { merge: true }
      );

      const msgRef = chatRef.collection("messages").doc();
      const messageData = {
        senderId: senderId,
        recipientId: recipientId,
        senderAccountId: senderAccountId,
        text,
        timestamp: admin.FieldValue.serverTimestamp(),
        isRead: false,
        userName: userName || "名無し",
        token: token || "",
      };
      transaction.set(msgRef, messageData);
    });

    if (senderSubscriptionBlocked) {
      logger.info(
        `[sendMessageWithLimit] subscriptionGuardBlocked senderUidTail=${uidTailForLog(senderId)} ` +
          `recipientUidTail=${uidTailForLog(recipientId)} guardType=SenderSubscriptionGuard ` +
          `returnedCode=${SENDER_SUBSCRIPTION_UNAVAILABLE} action=blockSend`,
      );
      return { success: false, code: SENDER_SUBSCRIPTION_UNAVAILABLE };
    }

    return { success: true };
  } catch (error) {
    const code =
      (error && typeof error.message === "string" && error.message) || "UNKNOWN";
    const extra = {};
    if (code === "DAILY_LIMIT_EXCEEDED" && typeof error.limit === "number") {
      extra.limit = error.limit;
    }
    logger.error("sendMessageWithLimit failed:", {
      code,
      ...extra,
      errorType: error?.constructor?.name || typeof error,
    });
    return { success: false, code, ...extra };
  }
});

/* =========================================================
 * アカウント削除
 *
 * - 本人の Auth UID だけを対象にする。
 * - 利用規約同意記録は、紛争対応等に必要な期間の証跡として残す。
 * - 課金サーバー通知を安全に受け続けるため、購入識別子だけを持つ匿名 tombstone を残す。
 * - 相手のメッセージは消さず、削除する本人が送った本文だけを消す。
 * =======================================================*/
const ACCOUNT_DELETION_BATCH_SIZE = 400;

async function deleteDocumentsInBatches(queryFactory) {
  const db = admin.getDb();
  let deletedCount = 0;

  while (true) {
    const snapshot = await queryFactory()
      .limit(ACCOUNT_DELETION_BATCH_SIZE)
      .get();
    if (snapshot.empty) {
      return deletedCount;
    }

    const batch = db.batch();
    for (const doc of snapshot.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    deletedCount += snapshot.size;
  }
}

async function assertAccountDeletionPrerequisites({ db, userRef, uid, accountId }) {
  await userRef.collection("contacts").limit(1).get();
  await db.collectionGroup("contacts").where("stableId", "==", uid).limit(1).get();
  if (accountId) {
    await db.collectionGroup("contacts").where("partnerId", "==", accountId).limit(1).get();
  }
  await db.collectionGroup("messages").where("senderId", "==", uid).limit(1).get();
  await admin.getAuthClient().getUser(uid);
}

function accountDeletionBillingTombstone(userData) {
  const tombstone = {
    accountDeletionState: "deleted",
    accountDeletedAt: admin.FieldValue.serverTimestamp(),
  };
  const retainedBillingFields = [
    "activePurchaseTokens",
    "appStoreAppAccountToken",
    "appStoreOriginalTransactionId",
    "appStoreTransactionId",
    "googlePlayPrimaryPurchaseToken",
    "subscriptions",
  ];

  for (const field of retainedBillingFields) {
    if (userData[field] !== undefined) {
      tombstone[field] = userData[field];
    }
  }
  return tombstone;
}

exports.deleteMyAccount = onCall(
  { region: "us-central1", enforceAppCheck: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const uid = request.auth.uid;
    const db = admin.getDb();
    const userRef = db.collection("users").doc(uid);

    try {
      const userSnapshot = await userRef.get();
      const userData = userSnapshot.data() || {};
      const accountId =
        typeof userData.accountId === "string" ? userData.accountId.trim() : "";

      await assertAccountDeletionPrerequisites({ db, userRef, uid, accountId });

      const ownContactsDeleted = await deleteDocumentsInBatches(() =>
        userRef.collection("contacts")
      );
      const linkedContactsDeleted = await deleteDocumentsInBatches(() =>
        db.collectionGroup("contacts").where("stableId", "==", uid)
      );
      const legacyLinkedContactsDeleted = accountId
        ? await deleteDocumentsInBatches(() =>
            db.collectionGroup("contacts").where("partnerId", "==", accountId)
          )
        : 0;
      const sentMessagesDeleted = await deleteDocumentsInBatches(() =>
        db.collectionGroup("messages").where("senderId", "==", uid)
      );

      // set() を merge なしで行い、メール・カモメID・通知トークン・利用状況など
      // 既存の個人データをまとめて落とす。購入識別子だけは外部課金通知の照合用に残す。
      await userRef.set(accountDeletionBillingTombstone(userData));
      await admin.getAuthClient().deleteUser(uid);

      logger.info("Account deletion completed.", {
        uidSuffix: uidTailForLog(uid),
        ownContactsDeleted,
        linkedContactsDeleted,
        legacyLinkedContactsDeleted,
        sentMessagesDeleted,
      });
      return { success: true };
    } catch (error) {
      logger.error("Account deletion failed.", {
        uidSuffix: uidTailForLog(uid),
        errorType: error?.constructor?.name || typeof error,
      });
      throw new HttpsError("internal", "Failed to delete account.");
    }
  }
);

/* =========================================================
 * 既存機能：メール保存 + accountId の補完
 * =======================================================*/
exports.upsertUserEmailAndAccount = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const uid = request.auth.uid;
  const { email } = request.data || {};

  if (typeof email !== "string" || email.length === 0) {
    throw new HttpsError("invalid-argument", "Parameter 'email' is required.");
  }

  const userRef = admin.getDb().collection("users").doc(uid);

  try {
    const snap = await userRef.get();
    const resolved = await resolveAccountIdForUpsert({
      db: admin.getDb(),
      excludeUid: uid,
      userSnap: snap,
      randomUUID,
    });
    if (!resolved.accountId) {
      logger.error("upsertUserEmailAndAccount: unique accountId generation failed.", {
        uidSuffix: uidTailForLog(uid),
        attempts: resolved.attempts,
      });
      throw new HttpsError("internal", "Failed to assign accountId.");
    }

    const accountIdToUse = resolved.accountId;
    const update = {
      email,
      accountId: accountIdToUse,
      updatedAt: admin.FieldValue.serverTimestamp(),
    };

    await userRef.set(update, { merge: true });

    logger.info("upsertUserEmailAndAccount succeeded.", {
      uidSuffix: uidTailForLog(uid),
      accountIdSuffix: billingTokenSuffix(accountIdToUse),
      accountIdSource: resolved.source,
      generationAttempts: resolved.attempts,
    });
    return { success: true, accountId: accountIdToUse };
  } catch (error) {
    logger.error("upsertUserEmailAndAccount failed.", {
      uidSuffix: uidTailForLog(uid),
      errorType: error?.constructor?.name || typeof error,
    });
    throw new HttpsError("internal", "Failed to upsert user email/accountId.");
  }
});

/* =========================================================
 * 既存機能：accountIdからユーザー情報を安全に取得する
 * =======================================================*/
exports.getUserInfoByAccountId = onCall({ enforceAppCheck: true }, async (request) => {
  let callerUid = request.auth?.uid || null;
  if (!callerUid) {
    const fallbackIdToken =
      typeof request.data?.idToken === "string" ? request.data.idToken : "";
    if (fallbackIdToken) {
      try {
        const decoded = await admin.getAuthClient().verifyIdToken(fallbackIdToken);
        callerUid = decoded.uid || null;
        logger.warn(
          "getUserInfoByAccountId: request.auth missing; verified fallback idToken.",
          { uidSuffix: uidTailForLog(callerUid || "") }
        );
      } catch (error) {
        logger.warn("getUserInfoByAccountId: fallback idToken verification failed.", {
          errorType: error?.constructor?.name || typeof error,
        });
      }
    }
  }

  if (!callerUid) {
    logger.warn("getUserInfoByAccountId: unauthenticated request.", {
      hasRequestAuth: !!request.auth,
      hasFallbackIdToken:
        typeof request.data?.idToken === "string" && request.data.idToken.length > 0,
    });
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }

  const { accountId } = request.data || {};
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new HttpsError("invalid-argument", "Parameter 'accountId' is required.");
  }

  const normalizedAccountId = accountId.trim();

  try {
    const querySnapshot = await admin.getDb()
      .collection("users")
      .where("accountId", "==", normalizedAccountId)
      .limit(2)
      .get();

    const lookup = resolveGetUserInfoByAccountIdLookup(querySnapshot.docs);

    if (lookup.status === "not_found") {
      logger.warn("getUserInfoByAccountId: user not found.", {
        accountIdSuffix: billingTokenSuffix(normalizedAccountId),
        callerUidSuffix: uidTailForLog(callerUid),
      });
      return { uid: null };
    }

    if (lookup.status === "duplicate") {
      logger.error("getUserInfoByAccountId: ACCOUNT_ID_DUPLICATE.", {
        accountIdSuffix: billingTokenSuffix(normalizedAccountId),
        callerUidSuffix: uidTailForLog(callerUid),
        matchCount: lookup.matchCount,
      });
      throw new HttpsError("failed-precondition", "ACCOUNT_ID_DUPLICATE");
    }

    logger.info("getUserInfoByAccountId: user found.", {
      accountIdSuffix: billingTokenSuffix(normalizedAccountId),
      callerUidSuffix: uidTailForLog(callerUid),
      matchedUidSuffix: uidTailForLog(lookup.uid),
    });
    return { uid: lookup.uid };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    logger.error("getUserInfoByAccountId failed.", {
      accountIdSuffix: billingTokenSuffix(normalizedAccountId),
      callerUidSuffix: uidTailForLog(callerUid),
      errorType: error?.constructor?.name || typeof error,
    });
    throw new HttpsError("internal", "Failed to retrieve user information.");
  }
});

/* =========================================================
 * Subscription: Google Play subscription purchase verifier
 *  - 本番Firebaseに存在するAndroid課金関数を正本リポジトリへ復元。
 * =======================================================*/
exports.verifyGooglePlaySubscriptionPurchase = onCall(
  { region: "us-central1", enforceAppCheck: true },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    const logUidSuffix = uidTailForLog(uid || "");
    console.info(`${GOOGLE_PLAY_BILLING_TRACE} function called`, {
      hasAuth: Boolean(request.auth),
      uidSuffix: logUidSuffix,
    });
    if (!uid) {
      console.warn(`${GOOGLE_PLAY_BILLING_TRACE} function unauthenticated`, {
        hasAuth: Boolean(request.auth),
      });
      throw new HttpsError("unauthenticated", "Sign-in is required.");
    }

    await assertPurchasingPlatformAllowed(uid, "android");

    const data = request.data || {};
    const productId = String(data.productId || "").trim();
    const purchaseToken = String(data.purchaseToken || "").trim();
    const packageName = String(data.packageName || GOOGLE_PLAY_PACKAGE_NAME).trim();
    const source = String(data.source || "google_play_purchase").trim();
    console.info(`${GOOGLE_PLAY_BILLING_TRACE} function payload`, {
      uidSuffix: logUidSuffix,
      productId,
      packageName,
      source,
      hasPurchaseToken: Boolean(purchaseToken),
      tokenSuffix: tokenSuffix(purchaseToken),
    });

    if (packageName !== GOOGLE_PLAY_PACKAGE_NAME) {
      console.warn(`${GOOGLE_PLAY_BILLING_TRACE} function invalid packageName`, {
        uidSuffix: logUidSuffix,
        packageName,
        expectedPackageName: GOOGLE_PLAY_PACKAGE_NAME,
      });
      throw new HttpsError("invalid-argument", "Unexpected package name.");
    }
    if (productId !== GOOGLE_PLAY_MONTHLY_PRODUCT_ID) {
      console.warn(`${GOOGLE_PLAY_BILLING_TRACE} function invalid productId`, {
        uidSuffix: logUidSuffix,
        productId,
        expectedProductId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
      });
      throw new HttpsError("invalid-argument", "Unexpected product ID.");
    }
    if (!purchaseToken) {
      console.warn(`${GOOGLE_PLAY_BILLING_TRACE} function missing purchaseToken`, {
        uidSuffix: logUidSuffix,
        productId,
        packageName,
      });
      throw new HttpsError("invalid-argument", "purchaseToken is required.");
    }

    console.info(`${GOOGLE_PLAY_BILLING_TRACE} google play api auth start`, {
      uidSuffix: logUidSuffix,
      productId,
      packageName,
      tokenSuffix: tokenSuffix(purchaseToken),
    });
    const auth = await google.auth.getClient({
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
    const androidpublisher = google.androidpublisher({
      version: "v3",
      auth,
    });

    let subscription;
    try {
      console.info(`${GOOGLE_PLAY_BILLING_TRACE} google play api call start`, {
        uidSuffix: logUidSuffix,
        productId,
        packageName,
        tokenSuffix: tokenSuffix(purchaseToken),
      });
      const response = await androidpublisher.purchases.subscriptionsv2.get({
        packageName,
        token: purchaseToken,
      });
      subscription = response.data;
      console.info(`${GOOGLE_PLAY_BILLING_TRACE} google play api call success`, {
        uidSuffix: logUidSuffix,
        productId,
        packageName,
        tokenSuffix: tokenSuffix(purchaseToken),
        subscriptionState: subscription.subscriptionState || "",
      });
    } catch (error) {
      console.error(`${GOOGLE_PLAY_BILLING_TRACE} google play api call failed`, {
        uidSuffix: logUidSuffix,
        productId,
        packageName,
        tokenSuffix: tokenSuffix(purchaseToken),
        errorType: error?.constructor?.name || typeof error,
      });
      throw new HttpsError(
        "failed-precondition",
        "Could not verify Google Play purchase.",
      );
    }

    const lineItems = Array.isArray(subscription.lineItems)
      ? subscription.lineItems
      : [];
    const matchedLineItem = lineItems.find(
      (item) => item.productId === GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
    );
    const subscriptionState = subscription.subscriptionState || "";
    const isActive =
      GOOGLE_PLAY_ACTIVE_STATES.has(subscriptionState) &&
      matchedLineItem !== undefined;
    console.info(`${GOOGLE_PLAY_BILLING_TRACE} google play verification result`, {
      uidSuffix: logUidSuffix,
      productId,
      packageName,
      tokenSuffix: tokenSuffix(purchaseToken),
      subscriptionState,
      matchedProduct: Boolean(matchedLineItem),
      isActive,
    });

    if (!isActive) {
      throw new HttpsError(
        "failed-precondition",
        "Google Play subscription is not active.",
      );
    }

    const expiryTime =
      matchedLineItem && matchedLineItem.expiryTime
        ? matchedLineItem.expiryTime
        : null;
    const now = admin.FieldValue.serverTimestamp();

    try {
      await assertSubscriptionNotLinkedToOtherUser(admin.getDb(), {
        uid,
        platform: "android",
        identifiers: { purchaseToken },
        log: console,
      });
      const linkedPurchaseToken = String(subscription.linkedPurchaseToken || "").trim();
      await claimAndroidSubscriptionOwnership(admin.getDb(), admin, {
        uid,
        purchaseToken,
        linkedPurchaseToken,
        productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        log: console,
      });

      console.info(`${GOOGLE_PLAY_BILLING_TRACE} firestore users update start`, {
        uidSuffix: logUidSuffix,
        productId,
        packageName,
        tokenSuffix: tokenSuffix(purchaseToken),
        expiryTime,
      });
      const legacyUpdate = {
        subscriptionStatus: "active",
        subscriptionProductId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
        subscriptionExpiryTime: expiryTime,
        subscriptionPlatform: "android",
        activePurchaseTokens: admin.FieldValue.arrayUnion(purchaseToken),
        googlePlayPrimaryPurchaseToken: purchaseToken,
        lastSubscriptionSource: source,
        lastSubscriptionCheckedAt: now,
        updatedAt: now,
        googlePlaySubscriptionState: subscriptionState,
      };
      const storeState = buildAndroidStoreState({
        status: "active",
        expiryTime,
        autoRenewing: inferAndroidAutoRenewing({
          status: "active",
          subscriptionState,
        }),
        primaryPurchaseToken: purchaseToken,
        subscriptionState,
        source: source || "google_play_purchase",
        updatedAt: now,
      });
      await commitUserSubscriptionDualWrite({
        db: admin.getDb(),
        admin,
        uid,
        source: "google_verify",
        platform: "android",
        storeState,
        legacyUpdate,
        log: console,
        meta: {
          purchaseToken,
        },
      });
      console.info(`${GOOGLE_PLAY_BILLING_TRACE} firestore users update success`, {
        uidSuffix: logUidSuffix,
        productId,
        packageName,
        tokenSuffix: tokenSuffix(purchaseToken),
      });
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }
      console.error(`${GOOGLE_PLAY_BILLING_TRACE} firestore users update failed`, {
        uidSuffix: logUidSuffix,
        productId,
        packageName,
        tokenSuffix: tokenSuffix(purchaseToken),
        errorType: error?.constructor?.name || typeof error,
      });
      throw new HttpsError(
        "internal",
        "Could not update subscription status.",
      );
    }

    console.info(`${GOOGLE_PLAY_BILLING_TRACE} function success`, {
      uidSuffix: logUidSuffix,
      productId,
      packageName,
      tokenSuffix: tokenSuffix(purchaseToken),
      expiryTime,
    });

    return {
      ok: true,
      subscriptionStatus: "active",
      productId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
      expiryTime,
    };
  },
);

/* =========================================================
 * Subscription: App Store Server API purchase verifier
 *  - iOS購入後、クライアントから transactionId / purchaseId を受け取り、
 *    Appleの正式APIで取引情報を取得して有効なサブスクだけ active にする。
 * =======================================================*/
exports.verifyAppStoreSubscriptionPurchase = onCall(
  {
    enforceAppCheck: true,
    secrets: [
      APP_STORE_CONNECT_ISSUER_ID,
      APP_STORE_CONNECT_KEY_ID,
      APP_STORE_CONNECT_PRIVATE_KEY,
    ],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const uid = request.auth.uid;
    const logUidSuffix = uidTailForLog(uid);
    const data = request.data || {};
    const traceId = extractBillingTraceId(data);
    const finalLog = createBillingFinalLogger(logger, {
      traceId,
      uid,
      functionName: "verifyAppStoreSubscriptionPurchase",
    });
    const ownershipLog = finalLog.asOwnershipLog();
    const transactionId = extractAppStoreTransactionId(data);
    const environmentHint = extractAppStoreEnvironmentHint(data);
    const serverVerificationData = String(data.serverVerificationData || "").trim();

    finalLog.info("verify.enter", {
      source: data.source || null,
      platform: data.platform || null,
      productId: data.productId || null,
      payloadKeys: payloadKeys(data),
      hasServerVerificationData: serverVerificationData.length > 0,
      serverVerificationDataLength: serverVerificationData.length,
      serverVerificationDataSuffix: billingTokenSuffix(serverVerificationData),
      dataTransactionIdSuffix: billingTokenSuffix(data.transactionId),
      extractedTransactionIdSuffix: billingTokenSuffix(transactionId),
      environmentHint: environmentHint || null,
    });

    await assertPurchasingPlatformAllowed(uid, "ios", traceId);

    if (!transactionId) {
      finalLog.reject("verify.missing_transaction_id", {
        hasServerVerificationData: serverVerificationData.length > 0,
      });
      logger.warn("verifyAppStoreSubscriptionPurchase: missing transaction id.", {
        uidSuffix: logUidSuffix,
        billingTraceId: traceId,
        hasServerVerificationData: serverVerificationData.length > 0,
      });
      throw new HttpsError(
        "invalid-argument",
        "A valid App Store transactionId is required. Pass PurchaseDetails.purchaseID or transactionId from Flutter."
      );
    }

    try {
      finalLog.info("verify.apple_api.start", {
        lookupTransactionIdSuffix: billingTokenSuffix(transactionId),
        environmentHint: environmentHint || null,
      });
      const result = await fetchAppStoreTransactionInfo(
        transactionId,
        environmentHint
      );
      finalLog.info("verify.apple_api.success", {
        environment: result.environment,
        transactionInfo: summarizeTransactionInfo(result.transactionInfo),
      });
      const validation = validateAppStoreSubscription(result.transactionInfo);

      if (!validation.active) {
        finalLog.warn("verify.inactive_transaction", {
          transactionIdSuffix: billingTokenSuffix(transactionId),
          environment: result.environment,
          validationCode: validation.code,
          transactionInfo: summarizeTransactionInfo(result.transactionInfo),
        });
        logger.warn("verifyAppStoreSubscriptionPurchase: inactive transaction.", {
          uidSuffix: logUidSuffix,
          billingTraceId: traceId,
          transactionIdSuffix: billingTokenSuffix(transactionId),
          environment: result.environment,
          code: validation.code,
          productId: result.transactionInfo?.productId || null,
          bundleId: result.transactionInfo?.bundleId || null,
          expiresDate: result.transactionInfo?.expiresDate || null,
          revocationDate: result.transactionInfo?.revocationDate || null,
          originalTransactionIdSuffix: billingTokenSuffix(
            result.transactionInfo?.originalTransactionId
          ),
        });

        if (validation.code === "SUBSCRIPTION_EXPIRED") {
          const lookupTransactionId =
            result.transactionInfo?.originalTransactionId || transactionId;
          finalLog.info("verify.latest_fallback.start", {
            lookupTransactionIdSuffix: billingTokenSuffix(lookupTransactionId),
            reason: validation.code,
          });
          try {
            const latest = await fetchLatestAppStoreSubscriptionState({
              lookupTransactionId,
              environmentHint: environmentHint || result.environment,
            });
            finalLog.info("verify.latest_fallback.result", {
              lookupTransactionIdSuffix: billingTokenSuffix(lookupTransactionId),
              latestStatus: latest?.derived?.status || null,
              latestTransactionIdSuffix: billingTokenSuffix(
                latest?.derived?.latestTransactionId
              ),
              latestOriginalTransactionIdSuffix: billingTokenSuffix(
                latest?.derived?.originalTransactionId
              ),
              latestExpiresDate: latest?.derived?.expiresDate || null,
              latestValidationCode: latest?.derived?.validationCode || null,
              latestCandidateCount: latest?.meta?.latestCandidateCount ?? 0,
              activeCandidateCount: latest?.meta?.activeCandidateCount ?? 0,
              adoptedTransactionIdSuffix: billingTokenSuffix(
                latest?.meta?.adoptedTransactionId
              ),
              latestTransactionInfo: summarizeTransactionInfo(
                latest?.transactionInfo
              ),
            });
            if (latest?.derived?.status === "active") {
              const update = buildAppStoreVerifyActiveUpdate({
                derived: latest.derived,
                environment: latest.environment,
                transactionInfo: latest.transactionInfo,
                lookupTransactionId,
              });
              await assertSubscriptionNotLinkedToOtherUser(admin.getDb(), {
                uid,
                platform: "ios",
                identifiers: ownershipIdentifiersFromAppStoreUpdate(update),
                log: ownershipLog,
                traceId,
              });
              await claimIosSubscriptionOwnership(admin.getDb(), admin, {
                uid,
                update,
                transactionInfo: latest.transactionInfo,
                productId: APP_STORE_PRODUCT_ID,
                log: ownershipLog,
                traceId,
              });
              finalLog.info("verify.users_update.start", {
                updateKeys: Object.keys(update).sort(),
                subscriptionStatus: update.subscriptionStatus || null,
                appStoreTransactionIdSuffix: billingTokenSuffix(
                  update.appStoreTransactionId
                ),
                appStoreOriginalTransactionIdSuffix: billingTokenSuffix(
                  update.appStoreOriginalTransactionId
                ),
              });
              await writeAppStoreVerifyUserUpdate({
                uid,
                update,
                autoRenewing: null,
                log: logger,
                traceId,
              });
              finalLog.success("verify.exit", {
                path: "latest_fallback_active",
                transactionIdSuffix: billingTokenSuffix(transactionId),
                lookupTransactionIdSuffix: billingTokenSuffix(lookupTransactionId),
                latestTransactionIdSuffix: billingTokenSuffix(
                  update.appStoreTransactionId
                ),
                originalTransactionIdSuffix: billingTokenSuffix(
                  update.appStoreOriginalTransactionId
                ),
                environment: update.appStoreEnvironment,
                expiresDate: latest.derived.expiresDate,
              });
              logger.info(
                "verifyAppStoreSubscriptionPurchase succeeded via latest subscription status.",
                {
                  uidSuffix: logUidSuffix,
                  transactionIdSuffix: billingTokenSuffix(transactionId),
                  lookupTransactionIdSuffix: billingTokenSuffix(lookupTransactionId),
                  latestTransactionIdSuffix: billingTokenSuffix(
                    update.appStoreTransactionId
                  ),
                  environment: update.appStoreEnvironment,
                  expiresDate: latest.derived.expiresDate,
                }
              );
              return {
                success: true,
                subscriptionStatus: "active",
                productId: APP_STORE_PRODUCT_ID,
                expiresDateMillis: latest.derived.expiresDate,
                environment: update.appStoreEnvironment,
              };
            }
            const fallbackExpiresDate =
              latest?.derived?.expiresDate ||
              result.transactionInfo?.expiresDate ||
              null;
            finalLog.reject("verify.latest_fallback.no_active_entitlement", {
              transactionIdSuffix: billingTokenSuffix(transactionId),
              originalTransactionIdSuffix: billingTokenSuffix(
                result.transactionInfo?.originalTransactionId || lookupTransactionId
              ),
              expiresDate: fallbackExpiresDate,
              latestCandidateCount: latest?.meta?.latestCandidateCount ?? 0,
              activeCandidateCount: latest?.meta?.activeCandidateCount ?? 0,
              adoptedTransactionIdSuffix: billingTokenSuffix(
                latest?.meta?.adoptedTransactionId
              ),
              rejectCode: "NO_ACTIVE_ENTITLEMENT",
              billingTraceId: traceId || null,
            });
            logger.warn(
              "verifyAppStoreSubscriptionPurchase: no active entitlement in latest subscription status.",
              {
                uidSuffix: logUidSuffix,
                billingTraceId: traceId,
                transactionIdSuffix: billingTokenSuffix(transactionId),
                lookupTransactionIdSuffix: billingTokenSuffix(lookupTransactionId),
                latestCandidateCount: latest?.meta?.latestCandidateCount ?? 0,
                activeCandidateCount: latest?.meta?.activeCandidateCount ?? 0,
                expiresDate: fallbackExpiresDate,
                rejectCode: "NO_ACTIVE_ENTITLEMENT",
              }
            );
            throw new HttpsError(
              "failed-precondition",
              "App Store subscription is not active: SUBSCRIPTION_EXPIRED",
              {
                code: "NO_ACTIVE_ENTITLEMENT",
                rejectCode: "NO_ACTIVE_ENTITLEMENT",
                billingTraceId: traceId || null,
                transactionId,
                originalTransactionId:
                  result.transactionInfo?.originalTransactionId ||
                  lookupTransactionId,
                expiresDate: fallbackExpiresDate,
              }
            );
          } catch (fallbackError) {
            if (fallbackError instanceof HttpsError) {
              throw fallbackError;
            }
            logger.warn(
              "verifyAppStoreSubscriptionPurchase: latest subscription fallback failed.",
              {
                uidSuffix: logUidSuffix,
                transactionIdSuffix: billingTokenSuffix(transactionId),
                lookupTransactionIdSuffix: billingTokenSuffix(lookupTransactionId),
                message: fallbackError?.message || null,
              }
            );
          }
        }

        const inactiveUpdate = buildAppStoreVerifyInactiveUpdate({
          derived: null,
          environment: result.environment,
          transactionInfo: result.transactionInfo,
          lookupTransactionId: transactionId,
          validationCode: validation.code,
        });

        await writeAppStoreVerifyUserUpdate({
          uid,
          update: inactiveUpdate,
          autoRenewing: false,
          log: logger,
          traceId,
        });

        throw new HttpsError(
          "failed-precondition",
          `App Store subscription is not active: ${validation.code}`
        );
      }

      const update = buildAppStoreVerifyActiveUpdate({
        derived: {
          latestTransactionId:
            result.transactionInfo?.transactionId || transactionId,
          originalTransactionId: result.transactionInfo?.originalTransactionId || "",
          expiresDate: validation.expiresDate,
          validationCode: validation.code,
          environment: result.transactionInfo?.environment || result.environment,
        },
        environment: result.environment,
        transactionInfo: result.transactionInfo,
        lookupTransactionId: transactionId,
      });

      await assertSubscriptionNotLinkedToOtherUser(admin.getDb(), {
        uid,
        platform: "ios",
        identifiers: ownershipIdentifiersFromAppStoreUpdate(update),
        log: ownershipLog,
        traceId,
      });
      await claimIosSubscriptionOwnership(admin.getDb(), admin, {
        uid,
        update,
        transactionInfo: result.transactionInfo,
        productId: APP_STORE_PRODUCT_ID,
        log: ownershipLog,
        traceId,
      });

      finalLog.info("verify.users_update.start", {
        updateKeys: Object.keys(update).sort(),
        subscriptionStatus: update.subscriptionStatus || null,
        appStoreTransactionIdSuffix: billingTokenSuffix(update.appStoreTransactionId),
        appStoreOriginalTransactionIdSuffix: billingTokenSuffix(
          update.appStoreOriginalTransactionId
        ),
      });
      await writeAppStoreVerifyUserUpdate({
        uid,
        update,
        autoRenewing: null,
        log: logger,
        traceId,
      });
      finalLog.success("verify.exit", {
        path: "active_transaction",
        transactionIdSuffix: billingTokenSuffix(transactionId),
        originalTransactionIdSuffix: billingTokenSuffix(
          update.appStoreOriginalTransactionId
        ),
        environment: update.appStoreEnvironment,
        expiresDate: validation.expiresDate,
      });

      logger.info("verifyAppStoreSubscriptionPurchase succeeded.", {
        uidSuffix: logUidSuffix,
        billingTraceId: traceId,
        transactionIdSuffix: billingTokenSuffix(transactionId),
        originalTransactionIdSuffix: billingTokenSuffix(
          update.appStoreOriginalTransactionId
        ),
        environment: update.appStoreEnvironment,
        expiresDate: validation.expiresDate,
      });

      return {
        success: true,
        subscriptionStatus: "active",
        productId: APP_STORE_PRODUCT_ID,
        expiresDateMillis: validation.expiresDate,
        environment: update.appStoreEnvironment,
      };
    } catch (error) {
      if (error instanceof HttpsError) {
        finalLog.reject("verify.exit", {
          ...summarizeHttpsError(error),
          transactionIdSuffix: billingTokenSuffix(transactionId),
        });
        throw error;
      }

      finalLog.error("verify.unexpected_error", {
        transactionIdSuffix: billingTokenSuffix(transactionId),
        credentialsRejected: error.credentialsRejected || false,
        lookupErrors: error.lookupErrors || null,
        errorType: error?.constructor?.name || typeof error,
      });
      logger.error("verifyAppStoreSubscriptionPurchase failed.", {
        uidSuffix: logUidSuffix,
        billingTraceId: traceId,
        transactionIdSuffix: billingTokenSuffix(transactionId),
        environmentHint: environmentHint || null,
        credentialsRejected: error.credentialsRejected || false,
        lookupErrors: error.lookupErrors || null,
        errorType: error?.constructor?.name || typeof error,
      });
      throw new HttpsError(
        "internal",
        "Failed to verify App Store subscription purchase."
      );
    }
  }
);

/* =========================================================
 * Subscription: ensure App Store appAccountToken (UUID)
 *  - users/{uid}.appStoreAppAccountToken を1ユーザー1UUIDで固定
 * =======================================================*/
exports.ensureAppStoreAppAccountToken = onCall({ enforceAppCheck: true }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const uid = request.auth.uid;
  const data = request.data || {};
  const traceId = extractBillingTraceId(data);
  const finalLog = createBillingFinalLogger(logger, {
    traceId,
    uid,
    functionName: "ensureAppStoreAppAccountToken",
  });
  const ownershipLog = finalLog.asOwnershipLog();

  finalLog.info("ensure.enter", {
    payloadKeys: payloadKeys(data),
  });

  try {
    const token = await ensureAppStoreAppAccountTokenForUser(admin.getDb(), admin, {
      uid,
      randomUuid: randomUUID,
      log: ownershipLog,
      traceId,
    });
    finalLog.success("ensure.exit", {
      tokenSuffix: billingTokenSuffix(token),
    });
    return {
      appStoreAppAccountToken: token,
    };
  } catch (error) {
    if (error instanceof HttpsError) {
      finalLog.reject("ensure.exit", summarizeHttpsError(error));
      throw error;
    }
    finalLog.error("ensure.unexpected_error", {
      message: error?.message || null,
    });
    throw error;
  }
});

/* =========================================================
 * Subscription: admin callable updater (temporary)
 *  - 管理者のみが users/{uid} のサブスク状態を更新するための簡易関数
 *  - カスタムクレーム（admin: true）を前提
 * =======================================================*/
exports.adminUpsertUserSubscription = onCall({ enforceAppCheck: true }, async (request) => {
  // 要: 管理者のみ（またはデプロイ者のみ）使えるように制限
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Admin privileges required.");
  }

  const {
    uid,
    subscriptionStatus = "none",
    subscriptionProductId = "",
    subscriptionBasePlanId = "",
    subscriptionOfferId = "",
    expiryTimeMillis = null,     // 例: Date.now() + 30*24*60*60*1000
    trialEndsAtMillis = null,    // 例: Date.now() + 7*24*60*60*1000
    activePurchaseTokens = [],   // string[]
    source = "manual_test"
  } = request.data || {};

  if (typeof uid !== "string" || uid.length === 0) {
    throw new HttpsError("invalid-argument", "Parameter 'uid' is required.");
  }

  const allowedStatuses = ["active", "trial", "grace", "paused", "expired", "canceled", "none"];
  if (!allowedStatuses.includes(subscriptionStatus)) {
    throw new HttpsError("invalid-argument", "Invalid 'subscriptionStatus'.");
  }

  const userRef = admin.getDb().collection("users").doc(uid);

  const update = {
    subscriptionStatus,
    subscriptionProductId,
    subscriptionBasePlanId,
    subscriptionOfferId,
    activePurchaseTokens: Array.isArray(activePurchaseTokens) ? activePurchaseTokens : [],
    lastSubscriptionSource: source,
    lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
  };

  if (expiryTimeMillis !== null) {
    const n = Number(expiryTimeMillis);
    if (Number.isNaN(n) || n <= 0) {
      throw new HttpsError("invalid-argument", "expiryTimeMillis must be a positive number.");
    }
    update.subscriptionExpiryTime = admin.Timestamp.fromMillis(n);
  }

  if (trialEndsAtMillis !== null) {
    const n = Number(trialEndsAtMillis);
    if (Number.isNaN(n) || n <= 0) {
      throw new HttpsError("invalid-argument", "trialEndsAtMillis must be a positive number.");
    }
    update.subscriptionTrialEndsAt = admin.Timestamp.fromMillis(n);
  }

  await userRef.set(update, { merge: true });
  try {
    await recomputeEntitlementFromStoredStores({
      db: admin.getDb(),
      admin,
      uid,
      source: "admin_upsert",
      log: logger,
    });
  } catch (recomputeError) {
    logger.warn("adminUpsertUserSubscription entitlement recompute failed", {
      uidSuffix: uidTailForLog(uid),
      errorType: recomputeError?.constructor?.name || typeof recomputeError,
    });
  }
  return { success: true };
});

/* =========================================================
 * Subscription: App Store Server Notifications V2 (phase 1)
 *  - 自動更新・解約・期限切れ・返金などを受信し Firestore を同期
 * =======================================================*/
exports.handleAppStoreServerNotification = onRequest(
  {
    region: "us-central1",
    invoker: "public",
    secrets: [
      APP_STORE_CONNECT_ISSUER_ID,
      APP_STORE_CONNECT_KEY_ID,
      APP_STORE_CONNECT_PRIVATE_KEY,
    ],
  },
  createAppStoreNotificationHandler({
    getDb: admin.getDb,
    admin,
    logger,
    secrets: {
      issuerSecret: APP_STORE_CONNECT_ISSUER_ID,
      keyIdSecret: APP_STORE_CONNECT_KEY_ID,
      privateKeySecret: APP_STORE_CONNECT_PRIVATE_KEY,
    },
    getAppAppleId: () => APP_STORE_CONNECT_APP_APPLE_ID.value(),
  })
);

/* =========================================================
 * Subscription: Google Play RTDN (phase 1)
 *  - 自動更新・解約・期限切れ・返金などを受信し Firestore を同期
 *  - verifyGooglePlaySubscriptionPurchase は変更しない
 * =======================================================*/
exports.handleGooglePlayRtdn = onMessagePublished(
  {
    topic: "ohayokamome-google-play-rtdn",
    region: "us-central1",
  },
  createGooglePlayRtdnHandler({
    getDb: admin.getDb,
    admin,
    logger,
  }),
);

/* =========================================================
 * Subscription: Google Play chat-session entitlement probe
 *  - チャット中60秒確認の50秒救済用（Androidのみ・Flutterから呼ぶ）
 *  - purchaseToken等はクライアントから受け取らない
 * =======================================================*/
exports.probeGooglePlaySubscriptionEntitlement = onCall(
  { region: "us-central1", enforceAppCheck: true },
  createGooglePlaySubscriptionProbeHandler({
    getDb: admin.getDb,
    admin,
    logger,
  }),
);

/* =========================================================
 * Device usage registry (admin analytics; record-only)
 * =======================================================*/
exports.registerDeviceUsage = onCall(
  { region: "us-central1", enforceAppCheck: true },
  createRegisterDeviceUsageHandler({ admin, logger }),
);

exports.transcribeExperiment = transcribeExperiment;
