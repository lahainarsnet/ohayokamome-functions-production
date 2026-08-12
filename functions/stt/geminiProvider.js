const {
  GEMINI_TRANSCRIBE_MODEL,
  STT_PROVIDER_GEMINI,
} = require("./constants");

const GEMINI_GENERATE_CONTENT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

function buildGeminiTranscribeInstruction(language) {
  if (language === "en") {
    return [
      "You are a transcription-only assistant.",
      "Transcribe the attached audio exactly as spoken.",
      "Do not summarize, rephrase, polish, or add words.",
      "Do not add explanations, labels, or quotation marks.",
      "Output only the transcript text on a single line.",
    ].join("\n");
  }
  return [
    "あなたは文字起こし専用のアシスタントです。",
    "添付音声を、聞こえた通りにそのまま文字起こししてください。",
    "要約、言い換え、敬語化、補完、説明文、引用符を付けないでください。",
    "音声にない語句を追加しないでください。",
    "出力は文字起こし本文のみを1行で返してください。",
  ].join("\n");
}

function buildGeminiSafetyInstruction(language) {
  if (language === "en") {
    return [
      "Process the attached audio according to the user's instructions.",
      "Do not invent content that is not grounded in the audio.",
      "Do not add explanations, labels, metadata, or quotation marks.",
      "Return only the requested output text on a single line.",
    ].join("\n");
  }
  return [
    "添付音声を、ユーザーの指示に従って処理してください。",
    "音声に根拠のない内容を創作しないでください。",
    "説明文、ラベル、メタデータ、引用符を付けないでください。",
    "要求された出力本文のみを1行で返してください。",
  ].join("\n");
}

function normalizeGeminiUserPrompt(prompt) {
  if (typeof prompt !== "string") {
    return null;
  }
  const trimmed = prompt.trim();
  return trimmed === "" ? null : trimmed;
}

function resolveGeminiInstructionAndUserPrompt(language, prompt) {
  const userPrompt = normalizeGeminiUserPrompt(prompt);
  if (!userPrompt) {
    return {
      instruction: buildGeminiTranscribeInstruction(language),
      userPrompt: null,
      promptForwarded: false,
    };
  }
  return {
    instruction: buildGeminiSafetyInstruction(language),
    userPrompt,
    promptForwarded: true,
  };
}

function resolveGeminiAudioMimeCandidates(mimeType) {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized === "audio/mp4" || normalized === "video/mp4") {
    return ["audio/mp4", "audio/aac"];
  }
  if (
    normalized === "audio/m4a" ||
    normalized === "audio/x-m4a" ||
    normalized === "audio/aac"
  ) {
    return ["audio/aac", "audio/mp4"];
  }
  if (!normalized) {
    return ["audio/aac"];
  }
  return [normalized];
}

function sanitizeGeminiTranscript(rawText) {
  if (typeof rawText !== "string") {
    return "";
  }
  let text = rawText.trim();
  const prefixes = [
    "Transcript:",
    "Transcription:",
    "文字起こし:",
    "文字起こし：",
  ];
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length).trim();
    }
  }
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("「") && text.endsWith("」"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function extractGeminiUsageMetadata(responseJson) {
  const usage = responseJson?.usageMetadata || {};
  return {
    inputTokens:
      typeof usage.promptTokenCount === "number" ? usage.promptTokenCount : null,
    outputTokens:
      typeof usage.candidatesTokenCount === "number"
        ? usage.candidatesTokenCount
        : null,
    thinkingTokens:
      typeof usage.thoughtsTokenCount === "number"
        ? usage.thoughtsTokenCount
        : null,
  };
}

function extractGeminiTranscriptText(responseJson) {
  const parts = responseJson?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }
  const chunks = [];
  for (const part of parts) {
    if (part && typeof part.text === "string" && part.text.trim() !== "") {
      chunks.push(part.text);
    }
  }
  return sanitizeGeminiTranscript(chunks.join("\n").trim());
}

function buildGenerateContentUrl(model, apiKey) {
  const encodedModel = encodeURIComponent(model);
  return `${GEMINI_GENERATE_CONTENT_BASE_URL}/${encodedModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function buildGeminiThinkingConfig() {
  return {
    thinkingLevel: "minimal",
  };
}

function buildGenerateContentBody({
  instruction,
  audioBase64,
  mimeType,
  userPrompt = null,
}) {
  const userParts = [];
  const normalizedUserPrompt = normalizeGeminiUserPrompt(userPrompt);
  if (normalizedUserPrompt) {
    userParts.push({ text: normalizedUserPrompt });
  }
  userParts.push({
    inlineData: {
      mimeType,
      data: audioBase64,
    },
  });
  return {
    systemInstruction: {
      parts: [{ text: instruction }],
    },
    contents: [
      {
        role: "user",
        parts: userParts,
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 512,
      thinkingConfig: buildGeminiThinkingConfig(),
    },
  };
}

function shouldRetryGeminiMime(httpStatus, responseJson) {
  if (httpStatus !== 400) {
    return false;
  }
  const message = JSON.stringify(responseJson || {}).toLowerCase();
  return (
    message.includes("mime") ||
    message.includes("audio") ||
    message.includes("invalid_argument") ||
    message.includes("unsupported")
  );
}

async function callGeminiGenerateContent({
  model,
  apiKey,
  instruction,
  audioBase64,
  mimeType,
  userPrompt = null,
  fetchImpl,
}) {
  const response = await fetchImpl(buildGenerateContentUrl(model, apiKey), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(
      buildGenerateContentBody({
        instruction,
        audioBase64,
        mimeType,
        userPrompt,
      }),
    ),
  });
  const rawBody = await response.text();
  let responseJson = null;
  try {
    responseJson = rawBody ? JSON.parse(rawBody) : null;
  } catch (_) {
    responseJson = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    responseJson,
  };
}

async function transcribeWithGemini({
  audioBuffer,
  mimeType,
  language,
  prompt = null,
  apiKey,
  receivedBytes,
  model = GEMINI_TRANSCRIBE_MODEL,
  fetchImpl = fetch,
  logger,
}) {
  const { instruction, userPrompt, promptForwarded } =
    resolveGeminiInstructionAndUserPrompt(language, prompt);
  const audioBase64 = audioBuffer.toString("base64");
  const mimeCandidates = resolveGeminiAudioMimeCandidates(mimeType);
  const apiStartedAt = Date.now();

  let lastFailure = {
    ok: false,
    code: "GEMINI_HTTP_ERROR",
    provider: STT_PROVIDER_GEMINI,
    model,
    apiLatencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
  };

  for (let index = 0; index < mimeCandidates.length; index += 1) {
    const candidateMime = mimeCandidates[index];
    let callResult;
    try {
      callResult = await callGeminiGenerateContent({
        model,
        apiKey,
        instruction,
        audioBase64,
        mimeType: candidateMime,
        userPrompt,
        fetchImpl,
      });
    } catch (error) {
      if (typeof logger?.error === "function") {
        logger.error("transcribeExperiment: GEMINI_REQUEST_FAILED", {
          fetchErrorName: error && typeof error.name === "string" ? error.name : "Error",
          receivedBytes,
          provider: STT_PROVIDER_GEMINI,
          model,
          mimeType: candidateMime,
        });
      }
      return {
        ok: false,
        code: "GEMINI_REQUEST_FAILED",
        provider: STT_PROVIDER_GEMINI,
        model,
        apiLatencyMs: Date.now() - apiStartedAt,
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
      };
    }

    const apiLatencyMs = Date.now() - apiStartedAt;
    if (!callResult.ok) {
      const canRetryMime =
        index < mimeCandidates.length - 1 &&
        shouldRetryGeminiMime(callResult.status, callResult.responseJson);
      if (canRetryMime) {
        lastFailure = {
          ok: false,
          code: "GEMINI_INVALID_AUDIO",
          provider: STT_PROVIDER_GEMINI,
          model,
          apiLatencyMs,
          inputTokens: null,
          outputTokens: null,
          thinkingTokens: null,
        };
        continue;
      }
      if (typeof logger?.warn === "function") {
        logger.warn("transcribeExperiment: GEMINI_HTTP_ERROR", {
          status: callResult.status,
          receivedBytes,
          provider: STT_PROVIDER_GEMINI,
          model,
          mimeType: candidateMime,
          apiLatencyMs,
        });
      }
      return {
        ok: false,
        code:
          callResult.status === 400 ? "GEMINI_INVALID_AUDIO" : "GEMINI_HTTP_ERROR",
        provider: STT_PROVIDER_GEMINI,
        model,
        apiLatencyMs,
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
      };
    }

    const text = extractGeminiTranscriptText(callResult.responseJson);
    const usage = extractGeminiUsageMetadata(callResult.responseJson);
    if (!text) {
      if (typeof logger?.warn === "function") {
        logger.warn("transcribeExperiment: GEMINI_EMPTY_TRANSCRIPT", {
          receivedBytes,
          provider: STT_PROVIDER_GEMINI,
          model,
          mimeType: candidateMime,
          apiLatencyMs,
        });
      }
      return {
        ok: false,
        code: "GEMINI_EMPTY_TRANSCRIPT",
        provider: STT_PROVIDER_GEMINI,
        model,
        apiLatencyMs,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thinkingTokens: usage.thinkingTokens,
      };
    }

    return {
      ok: true,
      text,
      provider: STT_PROVIDER_GEMINI,
      model,
      providerLanguage: language === "en" ? "en" : "ja",
      apiLatencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      thinkingTokens: usage.thinkingTokens,
      promptForwarded,
    };
  }

  return lastFailure;
}

module.exports = {
  buildGeminiTranscribeInstruction,
  buildGeminiSafetyInstruction,
  normalizeGeminiUserPrompt,
  resolveGeminiInstructionAndUserPrompt,
  buildGeminiThinkingConfig,
  resolveGeminiAudioMimeCandidates,
  sanitizeGeminiTranscript,
  extractGeminiUsageMetadata,
  extractGeminiTranscriptText,
  buildGenerateContentBody,
  transcribeWithGemini,
};
