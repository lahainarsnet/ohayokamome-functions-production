"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  describeAccountAccessUsability,
} = require("./accountAccessUsability");
const {
  computeEntitlementExpiryDeltaMs,
  shouldRetryRecipientEntitlementExpiryLag,
  resolveRecipientSubscriptionWithExpiryLagRetry,
  DEFAULT_GRACE_MS,
  DEFAULT_RETRY_INTERVAL_MS,
  DEFAULT_MAX_RETRIES,
} = require("./recipientSubscriptionGuardRetry");

const baseNow = new Date("2026-08-13T12:00:00.000Z");

function msFromNow(offsetMs, now = baseNow) {
  return new Date(now.getTime() + offsetMs);
}

function buildRecipientUserData({
  status = "active",
  entitlementUsable = true,
  entitlementExpiryOffsetMs,
  legacyExpiryOffsetMs = 86_400_000,
  platform = "android",
}) {
  return {
    subscriptionStatus: status,
    subscriptionPlatform: platform,
    entitlementUsable,
    entitlementExpiryTime: msFromNow(entitlementExpiryOffsetMs),
    subscriptionExpiryTime: msFromNow(legacyExpiryOffsetMs),
  };
}

function describeUsabilityForTest(userData, now = baseNow) {
  return describeAccountAccessUsability(userData, now);
}

function assertNoSleepCalls(sleepCalls) {
  assert.equal(sleepCalls, 0, "expected no retry sleep");
}

function assertFetchCalls(fetchCalls, expected) {
  assert.equal(fetchCalls, expected, `expected ${expected} fetch call(s)`);
}

function createSimulatedClock(start = baseNow) {
  let currentMs = start.getTime();
  return {
    now: () => new Date(currentMs),
    sleep: async (ms) => {
      currentMs += ms;
    },
  };
}

async function simulateSendAfterRecipientGuard({
  initialUserData,
  fetchSequence,
  sleepCallsRef,
  fetchCallsRef,
  clock = createSimulatedClock(),
}) {
  let dailyCount = 0;
  let messagesCreated = 0;
  let sleepCalls = 0;
  let fetchCalls = 0;
  let returnedCode = null;

  const recipientData = initialUserData;
  const subscriptionStatus = recipientData.subscriptionStatus;
  let usability = describeUsabilityForTest(recipientData, clock.now());

  if (!usability.subscriptionUsable) {
    const retryResult = await resolveRecipientSubscriptionWithExpiryLagRetry({
      recipientData,
      usability,
      subscriptionStatus,
      now: clock.now(),
      getNow: clock.now,
      fetchRecipientData: async () => {
        fetchCalls += 1;
        const next = fetchSequence.shift();
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
      sleep: async (ms) => {
        sleepCalls += 1;
        await clock.sleep(ms);
      },
      describeUsability: describeUsabilityForTest,
      parseExpiryWithMeta: undefined,
    });
    if (retryResult.retried) {
      usability = retryResult.usability;
    }
  }

  if (!usability.subscriptionUsable) {
    returnedCode = "RECIPIENT_SUBSCRIPTION_UNAVAILABLE";
  } else {
    dailyCount += 1;
    messagesCreated += 1;
    returnedCode = "OK";
  }

  if (sleepCallsRef) {
    sleepCallsRef.value = sleepCalls;
  }
  if (fetchCallsRef) {
    fetchCallsRef.value = fetchCalls;
  }

  return { returnedCode, dailyCount, messagesCreated, sleepCalls, fetchCalls };
}

(async () => {
  // Test A: 8秒過去 → 1回目再取得で未来 → allowSend, 1 message, dailyCount 1
  {
    const initial = buildRecipientUserData({ entitlementExpiryOffsetMs: -8_000 });
    const updated = buildRecipientUserData({ entitlementExpiryOffsetMs: 86_400_000 });
    const initialUsability = describeUsabilityForTest(initial);
    assert.equal(initialUsability.subscriptionUsable, false);
    assert.equal(initialUsability.denyReason, "expiry_expired");
    assert.equal(
      shouldRetryRecipientEntitlementExpiryLag({
        usability: initialUsability,
        subscriptionStatus: initial.subscriptionStatus,
        entitlementExpiry: initialUsability.entitlementExpiry,
        now: baseNow,
      }),
      true,
    );

    const sleepCallsRef = { value: 0 };
    const fetchCallsRef = { value: 0 };
    const result = await simulateSendAfterRecipientGuard({
      initialUserData: initial,
      fetchSequence: [updated],
      sleepCallsRef,
      fetchCallsRef,
    });

    assert.equal(result.returnedCode, "OK");
    assert.equal(result.dailyCount, 1);
    assert.equal(result.messagesCreated, 1);
    assert.equal(sleepCallsRef.value, 1);
    assert.equal(fetchCallsRef.value, 1);
  }

  // Test B: 3回再取得しても期限過去 → block, no message, no dailyCount
  {
    const stale = buildRecipientUserData({ entitlementExpiryOffsetMs: -8_000 });
    const sleepCallsRef = { value: 0 };
    const fetchCallsRef = { value: 0 };
    const result = await simulateSendAfterRecipientGuard({
      initialUserData: stale,
      fetchSequence: [stale, stale, stale],
      sleepCallsRef,
      fetchCallsRef,
    });

    assert.equal(result.returnedCode, "RECIPIENT_SUBSCRIPTION_UNAVAILABLE");
    assert.equal(result.dailyCount, 0);
    assert.equal(result.messagesCreated, 0);
    assert.equal(sleepCallsRef.value, DEFAULT_MAX_RETRIES);
    assert.equal(fetchCallsRef.value, DEFAULT_MAX_RETRIES);
  }

  // Test C: expired / entitlementUsable=false → retry 0, immediate block
  {
    const expiredStatus = buildRecipientUserData({
      status: "expired",
      entitlementExpiryOffsetMs: -8_000,
    });
    const expiredUsability = describeUsabilityForTest(expiredStatus);
    assert.equal(
      shouldRetryRecipientEntitlementExpiryLag({
        usability: expiredUsability,
        subscriptionStatus: expiredStatus.subscriptionStatus,
        entitlementExpiry: expiredUsability.entitlementExpiry,
        now: baseNow,
      }),
      false,
    );

    let sleepCalls = 0;
    const clock = createSimulatedClock();
    const result = await resolveRecipientSubscriptionWithExpiryLagRetry({
      recipientData: expiredStatus,
      usability: expiredUsability,
      subscriptionStatus: expiredStatus.subscriptionStatus,
      now: clock.now(),
      getNow: clock.now,
      fetchRecipientData: async () => {
        throw new Error("fetch must not run");
      },
      sleep: async () => {
        sleepCalls += 1;
      },
      describeUsability: describeUsabilityForTest,
    });
    assert.equal(result.retried, false);
    assertNoSleepCalls(sleepCalls);

    const unusable = buildRecipientUserData({
      entitlementUsable: false,
      entitlementExpiryOffsetMs: 86_400_000,
    });
    const unusableUsability = describeUsabilityForTest(unusable);
    assert.equal(unusableUsability.denyReason, "entitlement_false");
    assert.equal(
      shouldRetryRecipientEntitlementExpiryLag({
        usability: unusableUsability,
        subscriptionStatus: unusable.subscriptionStatus,
        entitlementExpiry: unusableUsability.entitlementExpiry,
        now: baseNow,
      }),
      false,
    );
  }

  // Test D: 30秒より大幅に過去 → retry 0, immediate block
  {
    const farPast = buildRecipientUserData({ entitlementExpiryOffsetMs: -45_000 });
    const farPastUsability = describeUsabilityForTest(farPast);
    assert.equal(farPastUsability.denyReason, "expiry_expired");
    assert.equal(
      computeEntitlementExpiryDeltaMs(farPastUsability.entitlementExpiry, baseNow),
      -45_000,
    );
    assert.equal(
      shouldRetryRecipientEntitlementExpiryLag({
        usability: farPastUsability,
        subscriptionStatus: farPast.subscriptionStatus,
        entitlementExpiry: farPastUsability.entitlementExpiry,
        now: baseNow,
        graceMs: DEFAULT_GRACE_MS,
      }),
      false,
    );

    let sleepCalls = 0;
    const clock = createSimulatedClock();
    const result = await resolveRecipientSubscriptionWithExpiryLagRetry({
      recipientData: farPast,
      usability: farPastUsability,
      subscriptionStatus: farPast.subscriptionStatus,
      now: clock.now(),
      getNow: clock.now,
      fetchRecipientData: async () => {
        throw new Error("fetch must not run");
      },
      sleep: async () => {
        sleepCalls += 1;
      },
      describeUsability: describeUsabilityForTest,
    });
    assert.equal(result.retried, false);
    assertNoSleepCalls(sleepCalls);
  }

  // Test E: 通常 active + 期限未来 → retry 0, immediate allow
  {
    const activeFuture = buildRecipientUserData({ entitlementExpiryOffsetMs: 86_400_000 });
    const activeUsability = describeUsabilityForTest(activeFuture);
    assert.equal(activeUsability.subscriptionUsable, true);

    let sleepCalls = 0;
    const clock = createSimulatedClock();
    const result = await resolveRecipientSubscriptionWithExpiryLagRetry({
      recipientData: activeFuture,
      usability: activeUsability,
      subscriptionStatus: activeFuture.subscriptionStatus,
      now: clock.now(),
      getNow: clock.now,
      fetchRecipientData: async () => {
        throw new Error("fetch must not run");
      },
      sleep: async () => {
        sleepCalls += 1;
      },
      describeUsability: describeUsabilityForTest,
    });
    assert.equal(result.retried, false);
    assert.equal(result.resolved, true);
    assertNoSleepCalls(sleepCalls);

    const sendResult = await simulateSendAfterRecipientGuard({
      initialUserData: activeFuture,
      fetchSequence: [],
    });
    assert.equal(sendResult.returnedCode, "OK");
    assert.equal(sendResult.dailyCount, 1);
    assert.equal(sendResult.messagesCreated, 1);
    assertNoSleepCalls(sendResult.sleepCalls);
    assertFetchCalls(sendResult.fetchCalls, 0);
  }

  // Test F: retry中 fetch error → safe block, no infinite wait, retry cap respected
  {
    const initial = buildRecipientUserData({ entitlementExpiryOffsetMs: -8_000 });
    const initialUsability = describeUsabilityForTest(initial);
    const logEvents = [];
    let sleepCalls = 0;
    let fetchCalls = 0;
    const clock = createSimulatedClock();

    const result = await resolveRecipientSubscriptionWithExpiryLagRetry({
      recipientData: initial,
      usability: initialUsability,
      subscriptionStatus: initial.subscriptionStatus,
      now: clock.now(),
      getNow: clock.now,
      fetchRecipientData: async () => {
        fetchCalls += 1;
        throw new Error("firestore unavailable");
      },
      sleep: async () => {
        sleepCalls += 1;
      },
      describeUsability: describeUsabilityForTest,
      log: (entry) => logEvents.push(entry),
    });

    assert.equal(result.retried, true);
    assert.equal(result.resolved, false);
    assert.equal(result.fetchError, true);
    assert.equal(sleepCalls, 1);
    assert.equal(fetchCalls, 1);
    assert.equal(logEvents.some((entry) => entry.event === "fetchError"), true);

    const sendResult = await simulateSendAfterRecipientGuard({
      initialUserData: initial,
      fetchSequence: [new Error("firestore unavailable")],
    });
    assert.equal(sendResult.returnedCode, "RECIPIENT_SUBSCRIPTION_UNAVAILABLE");
    assert.equal(sendResult.dailyCount, 0);
    assert.equal(sendResult.messagesCreated, 0);
    assert.equal(sendResult.sleepCalls, 1);
    assert.equal(sendResult.fetchCalls, 1);
  }

  // grace 境界: -30秒は retry 対象、-30秒1ms超過は対象外
  {
    const atGraceEdge = buildRecipientUserData({ entitlementExpiryOffsetMs: -30_000 });
    const atGraceUsability = describeUsabilityForTest(atGraceEdge);
    assert.equal(
      shouldRetryRecipientEntitlementExpiryLag({
        usability: atGraceUsability,
        subscriptionStatus: atGraceEdge.subscriptionStatus,
        entitlementExpiry: atGraceUsability.entitlementExpiry,
        now: baseNow,
      }),
      true,
    );

    const beyondGrace = buildRecipientUserData({ entitlementExpiryOffsetMs: -30_001 });
    const beyondGraceUsability = describeUsabilityForTest(beyondGrace);
    assert.equal(
      shouldRetryRecipientEntitlementExpiryLag({
        usability: beyondGraceUsability,
        subscriptionStatus: beyondGrace.subscriptionStatus,
        entitlementExpiry: beyondGraceUsability.entitlementExpiry,
        now: baseNow,
      }),
      false,
    );
  }

  // legacy fallback は retry 対象外
  {
    const legacy = {
      subscriptionStatus: "active",
      subscriptionExpiryTime: msFromNow(-8_000),
    };
    const legacyUsability = describeUsabilityForTest(legacy);
    assert.equal(legacyUsability.decisionSource, "legacyFallback");
    assert.equal(
      shouldRetryRecipientEntitlementExpiryLag({
        usability: legacyUsability,
        subscriptionStatus: legacy.subscriptionStatus,
        entitlementExpiry: legacyUsability.entitlementExpiry,
        now: baseNow,
      }),
      false,
    );
  }

  // index.js 統合: retry は transaction 前、block return 前
  {
    const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
    assert.match(
      indexSource,
      /resolveRecipientSubscriptionWithExpiryLagRetry\(/,
      "index.js must call resolveRecipientSubscriptionWithExpiryLagRetry",
    );
    const sendStart = indexSource.indexOf("exports.sendMessageWithLimit");
    const sendSection = indexSource.slice(sendStart, sendStart + 12_000);
    const retryPos = sendSection.indexOf("resolveRecipientSubscriptionWithExpiryLagRetry");
    const transactionPos = sendSection.indexOf("runTransaction");
    const recipientBlockPos = sendSection.indexOf(
      "code: RECIPIENT_SUBSCRIPTION_UNAVAILABLE",
    );
    assert.ok(retryPos >= 0, "retry must exist in sendMessageWithLimit");
    assert.ok(transactionPos > retryPos, "retry must run before transaction");
    assert.ok(recipientBlockPos > retryPos, "retry must run before recipient block return");
  }

  assert.equal(DEFAULT_RETRY_INTERVAL_MS, 3_000);
  assert.equal(DEFAULT_MAX_RETRIES, 3);
  assert.equal(DEFAULT_GRACE_MS, 30_000);

  console.log("recipientSubscriptionGuardRetry.test.js: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
