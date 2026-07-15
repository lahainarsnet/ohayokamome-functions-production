const assert = require("assert");
const {
  MAX_AUDIO_BYTES,
  STT_PROVIDER_OPENAI,
  STT_PROVIDER_GOOGLE,
} = require("./stt/constants");
const {
  resolveSttProvider,
  resolveSttLanguage,
  invokeSttProvider,
  uidSuffix,
  getJstDateKey,
} = require("./transcribeExperiment");

function mapProviderResultToClient(providerResult) {
  if (!providerResult.ok) {
    return { ok: false, code: providerResult.code };
  }
  return { ok: true, text: providerResult.text };
}

function validateAuth(request) {
  const uid = request.auth?.uid || null;
  if (!uid) {
    return { ok: false, code: "UNAUTHENTICATED" };
  }
  return { ok: true, uid };
}

function validateTranscribePayload(data) {
  const { audioBase64, mimeType } = data || {};
  if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
    return { ok: false, code: "MISSING_AUDIO_BASE64" };
  }
  if (typeof mimeType !== "string" || mimeType.trim() === "") {
    return { ok: false, code: "MISSING_MIME_TYPE" };
  }

  let buf;
  try {
    buf = Buffer.from(audioBase64, "base64");
  } catch (_) {
    return { ok: false, code: "INVALID_BASE64" };
  }

  const receivedBytes = buf.length;
  if (receivedBytes > MAX_AUDIO_BYTES) {
    return { ok: false, code: "AUDIO_TOO_LARGE", receivedBytes };
  }

  return {
    ok: true,
    audioBuffer: buf,
    mimeType,
    receivedBytes,
  };
}

async function runTests() {
  assert.strictEqual(uidSuffix("abcdefghijklmnop"), "klmnop");
  assert.strictEqual(uidSuffix("abc"), "abc");
  assert.strictEqual(uidSuffix(null), "none");

  const jstKey = getJstDateKey(new Date("2026-06-26T14:00:00.000Z"));
  assert.strictEqual(jstKey, "2026-06-26");

  const openaiProvider = resolveSttProvider("openai");
  assert.strictEqual(openaiProvider.ok, true);
  assert.strictEqual(openaiProvider.provider, STT_PROVIDER_OPENAI);

  const googleProvider = resolveSttProvider("google");
  assert.strictEqual(googleProvider.ok, true);
  assert.strictEqual(googleProvider.provider, STT_PROVIDER_GOOGLE);

  const typoProvider = resolveSttProvider("openai2");
  assert.strictEqual(typoProvider.ok, false);
  assert.strictEqual(typoProvider.code, "STT_PROVIDER_INVALID");

  const jaLanguage = resolveSttLanguage("ja");
  assert.strictEqual(jaLanguage.ok, true);
  assert.strictEqual(jaLanguage.language, "ja");

  const enLanguage = resolveSttLanguage("en");
  assert.strictEqual(enLanguage.ok, true);
  assert.strictEqual(enLanguage.language, "en");

  const defaultLanguage = resolveSttLanguage(undefined);
  assert.strictEqual(defaultLanguage.ok, true);
  assert.strictEqual(defaultLanguage.language, "ja");

  const emptyLanguage = resolveSttLanguage("");
  assert.strictEqual(emptyLanguage.ok, true);
  assert.strictEqual(emptyLanguage.language, "ja");

  const invalidLanguage = resolveSttLanguage("fr");
  assert.strictEqual(invalidLanguage.ok, false);
  assert.strictEqual(invalidLanguage.code, "STT_LANGUAGE_INVALID");

  const unauth = validateAuth({ auth: null });
  assert.deepStrictEqual(unauth, { ok: false, code: "UNAUTHENTICATED" });

  const missingAudio = validateTranscribePayload({ mimeType: "audio/mp4" });
  assert.deepStrictEqual(missingAudio, {
    ok: false,
    code: "MISSING_AUDIO_BASE64",
  });

  const missingMime = validateTranscribePayload({
    audioBase64: Buffer.from("x").toString("base64"),
  });
  assert.deepStrictEqual(missingMime, { ok: false, code: "MISSING_MIME_TYPE" });

  const tooLarge = validateTranscribePayload({
    audioBase64: Buffer.alloc(MAX_AUDIO_BYTES + 1).toString("base64"),
    mimeType: "audio/mp4",
  });
  assert.strictEqual(tooLarge.ok, false);
  assert.strictEqual(tooLarge.code, "AUDIO_TOO_LARGE");

  const successProviderResult = {
    ok: true,
    text: "recognized",
    provider: STT_PROVIDER_OPENAI,
    model: "gpt-4o-mini-transcribe",
    apiLatencyMs: 120,
  };
  assert.deepStrictEqual(mapProviderResultToClient(successProviderResult), {
    ok: true,
    text: "recognized",
  });

  const errorProviderResult = {
    ok: false,
    code: "OPENAI_HTTP_ERROR",
    provider: STT_PROVIDER_OPENAI,
    model: "gpt-4o-mini-transcribe",
    apiLatencyMs: 80,
  };
  assert.deepStrictEqual(mapProviderResultToClient(errorProviderResult), {
    ok: false,
    code: "OPENAI_HTTP_ERROR",
  });

  const logPayload = {
    event: "transcribe_succeeded",
    provider: STT_PROVIDER_OPENAI,
    model: "gpt-4o-mini-transcribe",
    receivedBytes: 100,
    apiLatencyMs: 50,
    totalLatencyMs: 60,
    success: true,
    errorCode: null,
    textLength: 12,
    uidSuffix: "user12",
    sttProviderSetting: STT_PROVIDER_OPENAI,
  };
  const serialized = JSON.stringify(logPayload);
  assert.ok(!serialized.includes("secret-should-not-log"));
  assert.ok(!serialized.includes("recognized text body"));
  assert.ok(!serialized.includes("audio bytes"));

  const googleInvoke = await invokeSttProvider({
    provider: STT_PROVIDER_GOOGLE,
    audioBuffer: Buffer.from("audio"),
    mimeType: "audio/mp4",
    language: "ja",
    receivedBytes: 5,
    googleOptions: {
      projectId: "lahainarsnet-ohayokamome-live",
      speechClientFactory: () => ({
        recognize: async () => [
          {
            results: [{ alternatives: [{ transcript: "google text" }] }],
          },
        ],
      }),
    },
  });
  assert.strictEqual(googleInvoke.ok, true);
  assert.strictEqual(googleInvoke.text, "google text");
  assert.strictEqual(googleInvoke.provider, STT_PROVIDER_GOOGLE);
  assert.strictEqual(googleInvoke.providerLanguage, "ja-JP");
  assert.deepStrictEqual(mapProviderResultToClient(googleInvoke), {
    ok: true,
    text: "google text",
  });

  const invalidInvoke = await invokeSttProvider({
    provider: "unknown",
    audioBuffer: Buffer.from("audio"),
    mimeType: "audio/mp4",
    language: "ja",
    receivedBytes: 5,
    apiKey: "test-key",
  });
  assert.deepStrictEqual(invalidInvoke, {
    ok: false,
    code: "STT_PROVIDER_INVALID",
    provider: "unknown",
    model: "",
    apiLatencyMs: 0,
  });

  console.log("transcribeExperiment.test.js: all tests passed");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
