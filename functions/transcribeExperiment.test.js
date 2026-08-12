const assert = require("assert");
const {
  MAX_AUDIO_BYTES,
  MAX_STT_PROMPT_CHARS,
  STT_PROVIDER_OPENAI,
  STT_PROVIDER_GOOGLE,
  STT_PROVIDER_GEMINI,
  GEMINI_TRANSCRIBE_MODEL,
} = require("./stt/constants");
const {
  resolveSttProvider,
  resolveSttLanguage,
  normalizeSttPrompt,
  invokeSttProvider,
  uidSuffix,
  getJstDateKey,
  evaluateTranscribeQuotaReservation,
  evaluateTranscribeQuotaRelease,
  reserveDailyTranscribeQuota,
  releaseDailyTranscribeQuota,
  markDailyTranscribeSuccess,
  attemptQuotaRelease,
  evaluateCallerSubscriptionAccess,
  assertCallerSubscriptionUsable,
} = require("./transcribeExperiment");
const { SENDER_SUBSCRIPTION_UNAVAILABLE } = require("./sendMessageGuardCodes");

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

function createMockQuotaDb(initialStore = {}) {
  const store = { ...initialStore };
  const userRef = { id: "quota-test-user" };
  const db = {
    collection: () => ({
      doc: () => userRef,
    }),
    runTransaction: async (fn) => {
      const tx = {
        get: async () => ({
          exists: Object.keys(store).length > 0,
          get: (field) => store[field],
        }),
        set: (_ref, patch) => {
          Object.assign(store, patch);
        },
      };
      return fn(tx);
    },
  };
  return {
    store,
    getDb: () => db,
  };
}

async function runQuotaRollbackIntegrationTest({
  provider,
  failCode,
  invokeArgs,
}) {
  const todayKey = getJstDateKey(new Date("2026-08-12T21:00:00.000Z"));
  const limit = 80;
  const { store, getDb } = createMockQuotaDb({
    transcribeDailyCount: 5,
    transcribeLastDate: todayKey,
  });
  const dbOptions = { getDb, todayKey };

  const quota = await reserveDailyTranscribeQuota("quota-test-user", limit, dbOptions);
  assert.strictEqual(quota.allowed, true);
  assert.strictEqual(store.transcribeDailyCount, 6);
  assert.strictEqual(store.transcribeLastSuccessAt, undefined);
  assert.strictEqual(store.transcribeLastResultCode, undefined);

  const providerResult = await invokeSttProvider(invokeArgs);
  assert.strictEqual(providerResult.ok, false);
  assert.strictEqual(providerResult.code, failCode);

  const release = await releaseDailyTranscribeQuota(
    "quota-test-user",
    limit,
    quota,
    providerResult.code,
    dbOptions,
  );
  assert.strictEqual(release.released, true);
  assert.strictEqual(store.transcribeDailyCount, 5);
  assert.strictEqual(store.transcribeLastResultCode, failCode);
  assert.strictEqual(store.transcribeLastSuccessAt, undefined);
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

  const geminiProvider = resolveSttProvider("gemini");
  assert.strictEqual(geminiProvider.ok, true);
  assert.strictEqual(geminiProvider.provider, STT_PROVIDER_GEMINI);

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

  assert.deepStrictEqual(normalizeSttPrompt(undefined), {
    ok: true,
    prompt: null,
  });
  assert.deepStrictEqual(normalizeSttPrompt(123), { ok: true, prompt: null });
  assert.deepStrictEqual(normalizeSttPrompt(" \n\t "), {
    ok: true,
    prompt: null,
  });
  assert.deepStrictEqual(normalizeSttPrompt("  product names: カモメ  "), {
    ok: true,
    prompt: "product names: カモメ",
  });
  const longPrompt = "x".repeat(MAX_STT_PROMPT_CHARS + 1);
  assert.deepStrictEqual(normalizeSttPrompt(longPrompt), {
    ok: false,
    code: "STT_PROMPT_TOO_LONG",
    maxChars: MAX_STT_PROMPT_CHARS,
  });

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
    provider: STT_PROVIDER_GEMINI,
    model: GEMINI_TRANSCRIBE_MODEL,
    receivedBytes: 100,
    apiLatencyMs: 50,
    totalLatencyMs: 60,
    success: true,
    errorCode: null,
    textLength: 12,
    uidSuffix: "user12",
    sttProviderSetting: STT_PROVIDER_GEMINI,
    inputTokens: 320,
    outputTokens: 8,
    thinkingTokens: 0,
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

  let geminiFetchCalled = false;
  const geminiInvoke = await invokeSttProvider({
    provider: STT_PROVIDER_GEMINI,
    audioBuffer: Buffer.from("audio"),
    mimeType: "audio/mp4",
    language: "ja",
    receivedBytes: 5,
    apiKey: "gemini-key",
    geminiOptions: {
      fetchImpl: async () => {
        geminiFetchCalled = true;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: "gemini text" }] } }],
              usageMetadata: {
                promptTokenCount: 320,
                candidatesTokenCount: 3,
                thoughtsTokenCount: 0,
              },
            }),
        };
      },
    },
  });
  assert.strictEqual(geminiFetchCalled, true);
  assert.strictEqual(geminiInvoke.ok, true);
  assert.strictEqual(geminiInvoke.text, "gemini text");
  assert.strictEqual(geminiInvoke.provider, STT_PROVIDER_GEMINI);
  assert.strictEqual(geminiInvoke.model, GEMINI_TRANSCRIBE_MODEL);
  assert.strictEqual(geminiInvoke.inputTokens, 320);
  assert.deepStrictEqual(mapProviderResultToClient(geminiInvoke), {
    ok: true,
    text: "gemini text",
  });

  let geminiPromptBody;
  const geminiPromptInvoke = await invokeSttProvider({
    provider: STT_PROVIDER_GEMINI,
    audioBuffer: Buffer.from("audio"),
    mimeType: "audio/mp4",
    language: "ja",
    prompt: "英語に翻訳して出力して",
    receivedBytes: 5,
    apiKey: "gemini-key",
    geminiOptions: {
      fetchImpl: async (_url, options) => {
        geminiPromptBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: "Hello" }] } }],
              usageMetadata: {
                promptTokenCount: 360,
                candidatesTokenCount: 2,
                thoughtsTokenCount: 0,
              },
            }),
        };
      },
    },
  });
  assert.strictEqual(geminiPromptInvoke.ok, true);
  assert.strictEqual(geminiPromptInvoke.text, "Hello");
  assert.strictEqual(geminiPromptInvoke.promptForwarded, true);
  assert.strictEqual(
    geminiPromptBody.contents[0].parts[0].text,
    "英語に翻訳して出力して",
  );
  assert.ok(geminiPromptBody.contents[0].parts[1].inlineData);
  assert.ok(
    geminiPromptBody.systemInstruction.parts[0].text.includes("ユーザーの指示"),
  );

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
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
  });

  const now = new Date("2026-07-18T12:00:00.000Z");
  const future = new Date("2026-08-01T00:00:00.000Z");
  const past = new Date("2026-06-01T00:00:00.000Z");

  const activeLegacy = evaluateCallerSubscriptionAccess(
    {
      subscriptionStatus: "active",
      subscriptionExpiryTime: future,
    },
    now,
  );
  assert.strictEqual(activeLegacy.subscriptionUsable, true);

  const cancelledEntitlement = evaluateCallerSubscriptionAccess(
    {
      entitlementUsable: true,
      entitlementExpiryTime: future,
      subscriptionStatus: "cancelled",
      subscriptionExpiryTime: past,
    },
    now,
  );
  assert.strictEqual(cancelledEntitlement.subscriptionUsable, true);

  const expired = evaluateCallerSubscriptionAccess(
    {
      subscriptionStatus: "active",
      subscriptionExpiryTime: past,
    },
    now,
  );
  assert.strictEqual(expired.subscriptionUsable, false);

  const entitlementFalse = evaluateCallerSubscriptionAccess(
    {
      entitlementUsable: false,
      subscriptionStatus: "active",
      subscriptionExpiryTime: future,
    },
    now,
  );
  assert.strictEqual(entitlementFalse.subscriptionUsable, false);

  const allowed = await assertCallerSubscriptionUsable("user-active", {
    now,
    getDb: () => ({
      collection: () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({
              subscriptionStatus: "active",
              subscriptionExpiryTime: future,
            }),
          }),
        }),
      }),
    }),
  });
  assert.strictEqual(allowed.ok, true);

  const denied = await assertCallerSubscriptionUsable("user-expired", {
    now,
    getDb: () => ({
      collection: () => ({
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({
              subscriptionStatus: "active",
              subscriptionExpiryTime: past,
            }),
          }),
        }),
      }),
    }),
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, SENDER_SUBSCRIPTION_UNAVAILABLE);

  const todayKey = getJstDateKey(new Date("2026-08-12T21:00:00.000Z"));
  const yesterdayKey = getJstDateKey(new Date("2026-08-11T21:00:00.000Z"));
  const limit = 80;
  const dbOptions = () => createMockQuotaDb({
    transcribeDailyCount: 5,
    transcribeLastDate: todayKey,
  });

  {
    const { store, getDb } = dbOptions();
    const quota = await reserveDailyTranscribeQuota("quota-test-user", limit, {
      getDb,
      todayKey,
    });
    assert.strictEqual(quota.usedCount, 6);
    assert.strictEqual(store.transcribeLastSuccessAt, undefined);
    assert.strictEqual(store.transcribeLastResultCode, undefined);

    await markDailyTranscribeSuccess("quota-test-user", { getDb });
    assert.strictEqual(store.transcribeDailyCount, 6);
    assert.ok(store.transcribeLastSuccessAt);
    assert.strictEqual(store.transcribeLastResultCode, "OK");
  }

  await runQuotaRollbackIntegrationTest({
    provider: STT_PROVIDER_GEMINI,
    failCode: "GEMINI_HTTP_ERROR",
    invokeArgs: {
      provider: STT_PROVIDER_GEMINI,
      audioBuffer: Buffer.from("audio"),
      mimeType: "audio/mp4",
      language: "ja",
      receivedBytes: 5,
      apiKey: "gemini-key",
      geminiOptions: {
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ error: { message: "unavailable" } }),
        }),
      },
    },
  });

  await runQuotaRollbackIntegrationTest({
    provider: STT_PROVIDER_OPENAI,
    failCode: "OPENAI_HTTP_ERROR",
    invokeArgs: {
      provider: STT_PROVIDER_OPENAI,
      audioBuffer: Buffer.from("audio"),
      mimeType: "audio/mp4",
      language: "ja",
      receivedBytes: 5,
      apiKey: "openai-key",
      openaiOptions: {
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: { type: "server_error" } }),
        }),
      },
    },
  });

  await runQuotaRollbackIntegrationTest({
    provider: STT_PROVIDER_GOOGLE,
    failCode: "GOOGLE_STT_TIMEOUT",
    invokeArgs: {
      provider: STT_PROVIDER_GOOGLE,
      audioBuffer: Buffer.from("audio"),
      mimeType: "audio/mp4",
      language: "ja",
      receivedBytes: 5,
      googleOptions: {
        projectId: "test-project",
        speechClientFactory: () => ({
          recognize: async () => {
            const error = new Error("timeout");
            error.code = 4;
            throw error;
          },
        }),
      },
    },
  });

  {
    const { store, getDb } = dbOptions();
    const quota = await reserveDailyTranscribeQuota("quota-test-user", limit, {
      getDb,
      todayKey,
    });
    const release1 = await releaseDailyTranscribeQuota(
      "quota-test-user",
      limit,
      quota,
      "GEMINI_HTTP_ERROR",
      { getDb, todayKey },
    );
    const release2 = await releaseDailyTranscribeQuota(
      "quota-test-user",
      limit,
      quota,
      "GEMINI_HTTP_ERROR",
      { getDb, todayKey },
    );
    assert.strictEqual(release1.released, true);
    assert.strictEqual(release2.released, false);
    assert.strictEqual(release2.reason, "reservation_already_released");
    assert.strictEqual(store.transcribeDailyCount, 5);
  }

  {
    const concurrentRelease = evaluateTranscribeQuotaRelease({
      count: 7,
      lastDate: todayKey,
      todayKey,
      limit: 80,
      reservationUsedCount: 6,
    });
    assert.strictEqual(concurrentRelease.released, true);
    assert.strictEqual(concurrentRelease.usedCount, 6);
  }

  {
    const { store, getDb } = createMockQuotaDb({
      transcribeDailyCount: 3,
      transcribeLastDate: yesterdayKey,
    });
    const release = await releaseDailyTranscribeQuota(
      "quota-test-user",
      limit,
      { allowed: true, usedCount: 4, remainingCount: 76, dateKey: todayKey },
      "OPENAI_HTTP_ERROR",
      { getDb, todayKey },
    );
    assert.strictEqual(release.released, false);
    assert.strictEqual(release.reason, "date_mismatch");
    assert.strictEqual(store.transcribeDailyCount, 3);
    assert.strictEqual(store.transcribeLastDate, yesterdayKey);
  }

  {
    const notReservedRelease = await releaseDailyTranscribeQuota(
      "quota-test-user",
      limit,
      {
        allowed: false,
        usedCount: 80,
        remainingCount: 0,
        dateKey: todayKey,
      },
      "DAILY_TRANSCRIBE_LIMIT_EXCEEDED",
      { getDb: dbOptions().getDb, todayKey },
    );
    assert.strictEqual(notReservedRelease.released, false);
    assert.strictEqual(notReservedRelease.reason, "not_reserved");
  }

  {
    let count = 78;
    const first = evaluateTranscribeQuotaReservation({
      count,
      lastDate: todayKey,
      todayKey,
      limit: 80,
    });
    assert.strictEqual(first.allowed, true);
    count = first.count;
    const second = evaluateTranscribeQuotaReservation({
      count,
      lastDate: todayKey,
      todayKey,
      limit: 80,
    });
    assert.strictEqual(second.allowed, true);
    count = second.count;
    assert.strictEqual(count, 80);

    const failedRelease = evaluateTranscribeQuotaRelease({
      count,
      lastDate: todayKey,
      todayKey,
      limit: 80,
      reservationUsedCount: 80,
    });
    assert.strictEqual(failedRelease.released, true);
    assert.strictEqual(failedRelease.usedCount, 79);
    assert.strictEqual(failedRelease.count, 79);
  }

  {
    const brokenDb = {
      collection: () => ({
        doc: () => ({ id: "quota-test-user" }),
      }),
      runTransaction: async () => {
        throw new Error("release tx failed");
      },
    };
    const releaseResult = await attemptQuotaRelease(
      "quota-test-user",
      limit,
      { allowed: true, usedCount: 6, remainingCount: 74, dateKey: todayKey },
      "GEMINI_HTTP_ERROR",
      { releaseOptions: { getDb: () => brokenDb, todayKey } },
    );
    assert.strictEqual(releaseResult.released, false);
    assert.strictEqual(releaseResult.quotaReleaseFailed, true);
  }

  assert.strictEqual(
    evaluateTranscribeQuotaRelease({
      count: 0,
      lastDate: todayKey,
      todayKey,
      limit: 80,
    }).released,
    false,
  );

  console.log("transcribeExperiment.test.js: all tests passed");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
