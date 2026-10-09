"use strict";

const assert = require("node:assert/strict");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  IOS_FIREBASE_APP_ID,
  ANDROID_FIREBASE_APP_ID,
} = require("./appCheckPlatform");
const {
  resolveVerifiedClientPlatform,
  PLATFORM_APP_CHECK_MISMATCH,
  UNKNOWN_APP_ID,
  APP_CHECK_REQUIRED,
} = require("./devicePlatformAppCheck");

function req(appId) {
  return { app: appId ? { appId } : undefined };
}

assert.equal(
  resolveVerifiedClientPlatform(req(IOS_FIREBASE_APP_ID), "ios"),
  "ios",
);
assert.equal(
  resolveVerifiedClientPlatform(req(ANDROID_FIREBASE_APP_ID), "android"),
  "android",
);

assert.throws(
  () => resolveVerifiedClientPlatform(req(IOS_FIREBASE_APP_ID), "android"),
  (error) =>
    error instanceof HttpsError &&
    error.code === "failed-precondition" &&
    error.details &&
    error.details.code === PLATFORM_APP_CHECK_MISMATCH,
);

assert.throws(
  () => resolveVerifiedClientPlatform(req(ANDROID_FIREBASE_APP_ID), "ios"),
  (error) =>
    error instanceof HttpsError &&
    error.details &&
    error.details.code === PLATFORM_APP_CHECK_MISMATCH,
);

assert.throws(
  () => resolveVerifiedClientPlatform(req("unknown-app-id"), "ios"),
  (error) =>
    error instanceof HttpsError &&
    error.details &&
    error.details.code === UNKNOWN_APP_ID,
);

assert.throws(
  () => resolveVerifiedClientPlatform(req(null), "ios"),
  (error) =>
    error instanceof HttpsError &&
    error.details &&
    error.details.code === APP_CHECK_REQUIRED,
);

console.log("devicePlatformAppCheck.test.js: ok");
