function normalizePushToken(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeDeviceId(value) {
  return String(value ?? "").trim();
}

function emptyPushTokenSet(source, deviceId = "") {
  return {
    tokens: [],
    deviceId,
    source,
    uniqueTokenCount: 0,
    deviceTokenCount: 0,
    tokenToDeviceIds: new Map(),
  };
}

/**
 * 通知先は users/{uid}.activeDeviceId の 1 token だけ。
 * 旧端末 devices には送らない。users.fcmToken は active token と確認できるときだけ。
 */
function resolveActiveDevicePushToken({
  activeDeviceId = "",
  activeDeviceFcmToken = "",
  userFcmToken = "",
} = {}) {
  const deviceId = normalizeDeviceId(activeDeviceId);
  if (!deviceId) {
    return emptyPushTokenSet("no_active_device");
  }

  const deviceToken = normalizePushToken(activeDeviceFcmToken);
  if (deviceToken) {
    return {
      tokens: [deviceToken],
      deviceId,
      source: "active_device",
      uniqueTokenCount: 1,
      deviceTokenCount: 1,
      tokenToDeviceIds: new Map([[deviceToken, [deviceId]]]),
    };
  }

  const userToken = normalizePushToken(userFcmToken);
  // active 端末 token と同一だと確認できる場合だけ users.fcmToken を使う。
  // device token が空なら確認できないので送らない（旧端末へ fallback しない）。
  if (userToken && userToken === deviceToken) {
    return {
      tokens: [userToken],
      deviceId,
      source: "user_fcmToken",
      uniqueTokenCount: 1,
      deviceTokenCount: 0,
      tokenToDeviceIds: new Map([[userToken, [deviceId]]]),
    };
  }

  return emptyPushTokenSet("active_device_no_token", deviceId);
}

function resolvePushTokenSet(options = {}) {
  return resolveActiveDevicePushToken(options);
}

function isPermanentInvalidFcmTokenError(error) {
  const code = String(error?.code || error?.errorInfo?.code || "").trim();
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  );
}

function toMulticastMessage(baseMessage, tokens) {
  const message = { ...(baseMessage || {}) };
  delete message.token;
  delete message.tokens;
  return {
    ...message,
    tokens: [...tokens],
  };
}

async function clearDeviceFcmTokenFields({
  db,
  admin,
  uid,
  deviceIds,
}) {
  if (!db || !admin || !uid || !Array.isArray(deviceIds) || deviceIds.length === 0) {
    return 0;
  }
  let cleared = 0;
  for (const deviceId of deviceIds) {
    const id = String(deviceId || "").trim();
    if (!id) {
      continue;
    }
    await db
      .collection("users")
      .doc(uid)
      .collection("devices")
      .doc(id)
      .set({ fcmToken: admin.FieldValue.delete() }, { merge: true });
    cleared += 1;
  }
  return cleared;
}

async function dispatchChatPushNotification({
  messaging,
  db,
  admin,
  uid,
  tokens,
  tokenToDeviceIds,
  message,
}) {
  const sendTokens = Array.isArray(tokens) ? tokens.filter((token) => normalizePushToken(token)) : [];
  if (sendTokens.length === 0) {
    return {
      success: false,
      successCount: 0,
      failureCount: 0,
      invalidTokenClearedCount: 0,
    };
  }

  const response = await messaging.sendEachForMulticast(
    toMulticastMessage(message, sendTokens)
  );
  const responses = Array.isArray(response?.responses) ? response.responses : [];
  let invalidTokenClearedCount = 0;

  for (let i = 0; i < responses.length; i += 1) {
    const item = responses[i];
    if (item?.success) {
      continue;
    }
    if (!isPermanentInvalidFcmTokenError(item?.error)) {
      continue;
    }
    const deviceIds =
      (tokenToDeviceIds instanceof Map && tokenToDeviceIds.get(sendTokens[i])) || [];
    invalidTokenClearedCount += await clearDeviceFcmTokenFields({
      db,
      admin,
      uid,
      deviceIds,
    });
  }

  const successCount = Number(response?.successCount || 0);
  const failureCount = Number(response?.failureCount || 0);
  return {
    success: successCount > 0,
    successCount,
    failureCount,
    invalidTokenClearedCount,
  };
}

module.exports = {
  normalizePushToken,
  resolveActiveDevicePushToken,
  resolvePushTokenSet,
  isPermanentInvalidFcmTokenError,
  toMulticastMessage,
  clearDeviceFcmTokenFields,
  dispatchChatPushNotification,
};
