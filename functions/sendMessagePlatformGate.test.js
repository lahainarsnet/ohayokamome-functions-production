"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const sendStart = indexSource.indexOf("exports.sendMessageWithLimit");
const sendEnd = indexSource.indexOf("exports.deleteMyAccount");
assert.ok(sendStart >= 0 && sendEnd > sendStart, "sendMessageWithLimit region");
const sendSource = indexSource.slice(sendStart, sendEnd);

assert.match(sendSource, /platformFromAppCheckAppId\(/);
assert.match(sendSource, /request\.app && request\.app\.appId/);
assert.match(sendSource, /evaluatePlatformEntitlement\(/);
assert.match(sendSource, /describeAccountAccessUsability\(recipientData/);
assert.doesNotMatch(
  sendSource,
  /evaluatePlatformEntitlement\(recipientData/
);
assert.doesNotMatch(
  sendSource,
  /platformFromAppCheckAppId\(request\.data/
);

const transcribeSource = fs.readFileSync(
  path.join(__dirname, "transcribeExperiment.js"),
  "utf8"
);
assert.match(
  transcribeSource,
  /assertCallerSubscriptionUsable\(uid, \{\s*appId: request\.app && request\.app\.appId/
);
assert.match(transcribeSource, /evaluatePlatformEntitlement\(/);
assert.doesNotMatch(transcribeSource, /describeAccountAccessUsability\(/);

const asnSource = fs.readFileSync(
  path.join(__dirname, "appStoreSubscriptionNotifications.js"),
  "utf8"
);
assert.doesNotMatch(asnSource, /platformFromAppCheckAppId/);
assert.doesNotMatch(asnSource, /evaluatePlatformEntitlement/);

const rtdnSource = fs.readFileSync(
  path.join(__dirname, "googlePlaySubscriptionNotifications.js"),
  "utf8"
);
assert.doesNotMatch(rtdnSource, /platformFromAppCheckAppId/);
assert.doesNotMatch(rtdnSource, /evaluatePlatformEntitlement/);

console.log("sendMessagePlatformGate.test.js: ok");
