const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  ALLOWED_EVENTS,
  CLIENT_DIAG_TAG,
  MAX_PAYLOAD_BYTES,
  buildClientDiagPayload,
  createEmitKamomeClientDiagHandler,
  payloadByteLength,
  sanitizeClientDiagFields,
} = require("./emitKamomeClientDiag");

function createTestLogger() {
  const entries = [];
  return {
    entries,
    info: (tag, payload) => entries.push({ level: "info", tag, payload }),
  };
}

async function runHandler(handler, request) {
  try {
    const result = await handler(request);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error };
  }
}

async function runTests() {
  {
    const fields = sanitizeClientDiagFields("subscription_ack_check_trigger", {
      path: "local",
      triggerReason: "sendMessage",
      denyReason: "expiry_expired",
      uid: "must-be-dropped",
      email: "secret@example.com",
      unknownField: "drop-me",
    });
    assert.equal(fields.path, "local");
    assert.equal(fields.triggerReason, "sendMessage");
    assert.equal(fields.denyReason, "expiry_expired");
    assert.equal(fields.uid, undefined);
    assert.equal(fields.email, undefined);
    assert.equal(fields.unknownField, undefined);
  }

  {
    const fields = sanitizeClientDiagFields("billing_verify_failed", {
      callableName: "verifyGooglePlaySubscriptionPurchase",
      errorCode: "unavailable",
      billingTraceId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
    });
    assert.equal(fields.callableName, "verifyGooglePlaySubscriptionPurchase");
    assert.equal(fields.errorCode, "unavailable");
    assert.equal(fields.billingTraceId, "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee");
  }

  {
    const logger = createTestLogger();
    const handler = createEmitKamomeClientDiagHandler({ logger });
    const response = await runHandler(handler, {
      auth: { uid: "abcdefghijklmnop" },
      data: {
        event: "subscription_ack_check_trigger",
        fields: {
          path: "cf",
          triggerReason: "senderSubscriptionUnavailableFromCloud",
          denyReason: "entitlement_false",
          subscriptionExpiryDeltaMs: "-1200",
        },
      },
    });
    assert.equal(response.ok, true);
    assert.equal(logger.entries.length, 1);
    assert.equal(logger.entries[0].tag, CLIENT_DIAG_TAG);
    assert.equal(logger.entries[0].payload.event, "subscription_ack_check_trigger");
    assert.equal(logger.entries[0].payload.uidSuffix, "klmnop");
    assert.equal(logger.entries[0].payload.path, "cf");
  }

  {
    const logger = createTestLogger();
    const handler = createEmitKamomeClientDiagHandler({ logger });
    const response = await runHandler(handler, {
      auth: { uid: "user123456" },
      data: {
        event: "not_allowed_event",
        fields: { reason: "x" },
      },
    });
    assert.equal(response.ok, false);
    assert.ok(response.error instanceof HttpsError);
    assert.equal(response.error.code, "invalid-argument");
    assert.equal(logger.entries.length, 0);
  }

  {
    const logger = createTestLogger();
    const handler = createEmitKamomeClientDiagHandler({ logger });
    const response = await runHandler(handler, {
      auth: null,
      data: {
        event: "cf_call_failed",
        fields: { errorCode: "unavailable" },
      },
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "unauthenticated");
  }

  {
    const longValue = "x".repeat(256);
    const logger = createTestLogger();
    const handler = createEmitKamomeClientDiagHandler({ logger });
    const response = await runHandler(handler, {
      auth: { uid: "abcdefghij" },
      data: {
        event: "subscription_ack_check_trigger",
        fields: {
          path: longValue,
          triggerReason: longValue,
          denyReason: longValue,
          decisionSource: longValue,
          subscriptionStatus: longValue,
          entitlementUsable: longValue,
          subscriptionPlatform: longValue,
          subscriptionExpiryDeltaMs: longValue,
          entitlementExpiryDeltaMs: longValue,
          lastSubscriptionSource: longValue,
          googlePlaySubscriptionState: longValue,
          errorCode: longValue,
          platform: longValue,
          appVersion: longValue,
          buildNumber: longValue,
          billingTraceId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
          provider: longValue,
        },
      },
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "invalid-argument");
  }

  {
    for (const event of ALLOWED_EVENTS) {
      const fields = sanitizeClientDiagFields(event, {
        platform: "android",
        appVersion: "6.0.0",
        buildNumber: "228",
        purchaseToken: "must-not-appear",
        message: "secret body",
      });
      assert.equal(fields.platform, "android");
      assert.equal(fields.purchaseToken, undefined);
      assert.equal(fields.message, undefined);
    }
  }

  console.log("emitKamomeClientDiag.test.js: all tests passed");
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
