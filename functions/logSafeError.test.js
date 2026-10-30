const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  safeErrorLogFields,
  safeLookupErrorsForLog,
  redactLogText,
  stackLocations,
} = require("./logSafeError");

const SAMPLE_UID = "AbCdEfGhIjKlMnOpQrStUvWxYz12";
const SAMPLE_TX = "2000000123456789";

function runTests() {
  // Redaction targets.
  {
    const raw = [
      `5 NOT_FOUND: No document to update: projects/p/databases/(default)/documents/users/${SAMPLE_UID}`,
      `path users/${SAMPLE_UID}/x`,
      `owner subscription_ownership/ios_${SAMPLE_TX}`,
      "contact someone@example.com",
      "Authorization: Bearer dummyBearerValue123",
      `orig ${SAMPLE_TX}`,
      `GPA.1234-5678-9012-34567 and ${"t".repeat(60)}`,
      "url?access_token=abc123&x=1",
    ].join(" | ");
    const out = redactLogText(raw, 2000);
    assert.ok(!out.includes(SAMPLE_UID), "uid must be redacted");
    assert.ok(!out.includes(SAMPLE_TX), "transaction id must be redacted");
    assert.ok(!out.includes("someone@example.com"));
    assert.ok(!out.includes("dummyBearerValue123"));
    assert.ok(!out.includes("abc123"));
    assert.ok(!out.includes("t".repeat(60)));
    assert.ok(out.includes("documents/[DOC_PATH_REDACTED]"));
    assert.ok(out.includes("users/[UID_REDACTED]"));
    assert.ok(out.includes("ios_[ID_REDACTED]"));
    assert.ok(out.includes("[EMAIL_REDACTED]"));
    assert.ok(out.includes("Bearer [REDACTED]"));
    assert.ok(out.includes("5 NOT_FOUND"), "diagnostic prefix is kept");
  }

  // Code / stage / location are kept; full stack is not.
  {
    const error = new Error(`write failed for users/${SAMPLE_UID}`);
    error.code = "not-found";
    error.status = 404;
    error.stack = [
      `Error: write failed for users/${SAMPLE_UID}`,
      "    at applyUpdate (/workspace/subscriptionEntitlement.js:912:11)",
      "    at async handler (/workspace/appStoreSubscriptionNotifications.js:1040:5)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n");
    error.cause = new TypeError("inner someone@example.com");
    const fields = safeErrorLogFields(error, "dual_write");
    assert.equal(fields.stage, "dual_write");
    assert.equal(fields.errorType, "Error");
    assert.equal(fields.errorName, "Error");
    assert.equal(fields.errorCode, "not-found");
    assert.equal(fields.errorStatus, 404);
    assert.ok(fields.errorMessage.includes("write failed"));
    assert.ok(!fields.errorMessage.includes(SAMPLE_UID));
    assert.deepEqual(fields.errorStackLocations, [
      "subscriptionEntitlement.js:912:11",
      "appStoreSubscriptionNotifications.js:1040:5",
    ]);
    assert.equal(fields.errorStack, undefined);
    assert.equal(fields.errorCause.errorType, "TypeError");
    assert.ok(!fields.errorCause.errorMessage.includes("someone@example.com"));
    assert.ok(!JSON.stringify(fields).includes(SAMPLE_UID));
  }

  // Apple-style and numeric codes.
  {
    const apiError = { constructor: { name: "APIException" }, httpStatusCode: 401, apiError: 4040010, errorMessage: "Invalid transaction id." };
    const fields = safeErrorLogFields(apiError, "notification_handle");
    assert.equal(fields.errorStatus, 401);
    assert.equal(fields.errorCode, 4040010);
    assert.equal(fields.errorMessage, "Invalid transaction id.");
  }

  // Never throws on odd inputs.
  {
    assert.doesNotThrow(() => safeErrorLogFields(null, "s"));
    assert.equal(safeErrorLogFields(null, "s").errorType, "null");
    assert.equal(safeErrorLogFields(undefined, "s").errorType, "undefined");
    const fromString = safeErrorLogFields(`plain ${SAMPLE_TX}`, "s");
    assert.equal(fromString.errorType, "string");
    assert.ok(!fromString.errorMessage.includes(SAMPLE_TX));

    const huge = new Error("m".repeat(1_000_000));
    const hugeFields = safeErrorLogFields(huge, "s");
    assert.ok(hugeFields.errorMessage.length <= 300 + "[TRUNCATED]".length);

    const circular = new Error("outer");
    circular.cause = circular;
    assert.doesNotThrow(() => safeErrorLogFields(circular, "s"));
    assert.equal(safeErrorLogFields(circular, "s").errorCause, null);

    const loopA = new Error("a");
    const loopB = new Error("b");
    loopA.cause = loopB;
    loopB.cause = loopA;
    assert.doesNotThrow(() => JSON.stringify(safeErrorLogFields(loopA, "s")));

    const hostile = {};
    Object.defineProperty(hostile, "message", { get() { throw new Error("boom"); } });
    assert.doesNotThrow(() => safeErrorLogFields(hostile, "s"));

    const badCode = new Error("x");
    badCode.code = { nested: true };
    assert.equal(safeErrorLogFields(badCode, "s").errorCode, "redacted");
    assert.equal(safeErrorLogFields(new Error("x"), "bad stage!").stage, "unknown");
    assert.deepEqual(stackLocations(12345), []);
  }

  // lookupErrors keep structure, message is redacted only for the log.
  {
    const lookupErrors = [
      { environment: "PRODUCTION", status: 404, appleErrorCode: 4040010, appleErrorMessage: `Not found ${SAMPLE_TX}` },
    ];
    const out = safeLookupErrorsForLog(lookupErrors);
    assert.equal(out[0].environment, "PRODUCTION");
    assert.equal(out[0].status, 404);
    assert.equal(out[0].appleErrorCode, 4040010);
    assert.ok(!out[0].appleErrorMessage.includes(SAMPLE_TX));
    assert.ok(lookupErrors[0].appleErrorMessage.includes(SAMPLE_TX), "input is not mutated");
    assert.equal(safeLookupErrorsForLog(undefined), null);
    assert.equal(safeLookupErrorsForLog("weird"), "redacted");
  }

  // (1) UID-bearing log calls: no raw uid inside logger calls, suffix present.
  {
    const logCallRe = /\blogger\.(?:info|warn|error)\s*\(/g;
    const logBodies = (file) => {
      const src = fs.readFileSync(path.join(__dirname, file), "utf8");
      const bodies = [];
      let match;
      while ((match = logCallRe.exec(src))) {
        let i = match.index + match[0].length;
        let depth = 1;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === "(" || c === "{" || c === "[") depth += 1;
          else if (c === ")" || c === "}" || c === "]") depth -= 1;
          i += 1;
        }
        bodies.push(src.slice(match.index, i));
      }
      return bodies;
    };
    const targets = [
      ["googlePlaySubscriptionNotifications.js", "revocation resolved"],
      ["googlePlaySubscriptionNotifications.js", "} processed`"],
      ["appStoreSubscriptionNotifications.js", "renewal decode failed"],
    ];
    for (const [file, marker] of targets) {
      const bodies = logBodies(file);
      for (const body of bodies) {
        assert.ok(!/\buid:\s*userLookup\.uid\b/.test(body), `${file}: raw uid in log call`);
      }
      const target = bodies.filter((body) => body.includes(marker));
      assert.ok(target.length >= 1, `${file}: ${marker} log call not found`);
      for (const body of target) {
        assert.ok(/uidSuffix:\s*tokenSuffix\(/.test(body), `${file}: ${marker} uses uidSuffix`);
      }
    }
    const gp = require("./googlePlaySubscriptionNotifications");
    const bf = require("./billingFinalTrace");
    assert.equal(gp.tokenSuffix(String(SAMPLE_UID || "")), SAMPLE_UID.slice(-6));
    assert.equal(gp.tokenSuffix(String(undefined || "")), "empty");
    assert.equal(bf.tokenSuffix(SAMPLE_UID), SAMPLE_UID.slice(-6));
  }

  console.log("logSafeError.test.js: all tests passed");
}

runTests();
