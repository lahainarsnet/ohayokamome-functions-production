const assert = require("assert");
const { transcribeWithGroq, classifyGroqHttpFailure } = require("./groqProvider");
const {
  GROQ_TRANSCRIBE_URL,
  GROQ_TRANSCRIBE_MODEL,
  GROQ_STT_API_TIMEOUT_MS,
  STT_PROVIDER_GROQ,
} = require("./constants");

function createFetchMock(handler) {
  return async (url, options) => handler(url, options);
}

function runTests() {
  const audioBuffer = Buffer.from("fake-audio");
  const mimeType = "audio/mp4";
  const apiKey = "test-key";
  const receivedBytes = audioBuffer.length;

  let capturedUrl;
  let capturedMethod;
  let capturedAuth;
  let capturedBodyEntries = [];

  const successFetch = createFetchMock(async (url, options) => {
    capturedUrl = url;
    capturedMethod = options.method;
    capturedAuth = options.headers.Authorization;
    if (options.body && typeof options.body.entries === "function") {
      for (const [key, value] of options.body.entries()) {
        if (value instanceof Blob) {
          capturedBodyEntries.push([key, `blob:${value.type}`]);
        } else {
          capturedBodyEntries.push([key, value]);
        }
      }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ text: "こんにちは" }),
    };
  });

  (async () => {
    const result = await transcribeWithGroq({
      audioBuffer,
      mimeType,
      language: "ja",
      apiKey,
      receivedBytes,
      fetchImpl: successFetch,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, "こんにちは");
    assert.strictEqual(result.provider, STT_PROVIDER_GROQ);
    assert.strictEqual(result.model, GROQ_TRANSCRIBE_MODEL);
    assert.strictEqual(result.providerLanguage, "ja");
    assert.strictEqual(typeof result.apiLatencyMs, "number");

    assert.strictEqual(capturedUrl, GROQ_TRANSCRIBE_URL);
    assert.strictEqual(capturedMethod, "POST");
    assert.strictEqual(capturedAuth, "Bearer test-key");
    assert.deepStrictEqual(capturedBodyEntries, [
      ["file", "blob:audio/mp4"],
      ["model", GROQ_TRANSCRIBE_MODEL],
      ["response_format", "json"],
      ["language", "ja"],
      ["temperature", "0"],
    ]);

    const promptFetch = createFetchMock(async (url, options) => {
      capturedBodyEntries = [];
      if (options.body && typeof options.body.entries === "function") {
        for (const [key, value] of options.body.entries()) {
          if (value instanceof Blob) {
            capturedBodyEntries.push([key, `blob:${value.type}`]);
          } else {
            capturedBodyEntries.push([key, value]);
          }
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: "prompted" }),
      };
    });
    const promptResult = await transcribeWithGroq({
      audioBuffer,
      mimeType,
      language: "ja",
      prompt:
        "聞こえた内容をできるだけそのまま文字起こししてください。言い換えや補完はしないでください",
      apiKey,
      receivedBytes,
      fetchImpl: promptFetch,
    });
    assert.strictEqual(promptResult.ok, true);
    assert.strictEqual(promptResult.promptForwarded, true);
    const promptEntry = capturedBodyEntries.find(([key]) => key === "prompt");
    assert.ok(promptEntry);
    assert.strictEqual(
      promptEntry[1],
      "聞こえた内容をできるだけそのまま文字起こししてください。言い換えや補完はしないでください",
    );
    assert.ok(promptEntry[1].includes("そのまま"));
    assert.ok(promptEntry[1].includes("言い換え"));
    assert.ok(promptEntry[1].includes("補完"));

    const rateLimitFetch = createFetchMock(async () => ({
      ok: false,
      status: 429,
      text: async () =>
        JSON.stringify({ error: { type: "rate_limit_exceeded", code: "rate_limit" } }),
    }));
    const rateLimit = await transcribeWithGroq({
      audioBuffer,
      mimeType,
      language: "ja",
      apiKey,
      receivedBytes,
      fetchImpl: rateLimitFetch,
    });
    assert.strictEqual(rateLimit.ok, false);
    assert.strictEqual(rateLimit.code, "GROQ_RATE_LIMIT");
    assert.strictEqual(rateLimit.errorCategory, "rate_limit");

    const authFetch = createFetchMock(async () => ({
      ok: false,
      status: 401,
      text: async () =>
        JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_api_key" } }),
    }));
    const authError = await transcribeWithGroq({
      audioBuffer,
      mimeType,
      language: "ja",
      apiKey,
      receivedBytes,
      fetchImpl: authFetch,
    });
    assert.strictEqual(authError.ok, false);
    assert.strictEqual(authError.code, "GROQ_AUTH_ERROR");
    assert.strictEqual(authError.errorCategory, "authentication_error");

    const invalidAudioFetch = createFetchMock(async () => ({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { type: "invalid_request_error", code: "invalid_audio_format" } }),
    }));
    const invalidAudio = await transcribeWithGroq({
      audioBuffer,
      mimeType,
      language: "ja",
      apiKey,
      receivedBytes,
      fetchImpl: invalidAudioFetch,
    });
    assert.strictEqual(invalidAudio.ok, false);
    assert.strictEqual(invalidAudio.code, "GROQ_INVALID_AUDIO");
    assert.strictEqual(invalidAudio.errorCategory, "invalid_audio");

    const httpErrorFetch = createFetchMock(async () => ({
      ok: false,
      status: 500,
      text: async () =>
        JSON.stringify({ error: { type: "server_error", code: "internal_error" } }),
    }));
    const httpError = await transcribeWithGroq({
      audioBuffer,
      mimeType,
      language: "ja",
      apiKey,
      receivedBytes,
      fetchImpl: httpErrorFetch,
    });
    assert.strictEqual(httpError.ok, false);
    assert.strictEqual(httpError.code, "GROQ_HTTP_ERROR");
    assert.strictEqual(httpError.errorCategory, "http_error");

    const requestFailedFetch = async () => {
      throw new Error("network down");
    };
    const requestFailed = await transcribeWithGroq({
      audioBuffer,
      mimeType,
      language: "ja",
      apiKey,
      receivedBytes,
      fetchImpl: requestFailedFetch,
    });
    assert.strictEqual(requestFailed.ok, false);
    assert.strictEqual(requestFailed.code, "GROQ_REQUEST_FAILED");
    assert.strictEqual(requestFailed.errorCategory, "network_error");

    let abortSignalSeen = false;
    const timeoutFetch = async (_url, options) => {
      abortSignalSeen = Boolean(options.signal);
      return new Promise(() => {});
    };
    const timeoutResult = await transcribeWithGroq({
      audioBuffer,
      mimeType,
      language: "ja",
      apiKey,
      receivedBytes,
      fetchImpl: timeoutFetch,
      timeoutMs: 20,
    });
    assert.strictEqual(abortSignalSeen, true);
    assert.strictEqual(timeoutResult.ok, false);
    assert.strictEqual(timeoutResult.code, "GROQ_TIMEOUT");
    assert.strictEqual(timeoutResult.errorCategory, "timeout");

    const badJsonFetch = createFetchMock(async () => ({
      ok: true,
      status: 200,
      text: async () => "not-json",
    }));
    const badJson = await transcribeWithGroq({
      audioBuffer,
      mimeType,
      language: "ja",
      apiKey,
      receivedBytes,
      fetchImpl: badJsonFetch,
    });
    assert.strictEqual(badJson.ok, false);
    assert.strictEqual(badJson.code, "GROQ_BAD_RESPONSE");

    const longPromptFetch = createFetchMock(async (url, options) => {
      capturedBodyEntries = [];
      if (options.body && typeof options.body.entries === "function") {
        for (const [key, value] of options.body.entries()) {
          capturedBodyEntries.push([key, value instanceof Blob ? `blob:${value.type}` : value]);
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ text: "truncated prompt ok" }),
      };
    });
    const longPromptResult = await transcribeWithGroq({
      audioBuffer,
      mimeType,
      language: "ja",
      prompt: "地名".repeat(500),
      apiKey,
      receivedBytes,
      fetchImpl: longPromptFetch,
    });
    assert.strictEqual(longPromptResult.ok, true);
    assert.strictEqual(longPromptResult.promptTruncated, true);
    const longPromptEntry = capturedBodyEntries.find(([key]) => key === "prompt");
    assert.ok(longPromptEntry);
    assert.ok(longPromptEntry[1].length < 500);

    assert.deepStrictEqual(classifyGroqHttpFailure(429, "rate_limit_exceeded", "rate_limit"), {
      code: "GROQ_RATE_LIMIT",
      errorCategory: "rate_limit",
    });
    assert.strictEqual(GROQ_STT_API_TIMEOUT_MS, 25000);

    console.log("stt/groqProvider.test.js: all tests passed");
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

runTests();
