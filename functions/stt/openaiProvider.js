const {
  OPENAI_TRANSCRIBE_URL,
  OPENAI_TRANSCRIBE_MODEL,
  STT_PROVIDER_OPENAI,
} = require("./constants");

async function transcribeWithOpenAI({
  audioBuffer,
  mimeType,
  apiKey,
  receivedBytes,
  fetchImpl = fetch,
  logger,
}) {
  const trimmedMime = mimeType.trim();
  const filename = trimmedMime.toLowerCase().includes("mp4")
    ? "audio.mp4"
    : "audio.m4a";

  const blob = new Blob([audioBuffer], { type: trimmedMime });
  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("model", OPENAI_TRANSCRIBE_MODEL);
  formData.append("response_format", "json");

  const apiStartedAt = Date.now();
  let res;
  try {
    res = await fetchImpl(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });
  } catch (e) {
    if (typeof logger?.error === "function") {
      logger.error("transcribeExperiment: OPENAI_REQUEST_FAILED", {
        fetchErrorName: e && typeof e.name === "string" ? e.name : "Error",
        receivedBytes,
        provider: STT_PROVIDER_OPENAI,
        model: OPENAI_TRANSCRIBE_MODEL,
      });
    }
    return {
      ok: false,
      code: "OPENAI_REQUEST_FAILED",
      provider: STT_PROVIDER_OPENAI,
      model: OPENAI_TRANSCRIBE_MODEL,
      apiLatencyMs: Date.now() - apiStartedAt,
    };
  }

  const apiLatencyMs = Date.now() - apiStartedAt;
  const rawBody = await res.text();
  if (!res.ok) {
    let openaiErrorType = "unknown";
    try {
      const errJson = JSON.parse(rawBody);
      if (
        errJson &&
        errJson.error &&
        typeof errJson.error.type === "string"
      ) {
        openaiErrorType = errJson.error.type;
      }
    } catch (_) {
      /* 本文はログに載せない */
    }
    if (typeof logger?.warn === "function") {
      logger.warn("transcribeExperiment: OPENAI_HTTP_ERROR", {
        status: res.status,
        openaiErrorType,
        receivedBytes,
        provider: STT_PROVIDER_OPENAI,
        model: OPENAI_TRANSCRIBE_MODEL,
        apiLatencyMs,
      });
    }
    return {
      ok: false,
      code: "OPENAI_HTTP_ERROR",
      provider: STT_PROVIDER_OPENAI,
      model: OPENAI_TRANSCRIBE_MODEL,
      apiLatencyMs,
    };
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (_) {
    if (typeof logger?.warn === "function") {
      logger.warn("transcribeExperiment: OPENAI_BAD_RESPONSE (parse)", {
        receivedBytes,
        provider: STT_PROVIDER_OPENAI,
        model: OPENAI_TRANSCRIBE_MODEL,
        apiLatencyMs,
      });
    }
    return {
      ok: false,
      code: "OPENAI_BAD_RESPONSE",
      provider: STT_PROVIDER_OPENAI,
      model: OPENAI_TRANSCRIBE_MODEL,
      apiLatencyMs,
    };
  }

  if (!data || typeof data.text !== "string") {
    if (typeof logger?.warn === "function") {
      logger.warn("transcribeExperiment: OPENAI_BAD_RESPONSE (shape)", {
        receivedBytes,
        provider: STT_PROVIDER_OPENAI,
        model: OPENAI_TRANSCRIBE_MODEL,
        apiLatencyMs,
      });
    }
    return {
      ok: false,
      code: "OPENAI_BAD_RESPONSE",
      provider: STT_PROVIDER_OPENAI,
      model: OPENAI_TRANSCRIBE_MODEL,
      apiLatencyMs,
    };
  }

  return {
    ok: true,
    text: data.text,
    provider: STT_PROVIDER_OPENAI,
    model: OPENAI_TRANSCRIBE_MODEL,
    apiLatencyMs,
  };
}

module.exports = {
  transcribeWithOpenAI,
};
