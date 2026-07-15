/**
 * Phase 3: Base64 音声 → STT provider（OpenAI / Google）→ text 返却。
 *
 * - 音声内容や変換結果は保存しない。
 *
 * 期待ペイロード例:
 *   { audioBase64: "...", mimeType: "audio/mp4" }
 *
 * 成功: { ok: true, text: "..." }
 * 失敗: { ok: false, code: "..." }
 */

const logger = require("firebase-functions/logger");
const { onCall } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("./firebaseAdmin");
const {
  DAILY_TRANSCRIBE_LIMIT,
  MAX_AUDIO_BYTES,
  STT_PROVIDER_OPENAI,
  STT_PROVIDER_GOOGLE,
  GOOGLE_STT_DEFAULT_MODEL,
  GOOGLE_STT_DEFAULT_LOCATION,
} = require("./stt/constants");
const { resolveSttProvider } = require("./stt/registry");
const { transcribeWithOpenAI } = require("./stt/openaiProvider");
const { transcribeWithGoogle } = require("./stt/googleProvider");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
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

async function reserveDailyTranscribeQuota(uid) {
  const todayKey = getJstDateKey(new Date());
  const userRef = admin.getDb().collection("users").doc(uid);

  return admin.getDb().runTransaction(async (tx) => {
    const now = admin.FieldValue.serverTimestamp();
    const snap = await tx.get(userRef);
    const lastDate = snap.exists ? snap.get("transcribeLastDate") : null;
    let count =
      snap.exists && typeof snap.get("transcribeDailyCount") === "number"
        ? snap.get("transcribeDailyCount")
        : 0;

    if (lastDate !== todayKey) {
      count = 0;
    }

    if (count >= DAILY_TRANSCRIBE_LIMIT) {
      const exceededCount =
        snap.exists && typeof snap.get("transcribeLimitExceededCount") === "number"
          ? snap.get("transcribeLimitExceededCount") + 1
          : 1;
      tx.set(
        userRef,
        {
          transcribeLastDate: todayKey,
          transcribeDailyCount: count,
          transcribeUpdatedAt: now,
          transcribeLastAttemptAt: now,
          transcribeLastLimitExceededAt: now,
          transcribeLimitExceededCount: exceededCount,
          transcribeLimit: DAILY_TRANSCRIBE_LIMIT,
          transcribeLastResultCode: "DAILY_TRANSCRIBE_LIMIT_EXCEEDED",
        },
        { merge: true },
      );
      return { allowed: false, count, dateKey: todayKey };
    }

    const newCount = count + 1;
    tx.set(
      userRef,
      {
        transcribeLastDate: todayKey,
        transcribeDailyCount: newCount,
        transcribeUpdatedAt: now,
        transcribeLastAttemptAt: now,
        transcribeLastSuccessAt: now,
        transcribeLimit: DAILY_TRANSCRIBE_LIMIT,
        transcribeLastResultCode: "OK",
      },
      { merge: true },
    );
    return { allowed: true, count: newCount, dateKey: todayKey };
  });
}

async function invokeSttProvider({
  provider,
  audioBuffer,
  mimeType,
  receivedBytes,
  apiKey,
  googleOptions = {},
}) {
  if (provider === STT_PROVIDER_OPENAI) {
    return transcribeWithOpenAI({
      audioBuffer,
      mimeType,
      apiKey,
      receivedBytes,
      logger,
    });
  }
  if (provider === STT_PROVIDER_GOOGLE) {
    return transcribeWithGoogle({
      audioBuffer,
      mimeType,
      receivedBytes,
      projectId: googleOptions.projectId,
      location: googleOptions.location,
      model: googleOptions.model,
      speechClientFactory: googleOptions.speechClientFactory,
      logger,
    });
  }
  return {
    ok: false,
    code: "STT_PROVIDER_INVALID",
    provider,
    model: "",
    apiLatencyMs: 0,
  };
}

exports.transcribeExperiment = onCall(
  { secrets: [OPENAI_API_KEY] },
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

    const { audioBase64, mimeType } = request.data || {};

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
        });
        return { ok: false, code: "SECRET_EMPTY" };
      }
    }

    let quota;
    try {
      quota = await reserveDailyTranscribeQuota(uid);
    } catch (e) {
      logger.error("transcribeExperiment: QUOTA_CHECK_FAILED", {
        uid,
        receivedBytes,
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
        uid,
        count: quota.count,
        limit: DAILY_TRANSCRIBE_LIMIT,
        dateKey: quota.dateKey,
        receivedBytes,
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
      return {
        ok: false,
        code: "DAILY_TRANSCRIBE_LIMIT_EXCEEDED",
        limit: DAILY_TRANSCRIBE_LIMIT,
      };
    }

    const providerResult = await invokeSttProvider({
      provider,
      audioBuffer: buf,
      mimeType,
      receivedBytes,
      apiKey,
      googleOptions: {
        projectId:
          process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
        location: process.env.STT_GOOGLE_LOCATION || GOOGLE_STT_DEFAULT_LOCATION,
        model: process.env.STT_GOOGLE_MODEL || GOOGLE_STT_DEFAULT_MODEL,
      },
    });

    if (!providerResult.ok) {
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
      });
      return { ok: false, code: providerResult.code };
    }

    logger.info("transcribeExperiment: transcription ok", {
      receivedBytes,
      provider: providerResult.provider,
      model: providerResult.model,
      location: providerResult.location || null,
      apiLatencyMs: providerResult.apiLatencyMs,
      uidSuffix: uidSuffix(uid),
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
    });

    return {
      ok: true,
      text: providerResult.text,
    };
  },
);

module.exports.getJstDateKey = getJstDateKey;
module.exports.reserveDailyTranscribeQuota = reserveDailyTranscribeQuota;
module.exports.resolveSttProvider = resolveSttProvider;
module.exports.invokeSttProvider = invokeSttProvider;
module.exports.logSttEvent = logSttEvent;
module.exports.uidSuffix = uidSuffix;
