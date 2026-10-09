/**
 * App Store Server API helpers for notification handling (phase 1).
 * verifyAppStoreSubscriptionPurchase in index.js is intentionally unchanged.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const APP_STORE_PRODUCT_ID = "ohayo_kamome_monthly";
const APP_STORE_BUNDLE_ID = "com.lahainarsnet.ohayokamome.live";
const APP_STORE_API_PRODUCTION_BASE_URL = "https://api.storekit.itunes.apple.com";
const APP_STORE_API_SANDBOX_BASE_URL = "https://api.storekit-sandbox.itunes.apple.com";

function readSecretValue(secret, envName) {
  try {
    const value = secret.value();
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  } catch (error) {
    // Local checks may use process.env instead.
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

function peekJwsPayload(signedJws) {
  if (typeof signedJws !== "string") {
    return null;
  }
  const parts = signedJws.trim().split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    return base64UrlDecodeJson(parts[1]);
  } catch (error) {
    return null;
  }
}

function createAppStoreServerApiJwt(secrets) {
  const issuerId = readSecretValue(
    secrets.issuerSecret,
    "APP_STORE_CONNECT_ISSUER_ID"
  );
  const keyId = readSecretValue(secrets.keyIdSecret, "APP_STORE_CONNECT_KEY_ID");
  const privateKey = normalizePrivateKey(
    readSecretValue(secrets.privateKeySecret, "APP_STORE_CONNECT_PRIVATE_KEY")
  );

  if (!issuerId || !keyId || !privateKey) {
    throw new Error("APP_STORE_API_CREDENTIALS_NOT_CONFIGURED");
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

function environmentOrder(environmentHint = "") {
  const production = {
    name: "Production",
    baseUrl: APP_STORE_API_PRODUCTION_BASE_URL,
  };
  const sandbox = {
    name: "Sandbox",
    baseUrl: APP_STORE_API_SANDBOX_BASE_URL,
  };
  return environmentHint === "Sandbox"
    ? [sandbox, production]
    : [production, sandbox];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableAppleHttpStatus(status) {
  return status === 429 || (Number.isFinite(status) && status >= 500);
}

function isAppleWrongEnvironmentError(status, appleErrorCode) {
  return status === 404 && Number(appleErrorCode) === 4040010;
}

async function fetchAppStoreHttpGet(url, headers, httpTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), httpTimeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("APP_STORE_HTTP_TIMEOUT");
      timeoutError.code = "TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function parseAppleSubscriptionResponse(response) {
  const responseText = await response.text();
  let responseBody = null;
  if (responseText) {
    try {
      responseBody = JSON.parse(responseText);
    } catch (error) {
      responseBody = { raw: responseText.slice(0, 500) };
    }
  }
  return responseBody;
}

async function fetchAppStoreAllSubscriptionStatuses(
  anyTransactionId,
  environmentHint,
  secrets
) {
  const jwt = createAppStoreServerApiJwt(secrets);
  const path = `/inApps/v1/subscriptions/${encodeURIComponent(anyTransactionId)}`;
  const errors = [];

  for (const environment of environmentOrder(environmentHint)) {
    const response = await fetch(`${environment.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
    });

    const responseBody = await parseAppleSubscriptionResponse(response);

    if (response.ok && responseBody?.data) {
      return {
        environment: environment.name,
        body: responseBody,
      };
    }

    errors.push({
      environment: environment.name,
      status: response.status,
      appleErrorCode: responseBody?.errorCode || null,
      appleErrorMessage: responseBody?.errorMessage || null,
    });
  }

  const error = new Error("APP_STORE_SUBSCRIPTION_LOOKUP_FAILED");
  error.lookupErrors = errors;
  throw error;
}

const DEFAULT_APP_STORE_RETRY = {
  maxHttpAttempts: 6,
  deadlineMs: 52_000,
  httpTimeoutMs: 8_000,
  retryBackoffMs: 1_000,
};

const APP_STORE_API_RETRY_TRACE = "APP_STORE_API_RETRY_TRACE";

function emitAppStoreRetryTrace(trace, payload) {
  if (!trace?.logger || typeof trace.logger.info !== "function") {
    return;
  }
  trace.logger.info(APP_STORE_API_RETRY_TRACE, {
    operationId: trace.operationId || null,
    ...payload,
  });
}

/**
 * Retries Apple subscription status GETs without treating HTTP errors as expired.
 * Each HTTP call (including Sandbox/Production switch) counts toward maxHttpAttempts.
 */
async function fetchAppStoreAllSubscriptionStatusesWithRetry(
  anyTransactionId,
  environmentHint,
  secrets,
  options = {}
) {
  const {
    maxHttpAttempts = DEFAULT_APP_STORE_RETRY.maxHttpAttempts,
    deadlineMs = DEFAULT_APP_STORE_RETRY.deadlineMs,
    httpTimeoutMs = DEFAULT_APP_STORE_RETRY.httpTimeoutMs,
    retryBackoffMs = DEFAULT_APP_STORE_RETRY.retryBackoffMs,
    trace = null,
  } = options;

  const jwt = createAppStoreServerApiJwt(secrets);
  const path = `/inApps/v1/subscriptions/${encodeURIComponent(anyTransactionId)}`;
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/json",
  };
  const [primaryEnvironment, secondaryEnvironment] =
    environmentOrder(environmentHint);
  let activeEnvironment = primaryEnvironment;
  const errors = [];
  const startedAt = Date.now();
  let httpAttempts = 0;

  while (
    httpAttempts < maxHttpAttempts &&
    Date.now() - startedAt < deadlineMs
  ) {
    const attemptNumber = httpAttempts + 1;
    const attemptStartedAt = Date.now();
    let response;
    let responseBody = null;
    try {
      response = await fetchAppStoreHttpGet(
        `${activeEnvironment.baseUrl}${path}`,
        headers,
        httpTimeoutMs
      );
      responseBody = await parseAppleSubscriptionResponse(response);
    } catch (error) {
      httpAttempts += 1;
      const errorKind = error?.code || "NETWORK_ERROR";
      errors.push({
        environment: activeEnvironment.name,
        status: null,
        appleErrorCode: errorKind,
        appleErrorMessage: error?.message || String(error),
      });
      emitAppStoreRetryTrace(trace, {
        step: "http_attempt",
        attemptNumber,
        environment: activeEnvironment.name,
        httpElapsedMs: Date.now() - attemptStartedAt,
        httpStatus: null,
        errorKind,
        outcome: "error",
      });
      activeEnvironment = primaryEnvironment;
      if (
        httpAttempts >= maxHttpAttempts ||
        Date.now() - startedAt + retryBackoffMs >= deadlineMs
      ) {
        break;
      }
      emitAppStoreRetryTrace(trace, {
        step: "retry_scheduled",
        attemptNumber,
        retryReason: "network_or_timeout",
        waitMs: retryBackoffMs,
      });
      await sleep(retryBackoffMs);
      continue;
    }

    httpAttempts += 1;
    emitAppStoreRetryTrace(trace, {
      step: "http_attempt",
      attemptNumber,
      environment: activeEnvironment.name,
      httpElapsedMs: Date.now() - attemptStartedAt,
      httpStatus: response.status,
      errorKind: response.ok ? null : responseBody?.errorCode || "HTTP_ERROR",
      outcome: response.ok && responseBody?.data ? "success" : "error",
    });

    if (response.ok && responseBody?.data) {
      emitAppStoreRetryTrace(trace, {
        step: "completed",
        outcome: "success",
        httpAttempts,
        totalElapsedMs: Date.now() - startedAt,
      });
      return {
        environment: activeEnvironment.name,
        body: responseBody,
        httpAttempts,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const appleErrorCode = responseBody?.errorCode ?? null;
    errors.push({
      environment: activeEnvironment.name,
      status: response.status,
      appleErrorCode,
      appleErrorMessage: responseBody?.errorMessage || null,
    });

    if (response.status === 401 || response.status === 403) {
      emitAppStoreRetryTrace(trace, {
        step: "completed",
        outcome: "auth_failed",
        httpAttempts,
        totalElapsedMs: Date.now() - startedAt,
      });
      const authError = new Error("APP_STORE_SUBSCRIPTION_LOOKUP_FAILED");
      authError.lookupErrors = errors;
      authError.nonRetryable = true;
      throw authError;
    }

    if (
      isAppleWrongEnvironmentError(response.status, appleErrorCode) &&
      httpAttempts < maxHttpAttempts &&
      Date.now() - startedAt < deadlineMs
    ) {
      emitAppStoreRetryTrace(trace, {
        step: "retry_scheduled",
        attemptNumber,
        retryReason: "wrong_environment_switch",
        waitMs: 0,
        nextEnvironment:
          activeEnvironment.name === primaryEnvironment.name
            ? secondaryEnvironment.name
            : primaryEnvironment.name,
      });
      activeEnvironment =
        activeEnvironment.name === primaryEnvironment.name
          ? secondaryEnvironment
          : primaryEnvironment;
      continue;
    }

    activeEnvironment = primaryEnvironment;
    if (
      isRetryableAppleHttpStatus(response.status) &&
      httpAttempts < maxHttpAttempts &&
      Date.now() - startedAt + retryBackoffMs < deadlineMs
    ) {
      emitAppStoreRetryTrace(trace, {
        step: "retry_scheduled",
        attemptNumber,
        retryReason: `retryable_http_${response.status}`,
        waitMs: retryBackoffMs,
      });
      await sleep(retryBackoffMs);
      continue;
    }
    break;
  }

  emitAppStoreRetryTrace(trace, {
    step: "completed",
    outcome: "failed",
    httpAttempts,
    totalElapsedMs: Date.now() - startedAt,
  });
  const error = new Error("APP_STORE_SUBSCRIPTION_LOOKUP_FAILED");
  error.lookupErrors = errors;
  error.httpAttempts = httpAttempts;
  error.elapsedMs = Date.now() - startedAt;
  throw error;
}

function loadAppleRootCertificates() {
  const certDir = path.join(__dirname, "certs");
  const filenames = ["AppleRootCA-G3.cer", "AppleRootCA-G2.cer"];
  const buffers = [];
  for (const filename of filenames) {
    const certPath = path.join(certDir, filename);
    if (fs.existsSync(certPath)) {
      buffers.push(fs.readFileSync(certPath));
    }
  }
  if (buffers.length === 0) {
    throw new Error("APPLE_ROOT_CA_CERTIFICATES_MISSING");
  }
  return buffers;
}

function deriveSubscriptionState(transactionInfo, nowMillis = Date.now()) {
  const expiresDate = Number(transactionInfo?.expiresDate || 0);
  const revocationDate = Number(transactionInfo?.revocationDate || 0);
  const productId = transactionInfo?.productId || "";
  const bundleId = transactionInfo?.bundleId || "";

  if (bundleId !== APP_STORE_BUNDLE_ID) {
    return {
      status: null,
      validationCode: "BUNDLE_ID_MISMATCH",
      expiresDate,
      latestTransactionId: transactionInfo?.transactionId || "",
      originalTransactionId: transactionInfo?.originalTransactionId || "",
      environment: transactionInfo?.environment || "",
    };
  }
  if (productId !== APP_STORE_PRODUCT_ID) {
    return {
      status: null,
      validationCode: "PRODUCT_ID_MISMATCH",
      expiresDate,
      latestTransactionId: transactionInfo?.transactionId || "",
      originalTransactionId: transactionInfo?.originalTransactionId || "",
      environment: transactionInfo?.environment || "",
    };
  }
  if (revocationDate > 0) {
    return {
      status: "none",
      validationCode: "TRANSACTION_REVOKED",
      expiresDate,
      latestTransactionId: transactionInfo?.transactionId || "",
      originalTransactionId: transactionInfo?.originalTransactionId || "",
      environment: transactionInfo?.environment || "",
    };
  }
  if (!Number.isFinite(expiresDate) || expiresDate <= nowMillis) {
    return {
      status: "expired",
      validationCode: "SUBSCRIPTION_EXPIRED",
      expiresDate,
      latestTransactionId: transactionInfo?.transactionId || "",
      originalTransactionId: transactionInfo?.originalTransactionId || "",
      environment: transactionInfo?.environment || "",
    };
  }

  return {
    status: "active",
    validationCode: "ACTIVE",
    expiresDate,
    latestTransactionId: transactionInfo?.transactionId || "",
    originalTransactionId: transactionInfo?.originalTransactionId || "",
    environment: transactionInfo?.environment || "",
  };
}

async function pickLatestTransactionEntry(statusResponseBody, decodeTransaction, options = {}) {
  const {
    activeOnly = false,
    now = Date.now(),
    meta = null,
  } = options || {};
  const groups = Array.isArray(statusResponseBody?.data)
    ? statusResponseBody.data
    : [];
  let best = null;
  let latestCandidateCount = 0;
  let activeCandidateCount = 0;

  for (const group of groups) {
    const lastTransactions = Array.isArray(group?.lastTransactions)
      ? group.lastTransactions
      : [];
    for (const entry of lastTransactions) {
      if (!entry?.signedTransactionInfo) {
        continue;
      }
      let transactionInfo;
      try {
        transactionInfo = await decodeTransaction(entry.signedTransactionInfo);
      } catch (error) {
        continue;
      }
      if (transactionInfo?.productId !== APP_STORE_PRODUCT_ID) {
        continue;
      }
      const expiresDate = Number(transactionInfo?.expiresDate || 0);
      latestCandidateCount += 1;
      const isActive = Number.isFinite(expiresDate) && expiresDate > now;
      if (isActive) {
        activeCandidateCount += 1;
      }
      if (activeOnly && !isActive) {
        continue;
      }
      if (!best || expiresDate > best.expiresDate) {
        best = {
          expiresDate,
          transactionInfo,
          renewalInfoSigned: entry.signedRenewalInfo || null,
          appleStatus: entry.status,
        };
      }
    }
  }

  if (meta && typeof meta === "object") {
    meta.latestCandidateCount = latestCandidateCount;
    meta.activeCandidateCount = activeCandidateCount;
    meta.adoptedTransactionId = best?.transactionInfo?.transactionId || null;
    meta.activeOnly = activeOnly;
  }

  return best;
}

module.exports = {
  APP_STORE_PRODUCT_ID,
  APP_STORE_BUNDLE_ID,
  peekJwsPayload,
  createAppStoreServerApiJwt,
  environmentOrder,
  fetchAppStoreAllSubscriptionStatuses,
  fetchAppStoreAllSubscriptionStatusesWithRetry,
  APP_STORE_API_RETRY_TRACE,
  DEFAULT_APP_STORE_RETRY,
  loadAppleRootCertificates,
  deriveSubscriptionState,
  pickLatestTransactionEntry,
};
