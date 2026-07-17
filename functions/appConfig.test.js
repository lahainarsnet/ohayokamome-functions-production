const assert = require("assert");
const {
  DEFAULT_DAILY_SEND_LIMIT,
  DEFAULT_DAILY_TRANSCRIBE_LIMIT,
  MAX_DAILY_LIMIT,
  parseDailyLimitField,
} = require("./appConfig");
const {
  evaluateTranscribeQuotaReservation,
  getJstDateKey,
} = require("./transcribeExperiment");

function runParseTests() {
  const ok120 = parseDailyLimitField(120, DEFAULT_DAILY_TRANSCRIBE_LIMIT, "dailyTranscribeLimit");
  assert.strictEqual(ok120.value, 120);
  assert.strictEqual(ok120.usedDefault, false);

  const ok80 = parseDailyLimitField(80, DEFAULT_DAILY_TRANSCRIBE_LIMIT, "dailyTranscribeLimit");
  assert.strictEqual(ok80.value, 80);
  assert.strictEqual(ok80.usedDefault, false);

  for (const raw of [undefined, null, "120", 0, -1, 1.5, NaN]) {
    const parsed = parseDailyLimitField(raw, DEFAULT_DAILY_TRANSCRIBE_LIMIT, "dailyTranscribeLimit");
    assert.strictEqual(parsed.value, DEFAULT_DAILY_TRANSCRIBE_LIMIT);
    assert.strictEqual(parsed.usedDefault, true);
  }

  const tooLarge = parseDailyLimitField(MAX_DAILY_LIMIT + 1, DEFAULT_DAILY_TRANSCRIBE_LIMIT, "dailyTranscribeLimit");
  assert.strictEqual(tooLarge.value, DEFAULT_DAILY_TRANSCRIBE_LIMIT);
  assert.strictEqual(tooLarge.reason, "too_large");

  assert.strictEqual(DEFAULT_DAILY_SEND_LIMIT, 120);
  assert.strictEqual(DEFAULT_DAILY_TRANSCRIBE_LIMIT, 120);
}

function runQuotaTests() {
  const today = getJstDateKey(new Date("2026-07-18T00:00:00.000Z"));
  const yesterday = getJstDateKey(new Date("2026-07-17T00:00:00.000Z"));

  const reserved = evaluateTranscribeQuotaReservation({
    count: 10,
    lastDate: today,
    todayKey: today,
    limit: 80,
  });
  assert.strictEqual(reserved.allowed, true);
  assert.strictEqual(reserved.count, 11);
  assert.strictEqual(reserved.limit, 80);
  assert.strictEqual(reserved.usedCount, 11);
  assert.strictEqual(reserved.remainingCount, 69);

  const blocked = evaluateTranscribeQuotaReservation({
    count: 80,
    lastDate: today,
    todayKey: today,
    limit: 80,
  });
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.count, 80);
  assert.strictEqual(blocked.usedCount, 80);
  assert.strictEqual(blocked.remainingCount, 0);

  const reset = evaluateTranscribeQuotaReservation({
    count: 80,
    lastDate: yesterday,
    todayKey: today,
    limit: 80,
  });
  assert.strictEqual(reset.allowed, true);
  assert.strictEqual(reset.count, 1);
  assert.strictEqual(reset.usedCount, 1);
  assert.strictEqual(reset.remainingCount, 79);

  let concurrentCount = 79;
  let allowedAttempts = 0;
  for (let i = 0; i < 5; i += 1) {
    const attempt = evaluateTranscribeQuotaReservation({
      count: concurrentCount,
      lastDate: today,
      todayKey: today,
      limit: 80,
    });
    if (attempt.allowed) {
      allowedAttempts += 1;
      concurrentCount = attempt.count;
    }
  }
  assert.strictEqual(allowedAttempts, 1);
  assert.strictEqual(concurrentCount, 80);

  const send120 = parseDailyLimitField(120, DEFAULT_DAILY_SEND_LIMIT, "dailySendLimit");
  assert.strictEqual(send120.value, 120);
  assert.strictEqual(send120.usedDefault, false);
}

runParseTests();
runQuotaTests();
console.log("appConfig.test.js: all tests passed");
