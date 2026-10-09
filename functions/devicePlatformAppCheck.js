"use strict";

const { HttpsError } = require("firebase-functions/v2/https");
const { platformFromAppCheckAppId } = require("./appCheckPlatform");

const PLATFORM_APP_CHECK_VERIFIED_FIELD = "platformAppCheckVerified";
const PLATFORM_APP_CHECK_MISMATCH = "PLATFORM_APP_CHECK_MISMATCH";
const UNKNOWN_APP_ID = "UNKNOWN_APP_ID";
const APP_CHECK_REQUIRED = "APP_CHECK_REQUIRED";

function normalizeDeclaredPlatform(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * App Check appId から得た OS とクライアント申告 platform を照合する。
 * 一致時のみ ios|android を返す。
 */
function resolveVerifiedClientPlatform(request, clientPlatform) {
  if (!request || !request.app || !request.app.appId) {
    throw new HttpsError("failed-precondition", APP_CHECK_REQUIRED, {
      code: APP_CHECK_REQUIRED,
    });
  }
  const appCheckPlatform = platformFromAppCheckAppId(request.app.appId);
  if (appCheckPlatform !== "ios" && appCheckPlatform !== "android") {
    throw new HttpsError("failed-precondition", UNKNOWN_APP_ID, {
      code: UNKNOWN_APP_ID,
    });
  }
  const declared = normalizeDeclaredPlatform(clientPlatform);
  if (declared !== "ios" && declared !== "android") {
    throw new HttpsError("invalid-argument", "platform must be ios or android.");
  }
  if (declared !== appCheckPlatform) {
    throw new HttpsError("failed-precondition", PLATFORM_APP_CHECK_MISMATCH, {
      code: PLATFORM_APP_CHECK_MISMATCH,
      appCheckPlatform,
    });
  }
  return appCheckPlatform;
}

function verifiedDevicePlatformFields(platform) {
  return {
    platform,
    [PLATFORM_APP_CHECK_VERIFIED_FIELD]: true,
  };
}

function isDevicePlatformAppCheckVerified(deviceData) {
  if (!deviceData || typeof deviceData !== "object") {
    return false;
  }
  return deviceData[PLATFORM_APP_CHECK_VERIFIED_FIELD] === true;
}

module.exports = {
  PLATFORM_APP_CHECK_VERIFIED_FIELD,
  PLATFORM_APP_CHECK_MISMATCH,
  UNKNOWN_APP_ID,
  APP_CHECK_REQUIRED,
  resolveVerifiedClientPlatform,
  verifiedDevicePlatformFields,
  isDevicePlatformAppCheckVerified,
};
