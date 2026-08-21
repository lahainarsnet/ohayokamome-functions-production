"use strict";

const assert = require("node:assert/strict");
const {
  platformFromAppCheckAppId,
  IOS_FIREBASE_APP_ID,
  ANDROID_FIREBASE_APP_ID,
} = require("./appCheckPlatform");

assert.equal(platformFromAppCheckAppId(IOS_FIREBASE_APP_ID), "ios");
assert.equal(platformFromAppCheckAppId(ANDROID_FIREBASE_APP_ID), "android");
assert.equal(platformFromAppCheckAppId(""), "");
assert.equal(platformFromAppCheckAppId(null), "");
assert.equal(platformFromAppCheckAppId("1:762588322233:ios:other"), "");
assert.equal(platformFromAppCheckAppId("1:762588322233:android:other"), "");
assert.equal(platformFromAppCheckAppId("ios"), "");

console.log("appCheckPlatform.test.js: ok");
