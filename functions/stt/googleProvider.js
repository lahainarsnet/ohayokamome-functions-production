const {
  STT_PROVIDER_GOOGLE,
  GOOGLE_STT_DEFAULT_MODEL,
  GOOGLE_STT_DEFAULT_LOCATION,
  GOOGLE_STT_DEFAULT_LANGUAGE,
  GOOGLE_STT_API_TIMEOUT_MS,
} = require("./constants");

function buildRecognizerName(projectId, location) {
  return `projects/${projectId}/locations/${location}/recognizers/_`;
}

function extractTextFromGoogleResponse(response) {
  if (!response || !Array.isArray(response.results)) {
    return "";
  }

  const parts = [];
  for (const result of response.results) {
    const alternatives = result && result.alternatives;
    const primary =
      Array.isArray(alternatives) && alternatives.length > 0
        ? alternatives[0]
        : null;
    if (
      primary &&
      typeof primary.transcript === "string" &&
      primary.transcript.length > 0
    ) {
      parts.push(primary.transcript);
    }
  }

  return parts.join(" ").trim();
}

function normalizeGoogleError(error) {
  const code =
    error && typeof error.code === "number"
      ? error.code
      : error && typeof error.code === "string"
        ? Number(error.code)
        : NaN;

  switch (code) {
    case 3:
      return "GOOGLE_STT_INVALID_AUDIO";
    case 4:
      return "GOOGLE_STT_TIMEOUT";
    case 7:
    case 16:
      return "GOOGLE_STT_PERMISSION";
    case 8:
      return "GOOGLE_STT_QUOTA";
    case 14:
      return "GOOGLE_STT_ERROR";
    default:
      break;
  }

  const message =
    error && typeof error.message === "string" ? error.message : "";
  if (message.includes("DEADLINE_EXCEEDED")) {
    return "GOOGLE_STT_TIMEOUT";
  }
  if (message.includes("PERMISSION_DENIED")) {
    return "GOOGLE_STT_PERMISSION";
  }
  if (message.includes("RESOURCE_EXHAUSTED")) {
    return "GOOGLE_STT_QUOTA";
  }
  if (message.includes("INVALID_ARGUMENT")) {
    return "GOOGLE_STT_INVALID_AUDIO";
  }
  return "GOOGLE_STT_ERROR";
}

function defaultSpeechClientFactory() {
  const { SpeechClient } = require("@google-cloud/speech").v2;
  return new SpeechClient();
}

function resolveProjectId(projectId) {
  const resolved =
    projectId ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    "";
  return typeof resolved === "string" ? resolved.trim() : "";
}

async function transcribeWithGoogle({
  audioBuffer,
  mimeType,
  receivedBytes,
  projectId,
  location = GOOGLE_STT_DEFAULT_LOCATION,
  model = GOOGLE_STT_DEFAULT_MODEL,
  languageCode = GOOGLE_STT_DEFAULT_LANGUAGE,
  speechClientFactory = defaultSpeechClientFactory,
  logger,
  timeoutMs = GOOGLE_STT_API_TIMEOUT_MS,
}) {
  const apiStartedAt = Date.now();
  const resolvedProjectId = resolveProjectId(projectId);
  if (!resolvedProjectId) {
    if (typeof logger?.warn === "function") {
      logger.warn("transcribeExperiment: GOOGLE_PROJECT_MISSING", {
        receivedBytes,
        provider: STT_PROVIDER_GOOGLE,
        model,
        location,
      });
    }
    return {
      ok: false,
      code: "GOOGLE_STT_ERROR",
      provider: STT_PROVIDER_GOOGLE,
      model,
      location,
      apiLatencyMs: Date.now() - apiStartedAt,
    };
  }

  let client;
  try {
    client = speechClientFactory();
  } catch (error) {
    if (typeof logger?.error === "function") {
      logger.error("transcribeExperiment: GOOGLE_CLIENT_INIT_FAILED", {
        receivedBytes,
        provider: STT_PROVIDER_GOOGLE,
        model,
        location,
        errorName: error && typeof error.name === "string" ? error.name : "Error",
      });
    }
    return {
      ok: false,
      code: "GOOGLE_STT_ERROR",
      provider: STT_PROVIDER_GOOGLE,
      model,
      location,
      apiLatencyMs: Date.now() - apiStartedAt,
    };
  }

  const request = {
    recognizer: buildRecognizerName(resolvedProjectId, location),
    config: {
      autoDecodingConfig: {},
      languageCodes: [languageCode],
      model,
      features: {
        enableAutomaticPunctuation: true,
      },
    },
    content: audioBuffer,
  };

  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const timeoutError = new Error("GOOGLE_STT_TIMEOUT");
      timeoutError.code = 4;
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    const [response] = await Promise.race([
      client.recognize(request),
      timeoutPromise,
    ]);
    const text = extractTextFromGoogleResponse(response);
    return {
      ok: true,
      text,
      provider: STT_PROVIDER_GOOGLE,
      model,
      location,
      apiLatencyMs: Date.now() - apiStartedAt,
    };
  } catch (error) {
    const code = normalizeGoogleError(error);
    if (typeof logger?.warn === "function") {
      logger.warn("transcribeExperiment: GOOGLE_STT_ERROR", {
        receivedBytes,
        provider: STT_PROVIDER_GOOGLE,
        model,
        location,
        errorCode: code,
        grpcCode:
          error && typeof error.code !== "undefined" ? error.code : null,
        apiLatencyMs: Date.now() - apiStartedAt,
      });
    }
    return {
      ok: false,
      code,
      provider: STT_PROVIDER_GOOGLE,
      model,
      location,
      apiLatencyMs: Date.now() - apiStartedAt,
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

module.exports = {
  buildRecognizerName,
  extractTextFromGoogleResponse,
  normalizeGoogleError,
  transcribeWithGoogle,
};
