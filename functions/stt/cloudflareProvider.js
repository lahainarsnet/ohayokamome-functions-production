const {
  CLOUDFLARE_TRANSCRIBE_MODEL,
  CLOUDFLARE_WORKERS_AI_BASE_URL,
  CLOUDFLARE_STT_API_TIMEOUT_MS,
  STT_PROVIDER_CLOUDFLARE,
} = require("./constants");
const { toOpenAiLanguage } = require("./language");

function buildCloudflareWorkersAiUrl(accountId, model = CLOUDFLARE_TRANSCRIBE_MODEL) {
  return `${CLOUDFLARE_WORKERS_AI_BASE_URL}/${encodeURIComponent(
    accountId,
  )}/ai/run/${model}`;
}

function buildCloudflareRequestBody({ audioBuffer, language, prompt = null }) {
  const body = {
    audio: audioBuffer.toString("base64"),
    task: "transcribe",
    language: toOpenAiLanguage(language),
    vad_filter: false,
  };
  if (typeof prompt === "string" && prompt.trim() !== "") {
    body.initial_prompt = prompt.trim();
  }
  return body;
}

function parseCloudflareErrorPayload(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const error = Array.isArray(parsed?.errors) ? parsed.errors[0] : null;
    return {
      errorCode: error?.code ?? null,
      errorMessage:
        typeof error?.message === "string" ? error.message : null,
    };
  } catch (_) {
    return { errorCode: null, errorMessage: null };
  }
}

function classifyCloudflareHttpFailure(status, errorMessage = "") {
  if (status === 401 || status === 403) {
    return { code: "CLOUDFLARE_AUTH_ERROR", errorCategory: "authentication_error" };
  }
  if (status === 429) {
    return { code: "CLOUDFLARE_RATE_LIMIT", errorCategory: "rate_limit" };
  }
  if (status === 400) {
    const normalized = String(errorMessage).toLowerCase();
    if (
      normalized.includes("audio") ||
      normalized.includes("mime") ||
      normalized.includes("format") ||
      normalized.includes("invalid")
    ) {
      return { code: "CLOUDFLARE_INVALID_AUDIO", errorCategory: "invalid_audio" };
    }
  }
  return { code: "CLOUDFLARE_HTTP_ERROR", errorCategory: "http_error" };
}

function isAbortError(error) {
  return (
    error &&
    (error.name === "AbortError" ||
      error.code === "ABORT_ERR" ||
      String(error.message || "").toLowerCase().includes("aborted"))
  );
}

async function fetchCloudflareWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildCloudflareResultBase({ accountId, gatewayId, providerLanguage, apiLatencyMs }) {
  return {
    provider: STT_PROVIDER_CLOUDFLARE,
    model: CLOUDFLARE_TRANSCRIBE_MODEL,
    providerLanguage,
    apiLatencyMs,
    cloudflareAccountIdPresent: Boolean(accountId),
    cloudflareGatewayId: gatewayId || null,
  };
}

async function transcribeWithCloudflare({
  audioBuffer,
  language,
  prompt = null,
  apiToken,
  accountId,
  gatewayId,
  receivedBytes,
  fetchImpl = fetch,
  timeoutMs = CLOUDFLARE_STT_API_TIMEOUT_MS,
  logger,
}) {
  const providerLanguage = toOpenAiLanguage(language);
  const apiStartedAt = Date.now();
  const url = buildCloudflareWorkersAiUrl(accountId);
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
    // Keep audio and transcript text out of AI Gateway request/response logs.
    "cf-aig-collect-log-payload": "false",
  };
  if (gatewayId) {
    headers["cf-aig-gateway-id"] = gatewayId;
  }

  let response;
  try {
    response = await fetchCloudflareWithTimeout(
      fetchImpl,
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(
          buildCloudflareRequestBody({ audioBuffer, language, prompt }),
        ),
      },
      timeoutMs,
    );
  } catch (error) {
    const apiLatencyMs = Date.now() - apiStartedAt;
    const base = buildCloudflareResultBase({
      accountId,
      gatewayId,
      providerLanguage,
      apiLatencyMs,
    });
    if (isAbortError(error)) {
      if (typeof logger?.warn === "function") {
        logger.warn("transcribeExperiment: CLOUDFLARE_TIMEOUT", {
          receivedBytes,
          ...base,
          timeoutMs,
          errorCategory: "timeout",
        });
      }
      return { ok: false, code: "CLOUDFLARE_TIMEOUT", errorCategory: "timeout", ...base };
    }
    if (typeof logger?.error === "function") {
      logger.error("transcribeExperiment: CLOUDFLARE_REQUEST_FAILED", {
        receivedBytes,
        ...base,
        fetchErrorName: typeof error?.name === "string" ? error.name : "Error",
        errorCategory: "network_error",
      });
    }
    return {
      ok: false,
      code: "CLOUDFLARE_REQUEST_FAILED",
      errorCategory: "network_error",
      ...base,
    };
  }

  const apiLatencyMs = Date.now() - apiStartedAt;
  const base = buildCloudflareResultBase({
    accountId,
    gatewayId,
    providerLanguage,
    apiLatencyMs,
  });
  const rawBody = await response.text();
  if (!response.ok) {
    const { errorCode, errorMessage } = parseCloudflareErrorPayload(rawBody);
    const failure = classifyCloudflareHttpFailure(response.status, errorMessage);
    if (typeof logger?.warn === "function") {
      logger.warn("transcribeExperiment: CLOUDFLARE_HTTP_ERROR", {
        receivedBytes,
        ...base,
        status: response.status,
        cloudflareErrorCode: errorCode,
        errorCategory: failure.errorCategory,
        resultCode: failure.code,
      });
    }
    return { ok: false, ...failure, ...base };
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (_) {
    return {
      ok: false,
      code: "CLOUDFLARE_BAD_RESPONSE",
      errorCategory: "bad_response",
      ...base,
    };
  }
  const text = data?.result?.text;
  if (data?.success !== true || typeof text !== "string" || text.trim() === "") {
    return {
      ok: false,
      code: "CLOUDFLARE_BAD_RESPONSE",
      errorCategory: "bad_response",
      ...base,
    };
  }

  const neurons =
    typeof data?.usage?.neurons === "number" ? data.usage.neurons : null;
  if (typeof logger?.info === "function") {
    logger.info("transcribeExperiment: CLOUDFLARE_API_SUCCESS", {
      receivedBytes,
      ...base,
      neurons,
      errorCategory: "success",
    });
  }
  return {
    ok: true,
    text: text.trim(),
    neurons,
    promptForwarded: typeof prompt === "string" && prompt.trim() !== "",
    ...base,
  };
}

module.exports = {
  buildCloudflareWorkersAiUrl,
  buildCloudflareRequestBody,
  parseCloudflareErrorPayload,
  classifyCloudflareHttpFailure,
  transcribeWithCloudflare,
};
