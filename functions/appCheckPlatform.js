"use strict";

/**
 * 本番 Firebase App ID（Flutter firebase_options.dart / google-services.json /
 * GoogleService-Info.plist と一致）。
 *
 * クライアントから渡した platform 文字列は使わず、App Check の appId だけを正本にする。
 */
const IOS_FIREBASE_APP_ID =
  "1:762588322233:ios:7a4f63a7bc68678cea7e68";
const ANDROID_FIREBASE_APP_ID =
  "1:762588322233:android:7fc616ed73ce620dea7e68";

function platformFromAppCheckAppId(appId) {
  const id = String(appId || "").trim();
  if (id === IOS_FIREBASE_APP_ID) {
    return "ios";
  }
  if (id === ANDROID_FIREBASE_APP_ID) {
    return "android";
  }
  return "";
}

module.exports = {
  IOS_FIREBASE_APP_ID,
  ANDROID_FIREBASE_APP_ID,
  platformFromAppCheckAppId,
};
