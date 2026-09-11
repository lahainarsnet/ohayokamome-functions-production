const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getJstDateKey,
  getPreviousJstDateKey,
  getReportWindowUtc,
  isTimestampInReportWindow,
} = require("./jstDate");
const { sanitizeErrorCode, sanitizeMetricKey, assertSafeDailyReportPayload } = require("./schema");
const {
  buildIncrementUpdate,
  incrementDailyReport,
  recordMessageSent,
  recordSttFailure,
  recordSubscriptionEventActivity,
} = require("./increment");
const {
  isDeletedUser,
  trimTopBuckets,
  finalizeDailyReport,
} = require("./eodSnapshot");
const { runScheduledDailyReportHandler } = require("./scheduledDailyReport");

test("getJstDateKey uses JST calendar day", () => {
  assert.equal(getJstDateKey(new Date("2026-09-10T15:30:00.000Z")), "2026-09-11");
  assert.equal(getJstDateKey(new Date("2026-09-10T14:59:59.999Z")), "2026-09-10");
});

test("getPreviousJstDateKey returns prior JST day", () => {
  assert.equal(getPreviousJstDateKey(new Date("2026-09-11T15:20:00.000Z")), "2026-09-11");
});

test("getReportWindowUtc covers JST midnight boundaries", () => {
  const window = getReportWindowUtc("2026-09-11");
  assert.equal(window.windowStartUtc, "2026-09-10T15:00:00.000Z");
  assert.equal(window.windowEndUtc, "2026-09-11T14:59:59.999Z");
  assert.equal(
    isTimestampInReportWindow("2026-09-10T15:00:00.000Z", "2026-09-11"),
    true,
  );
  assert.equal(
    isTimestampInReportWindow("2026-09-11T15:00:00.000Z", "2026-09-11"),
    false,
  );
});

test("sanitizeErrorCode keeps stable codes only", () => {
  assert.equal(sanitizeErrorCode("DAILY_TRANSCRIBE_LIMIT_EXCEEDED"), "DAILY_TRANSCRIBE_LIMIT_EXCEEDED");
  assert.equal(sanitizeErrorCode("bad-code"), "UNKNOWN");
});

test("sanitizeMetricKey rejects forbidden tokens", () => {
  assert.equal(sanitizeMetricKey("ios"), "ios");
  assert.equal(sanitizeMetricKey("purchaseToken"), "unknown");
});

test("assertSafeDailyReportPayload rejects forbidden field names", () => {
  assert.throws(() => assertSafeDailyReportPayload({ activity: { email: 1 } }));
  assert.doesNotThrow(() =>
    assertSafeDailyReportPayload({ activity: { messaging: { sentCount: 1 } } }),
  );
});

test("incrementDailyReport merges counters without dropping metadata", async () => {
  const store = new Map();
  const getDb = () => ({
    collection: () => ({
      doc: (id) => ({
        set: async (payload, opts) => {
          const prev = store.get(id) || {};
          const next = opts?.merge ? { ...prev } : {};
          for (const [key, value] of Object.entries(payload)) {
            if (typeof value === "number") next[key] = (next[key] || 0) + value;
            else next[key] = value;
          }
          store.set(id, next);
        },
      }),
    }),
  });

  await incrementDailyReport(
    "2026-09-11",
    { "activity.messaging.sentCount": 2 },
    { getDb, incrementFn: (amount) => amount },
  );
  await incrementDailyReport(
    "2026-09-11",
    { "activity.messaging.sentCount": 3 },
    { getDb, incrementFn: (amount) => amount },
  );
  assert.equal(store.get("2026-09-11").reportDate, "2026-09-11");
  assert.equal(store.get("2026-09-11")["activity.messaging.sentCount"], 5);
});

test("buildIncrementUpdate skips zero increments", () => {
  const update = buildIncrementUpdate(
    {
      "activity.messaging.sentCount": 1,
      "activity.messaging.receivedCount": 0,
    },
    (amount) => amount,
  );
  assert.equal(Object.keys(update).length, 1);
  assert.equal(update["activity.messaging.sentCount"], 1);
});

test("record helpers do not throw when firestore write fails", async () => {
  const warnings = [];
  const logger = { warn: (_, payload) => warnings.push(payload) };
  recordMessageSent({
    reportDate: "2026-09-11",
    getDb: () => {
      throw new Error("db unavailable");
    },
    logger,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(warnings.length, 1);
});

test("isDeletedUser accepts accountDeletionState and legacy deleted", () => {
  assert.equal(isDeletedUser({ accountDeletionState: "deleted" }), true);
  assert.equal(isDeletedUser({ deleted: true }), true);
  assert.equal(isDeletedUser({ accountDeletionState: "active" }), false);
});

test("trimTopBuckets keeps top N and other", () => {
  const map = {};
  for (let i = 0; i < 60; i += 1) map[`v${i}`] = i;
  const trimmed = trimTopBuckets(map, 3);
  assert.equal(Object.keys(trimmed).length, 4);
  assert.ok(trimmed.other > 0);
});

test("finalizeDailyReport preserves existing activity on rerun", async () => {
  const docs = new Map([
    [
      "2026-09-11",
      {
        status: "complete",
        generatedAt: { toDate: () => new Date("2026-09-12T00:20:00.000Z") },
        activity: { messaging: { sentCount: 7, receivedCount: 7 } },
      },
    ],
  ]);

  const getDb = () => createMockDb(docs);
  const result = await finalizeDailyReport("2026-09-11", { getDb, now: new Date("2026-09-12T00:25:00.000Z") });
  assert.equal(result.ok, true);
  const saved = docs.get("2026-09-11");
  assert.equal(saved.activity.messaging.sentCount, 7);
  assert.equal(saved.snapshot.users.total, 1);
  assert.ok(saved.regeneratedAt);
  assert.ok(saved.generatedAt);
});

test("scheduled handler targets previous JST day", async () => {
  const docs = new Map();
  const result = await runScheduledDailyReportHandler({
    now: new Date("2026-09-12T00:25:00.000Z"),
    getDb: () => createMockDb(docs),
  });
  assert.equal(result.reportDate, "2026-09-11");
});

function createMockDb(docs) {
  const users = [
    {
      id: "user-1",
      data: () => ({
        subscriptionStatus: "active",
        subscriptionPlatform: "ios",
        entitlementUsable: true,
      }),
    },
  ];
  return {
    collection: (name) => {
      if (name === "users") {
        return {
          orderBy: () => ({
            limit: () => ({
              get: async () => ({ empty: false, docs: users, size: users.length }),
              startAfter: () => ({
                get: async () => ({ empty: true, docs: [], size: 0 }),
              }),
            }),
            startAfter: () => ({
              get: async () => ({ empty: true, docs: [], size: 0 }),
            }),
          }),
        };
      }
      if (name === "daily_reports") {
        return {
          doc: (id) => ({
            get: async () => ({
              exists: docs.has(id),
              data: () => docs.get(id),
            }),
            set: async (payload, opts) => {
              const prev = docs.get(id) || {};
              if (!opts?.merge) {
                docs.set(id, payload);
                return;
              }
              const next = { ...prev, ...payload };
              if (prev.activity && payload.activity == null) next.activity = prev.activity;
              docs.set(id, next);
            },
            update: async (payload) => {
              docs.set(id, { ...(docs.get(id) || {}), ...payload });
            },
          }),
        };
      }
      if (name === "tos_agreements") {
        return {
          where: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  get: async () => ({ empty: true, docs: [], size: 0 }),
                  startAfter: () => ({
                    get: async () => ({ empty: true, docs: [], size: 0 }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {
        doc: (id) => ({
          get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }),
          set: async (payload, opts) => {
            const prev = docs.get(id) || {};
            docs.set(id, opts?.merge ? { ...prev, ...payload } : payload);
          },
          update: async (payload) => {
            docs.set(id, { ...(docs.get(id) || {}), ...payload });
          },
        }),
      };
    },
    collectionGroup: () => ({
      orderBy: () => ({
        limit: () => ({
          get: async () => ({ empty: true, docs: [], size: 0 }),
          startAfter: () => ({
            get: async () => ({ empty: true, docs: [], size: 0 }),
          }),
        }),
        startAfter: () => ({
          get: async () => ({ empty: true, docs: [], size: 0 }),
        }),
      }),
    }),
  };
}

test("recordSubscriptionEventActivity uses sanitized keys only", async () => {
  const store = new Map();
  const getDb = () => ({
    collection: () => ({
      doc: (id) => ({
        set: async (payload, opts) => {
          const prev = store.get(id) || {};
          store.set(id, opts?.merge ? { ...prev, ...payload } : payload);
        },
      }),
    }),
  });
  recordSubscriptionEventActivity(
    {
      platform: "ios",
      notificationType: "DID_RENEW",
      status: "processed",
      purchaseToken: "must-not-appear",
    },
    { getDb, reportDate: "2026-09-11" },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const json = JSON.stringify(store.get("2026-09-11") || {});
  assert.equal(json.includes("purchaseToken"), false);
});
