const MAX_CHAT_PUSH_TOKENS = 16;

function normalizePushToken(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function collectDevicePushTokens(deviceEntries, { limit = MAX_CHAT_PUSH_TOKENS } = {}) {
  const tokenToDeviceIds = new Map();
  let deviceTokenCount = 0;

  for (const entry of Array.isArray(deviceEntries) ? deviceEntries : []) {
    const token = normalizePushToken(entry?.fcmToken);
    if (!token) {
      continue;
    }
    deviceTokenCount += 1;
    const deviceId = String(entry?.deviceId || "").trim();
    if (!tokenToDeviceIds.has(token)) {
      tokenToDeviceIds.set(token, []);
    }
    if (deviceId) {
      tokenToDeviceIds.get(token).push(deviceId);
    }
  }

  const tokens = [];
  for (const token of tokenToDeviceIds.keys()) {
    tokens.push(token);
    if (tokens.length >= limit) {
      break;
    }
  }

  return {
    tokens,
    deviceTokenCount,
    uniqueTokenCount: tokens.length,
    tokenToDeviceIds,
  };
}

function resolvePushTokenSet({
  deviceEntries = [],
  userFcmToken = "",
  embeddedToken = "",
  limit = MAX_CHAT_PUSH_TOKENS,
} = {}) {
  const collected = collectDevicePushTokens(deviceEntries, { limit });
  if (collected.tokens.length > 0) {
    return { ...collected, source: "devices" };
  }

  const userToken = normalizePushToken(userFcmToken);
  if (userToken) {
    return {
      tokens: [userToken],
      deviceTokenCount: 0,
      uniqueTokenCount: 1,
      tokenToDeviceIds: new Map(),
      source: "user_fcmToken",
    };
  }

  const embedded = normalizePushToken(embeddedToken);
  if (embedded) {
    return {
      tokens: [embedded],
      deviceTokenCount: 0,
      uniqueTokenCount: 1,
      tokenToDeviceIds: new Map(),
      source: "embedded",
    };
  }

  return {
    tokens: [],
    deviceTokenCount: 0,
    uniqueTokenCount: 0,
    tokenToDeviceIds: new Map(),
    source: "none",
  };
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
  MAX_CHAT_PUSH_TOKENS,
  normalizePushToken,
  collectDevicePushTokens,
  resolvePushTokenSet,
  isPermanentInvalidFcmTokenError,
  toMulticastMessage,
  clearDeviceFcmTokenFields,
  dispatchChatPushNotification,
};
