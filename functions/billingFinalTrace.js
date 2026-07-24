const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function extractBillingTraceId(data) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const raw = data.billingTraceId ?? data.traceId;
  const normalized = String(raw || "").trim();
  return normalized || null;
}

function tokenSuffix(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "empty";
  return normalized.length <= 6 ? normalized : normalized.slice(-6);
}

function normalizeUuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  return UUID_PATTERN.test(normalized) ? normalized : "";
}

function summarizeTransactionInfo(transactionInfo) {
  if (!transactionInfo) {
    return null;
  }
  return {
    transactionIdSuffix: tokenSuffix(transactionInfo.transactionId),
    originalTransactionIdSuffix: tokenSuffix(transactionInfo.originalTransactionId),
    webOrderLineItemId: transactionInfo.webOrderLineItemId || null,
    productId: transactionInfo.productId || null,
    expiresDate: transactionInfo.expiresDate || null,
    signedDate: transactionInfo.signedDate || null,
    environment: transactionInfo.environment || null,
    hasAppAccountToken: Boolean(normalizeUuid(transactionInfo.appAccountToken)),
    appAccountTokenSuffix: tokenSuffix(transactionInfo.appAccountToken),
  };
}

function payloadKeys(data) {
  if (!data || typeof data !== "object") {
    return [];
  }
  return Object.keys(data).sort();
}

function createBillingFinalLogger(baseLogger, { traceId, uid, functionName }) {
  const startedAt = Date.now();
  const emit = (level, step, fields = {}) => {
    baseLogger[level]("KAMOME_BILLING_FINAL_TRACE", {
      step,
      billingTraceId: traceId || null,
      uidSuffix: tokenSuffix(uid),
      functionName: functionName || null,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      ...fields,
    });
  };
  return {
    info: (step, fields) => emit("info", step, fields),
    warn: (step, fields) => emit("warn", step, fields),
    error: (step, fields) => emit("error", step, fields),
    reject: (step, fields) =>
      emit("warn", step, { ...fields, outcome: "reject" }),
    success: (step, fields) =>
      emit("info", step, { ...fields, outcome: "success" }),
    asOwnershipLog: () => ({
      info: (message, fields = {}) =>
        emit("info", message, fields),
      warn: (message, fields = {}) =>
        emit("warn", message, fields),
    }),
  };
}

function summarizeHttpsError(error) {
  if (!error) {
    return null;
  }
  return {
    code: error.code || null,
    message: error.message || null,
    details: error.details || null,
  };
}

module.exports = {
  extractBillingTraceId,
  tokenSuffix,
  normalizeUuid,
  summarizeTransactionInfo,
  payloadKeys,
  createBillingFinalLogger,
  summarizeHttpsError,
};
