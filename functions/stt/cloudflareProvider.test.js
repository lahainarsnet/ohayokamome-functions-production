const assert = require("assert");
const {
  buildCloudflareWorkersAiUrl,
  buildCloudflareRequestBody,
  classifyCloudflareHttpFailure,
  transcribeWithCloudflare,
} = require("./cloudflareProvider");
const {
  CLOUDFLARE_TRANSCRIBE_MODEL,
  STT_PROVIDER_CLOUDFLARE,
} = require("./constants");

function response({ ok, status, body }) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

async function runTests() {
  assert.strictEqual(
    buildCloudflareWorkersAiUrl("account-id"),
    `https://api.cloudflare.com/client/v4/accounts/account-id/ai/run/${CLOUDFLARE_TRANSCRIBE_MODEL}`,
  );
  const body = buildCloudflareRequestBody({
    audioBuffer: Buffer.from("audio"),
    language: "ja",
    prompt: "そのまま文字起こししてください",
  });
  assert.deepStrictEqual(body, {
    audio: Buffer.from("audio").toString("base64"),
    task: "transcribe",
    language: "ja",
    vad_filter: false,
    initial_prompt: "そのまま文字起こししてください",
  });
  assert.strictEqual(
    classifyCloudflareHttpFailure(429).code,
    "CLOUDFLARE_RATE_LIMIT",
  );
  assert.strictEqual(
    classifyCloudflareHttpFailure(400, "invalid audio format").code,
    "CLOUDFLARE_INVALID_AUDIO",
  );

  let capturedUrl;
  let capturedOptions;
  const success = await transcribeWithCloudflare({
    audioBuffer: Buffer.from("fake-audio"),
    language: "ja",
    prompt: "そのまま文字起こししてください",
    apiToken: "test-token",
    accountId: "account-id",
    gatewayId: "ohayokamome-stt-test",
    receivedBytes: 10,
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return response({
        ok: true,
        status: 200,
        body: {
          success: true,
          result: { text: "こんにちは" },
          usage: { neurons: 9.7488 },
        },
      });
    },
  });
  assert.strictEqual(success.ok, true);
  assert.strictEqual(success.text, "こんにちは");
  assert.strictEqual(success.provider, STT_PROVIDER_CLOUDFLARE);
  assert.strictEqual(success.model, CLOUDFLARE_TRANSCRIBE_MODEL);
  assert.strictEqual(success.neurons, 9.7488);
  assert.strictEqual(success.cloudflareGatewayId, "ohayokamome-stt-test");
  assert.ok(capturedUrl.endsWith(`/ai/run/${CLOUDFLARE_TRANSCRIBE_MODEL}`));
  assert.strictEqual(capturedOptions.headers.Authorization, "Bearer test-token");
  assert.strictEqual(capturedOptions.headers["cf-aig-gateway-id"], "ohayokamome-stt-test");
  assert.strictEqual(capturedOptions.headers["cf-aig-collect-log-payload"], "false");
  assert.deepStrictEqual(JSON.parse(capturedOptions.body), {
    audio: Buffer.from("fake-audio").toString("base64"),
    task: "transcribe",
    language: "ja",
    vad_filter: false,
    initial_prompt: "そのまま文字起こししてください",
  });

  const rateLimit = await transcribeWithCloudflare({
    audioBuffer: Buffer.from("a"), language: "en", apiToken: "token", accountId: "id",
    receivedBytes: 1,
    fetchImpl: async () => response({ ok: false, status: 429, body: { errors: [] } }),
  });
  assert.strictEqual(rateLimit.code, "CLOUDFLARE_RATE_LIMIT");

  const authError = await transcribeWithCloudflare({
    audioBuffer: Buffer.from("a"), language: "en", apiToken: "token", accountId: "id",
    receivedBytes: 1,
    fetchImpl: async () => response({ ok: false, status: 403, body: { errors: [] } }),
  });
  assert.strictEqual(authError.code, "CLOUDFLARE_AUTH_ERROR");

  const badResponse = await transcribeWithCloudflare({
    audioBuffer: Buffer.from("a"), language: "en", apiToken: "token", accountId: "id",
    receivedBytes: 1,
    fetchImpl: async () => response({ ok: true, status: 200, body: { success: true, result: {} } }),
  });
  assert.strictEqual(badResponse.code, "CLOUDFLARE_BAD_RESPONSE");

  const timeout = await transcribeWithCloudflare({
    audioBuffer: Buffer.from("a"), language: "en", apiToken: "token", accountId: "id",
    receivedBytes: 1, timeoutMs: 10,
    fetchImpl: async (_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });
  assert.strictEqual(timeout.code, "CLOUDFLARE_TIMEOUT");
  console.log("stt/cloudflareProvider.test.js: all tests passed");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
