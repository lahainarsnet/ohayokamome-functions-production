"use strict";

const { normalizeSubscriptionPlatform, describeAccountAccessUsability } = require("./accountAccessUsability");
const { resolveChatEntitlementWithUnknownProvisional } = require("./chatUnknownProvisional");
const {
  isDevicePlatformAppCheckVerified,
} = require("./devicePlatformAppCheck");

/**
 * 受信者の現在端末 OS（チャット契約判定用）。
 * subscriptionPlatform / subscriptions は購入履歴であり端末 OS の代用にしない。
 */
function resolveRecipientPlatformForChatEntitlement(activeDeviceInfo) {
  if (!activeDeviceInfo || !activeDeviceInfo.platform) {
    return { platform: null, source: "unresolved" };
  }
  const normalized = normalizeSubscriptionPlatform(activeDeviceInfo.platform);
  if (normalized !== "ios" && normalized !== "android") {
    return { platform: null, source: "unresolved" };
  }
  if (!isDevicePlatformAppCheckVerified(activeDeviceInfo)) {
    return {
      platform: null,
      source: "activeDeviceUnverified",
    };
  }
  return {
    platform: normalized,
    source: "activeDeviceVerified",
  };
}

async function readActiveDevicePlatformInfo({
  admin,
  recipientId,
  recipientData,
  readDocument = (ref) => ref.get(),
}) {
  const activeDeviceId = String(
    (recipientData && recipientData.activeDeviceId) || "",
  ).trim();
  if (!activeDeviceId || !recipientId) {
    return null;
  }
  const deviceRef = admin
    .getDb()
    .collection("users")
    .doc(recipientId)
    .collection("devices")
    .doc(activeDeviceId);
  const deviceSnap = await readDocument(deviceRef);
  if (!deviceSnap.exists) {
    return null;
  }
  const data = deviceSnap.data() || {};
  const platform = normalizeSubscriptionPlatform(data.platform);
  return {
    platform: platform === "ios" || platform === "android" ? platform : null,
    platformAppCheckVerified:
      data.deviceId === activeDeviceId && isDevicePlatformAppCheckVerified(data),
    deviceIdMatches: data.deviceId === activeDeviceId,
    activeDeviceId,
  };
}

// 現在OSが検証済みなら、集約契約よりそのOSの確定状態を優先する。
// OS不明の旧端末は従来の明確なActiveのみ維持し、仮期限では救済しない。
function resolveRecipientChatEntitlement(recipientData, activeDeviceInfo, now = new Date(), options = {}) {
  // 明示的な端末ID不整合は旧端末情報不足とは区別して拒否する。
  if (activeDeviceInfo && activeDeviceInfo.deviceIdMatches === false) {
    return {
      allowed: false, provisionalUsed: false, contractState: "dedicatedStop",
      denyReason: "recipient_active_device_inconsistent", platform: null,
      platformSource: "activeDeviceInconsistent",
    };
  }
  const resolution = resolveRecipientPlatformForChatEntitlement(activeDeviceInfo);
  if (resolution.platform) {
    return {
      ...resolveChatEntitlementWithUnknownProvisional(recipientData, resolution.platform, now, options),
      platform: resolution.platform,
      platformSource: resolution.source,
    };
  }
  const legacy = describeAccountAccessUsability(recipientData, now, options);
  return {
    allowed: legacy.subscriptionUsable === true,
    provisionalUsed: false,
    contractState: legacy.subscriptionUsable ? "active" : "dedicatedStop",
    denyReason: legacy.subscriptionUsable ? null : "recipient_platform_unresolved",
    platform: null,
    platformSource: resolution.source,
  };
}

module.exports = {
  resolveRecipientPlatformForChatEntitlement,
  resolveRecipientChatEntitlement,
  readActiveDevicePlatformInfo,
  // 後方互換（テスト・呼び出し名）
  readActiveDevicePlatform: readActiveDevicePlatformInfo,
};
