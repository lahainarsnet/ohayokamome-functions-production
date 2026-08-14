const assert = require("assert");
const {
  normalizeGeminiUserPrompt,
  resolveGeminiInstructionAndUserPrompt,
  resolveGeminiAudioMimeCandidates,
  sanitizeGeminiTranscript,
  extractGeminiUsageMetadata,
  extractGeminiTranscriptText,
  buildGeminiThinkingConfig,
  buildGenerateContentBody,
  transcribeWithGemini,
} = require("./geminiProvider");
const {
  GEMINI_TRANSCRIBE_MODEL,
  STT_PROVIDER_GEMINI,
} = require("./constants");

const FIRESTORE_CANONICAL_PROMPT =
  "聞こえた内容をできるだけそのまま文字起こししてください。言い換えや補完はしないでください";

function createFetchMock(handler) {
  return async (url, options) => handler(url, options);
}

async function runTests() {
  assert.strictEqual(normalizeGeminiUserPrompt(undefined), null);
  assert.strictEqual(normalizeGeminiUserPrompt("   "), null);
  assert.strictEqual(normalizeGeminiUserPrompt("  hello  "), "hello");

  const noPromptPlan = resolveGeminiInstructionAndUserPrompt("ja", null);
  assert.strictEqual(noPromptPlan.instruction, null);
  assert.strictEqual(noPromptPlan.userPrompt, null);
  assert.strictEqual(noPromptPlan.promptForwarded, false);

  const withPromptPlan = resolveGeminiInstructionAndUserPrompt(
    "ja",
    FIRESTORE_CANONICAL_PROMPT,
  );
  assert.strictEqual(withPromptPlan.instruction, FIRESTORE_CANONICAL_PROMPT);
  assert.strictEqual(withPromptPlan.userPrompt, null);
  assert.strictEqual(withPromptPlan.promptForwarded, true);

  assert.deepStrictEqual(resolveGeminiAudioMimeCandidates("audio/mp4"), [
    "audio/mp4",
    "audio/aac",
  ]);
  assert.deepStrictEqual(resolveGeminiAudioMimeCandidates("audio/m4a"), [
    "audio/aac",
    "audio/mp4",
  ]);
  assert.deepStrictEqual(resolveGeminiAudioMimeCandidates("audio/aac"), [
    "audio/aac",
    "audio/mp4",
  ]);

  assert.strictEqual(sanitizeGeminiTranscript('"こんにちは"'), "こんにちは");
  assert.strictEqual(sanitizeGeminiTranscript("「おはよう」"), "おはよう");
  assert.strictEqual(
    sanitizeGeminiTranscript("文字起こし：テスト"),
    "テスト",
  );

  assert.deepStrictEqual(
    extractGeminiUsageMetadata({
      usageMetadata: {
        promptTokenCount: 320,
        candidatesTokenCount: 12,
        thoughtsTokenCount: 0,
      },
    }),
    {
      inputTokens: 320,
      outputTokens: 12,
      thinkingTokens: 0,
    },
  );

  assert.strictEqual(
    extractGeminiTranscriptText({
      candidates: [{ content: { parts: [{ text: "  テスト  " }] } }],
    }),
    "テスト",
  );

  const body = buildGenerateContentBody({
    instruction: "test",
    audioBase64: "abc",
    mimeType: "audio/mp4",
  });
  assert.deepStrictEqual(
    buildGeminiThinkingConfig(),
    body.generationConfig.thinkingConfig,
  );
  assert.strictEqual(body.generationConfig.thinkingConfig.thinkingLevel, "minimal");
  assert.strictEqual(body.generationConfig.temperature, 0);
  assert.strictEqual(body.systemInstruction.parts[0].text, "test");
  assert.strictEqual(body.contents[0].parts.length, 1);
  assert.ok(body.contents[0].parts[0].inlineData);

  const noInstructionBody = buildGenerateContentBody({
    audioBase64: "abc",
    mimeType: "audio/mp4",
  });
  assert.strictEqual(noInstructionBody.systemInstruction, undefined);
  assert.strictEqual(noInstructionBody.contents[0].parts.length, 1);
  assert.ok(noInstructionBody.contents[0].parts[0].inlineData);

  const promptBody = buildGenerateContentBody({
    instruction: FIRESTORE_CANONICAL_PROMPT,
    audioBase64: "abc",
    mimeType: "audio/mp4",
  });
  assert.strictEqual(
    promptBody.systemInstruction.parts[0].text,
    FIRESTORE_CANONICAL_PROMPT,
  );
  assert.strictEqual(promptBody.contents[0].parts.length, 1);
  assert.strictEqual(promptBody.contents[0].parts[0].inlineData.mimeType, "audio/mp4");

  const emptyPromptBody = buildGenerateContentBody({
    instruction: "   ",
    audioBase64: "abc",
    mimeType: "audio/mp4",
  });
  assert.strictEqual(emptyPromptBody.systemInstruction, undefined);
  assert.strictEqual(emptyPromptBody.contents[0].parts.length, 1);
  assert.ok(emptyPromptBody.contents[0].parts[0].inlineData);

  function findInlineDataPart(parts) {
    return parts.find((part) => part && part.inlineData);
  }

  const audioBuffer = Buffer.from("fake-audio");
  let capturedUrl;
  let capturedBody;
  const successFetch = createFetchMock(async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "おはよう" }] } }],
          usageMetadata: {
            promptTokenCount: 320,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 0,
          },
        }),
    };
  });

  const successResult = await transcribeWithGemini({
    audioBuffer,
    mimeType: "audio/mp4",
    language: "ja",
    apiKey: "test-key",
    receivedBytes: audioBuffer.length,
    fetchImpl: successFetch,
  });
  assert.strictEqual(successResult.ok, true);
  assert.strictEqual(successResult.text, "おはよう");
  assert.strictEqual(successResult.provider, STT_PROVIDER_GEMINI);
  assert.strictEqual(successResult.model, GEMINI_TRANSCRIBE_MODEL);
  assert.strictEqual(successResult.inputTokens, 320);
  assert.strictEqual(successResult.outputTokens, 4);
  assert.strictEqual(successResult.thinkingTokens, 0);
  assert.ok(capturedUrl.includes(GEMINI_TRANSCRIBE_MODEL));
  assert.ok(capturedUrl.includes("key=test-key"));
  assert.strictEqual(
    capturedBody.generationConfig.thinkingConfig.thinkingLevel,
    "minimal",
  );
  assert.strictEqual(capturedBody.contents[0].parts.length, 1);
  assert.strictEqual(capturedBody.systemInstruction, undefined);
  assert.strictEqual(successResult.promptForwarded, false);

  let promptCapturedBody;
  const promptFetch = createFetchMock(async (url, options) => {
    promptCapturedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "Good morning" }] } }],
          usageMetadata: {
            promptTokenCount: 360,
            candidatesTokenCount: 3,
            thoughtsTokenCount: 0,
          },
        }),
    };
  });
  const promptResult = await transcribeWithGemini({
    audioBuffer,
    mimeType: "audio/mp4",
    language: "ja",
    prompt: FIRESTORE_CANONICAL_PROMPT,
    apiKey: "test-key",
    receivedBytes: audioBuffer.length,
    fetchImpl: promptFetch,
  });
  assert.strictEqual(promptResult.ok, true);
  assert.strictEqual(promptResult.text, "Good morning");
  assert.strictEqual(promptResult.promptForwarded, true);
  assert.strictEqual(
    promptCapturedBody.systemInstruction.parts[0].text,
    FIRESTORE_CANONICAL_PROMPT,
  );
  assert.strictEqual(promptCapturedBody.contents[0].parts.length, 1);
  assert.ok(promptCapturedBody.contents[0].parts[0].inlineData);

  const blankPromptFetch = createFetchMock(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "おはよう" }] } }],
        usageMetadata: {
          promptTokenCount: 320,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 0,
        },
      }),
  }));
  let blankCapturedBody;
  const blankPromptFetchWithCapture = createFetchMock(async (url, options) => {
    blankCapturedBody = JSON.parse(options.body);
    return blankPromptFetch(url, options);
  });
  const blankPromptResult = await transcribeWithGemini({
    audioBuffer,
    mimeType: "audio/mp4",
    language: "ja",
    prompt: "   ",
    apiKey: "test-key",
    receivedBytes: audioBuffer.length,
    fetchImpl: blankPromptFetchWithCapture,
  });
  assert.strictEqual(blankPromptResult.ok, true);
  assert.strictEqual(blankPromptResult.promptForwarded, false);
  assert.strictEqual(blankCapturedBody.systemInstruction, undefined);
  assert.strictEqual(blankCapturedBody.contents[0].parts.length, 1);
  assert.ok(blankCapturedBody.contents[0].parts[0].inlineData);

  let callCount = 0;
  const mimeFallbackFetch = createFetchMock(async (url, options) => {
    callCount += 1;
    const parsed = JSON.parse(options.body);
    const inlinePart = findInlineDataPart(parsed.contents[0].parts);
    if (inlinePart.inlineData.mimeType === "audio/mp4") {
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({
            error: {
              code: 400,
              message: "Unsupported mime type audio/mp4",
              status: "INVALID_ARGUMENT",
            },
          }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "fallback ok" }] } }],
          usageMetadata: {
            promptTokenCount: 384,
            candidatesTokenCount: 3,
            thoughtsTokenCount: 0,
          },
        }),
    };
  });
  const fallbackResult = await transcribeWithGemini({
    audioBuffer,
    mimeType: "audio/mp4",
    language: "ja",
    apiKey: "test-key",
    receivedBytes: audioBuffer.length,
    fetchImpl: mimeFallbackFetch,
  });
  assert.strictEqual(fallbackResult.ok, true);
  assert.strictEqual(fallbackResult.text, "fallback ok");
  assert.strictEqual(callCount, 2);

  const explanationFetch = createFetchMock(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'Transcript: "こんにちは"' }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 320,
          candidatesTokenCount: 8,
          thoughtsTokenCount: 0,
        },
      }),
  }));
  const sanitizedResult = await transcribeWithGemini({
    audioBuffer,
    mimeType: "audio/aac",
    language: "ja",
    apiKey: "test-key",
    receivedBytes: audioBuffer.length,
    fetchImpl: explanationFetch,
  });
  assert.strictEqual(sanitizedResult.ok, true);
  assert.strictEqual(sanitizedResult.text, "こんにちは");

  const httpErrorFetch = createFetchMock(async () => ({
    ok: false,
    status: 503,
    text: async () => JSON.stringify({ error: { message: "unavailable" } }),
  }));
  const httpErrorResult = await transcribeWithGemini({
    audioBuffer,
    mimeType: "audio/aac",
    language: "ja",
    apiKey: "test-key",
    receivedBytes: audioBuffer.length,
    fetchImpl: httpErrorFetch,
  });
  assert.strictEqual(httpErrorResult.ok, false);
  assert.strictEqual(httpErrorResult.code, "GEMINI_HTTP_ERROR");

  const emptyFetch = createFetchMock(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "   " }] } }],
        usageMetadata: {
          promptTokenCount: 320,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
        },
      }),
  }));
  const emptyResult = await transcribeWithGemini({
    audioBuffer,
    mimeType: "audio/aac",
    language: "ja",
    apiKey: "test-key",
    receivedBytes: audioBuffer.length,
    fetchImpl: emptyFetch,
  });
  assert.strictEqual(emptyResult.ok, false);
  assert.strictEqual(emptyResult.code, "GEMINI_EMPTY_TRANSCRIPT");

  console.log("stt/geminiProvider.test.js: all tests passed");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
