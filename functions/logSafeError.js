// Log-only error summaries. No dependencies, no side effects, never throws.
// Keeps what is needed to locate a failure (stage, type, code, status, file:line)
// and a short redacted message; drops full stacks and raw provider messages.

const MAX_INPUT_LENGTH = 4000;
const MAX_MESSAGE_LENGTH = 300;
const MAX_STACK_INPUT_LENGTH = 20000;
const MAX_STACK_LOCATIONS = 8;
const SAFE_NAME = /^[A-Za-z0-9_.]{1,64}$/;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

function redactLogText(value, maxLength = MAX_MESSAGE_LENGTH) {
  try {
    if (value == null) return null;
    const text = String(value).slice(0, MAX_INPUT_LENGTH)
      .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
      .replace(/\b((?:access_?|id_?|refresh_?)?token|key|signature|sig|secret)=[^&\s,;"']+/gi, "$1=[REDACTED]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]")
      .replace(/documents\/[^\s"'`,;)]+/g, "documents/[DOC_PATH_REDACTED]")
      .replace(/\busers\/[^/\s"'`,;)?]+/g, "users/[UID_REDACTED]")
      .replace(/\bios_\d+/g, "ios_[ID_REDACTED]")
      .replace(/\d{10,}/g, "[NUM_REDACTED]")
      .replace(/\b(?:GPA\.[A-Za-z0-9._~-]{12,}|[A-Za-z0-9_-]{48,})\b/g, "[OPAQUE_TOKEN_REDACTED]");
    return text.length > maxLength ? `${text.slice(0, maxLength)}[TRUNCATED]` : text;
  } catch (_) {
    return "[UNREADABLE]";
  }
}

function stackLocations(stack) {
  try {
    if (typeof stack !== "string" || !stack) return [];
    return [...stack.slice(0, MAX_STACK_INPUT_LENGTH)
      .matchAll(/(?:^|[/\\(\s])([A-Za-z0-9_.-]+\.m?js:\d+(?::\d+)?)/gm)]
      .slice(0, MAX_STACK_LOCATIONS)
      .map((match) => match[1]);
  } catch (_) {
    return [];
  }
}

function safeName(value) {
  return typeof value === "string" && SAFE_NAME.test(value) ? value : null;
}

function safeCode(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && SAFE_CODE.test(value)) return value;
  return value == null ? null : "redacted";
}

function safeStatus(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarize(error) {
  if (error == null) {
    return { errorType: String(error), errorName: null, errorCode: null, errorStatus: null,
      errorMessage: null, errorStackLocations: [] };
  }
  if (typeof error !== "object" && typeof error !== "function") {
    return { errorType: typeof error, errorName: null, errorCode: null, errorStatus: null,
      errorMessage: redactLogText(error), errorStackLocations: [] };
  }
  return {
    errorType: safeName(error.constructor?.name) || "Error",
    errorName: safeName(error.name),
    errorCode: safeCode(error.code ?? error.apiError ?? null),
    errorStatus: safeStatus(error.status ?? error.httpStatusCode ?? error.response?.status ?? null),
    errorMessage: redactLogText(error.message ?? error.errorMessage ?? null),
    errorStackLocations: stackLocations(error.stack),
  };
}

function safeErrorLogFields(error, stage) {
  try {
    const fields = { stage: safeName(stage) || "unknown", ...summarize(error) };
    let cause = null;
    try {
      // One level only: a circular cause chain cannot loop.
      if (error && typeof error === "object" && error.cause != null && error.cause !== error) {
        cause = summarize(error.cause);
      }
    } catch (_) {
      cause = { errorType: "Error", errorMessage: "[UNREADABLE]" };
    }
    fields.errorCause = cause;
    return fields;
  } catch (_) {
    return { stage: "unknown", errorType: "Error", errorMessage: "[UNREADABLE]", errorStackLocations: [] };
  }
}

function safeLookupErrorsForLog(lookupErrors) {
  try {
    if (!Array.isArray(lookupErrors)) return lookupErrors == null ? null : "redacted";
    return lookupErrors.slice(0, 10).map((entry) => ({
      environment: safeName(entry?.environment),
      status: safeStatus(entry?.status),
      appleErrorCode: safeCode(entry?.appleErrorCode ?? null),
      appleErrorMessage: redactLogText(entry?.appleErrorMessage ?? null, 200),
    }));
  } catch (_) {
    return "redacted";
  }
}

module.exports = {
  safeErrorLogFields,
  safeLookupErrorsForLog,
  redactLogText,
  stackLocations,
};
