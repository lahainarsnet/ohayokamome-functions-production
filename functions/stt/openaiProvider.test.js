const assert = require("assert");
const { transcribeWithOpenAI } = require("./openaiProvider");
const {
  OPENAI_TRANSCRIBE_MODEL,
  STT_PROVIDER_OPENAI,
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
    const result = await transcribeWithOpenAI({
      audioBuffer,
      mimeType,
      apiKey,
      receivedBytes,
      fetchImpl: successFetch,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.text, "こんにちは");
    assert.strictEqual(result.provider, STT_PROVIDER_OPENAI);
    assert.strictEqual(result.model, OPENAI_TRANSCRIBE_MODEL);
    assert.strictEqual(typeof result.apiLatencyMs, "number");

    assert.strictEqual(
      capturedUrl,
      "https://api.openai.com/v1/audio/transcriptions",
    );
    assert.strictEqual(capturedMethod, "POST");
    assert.strictEqual(capturedAuth, "Bearer test-key");
    assert.deepStrictEqual(capturedBodyEntries, [
      ["file", "blob:audio/mp4"],
      ["model", OPENAI_TRANSCRIBE_MODEL],
      ["response_format", "json"],
    ]);

    const m4aFetch = createFetchMock(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ text: "ok" }),
    }));
    await transcribeWithOpenAI({
      audioBuffer,
      mimeType: "audio/m4a",
      apiKey,
      receivedBytes,
      fetchImpl: m4aFetch,
    });

    const httpErrorFetch = createFetchMock(async () => ({
      ok: false,
      status: 429,
      text: async () =>
        JSON.stringify({ error: { type: "rate_limit_exceeded" } }),
    }));
    const httpError = await transcribeWithOpenAI({
      audioBuffer,
      mimeType,
      apiKey,
      receivedBytes,
      fetchImpl: httpErrorFetch,
    });
    assert.strictEqual(httpError.ok, false);
    assert.strictEqual(httpError.code, "OPENAI_HTTP_ERROR");

    const requestFailedFetch = async () => {
      throw new Error("network down");
    };
    const requestFailed = await transcribeWithOpenAI({
      audioBuffer,
      mimeType,
      apiKey,
      receivedBytes,
      fetchImpl: requestFailedFetch,
    });
    assert.strictEqual(requestFailed.ok, false);
    assert.strictEqual(requestFailed.code, "OPENAI_REQUEST_FAILED");

    const badJsonFetch = createFetchMock(async () => ({
      ok: true,
      status: 200,
      text: async () => "not-json",
    }));
    const badJson = await transcribeWithOpenAI({
      audioBuffer,
      mimeType,
      apiKey,
      receivedBytes,
      fetchImpl: badJsonFetch,
    });
    assert.strictEqual(badJson.ok, false);
    assert.strictEqual(badJson.code, "OPENAI_BAD_RESPONSE");

    const noTextFetch = createFetchMock(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ transcript: "missing text field" }),
    }));
    const noText = await transcribeWithOpenAI({
      audioBuffer,
      mimeType,
      apiKey,
      receivedBytes,
      fetchImpl: noTextFetch,
    });
    assert.strictEqual(noText.ok, false);
    assert.strictEqual(noText.code, "OPENAI_BAD_RESPONSE");

    console.log("stt/openaiProvider.test.js: all tests passed");
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

runTests();
