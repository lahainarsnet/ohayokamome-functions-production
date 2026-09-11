const admin = require("../firebaseAdmin");
const { getJstDateKey, getReportWindowUtc, TIMEZONE } = require("./jstDate");
const {
  COLLECTION_ID,
  createBaseReportMetadata,
  sanitizeErrorCode,
  sanitizeMetricKey,
} = require("./schema");

function buildIncrementUpdate(increments, incrementFn) {
  const inc = incrementFn || ((amount) => admin.FieldValue.increment(amount));
  const update = {};
  for (const [path, amount] of Object.entries(increments)) {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount === 0) continue;
    update[path] = inc(amount);
  }
  return update;
}

async function incrementDailyReport(reportDate, increments, options = {}) {
  const getDb = options.getDb || (() => admin.getDb());
  const logger = options.logger || console;
  const update = buildIncrementUpdate(increments, options.incrementFn);
  if (Object.keys(update).length === 0) return { ok: true, skipped: true };

  const { windowStartUtc, windowEndUtc } = getReportWindowUtc(reportDate);
  const ref = getDb().collection(COLLECTION_ID).doc(reportDate);
  await ref.set(
    {
      ...createBaseReportMetadata(reportDate, TIMEZONE),
      windowStartUtc,
      windowEndUtc,
      ...update,
    },
    { merge: true },
  );
  return { ok: true, reportDate };
}

function scheduleIncrement(increments, options = {}) {
  const reportDate = options.reportDate || getJstDateKey(options.now instanceof Date ? options.now : new Date());
  const logger = options.logger || console;
  const context = options.context || "dailyReport";
  void incrementDailyReport(reportDate, increments, options).catch((error) => {
    logger.warn(`${context}: increment_failed`, {
      reportDate,
      errorType: error?.constructor?.name || typeof error,
    });
  });
}

function recordMessageSent(options = {}) {
  scheduleIncrement(
    {
      "activity.messaging.sentCount": 1,
      "activity.messaging.receivedCount": 1,
    },
    { ...options, context: "dailyReport.messaging.sent" },
  );
}

function recordMessageBlocked(reason, options = {}) {
  const key =
    reason === "limitExceeded"
      ? "activity.messaging.sendBlocked.limitExceeded"
      : reason === "subscription"
        ? "activity.messaging.sendBlocked.subscription"
        : reason === "deviceGate"
          ? "activity.messaging.sendBlocked.deviceGate"
          : null;
  if (!key) return;
  scheduleIncrement({ [key]: 1 }, { ...options, context: "dailyReport.messaging.blocked" });
}

function recordSttLimitExceeded(options = {}) {
  scheduleIncrement(
    { "activity.stt.limitExceededAttempts": 1 },
    { ...options, context: "dailyReport.stt.limitExceeded" },
  );
}

function recordSttAttempt(options = {}) {
  scheduleIncrement(
    { "activity.stt.attemptCount": 1 },
    { ...options, context: "dailyReport.stt.attempt" },
  );
}

function recordSttSuccess(options = {}) {
  scheduleIncrement(
    { "activity.stt.successCount": 1 },
    { ...options, context: "dailyReport.stt.success" },
  );
}

function recordSttFailure(errorCode, options = {}) {
  const code = sanitizeErrorCode(errorCode);
  scheduleIncrement(
    {
      "activity.stt.failureCount": 1,
      [`activity.stt.failureByCode.${code}`]: 1,
    },
    { ...options, context: "dailyReport.stt.failure" },
  );
}

function recordAccountDeletion(options = {}) {
  scheduleIncrement(
    { "activity.users.accountDeletions": 1 },
    { ...options, context: "dailyReport.users.accountDeletion" },
  );
}

function recordSubscriptionEventActivity(fields = {}, options = {}) {
  const platform = sanitizeMetricKey(fields.platform, "unknown");
  const notificationType = sanitizeMetricKey(fields.notificationType || fields.type, "unknown");
  const status = sanitizeMetricKey(fields.status, "unknown");
  scheduleIncrement(
    {
      "activity.billing.subscriptionEvents.total": 1,
      [`activity.billing.subscriptionEvents.byPlatform.${platform}`]: 1,
      [`activity.billing.subscriptionEvents.byType.${notificationType}`]: 1,
      [`activity.billing.subscriptionEvents.byStatus.${status}`]: 1,
    },
    { ...options, context: "dailyReport.billing.subscriptionEvent" },
  );
}

module.exports = {
  buildIncrementUpdate,
  incrementDailyReport,
  scheduleIncrement,
  recordMessageSent,
  recordMessageBlocked,
  recordSttLimitExceeded,
  recordSttAttempt,
  recordSttSuccess,
  recordSttFailure,
  recordAccountDeletion,
  recordSubscriptionEventActivity,
};
