/**
 * Phase 3: Base64 音声 → OpenAI Speech-to-text（/v1/audio/transcriptions）。
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
const { defineSecret } = require("firebase-functions/params");
const admin = require("./firebaseAdmin");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODEL = "gpt-4o-mini-transcribe";
const DAILY_TRANSCRIBE_LIMIT = 5;
/** OpenAI 上限に合わせたガード（https://platform.openai.com/docs/api-reference/audio） */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function getJstDateKey(baseDate = new Date()) {
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jst = new Date(baseDate.getTime() + JST_OFFSET_MS);
  return jst.toISOString().slice(0, 10);
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

exports.transcribeExperiment = onCall(
  { secrets: [OPENAI_API_KEY] },
  async (request) => {
    const uid = request.auth?.uid || null;
    if (!uid) {
      logger.warn("transcribeExperiment: UNAUTHENTICATED");
      return { ok: false, code: "UNAUTHENTICATED" };
    }

    const { audioBase64, mimeType } = request.data || {};

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
      logger.warn("transcribeExperiment: AUDIO_TOO_LARGE", {
        receivedBytes,
        maxBytes: MAX_AUDIO_BYTES,
      });
      return { ok: false, code: "AUDIO_TOO_LARGE" };
    }

    let apiKey;
    try {
      apiKey = OPENAI_API_KEY.value();
    } catch (_) {
      logger.warn("transcribeExperiment: SECRET_READ_FAILED", {
        receivedBytes,
      });
      return { ok: false, code: "SECRET_READ_FAILED" };
    }
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      logger.warn("transcribeExperiment: SECRET_EMPTY", { receivedBytes });
      return { ok: false, code: "SECRET_EMPTY" };
    }

    let quota;
    try {
      quota = await reserveDailyTranscribeQuota(uid);
    } catch (e) {
      logger.error("transcribeExperiment: QUOTA_CHECK_FAILED", {
        uid,
        receivedBytes,
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
      return {
        ok: false,
        code: "DAILY_TRANSCRIBE_LIMIT_EXCEEDED",
        limit: DAILY_TRANSCRIBE_LIMIT,
      };
    }

    const trimmedMime = mimeType.trim();
    const filename = trimmedMime.toLowerCase().includes("mp4")
      ? "audio.mp4"
      : "audio.m4a";

    const blob = new Blob([buf], { type: trimmedMime });
    const formData = new FormData();
    formData.append("file", blob, filename);
    formData.append("model", MODEL);
    /** plain text より JSON の方が応答構造が安定してパースが最小 */
    formData.append("response_format", "json");

    let res;
    try {
      res = await fetch(TRANSCRIBE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
      });
    } catch (e) {
      logger.error("transcribeExperiment: OPENAI_REQUEST_FAILED", {
        fetchErrorName: e && typeof e.name === "string" ? e.name : "Error",
        receivedBytes,
      });
      return { ok: false, code: "OPENAI_REQUEST_FAILED" };
    }

    const rawBody = await res.text();
    if (!res.ok) {
      let openaiErrorType = "unknown";
      try {
        const errJson = JSON.parse(rawBody);
        if (
          errJson &&
          errJson.error &&
          typeof errJson.error.type === "string"
        ) {
          openaiErrorType = errJson.error.type;
        }
      } catch (_) {
        /* 本文はログに載せない */
      }
      logger.warn("transcribeExperiment: OPENAI_HTTP_ERROR", {
        status: res.status,
        openaiErrorType,
        receivedBytes,
      });
      return { ok: false, code: "OPENAI_HTTP_ERROR" };
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (_) {
      logger.warn("transcribeExperiment: OPENAI_BAD_RESPONSE (parse)", {
        receivedBytes,
      });
      return { ok: false, code: "OPENAI_BAD_RESPONSE" };
    }

    if (!data || typeof data.text !== "string") {
      logger.warn("transcribeExperiment: OPENAI_BAD_RESPONSE (shape)", {
        receivedBytes,
      });
      return { ok: false, code: "OPENAI_BAD_RESPONSE" };
    }

    logger.info("transcribeExperiment: transcription ok", { receivedBytes });

    return {
      ok: true,
      text: data.text,
    };
  },
);
