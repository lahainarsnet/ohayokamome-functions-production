const {
  STT_PROVIDER_GOOGLE,
  GOOGLE_STT_DEFAULT_MODEL,
  GOOGLE_STT_DEFAULT_LOCATION,
  GOOGLE_STT_API_TIMEOUT_MS,
} = require("./constants");
const { toGoogleLanguageCode } = require("./language");

const GOOGLE_ERROR_MESSAGE_MAX_LEN = 300;
const GOOGLE_ERROR_DETAIL_MAX_LEN = 200;

function buildRecognizerName(projectId, location) {
  return `projects/${projectId}/locations/${location}/recognizers/_`;
}

function buildSpeechApiEndpoint(location) {
  const normalized = typeof location === "string" ? location.trim() : "";
  if (!normalized || normalized === "global") {
    return "speech.googleapis.com";
  }
  return `${normalized}-speech.googleapis.com`;
}

function summarizeGoogleText(value, maxLen = GOOGLE_ERROR_MESSAGE_MAX_LEN) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}...` : trimmed;
}

function extractFieldViolations(error) {
  const violations = [];
  const candidates = [];

  if (Array.isArray(error?.statusDetails)) {
    candidates.push(...error.statusDetails);
  }
  if (Array.isArray(error?.details)) {
    candidates.push(...error.details);
  }
  if (error?.response?.data?.error?.details) {
    const responseDetails = error.response.data.error.details;
    if (Array.isArray(responseDetails)) {
      candidates.push(...responseDetails);
    }
  }

  for (const detail of candidates) {
    if (!detail || typeof detail !== "object") {
      continue;
    }
    const fieldViolations = detail.fieldViolations;
    if (!Array.isArray(fieldViolations)) {
      continue;
    }
    for (const violation of fieldViolations) {
      if (!violation || typeof violation !== "object") {
        continue;
      }
      violations.push({
        field:
          typeof violation.field === "string" ? violation.field.slice(0, 120) : null,
        description: summarizeGoogleText(
          violation.description,
          GOOGLE_ERROR_DETAIL_MAX_LEN,
        ),
      });
    }
  }

  return violations;
}

function extractSafeGoogleErrorDiagnostics(error) {
  const messageSummary = summarizeGoogleText(error?.message);
  const fieldViolations = extractFieldViolations(error);
  const detailsSummaryParts = [];

  if (Array.isArray(error?.details)) {
    for (const detail of error.details) {
      if (typeof detail === "string") {
        const summary = summarizeGoogleText(detail, GOOGLE_ERROR_DETAIL_MAX_LEN);
        if (summary) {
          detailsSummaryParts.push(summary);
        }
      } else if (detail && typeof detail === "object" && typeof detail["@type"] === "string") {
        detailsSummaryParts.push(detail["@type"].slice(0, 120));
      }
    }
  }

  const responseError = error?.response?.data?.error;
  if (responseError && typeof responseError === "object") {
    const status = summarizeGoogleText(responseError.status, 80);
    const responseMessage = summarizeGoogleText(
      responseError.message,
      GOOGLE_ERROR_DETAIL_MAX_LEN,
    );
    if (status) {
      detailsSummaryParts.push(status);
    }
    if (responseMessage) {
      detailsSummaryParts.push(responseMessage);
    }
  }

  return {
    grpcCode:
      error && typeof error.code !== "undefined" ? error.code : null,
    messageSummary,
    detailsSummary:
      detailsSummaryParts.length > 0
        ? detailsSummaryParts.join(" | ").slice(0, GOOGLE_ERROR_MESSAGE_MAX_LEN)
        : null,
    fieldViolations,
  };
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

function defaultSpeechClientFactory(location = GOOGLE_STT_DEFAULT_LOCATION) {
  const { SpeechClient } = require("@google-cloud/speech").v2;
  return new SpeechClient({
    apiEndpoint: buildSpeechApiEndpoint(location),
  });
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
  language,
  receivedBytes,
  projectId,
  location = GOOGLE_STT_DEFAULT_LOCATION,
  model = GOOGLE_STT_DEFAULT_MODEL,
  speechClientFactory,
  logger,
  timeoutMs = GOOGLE_STT_API_TIMEOUT_MS,
}) {
  const apiStartedAt = Date.now();
  const googleLanguageCode = toGoogleLanguageCode(language);
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

  const clientFactory =
    speechClientFactory ||
    (() => defaultSpeechClientFactory(location));

  let client;
  try {
    client = clientFactory();
  } catch (error) {
    if (typeof logger?.error === "function") {
      logger.error("transcribeExperiment: GOOGLE_CLIENT_INIT_FAILED", {
        receivedBytes,
        provider: STT_PROVIDER_GOOGLE,
        model,
        location,
        apiEndpoint: buildSpeechApiEndpoint(location),
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
      languageCodes: [googleLanguageCode],
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
      providerLanguage: googleLanguageCode,
      apiLatencyMs: Date.now() - apiStartedAt,
    };
  } catch (error) {
    const code = normalizeGoogleError(error);
    const diagnostics = extractSafeGoogleErrorDiagnostics(error);
    if (typeof logger?.warn === "function") {
      logger.warn("transcribeExperiment: GOOGLE_STT_ERROR", {
        receivedBytes,
        provider: STT_PROVIDER_GOOGLE,
        model,
        location,
        apiEndpoint: buildSpeechApiEndpoint(location),
        errorCode: code,
        grpcCode: diagnostics.grpcCode,
        messageSummary: diagnostics.messageSummary,
        detailsSummary: diagnostics.detailsSummary,
        fieldViolations: diagnostics.fieldViolations,
        apiLatencyMs: Date.now() - apiStartedAt,
      });
    }
    return {
      ok: false,
      code,
      provider: STT_PROVIDER_GOOGLE,
      model,
      location,
      providerLanguage: googleLanguageCode,
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
  buildSpeechApiEndpoint,
  extractSafeGoogleErrorDiagnostics,
  extractTextFromGoogleResponse,
  normalizeGoogleError,
  transcribeWithGoogle,
};
