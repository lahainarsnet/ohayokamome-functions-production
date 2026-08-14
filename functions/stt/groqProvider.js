const {
  GROQ_TRANSCRIBE_URL,
  GROQ_TRANSCRIBE_MODEL,
  GROQ_STT_API_TIMEOUT_MS,
  STT_PROVIDER_GROQ,
} = require("./constants");
const { toOpenAiLanguage } = require("./language");
const { buildGroqTranscriptionPrompt } = require("./groqPrompt");

function resolveGroqFilename(mimeType) {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized.includes("mp4")) {
    return "audio.mp4";
  }
  if (normalized.includes("m4a")) {
    return "audio.m4a";
  }
  return "audio.m4a";
}

function parseGroqErrorPayload(rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    const error = parsed?.error;
    if (!error || typeof error !== "object") {
      return {
        errorType: "unknown",
        errorCode: "unknown",
      };
    }
    return {
      errorType:
        typeof error.type === "string" && error.type.trim() !== ""
          ? error.type.trim()
          : "unknown",
      errorCode:
        typeof error.code === "string" && error.code.trim() !== ""
          ? error.code.trim()
          : "unknown",
    };
  } catch (_) {
    return {
      errorType: "unknown",
      errorCode: "unknown",
    };
  }
}

function classifyGroqHttpFailure(status, errorType, errorCode) {
  if (status === 401 || status === 403) {
    return {
      code: "GROQ_AUTH_ERROR",
      errorCategory: "authentication_error",
    };
  }
  if (status === 429) {
    return {
      code: "GROQ_RATE_LIMIT",
      errorCategory: "rate_limit",
    };
  }
  if (status === 400) {
    const haystack = `${errorType} ${errorCode}`.toLowerCase();
    if (
      haystack.includes("audio") ||
      haystack.includes("file") ||
      haystack.includes("mime") ||
      haystack.includes("format") ||
      haystack.includes("invalid")
    ) {
      return {
        code: "GROQ_INVALID_AUDIO",
        errorCategory: "invalid_audio",
      };
    }
  }
  return {
    code: "GROQ_HTTP_ERROR",
    errorCategory: "http_error",
  };
}

function isAbortError(error) {
  return (
    error &&
    (error.name === "AbortError" ||
      error.code === "ABORT_ERR" ||
      String(error.message || "").toLowerCase().includes("aborted"))
  );
}

async function fetchGroqWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function transcribeWithGroq({
  audioBuffer,
  mimeType,
  language,
  prompt,
  apiKey,
  receivedBytes,
  fetchImpl = fetch,
  timeoutMs = GROQ_STT_API_TIMEOUT_MS,
  logger,
}) {
  const trimmedMime = mimeType.trim();
  const groqLanguage = toOpenAiLanguage(language);
  const promptResolution = buildGroqTranscriptionPrompt({
    language,
    userPrompt: prompt,
  });
  const groqPrompt = promptResolution.prompt;

  const blob = new Blob([audioBuffer], { type: trimmedMime });
  const formData = new FormData();
  formData.append("file", blob, resolveGroqFilename(trimmedMime));
  formData.append("model", GROQ_TRANSCRIBE_MODEL);
  formData.append("response_format", "json");
  formData.append("language", groqLanguage);
  formData.append("temperature", "0");
  if (typeof groqPrompt === "string" && groqPrompt.trim() !== "") {
    formData.append("prompt", groqPrompt);
  }

  const apiStartedAt = Date.now();
  let res;
  try {
    res = await fetchGroqWithTimeout(
      fetchImpl,
      GROQ_TRANSCRIBE_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      },
      timeoutMs,
    );
  } catch (e) {
    const apiLatencyMs = Date.now() - apiStartedAt;
    if (isAbortError(e)) {
      if (typeof logger?.warn === "function") {
        logger.warn("transcribeExperiment: GROQ_TIMEOUT", {
          receivedBytes,
          provider: STT_PROVIDER_GROQ,
          model: GROQ_TRANSCRIBE_MODEL,
          apiLatencyMs,
          timeoutMs,
          errorCategory: "timeout",
        });
      }
      return {
        ok: false,
        code: "GROQ_TIMEOUT",
        errorCategory: "timeout",
        provider: STT_PROVIDER_GROQ,
        model: GROQ_TRANSCRIBE_MODEL,
        providerLanguage: groqLanguage,
        apiLatencyMs,
        promptTruncated: promptResolution.truncated,
        promptEstimatedTokens: promptResolution.estimatedTokens,
      };
    }
    if (typeof logger?.error === "function") {
      logger.error("transcribeExperiment: GROQ_REQUEST_FAILED", {
        fetchErrorName: e && typeof e.name === "string" ? e.name : "Error",
        receivedBytes,
        provider: STT_PROVIDER_GROQ,
        model: GROQ_TRANSCRIBE_MODEL,
        apiLatencyMs,
        errorCategory: "network_error",
      });
    }
    return {
      ok: false,
      code: "GROQ_REQUEST_FAILED",
      errorCategory: "network_error",
      provider: STT_PROVIDER_GROQ,
      model: GROQ_TRANSCRIBE_MODEL,
      providerLanguage: groqLanguage,
      apiLatencyMs,
      promptTruncated: promptResolution.truncated,
      promptEstimatedTokens: promptResolution.estimatedTokens,
    };
  }

  const apiLatencyMs = Date.now() - apiStartedAt;
  const rawBody = await res.text();
  if (!res.ok) {
    const { errorType, errorCode } = parseGroqErrorPayload(rawBody);
    const failure = classifyGroqHttpFailure(res.status, errorType, errorCode);
    if (typeof logger?.warn === "function") {
      logger.warn("transcribeExperiment: GROQ_HTTP_ERROR", {
        status: res.status,
        groqErrorType: errorType,
        groqErrorCode: errorCode,
        receivedBytes,
        provider: STT_PROVIDER_GROQ,
        model: GROQ_TRANSCRIBE_MODEL,
        apiLatencyMs,
        errorCategory: failure.errorCategory,
        resultCode: failure.code,
      });
    }
    return {
      ok: false,
      code: failure.code,
      errorCategory: failure.errorCategory,
      provider: STT_PROVIDER_GROQ,
      model: GROQ_TRANSCRIBE_MODEL,
      providerLanguage: groqLanguage,
      apiLatencyMs,
      promptTruncated: promptResolution.truncated,
      promptEstimatedTokens: promptResolution.estimatedTokens,
    };
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (_) {
    if (typeof logger?.warn === "function") {
      logger.warn("transcribeExperiment: GROQ_BAD_RESPONSE (parse)", {
        receivedBytes,
        provider: STT_PROVIDER_GROQ,
        model: GROQ_TRANSCRIBE_MODEL,
        apiLatencyMs,
        errorCategory: "bad_response",
      });
    }
    return {
      ok: false,
      code: "GROQ_BAD_RESPONSE",
      errorCategory: "bad_response",
      provider: STT_PROVIDER_GROQ,
      model: GROQ_TRANSCRIBE_MODEL,
      providerLanguage: groqLanguage,
      apiLatencyMs,
      promptTruncated: promptResolution.truncated,
      promptEstimatedTokens: promptResolution.estimatedTokens,
    };
  }

  if (!data || typeof data.text !== "string" || data.text.trim() === "") {
    if (typeof logger?.warn === "function") {
      logger.warn("transcribeExperiment: GROQ_BAD_RESPONSE (shape)", {
        receivedBytes,
        provider: STT_PROVIDER_GROQ,
        model: GROQ_TRANSCRIBE_MODEL,
        apiLatencyMs,
        errorCategory: "bad_response",
      });
    }
    return {
      ok: false,
      code: "GROQ_BAD_RESPONSE",
      errorCategory: "bad_response",
      provider: STT_PROVIDER_GROQ,
      model: GROQ_TRANSCRIBE_MODEL,
      providerLanguage: groqLanguage,
      apiLatencyMs,
      promptTruncated: promptResolution.truncated,
      promptEstimatedTokens: promptResolution.estimatedTokens,
    };
  }

  if (typeof logger?.info === "function") {
    logger.info("transcribeExperiment: GROQ_API_SUCCESS", {
      receivedBytes,
      provider: STT_PROVIDER_GROQ,
      model: GROQ_TRANSCRIBE_MODEL,
      apiLatencyMs,
      providerLanguage: groqLanguage,
      errorCategory: "success",
      promptTruncated: promptResolution.truncated,
      promptEstimatedTokens: promptResolution.estimatedTokens,
    });
  }

  return {
    ok: true,
    text: data.text,
    provider: STT_PROVIDER_GROQ,
    model: GROQ_TRANSCRIBE_MODEL,
    providerLanguage: groqLanguage,
    apiLatencyMs,
    promptTruncated: promptResolution.truncated,
    promptEstimatedTokens: promptResolution.estimatedTokens,
    promptForwarded: typeof groqPrompt === "string" && groqPrompt.trim() !== "",
  };
}

module.exports = {
  transcribeWithGroq,
  classifyGroqHttpFailure,
  parseGroqErrorPayload,
  resolveGroqFilename,
};
