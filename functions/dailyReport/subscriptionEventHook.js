const { recordSubscriptionEventActivity } = require("./increment");

async function writeSubscriptionEventWithDailyReport(db, eventId, fields, options = {}) {
  const writeFn = options.writeFn;
  if (typeof writeFn !== "function") {
    throw new Error("writeSubscriptionEventWithDailyReport requires writeFn");
  }
  await writeFn(db, eventId, fields);
  recordSubscriptionEventActivity(fields, options);
}

module.exports = {
  writeSubscriptionEventWithDailyReport,
};
