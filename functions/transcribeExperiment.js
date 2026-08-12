/**
 * Phase 3: Base64 音声 → STT provider（OpenAI / Google / Gemini）→ text 返却。
 *
 * - 音声内容や変換結果は保存しない。
 *
 * 期待ペイロード例:
 *   { audioBase64: "...", mimeType: "audio/mp4", language: "ja" }
 *
 * 成功: { ok: true, text: "..." }
 * 失敗: { ok: false, code: "..." }
 */

const logger = require("firebase-functions/logger");
const { onCall } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("./firebaseAdmin");
const { loadAppConfig, assertAccessNotBlocked } = require("./appConfig");
const { describeAccountAccessUsability } = require("./accountAccessUsability");
const { SENDER_SUBSCRIPTION_UNAVAILABLE } = require("./sendMessageGuardCodes");
const {
  DEFAULT_DAILY_TRANSCRIBE_LIMIT,
  MAX_AUDIO_BYTES,
  MAX_STT_PROMPT_CHARS,
  STT_PROVIDER_OPENAI,
  STT_PROVIDER_GOOGLE,
  STT_PROVIDER_GEMINI,
  GOOGLE_STT_DEFAULT_MODEL,
  GOOGLE_STT_DEFAULT_LOCATION,
} = require("./stt/constants");
const { resolveSttProvider } = require("./stt/registry");
const { resolveSttLanguage } = require("./stt/language");
const { transcribeWithOpenAI } = require("./stt/openaiProvider");
const { transcribeWithGoogle } = require("./stt/googleProvider");
const { transcribeWithGemini } = require("./stt/geminiProvider");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const STT_PROVIDER = defineString("STT_PROVIDER", {
  default: STT_PROVIDER_OPENAI,
});

function getJstDateKey(baseDate = new Date()) {
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jst = new Date(baseDate.getTime() + JST_OFFSET_MS);
  return jst.toISOString().slice(0, 10);
}

function uidSuffix(uid) {
  if (!uid) {
    return "none";
  }
  return uid.length <= 6 ? uid : uid.slice(-6);
}

function logSttEvent(fields) {
  logger.info("STT_TRACE", fields);
}

function evaluateCallerSubscriptionAccess(userData, now = new Date(), options = {}) {
  return describeAccountAccessUsability(userData, now, options);
}

async function assertCallerSubscriptionUsable(uid, options = {}) {
  const getDb = options.getDb || (() => admin.getDb());
  const parseExpiryWithMeta = options.parseExpiryWithMeta;
  const now = options.now instanceof Date ? options.now : new Date();
  const userDoc = await getDb().collection("users").doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() || {} : {};
  const usability = evaluateCallerSubscriptionAccess(userData, now, {
    ...(parseExpiryWithMeta ? { parseExpiryWithMeta } : {}),
  });

  if (!usability.subscriptionUsable) {
    logger.warn("transcribeExperiment: SENDER_SUBSCRIPTION_UNAVAILABLE", {
      uidSuffix: uidSuffix(uid),
      decisionSource: usability.decisionSource,
      entitlementUsable: usability.entitlementUsable,
      entitlementExpiryIsFuture: usability.entitlementExpiryIsFuture,
      denyReason: usability.denyReason,
    });
    return { ok: false, code: SENDER_SUBSCRIPTION_UNAVAILABLE, usability };
  }

  logger.info("transcribeExperiment: subscription guard passed", {
    uidSuffix: uidSuffix(uid),
    decisionSource: usability.decisionSource,
    entitlementUsable: usability.entitlementUsable,
    entitlementExpiryIsFuture: usability.entitlementExpiryIsFuture,
  });
  return { ok: true, usability };
}

function normalizeSttPrompt(rawPrompt) {
  if (typeof rawPrompt !== "string") {
    return { ok: true, prompt: null };
  }
  const prompt = rawPrompt.trim();
  if (prompt === "") {
    return { ok: true, prompt: null };
  }
  if (prompt.length > MAX_STT_PROMPT_CHARS) {
    return { ok: false, code: "STT_PROMPT_TOO_LONG", maxChars: MAX_STT_PROMPT_CHARS };
  }
  return { ok: true, prompt };
}

function evaluateTranscribeQuotaReservation({
  count,
  lastDate,
  todayKey,
  limit,
}) {
  let effectiveCount =
    typeof count === "number" && Number.isFinite(count) ? count : 0;
  if (lastDate !== todayKey) {
    effectiveCount = 0;
  }

  if (effectiveCount >= limit) {
    return {
      allowed: false,
      count: effectiveCount,
      limit,
      usedCount: effectiveCount,
      remainingCount: 0,
      dateKey: todayKey,
    };
  }

  const newCount = effectiveCount + 1;
  return {
    allowed: true,
    count: newCount,
    limit,
    usedCount: newCount,
    remainingCount: Math.max(0, limit - newCount),
    dateKey: todayKey,
  };
}

async function reserveDailyTranscribeQuota(uid, limit, options = {}) {
  const todayKey = options.todayKey || getJstDateKey(new Date());
  const getDb = options.getDb || (() => admin.getDb());
  const userRef = getDb().collection("users").doc(uid);

  return getDb().runTransaction(async (tx) => {
    const now = admin.FieldValue.serverTimestamp();
    const snap = await tx.get(userRef);
    const lastDate = snap.exists ? snap.get("transcribeLastDate") : null;
    const count =
      snap.exists && typeof snap.get("transcribeDailyCount") === "number"
        ? snap.get("transcribeDailyCount")
        : 0;

    const reservation = evaluateTranscribeQuotaReservation({
      count,
      lastDate,
      todayKey,
      limit,
    });

    logger.info("transcribeExperiment: quota reservation evaluated", {
      uidSuffix: uidSuffix(uid),
      jstDateKey: todayKey,
      transcribeDailyCount: count,
      transcribeLastDate: lastDate,
      dailyTranscribeLimit: limit,
      allowed: reservation.allowed,
      usedCount: reservation.usedCount,
      remainingCount: reservation.remainingCount,
    });

    if (!reservation.allowed) {
      const exceededCount =
        snap.exists &&
        typeof snap.get("transcribeLimitExceededCount") === "number"
          ? snap.get("transcribeLimitExceededCount") + 1
          : 1;
      tx.set(
        userRef,
        {
          transcribeLastDate: todayKey,
          transcribeDailyCount: reservation.count,
          transcribeUpdatedAt: now,
          transcribeLastAttemptAt: now,
          transcribeLastLimitExceededAt: now,
          transcribeLimitExceededCount: exceededCount,
          transcribeLimit: limit,
          transcribeLastResultCode: "DAILY_TRANSCRIBE_LIMIT_EXCEEDED",
        },
        { merge: true },
      );
      logger.warn("transcribeExperiment: quota limit reached in transaction", {
        uidSuffix: uidSuffix(uid),
        jstDateKey: todayKey,
        dailyTranscribeLimit: limit,
        usedCount: reservation.usedCount,
        remainingCount: reservation.remainingCount,
      });
      return reservation;
    }

    tx.set(
      userRef,
      {
        transcribeLastDate: todayKey,
        transcribeDailyCount: reservation.count,
        transcribeUpdatedAt: now,
        transcribeLastAttemptAt: now,
        transcribeLimit: limit,
      },
      { merge: true },
    );
    logger.info("transcribeExperiment: quota reserved", {
      uidSuffix: uidSuffix(uid),
      jstDateKey: todayKey,
      dailyTranscribeLimit: limit,
      usedCount: reservation.usedCount,
      remainingCount: reservation.remainingCount,
      quotaReserved: true,
    });
    return reservation;
  });
}

function evaluateTranscribeQuotaRelease({
  count,
  lastDate,
  todayKey,
  limit,
  reservationUsedCount = null,
}) {
  if (lastDate !== todayKey) {
    return {
      released: false,
      reason: "date_mismatch",
      count:
        typeof count === "number" && Number.isFinite(count) ? count : 0,
      usedCount:
        lastDate === todayKey && typeof count === "number" && Number.isFinite(count)
          ? count
          : 0,
      remainingCount:
        lastDate === todayKey && typeof count === "number" && Number.isFinite(count)
          ? Math.max(0, limit - count)
          : limit,
    };
  }

  const effectiveCount =
    typeof count === "number" && Number.isFinite(count) ? count : 0;
  if (effectiveCount <= 0) {
    return {
      released: false,
      reason: "already_zero",
      count: 0,
      usedCount: 0,
      remainingCount: limit,
    };
  }

  if (
    typeof reservationUsedCount === "number" &&
    Number.isFinite(reservationUsedCount) &&
    effectiveCount < reservationUsedCount
  ) {
    return {
      released: false,
      reason: "reservation_already_released",
      count: effectiveCount,
      usedCount: effectiveCount,
      remainingCount: Math.max(0, limit - effectiveCount),
    };
  }

  const newCount = effectiveCount - 1;
  return {
    released: true,
    reason: null,
    count: newCount,
    usedCount: newCount,
    remainingCount: Math.max(0, limit - newCount),
  };
}

async function releaseDailyTranscribeQuota(
  uid,
  limit,
  reservation,
  resultCode,
  options = {},
) {
  if (!reservation?.allowed) {
    return {
      released: false,
      reason: "not_reserved",
      usedCount: reservation?.usedCount ?? null,
      remainingCount: reservation?.remainingCount ?? null,
    };
  }

  const todayKey = options.todayKey || getJstDateKey(new Date());
  const getDb = options.getDb || (() => admin.getDb());
  const userRef = getDb().collection("users").doc(uid);
  const normalizedResultCode =
    typeof resultCode === "string" && resultCode.trim() !== ""
      ? resultCode.trim()
      : "TRANSCRIBE_FAILED";

  return getDb().runTransaction(async (tx) => {
    const now = admin.FieldValue.serverTimestamp();
    const snap = await tx.get(userRef);
    const lastDate = snap.exists ? snap.get("transcribeLastDate") : null;
    const count =
      snap.exists && typeof snap.get("transcribeDailyCount") === "number"
        ? snap.get("transcribeDailyCount")
        : 0;

    const release = evaluateTranscribeQuotaRelease({
      count,
      lastDate,
      todayKey,
      limit,
      reservationUsedCount: reservation?.usedCount ?? null,
    });

    if (!release.released) {
      return release;
    }

    tx.set(
      userRef,
      {
        transcribeLastDate: todayKey,
        transcribeDailyCount: release.count,
        transcribeUpdatedAt: now,
        transcribeLastResultCode: normalizedResultCode,
      },
      { merge: true },
    );
    return release;
  });
}

async function markDailyTranscribeSuccess(uid, options = {}) {
  const getDb = options.getDb || (() => admin.getDb());
  const userRef = getDb().collection("users").doc(uid);

  return getDb().runTransaction(async (tx) => {
    const now = admin.FieldValue.serverTimestamp();
    tx.set(
      userRef,
      {
        transcribeLastSuccessAt: now,
        transcribeLastResultCode: "OK",
        transcribeUpdatedAt: now,
      },
      { merge: true },
    );
    return { ok: true };
  });
}

async function attemptQuotaRelease(uid, limit, quota, resultCode, logFields = {}) {
  try {
    const releaseResult = await releaseDailyTranscribeQuota(
      uid,
      limit,
      quota,
      resultCode,
      logFields.releaseOptions || {},
    );
    if (!releaseResult.released) {
      logger.warn("transcribeExperiment: quota release skipped", {
        uidSuffix: uidSuffix(uid),
        reason: releaseResult.reason || "unknown",
        resultCode,
        ...logFields,
      });
    } else {
      logger.info("transcribeExperiment: quota released", {
        uidSuffix: uidSuffix(uid),
        resultCode,
        usedCount: releaseResult.usedCount,
        remainingCount: releaseResult.remainingCount,
        quotaReleased: true,
        ...logFields,
      });
    }
    return {
      ...releaseResult,
      quotaReleaseFailed: false,
    };
  } catch (error) {
    logger.warn("transcribeExperiment: quota release failed", {
      uidSuffix: uidSuffix(uid),
      resultCode,
      error: String(error?.message || error),
      quotaReleaseFailed: true,
      ...logFields,
    });
    return {
      released: false,
      reason: "release_transaction_failed",
      quotaReleaseFailed: true,
      usedCount: quota?.usedCount ?? null,
      remainingCount: quota?.remainingCount ?? null,
    };
  }
}

async function invokeSttProvider({
  provider,
  audioBuffer,
  mimeType,
  language,
  prompt,
  receivedBytes,
  apiKey,
  openaiOptions = {},
  googleOptions = {},
  geminiOptions = {},
}) {
  if (provider === STT_PROVIDER_OPENAI) {
    return transcribeWithOpenAI({
      audioBuffer,
      mimeType,
      language,
      prompt,
      apiKey,
      receivedBytes,
      fetchImpl: openaiOptions.fetchImpl,
      logger,
    });
  }
  if (provider === STT_PROVIDER_GOOGLE) {
    return transcribeWithGoogle({
      audioBuffer,
      mimeType,
      language,
      receivedBytes,
      projectId: googleOptions.projectId,
      location: googleOptions.location,
      model: googleOptions.model,
      speechClientFactory: googleOptions.speechClientFactory,
      logger,
    });
  }
  if (provider === STT_PROVIDER_GEMINI) {
    return transcribeWithGemini({
      audioBuffer,
      mimeType,
      language,
      prompt,
      apiKey,
      receivedBytes,
      fetchImpl: geminiOptions.fetchImpl,
      logger,
    });
  }
  return {
    ok: false,
    code: "STT_PROVIDER_INVALID",
    provider,
    model: "",
    apiLatencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
  };
}

async function runTranscribeAdminGateAfterAuth(request, options = {}) {
  const uid = request.auth?.uid || null;
  if (!uid) {
    return { ok: false, code: "UNAUTHENTICATED", uid: null };
  }
  const accessGate = await assertAccessNotBlocked(options);
  if (accessGate.blocked) {
    return { ok: false, code: accessGate.code, uid };
  }
  return { ok: true, uid };
}

exports.transcribeExperiment = onCall(
  {
    secrets: [OPENAI_API_KEY, GEMINI_API_KEY],
    enforceAppCheck: true,
    maxInstances: 30,
    concurrency: 10,
  },
  async (request) => {
    const startedAt = Date.now();
    const uid = request.auth?.uid || null;
    if (!uid) {
      logger.warn("transcribeExperiment: UNAUTHENTICATED");
      logSttEvent({
        event: "transcribe_failed",
        provider: null,
        model: null,
        receivedBytes: null,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: "UNAUTHENTICATED",
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: null,
      });
      return { ok: false, code: "UNAUTHENTICATED" };
    }

    const adminGate = await runTranscribeAdminGateAfterAuth(request);
    if (!adminGate.ok) {
      logger.warn("transcribeExperiment: admin access gate blocked", {
        uidSuffix: uidSuffix(uid),
        errorCode: adminGate.code,
      });
      logSttEvent({
        event: "transcribe_failed",
        provider: null,
        model: null,
        receivedBytes: null,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: adminGate.code,
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: null,
      });
      return { ok: false, code: adminGate.code };
    }

    let subscriptionCheck;
    try {
      subscriptionCheck = await assertCallerSubscriptionUsable(uid);
    } catch (e) {
      logger.error("transcribeExperiment: SUBSCRIPTION_CHECK_FAILED", {
        uidSuffix: uidSuffix(uid),
        error: String(e?.message || e),
      });
      logSttEvent({
        event: "transcribe_failed",
        provider: null,
        model: null,
        receivedBytes: null,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: "SUBSCRIPTION_CHECK_FAILED",
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: null,
      });
      return { ok: false, code: "SUBSCRIPTION_CHECK_FAILED" };
    }
    if (!subscriptionCheck.ok) {
      logSttEvent({
        event: "transcribe_failed",
        provider: null,
        model: null,
        receivedBytes: null,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: subscriptionCheck.code,
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: null,
      });
      return { ok: false, code: subscriptionCheck.code };
    }

    const providerResolution = resolveSttProvider(STT_PROVIDER.value());
    if (!providerResolution.ok) {
      logger.warn("transcribeExperiment: STT_PROVIDER_INVALID", {
        configuredProvider: String(STT_PROVIDER.value() || ""),
        resolvedProvider: providerResolution.provider || null,
        uidSuffix: uidSuffix(uid),
      });
      logSttEvent({
        event: "transcribe_failed",
        provider: providerResolution.provider || null,
        model: null,
        receivedBytes: null,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: providerResolution.code,
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: String(STT_PROVIDER.value() || ""),
      });
      return { ok: false, code: providerResolution.code };
    }
    const provider = providerResolution.provider;

    const {
      audioBase64,
      mimeType,
      language: rawLanguage,
      prompt: rawPrompt,
    } = request.data || {};

    if (typeof audioBase64 !== "string" || audioBase64.length === 0) {
      logSttEvent({
        event: "transcribe_failed",
        provider,
        model: null,
        receivedBytes: null,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: "MISSING_AUDIO_BASE64",
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: provider,
      });
      return { ok: false, code: "MISSING_AUDIO_BASE64" };
    }
    if (typeof mimeType !== "string" || mimeType.trim() === "") {
      logSttEvent({
        event: "transcribe_failed",
        provider,
        model: null,
        receivedBytes: null,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: "MISSING_MIME_TYPE",
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: provider,
      });
      return { ok: false, code: "MISSING_MIME_TYPE" };
    }

    let buf;
    try {
      buf = Buffer.from(audioBase64, "base64");
    } catch (_) {
      logSttEvent({
        event: "transcribe_failed",
        provider,
        model: null,
        receivedBytes: null,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: "INVALID_BASE64",
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: provider,
      });
      return { ok: false, code: "INVALID_BASE64" };
    }

    const receivedBytes = buf.length;
    if (receivedBytes > MAX_AUDIO_BYTES) {
      logger.warn("transcribeExperiment: AUDIO_TOO_LARGE", {
        receivedBytes,
        maxBytes: MAX_AUDIO_BYTES,
        provider,
        uidSuffix: uidSuffix(uid),
      });
      logSttEvent({
        event: "transcribe_failed",
        provider,
        model: null,
        receivedBytes,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: "AUDIO_TOO_LARGE",
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: provider,
      });
      return { ok: false, code: "AUDIO_TOO_LARGE" };
    }

    const languageResolution = resolveSttLanguage(rawLanguage);
    if (!languageResolution.ok) {
      logger.warn("transcribeExperiment: STT_LANGUAGE_INVALID", {
        configuredLanguage: String(rawLanguage ?? ""),
        resolvedLanguage: languageResolution.language || null,
        provider,
        uidSuffix: uidSuffix(uid),
      });
      logSttEvent({
        event: "transcribe_failed",
        provider,
        model: null,
        location: null,
        receivedBytes,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: languageResolution.code,
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: provider,
        requestedLanguage: languageResolution.language || null,
        providerLanguage: null,
      });
      return { ok: false, code: languageResolution.code };
    }
    const language = languageResolution.language;

    const promptResolution = normalizeSttPrompt(rawPrompt);
    if (!promptResolution.ok) {
      logSttEvent({
        event: "transcribe_failed",
        provider,
        model: null,
        location: null,
        receivedBytes,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: promptResolution.code,
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: provider,
        requestedLanguage: language,
        providerLanguage: null,
      });
      return { ok: false, code: promptResolution.code };
    }
    const prompt = promptResolution.prompt;

    let apiKey = null;
    if (provider === STT_PROVIDER_OPENAI) {
      try {
        apiKey = OPENAI_API_KEY.value();
      } catch (_) {
        logger.warn("transcribeExperiment: SECRET_READ_FAILED", {
          receivedBytes,
          provider,
          uidSuffix: uidSuffix(uid),
        });
        logSttEvent({
          event: "transcribe_failed",
          provider,
          model: null,
          receivedBytes,
          apiLatencyMs: null,
          totalLatencyMs: Date.now() - startedAt,
          success: false,
          errorCode: "SECRET_READ_FAILED",
          textLength: null,
          uidSuffix: uidSuffix(uid),
          sttProviderSetting: provider,
          inputTokens: null,
          outputTokens: null,
          thinkingTokens: null,
        });
        return { ok: false, code: "SECRET_READ_FAILED" };
      }
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        logger.warn("transcribeExperiment: SECRET_EMPTY", {
          receivedBytes,
          provider,
          uidSuffix: uidSuffix(uid),
        });
        logSttEvent({
          event: "transcribe_failed",
          provider,
          model: null,
          receivedBytes,
          apiLatencyMs: null,
          totalLatencyMs: Date.now() - startedAt,
          success: false,
          errorCode: "SECRET_EMPTY",
          textLength: null,
          uidSuffix: uidSuffix(uid),
          sttProviderSetting: provider,
          inputTokens: null,
          outputTokens: null,
          thinkingTokens: null,
        });
        return { ok: false, code: "SECRET_EMPTY" };
      }
    }
    if (provider === STT_PROVIDER_GEMINI) {
      try {
        apiKey = GEMINI_API_KEY.value();
      } catch (_) {
        logger.warn("transcribeExperiment: SECRET_READ_FAILED", {
          receivedBytes,
          provider,
          uidSuffix: uidSuffix(uid),
        });
        logSttEvent({
          event: "transcribe_failed",
          provider,
          model: null,
          receivedBytes,
          apiLatencyMs: null,
          totalLatencyMs: Date.now() - startedAt,
          success: false,
          errorCode: "SECRET_READ_FAILED",
          textLength: null,
          uidSuffix: uidSuffix(uid),
          sttProviderSetting: provider,
          inputTokens: null,
          outputTokens: null,
          thinkingTokens: null,
        });
        return { ok: false, code: "SECRET_READ_FAILED" };
      }
      if (typeof apiKey !== "string" || apiKey.length === 0) {
        logger.warn("transcribeExperiment: SECRET_EMPTY", {
          receivedBytes,
          provider,
          uidSuffix: uidSuffix(uid),
        });
        logSttEvent({
          event: "transcribe_failed",
          provider,
          model: null,
          receivedBytes,
          apiLatencyMs: null,
          totalLatencyMs: Date.now() - startedAt,
          success: false,
          errorCode: "SECRET_EMPTY",
          textLength: null,
          uidSuffix: uidSuffix(uid),
          sttProviderSetting: provider,
          inputTokens: null,
          outputTokens: null,
          thinkingTokens: null,
        });
        return { ok: false, code: "SECRET_EMPTY" };
      }
    }

    let dailyTranscribeLimit = DEFAULT_DAILY_TRANSCRIBE_LIMIT;
    let dailyTranscribeLimitUsedDefault = true;
    try {
      const appConfig = await loadAppConfig();
      dailyTranscribeLimit = appConfig.dailyTranscribeLimit;
      dailyTranscribeLimitUsedDefault = appConfig.dailyTranscribeLimitUsedDefault;
      logger.info("transcribeExperiment: loaded app config", {
        uidSuffix: uidSuffix(uid),
        dailyTranscribeLimit,
        dailyTranscribeLimitUsedDefault,
        dailyTranscribeLimitFromDoc: appConfig.dailyTranscribeLimitFromDoc,
      });
    } catch (e) {
      logger.warn("transcribeExperiment: loadAppConfig failed; using default limit", {
        uidSuffix: uidSuffix(uid),
        dailyTranscribeLimit: DEFAULT_DAILY_TRANSCRIBE_LIMIT,
        error: String(e?.message || e),
      });
    }

    let quota;
    try {
      quota = await reserveDailyTranscribeQuota(uid, dailyTranscribeLimit);
    } catch (e) {
      logger.error("transcribeExperiment: QUOTA_CHECK_FAILED", {
        uidSuffix: uidSuffix(uid),
        receivedBytes,
        dailyTranscribeLimit,
      });
      logSttEvent({
        event: "transcribe_failed",
        provider,
        model: null,
        receivedBytes,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: "QUOTA_CHECK_FAILED",
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: provider,
      });
      return { ok: false, code: "QUOTA_CHECK_FAILED" };
    }
    if (!quota.allowed) {
      logger.warn("transcribeExperiment: DAILY_TRANSCRIBE_LIMIT_EXCEEDED", {
        uidSuffix: uidSuffix(uid),
        usedCount: quota.usedCount,
        remainingCount: quota.remainingCount,
        limit: quota.limit,
        dateKey: quota.dateKey,
        receivedBytes,
        dailyTranscribeLimitUsedDefault,
      });
      logSttEvent({
        event: "transcribe_failed",
        provider,
        model: null,
        receivedBytes,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: "DAILY_TRANSCRIBE_LIMIT_EXCEEDED",
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: provider,
      });
      const limitExceededResponse = {
        ok: false,
        code: "DAILY_TRANSCRIBE_LIMIT_EXCEEDED",
        limit: quota.limit,
        usedCount: quota.usedCount,
        remainingCount: quota.remainingCount,
      };
      logger.info("transcribeExperiment: callable result", {
        uidSuffix: uidSuffix(uid),
        ok: false,
        code: limitExceededResponse.code,
        limit: limitExceededResponse.limit,
        usedCount: limitExceededResponse.usedCount,
        remainingCount: limitExceededResponse.remainingCount,
      });
      return limitExceededResponse;
    }

    let providerResult;
    try {
      providerResult = await invokeSttProvider({
        provider,
        audioBuffer: buf,
        mimeType,
        language,
        prompt,
        receivedBytes,
        apiKey,
        googleOptions: {
          projectId:
            process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
          location: process.env.STT_GOOGLE_LOCATION || GOOGLE_STT_DEFAULT_LOCATION,
          model: process.env.STT_GOOGLE_MODEL || GOOGLE_STT_DEFAULT_MODEL,
        },
      });
    } catch (invokeError) {
      const releaseResult = await attemptQuotaRelease(
        uid,
        dailyTranscribeLimit,
        quota,
        "TRANSCRIBE_INTERNAL_ERROR",
      );
      logger.error("transcribeExperiment: invokeSttProvider threw", {
        uidSuffix: uidSuffix(uid),
        error: String(invokeError?.message || invokeError),
      });
      logSttEvent({
        event: "transcribe_failed",
        provider,
        model: null,
        receivedBytes,
        apiLatencyMs: null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: "TRANSCRIBE_INTERNAL_ERROR",
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: provider,
        requestedLanguage: language,
        providerLanguage: null,
        quotaReserved: true,
        quotaReleased: releaseResult.released === true,
        quotaReleaseFailed: releaseResult.quotaReleaseFailed === true,
        usedCount: releaseResult.usedCount ?? quota.usedCount,
        remainingCount: releaseResult.remainingCount ?? quota.remainingCount,
      });
      return { ok: false, code: "TRANSCRIBE_INTERNAL_ERROR" };
    }

    if (!providerResult.ok) {
      const releaseResult = await attemptQuotaRelease(
        uid,
        dailyTranscribeLimit,
        quota,
        providerResult.code,
      );
      logSttEvent({
        event: "transcribe_failed",
        provider: providerResult.provider || provider,
        model: providerResult.model || null,
        location: providerResult.location || null,
        receivedBytes,
        apiLatencyMs: providerResult.apiLatencyMs ?? null,
        totalLatencyMs: Date.now() - startedAt,
        success: false,
        errorCode: providerResult.code,
        textLength: null,
        uidSuffix: uidSuffix(uid),
        sttProviderSetting: provider,
        requestedLanguage: language,
        providerLanguage: providerResult.providerLanguage || null,
        inputTokens: providerResult.inputTokens ?? null,
        outputTokens: providerResult.outputTokens ?? null,
        thinkingTokens: providerResult.thinkingTokens ?? null,
        quotaReserved: true,
        quotaReleased: releaseResult.released === true,
        quotaReleaseFailed: releaseResult.quotaReleaseFailed === true,
        usedCount: releaseResult.usedCount ?? quota.usedCount,
        remainingCount: releaseResult.remainingCount ?? quota.remainingCount,
      });
      return { ok: false, code: providerResult.code };
    }

    try {
      await markDailyTranscribeSuccess(uid);
    } catch (successMarkError) {
      logger.warn("transcribeExperiment: success metadata update failed", {
        uidSuffix: uidSuffix(uid),
        error: String(successMarkError?.message || successMarkError),
      });
    }

    logger.info("transcribeExperiment: transcription ok", {
      receivedBytes,
      provider: providerResult.provider,
      model: providerResult.model,
      location: providerResult.location || null,
      apiLatencyMs: providerResult.apiLatencyMs,
      uidSuffix: uidSuffix(uid),
      requestedLanguage: language,
      providerLanguage: providerResult.providerLanguage || null,
      inputTokens: providerResult.inputTokens ?? null,
      outputTokens: providerResult.outputTokens ?? null,
      thinkingTokens: providerResult.thinkingTokens ?? null,
      promptPresent: prompt != null,
      promptLength: prompt != null ? prompt.length : 0,
      geminiPromptForwarded:
        provider === STT_PROVIDER_GEMINI &&
        providerResult.promptForwarded === true,
      quotaReserved: true,
      quotaReleased: false,
      quotaReleaseFailed: false,
      usedCount: quota.usedCount,
      remainingCount: quota.remainingCount,
    });
    logSttEvent({
      event: "transcribe_succeeded",
      provider: providerResult.provider,
      model: providerResult.model,
      location: providerResult.location || null,
      receivedBytes,
      apiLatencyMs: providerResult.apiLatencyMs,
      totalLatencyMs: Date.now() - startedAt,
      success: true,
      errorCode: null,
      textLength: providerResult.text.length,
      uidSuffix: uidSuffix(uid),
      sttProviderSetting: provider,
      requestedLanguage: language,
      providerLanguage: providerResult.providerLanguage || null,
      inputTokens: providerResult.inputTokens ?? null,
      outputTokens: providerResult.outputTokens ?? null,
      thinkingTokens: providerResult.thinkingTokens ?? null,
      promptPresent: prompt != null,
      promptLength: prompt != null ? prompt.length : 0,
      geminiPromptForwarded:
        provider === STT_PROVIDER_GEMINI &&
        providerResult.promptForwarded === true,
      quotaReserved: true,
      quotaReleased: false,
      quotaReleaseFailed: false,
      usedCount: quota.usedCount,
      remainingCount: quota.remainingCount,
    });

    logger.info("transcribeExperiment: callable result", {
      uidSuffix: uidSuffix(uid),
      ok: true,
      textLength: providerResult.text.length,
      dailyTranscribeLimit,
      quotaUsedCount: quota.usedCount,
      quotaRemainingCount: quota.remainingCount,
    });

    return {
      ok: true,
      text: providerResult.text,
    };
  },
);

module.exports.getJstDateKey = getJstDateKey;
module.exports.evaluateTranscribeQuotaReservation = evaluateTranscribeQuotaReservation;
module.exports.evaluateTranscribeQuotaRelease = evaluateTranscribeQuotaRelease;
module.exports.reserveDailyTranscribeQuota = reserveDailyTranscribeQuota;
module.exports.releaseDailyTranscribeQuota = releaseDailyTranscribeQuota;
module.exports.markDailyTranscribeSuccess = markDailyTranscribeSuccess;
module.exports.attemptQuotaRelease = attemptQuotaRelease;
module.exports.evaluateCallerSubscriptionAccess = evaluateCallerSubscriptionAccess;
module.exports.assertCallerSubscriptionUsable = assertCallerSubscriptionUsable;
module.exports.runTranscribeAdminGateAfterAuth = runTranscribeAdminGateAfterAuth;
module.exports.resolveSttProvider = resolveSttProvider;
module.exports.resolveSttLanguage = resolveSttLanguage;
module.exports.normalizeSttPrompt = normalizeSttPrompt;
module.exports.invokeSttProvider = invokeSttProvider;
module.exports.logSttEvent = logSttEvent;
module.exports.uidSuffix = uidSuffix;
