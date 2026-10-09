"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const transcribeSource = fs.readFileSync(
  path.join(__dirname, "transcribeExperiment.js"),
  "utf8"
);
const asnSource = fs.readFileSync(
  path.join(__dirname, "appStoreSubscriptionNotifications.js"),
  "utf8"
);
const rtdnSource = fs.readFileSync(
  path.join(__dirname, "googlePlaySubscriptionNotifications.js"),
  "utf8"
);

function exportBlock(source, exportName) {
  const token = `exports.${exportName}`;
  const start = source.indexOf(token);
  assert.ok(start >= 0, `${exportName} export must exist`);
  const next = source.indexOf("exports.", start + token.length);
  return source.slice(start, next >= 0 ? next : source.length);
}

function assertGateBefore(source, laterNeedle, label) {
  const gateIdx = source.indexOf("evaluateActiveDeviceGateForRequest");
  const assertIdx = source.indexOf("assertActiveDeviceAllowed");
  const txGateIdx = source.indexOf("evaluateActiveDeviceGate");
  const gatePos = gateIdx >= 0 ? gateIdx : (assertIdx >= 0 ? assertIdx : txGateIdx);
  const laterPos = source.indexOf(laterNeedle);
  assert.ok(gatePos >= 0, `${label} must call activeDevice gate`);
  assert.ok(laterPos >= 0, `${label} must contain ${laterNeedle}`);
  assert.ok(
    gatePos < laterPos,
    `${label} must run activeDevice gate before ${laterNeedle}`
  );
}

const chatProvisionalSource = fs.readFileSync(
  path.join(__dirname, "chatUnknownProvisional.js"),
  "utf8"
);
const recordHandler = chatProvisionalSource.slice(
  chatProvisionalSource.indexOf("function createRecordChatUnknownProvisionalHandler"),
  chatProvisionalSource.indexOf("function createClearChatUnknownProvisionalHandler")
);
assert.match(recordHandler, /evaluateActiveDeviceGate/);
assert.match(recordHandler, /classifyChatPlatformEntitlement/);
assertGateBefore(
  recordHandler,
  "classifyChatPlatformEntitlement",
  "createRecordChatUnknownProvisionalHandler"
);
assert.match(
  exportBlock(indexSource, "recordChatUnknownProvisional"),
  /createRecordChatUnknownProvisionalHandler/
);

const sendSource = exportBlock(indexSource, "sendMessageWithLimit");
assert.match(sendSource, /evaluateActiveDeviceGateForRequest/);
assertGateBefore(sendSource, "platformFromAppCheckAppId", "sendMessageWithLimit");
assertGateBefore(
  sendSource,
  "resolveChatEntitlementWithUnknownProvisional",
  "sendMessageWithLimit"
);
assert.match(sendSource, /resolveRecipientChatEntitlement/);
assert.match(
  sendSource,
  /resolveRecipientChatEntitlement\(/
);
assert.ok(
  sendSource.indexOf("SENDER_AUTH_MISMATCH") <
    sendSource.indexOf("evaluateActiveDeviceGateForRequest")
);

const transcribeHandler = transcribeSource.slice(
  transcribeSource.indexOf("exports.transcribeExperiment")
);
assert.match(transcribeHandler, /evaluateActiveDeviceGateForRequest/);
assertGateBefore(
  transcribeHandler,
  "runTranscribeAdminGateAfterAuth",
  "transcribeExperiment"
);
assertGateBefore(
  transcribeHandler,
  "assertCallerSubscriptionUsable",
  "transcribeExperiment"
);
assert.ok(
  transcribeHandler.indexOf('return { ok: false, code: "UNAUTHENTICATED" }') <
    transcribeHandler.indexOf("evaluateActiveDeviceGateForRequest")
);

const playVerify = exportBlock(
  indexSource,
  "verifyGooglePlaySubscriptionPurchase"
);
assert.match(playVerify, /assertActiveDeviceAllowed/);
assertGateBefore(
  playVerify,
  "assertPurchasingPlatformAllowed(uid, \"android\")",
  "verifyGooglePlaySubscriptionPurchase"
);

const iosVerify = exportBlock(
  indexSource,
  "verifyAppStoreSubscriptionPurchase"
);
assert.match(iosVerify, /assertActiveDeviceAllowed/);
assertGateBefore(
  iosVerify,
  "assertPurchasingPlatformAllowed(uid, \"ios\", traceId)",
  "verifyAppStoreSubscriptionPurchase"
);

const ensureSource = exportBlock(indexSource, "ensureAppStoreAppAccountToken");
assert.match(ensureSource, /assertActiveDeviceAllowed/);
assertGateBefore(
  ensureSource,
  "ensureAppStoreAppAccountTokenForUser",
  "ensureAppStoreAppAccountToken"
);

const inspectHandlerSource = fs.readFileSync(
  path.join(__dirname, "inspectSubscriptionSeriesOwnership.js"),
  "utf8"
);
assert.doesNotMatch(
  inspectHandlerSource,
  /assertActiveDeviceAllowed|evaluateActiveDeviceGateForRequest/
);

const ungated = [
  "handleAppStoreServerNotification",
  "handleGooglePlayRtdn",
  "adminUpsertUserSubscription",
  "emitKamomeClientDiag",
  "upsertUserEmailAndAccount",
  "getUserInfoByAccountId",
  "deleteMyAccount",
  "probeGooglePlaySubscriptionEntitlement",
  "clearDeviceFcmToken",
  "sendPushNotification",
  "inspectSubscriptionSeriesOwnership",
];
for (const exportName of ungated) {
  const block = exportBlock(indexSource, exportName);
  assert.doesNotMatch(
    block,
    /assertActiveDeviceAllowed|evaluateActiveDeviceGateForRequest/
  );
}

const upsertEmail = exportBlock(indexSource, "upsertUserEmailAndAccount");
assert.match(upsertEmail, /expectedUid !== uid/);
assert.match(upsertEmail, /new HttpsError\("failed-precondition"/);
const uidGuardPosition = upsertEmail.indexOf("expectedUid !== uid");
for (const writePath of [
  'collection("users")',
  "resolveAccountIdForUpsert(",
  "userRef.set(",
]) {
  const writePosition = upsertEmail.indexOf(writePath);
  assert.ok(writePosition >= 0, `upsert must contain ${writePath}`);
  assert.ok(
    uidGuardPosition < writePosition,
    `expectedUid guard must run before ${writePath}`
  );
}

assert.doesNotMatch(asnSource, /assertActiveDeviceAllowed|ACTIVE_DEVICE_MISMATCH|deviceId/);
assert.doesNotMatch(rtdnSource, /assertActiveDeviceAllowed|ACTIVE_DEVICE_MISMATCH|deviceId/);

assert.match(
  indexSource,
  /verifyGooglePlaySubscriptionPurchase[\s\S]*?assertPurchasingPlatformAllowed\(uid, "android"\)/
);
assert.match(
  indexSource,
  /verifyAppStoreSubscriptionPurchase[\s\S]*?assertPurchasingPlatformAllowed\(uid, "ios", traceId\)/
);

console.log("activeDeviceCallableGate.test.js: ok");
