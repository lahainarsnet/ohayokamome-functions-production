const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getPreviousJstDateKey } = require("./jstDate");
const { finalizeDailyReport } = require("./eodSnapshot");

async function runScheduledDailyReportHandler(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const reportDate = options.reportDate || getPreviousJstDateKey(now);
  return finalizeDailyReport(reportDate, {
    ...options,
    source: options.source || "scheduled",
    now,
  });
}

const scheduledDailyReport = onSchedule(
  {
    schedule: "20 0 * * *",
    timeZone: "Asia/Tokyo",
    region: "us-central1",
  },
  async () => runScheduledDailyReportHandler(),
);

module.exports = {
  runScheduledDailyReportHandler,
  scheduledDailyReport,
};
