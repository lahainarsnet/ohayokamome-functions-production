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

    const responseText = await response.text();
    let responseBody = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch (error) {
        responseBody = { raw: responseText.slice(0, 500) };
      }
    }

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

async function pickLatestTransactionEntry(statusResponseBody, decodeTransaction) {
  const groups = Array.isArray(statusResponseBody?.data)
    ? statusResponseBody.data
    : [];
  let best = null;

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

  return best;
}

module.exports = {
  APP_STORE_PRODUCT_ID,
  APP_STORE_BUNDLE_ID,
  peekJwsPayload,
  createAppStoreServerApiJwt,
  fetchAppStoreAllSubscriptionStatuses,
  loadAppleRootCertificates,
  deriveSubscriptionState,
  pickLatestTransactionEntry,
};
