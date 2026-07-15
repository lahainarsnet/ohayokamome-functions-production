/**
 * Google Play Real-time Developer Notifications (RTDN) handler (phase 1).
 */
const { google } = require("googleapis");

const GOOGLE_PLAY_PACKAGE_NAME = "com.lahainarsnet.ohayokamome.live";
const GOOGLE_PLAY_MONTHLY_PRODUCT_ID = "ohayo_kamome_monthly";
const NOTIFICATION_TRACE = "GOOGLE_PLAY_RTDN_TRACE";
const PROCESSING_STALE_MS = 10 * 60 * 1000;

const SUBSCRIPTION_NOTIFICATION_TYPE_NAMES = {
  1: "SUBSCRIPTION_RECOVERED",
  2: "SUBSCRIPTION_RENEWED",
  3: "SUBSCRIPTION_CANCELED",
  4: "SUBSCRIPTION_PURCHASED",
  5: "SUBSCRIPTION_ON_HOLD",
  6: "SUBSCRIPTION_IN_GRACE_PERIOD",
  7: "SUBSCRIPTION_RESTARTED",
  8: "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED",
  9: "SUBSCRIPTION_DEFERRED",
  10: "SUBSCRIPTION_PAUSED",
  11: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED",
  12: "SUBSCRIPTION_REVOKED",
  13: "SUBSCRIPTION_EXPIRED",
  14: "SUBSCRIPTION_PENDING_PURCHASE_CANCELED",
  15: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  16: "SUBSCRIPTION_PRICE_CHANGE_UPDATED",
  17: "SUBSCRIPTION_ITEMS_CHANGED",
};

const VOIDED_PRODUCT_TYPE_SUBSCRIPTION = 1;
const REVOKED_NOTIFICATION_TYPE = 12;

function tokenSuffix(token) {
  if (!token) {
    return "empty";
  }
  return token.length <= 6 ? token : token.slice(-6);
}

function parseApiExpiryTime(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed);
}

function parseFirestoreExpiryTime(value) {
  if (value == null) {
    return null;
  }
  if (typeof value.toDate === "function") {
    return value.toDate();
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string") {
    return parseApiExpiryTime(value);
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value);
  }
  return null;
}

function decodePubSubMessageData(message) {
  if (!message || !message.data) {
    return null;
  }
  const raw = Buffer.from(message.data, "base64").toString("utf8");
  if (!raw) {
    return null;
  }
  return JSON.parse(raw);
}

function buildEventId({
  eventTimeMillis,
  notificationType,
  purchaseToken,
  messageId,
  kind,
}) {
  const timePart = String(eventTimeMillis || "0");
  const typePart =
    notificationType === undefined || notificationType === null
      ? kind || "unknown"
      : String(notificationType);
  const tokenPart = tokenSuffix(purchaseToken);
  const candidate = `gp-${timePart}-${typePart}-${tokenPart}`;
  if (candidate.length <= 1500) {
    return candidate;
  }
  const safeMessageId = String(messageId || "nomsg").replace(/[^a-zA-Z0-9_-]/g, "");
  return `gp-${safeMessageId}`;
}

function notificationTypeName(notificationType) {
  const numeric = Number(notificationType);
  if (!Number.isFinite(numeric)) {
    return "UNKNOWN";
  }
  return SUBSCRIPTION_NOTIFICATION_TYPE_NAMES[numeric] || `UNKNOWN_${numeric}`;
}

function pickMatchedLineItem(lineItems) {
  const matched = (Array.isArray(lineItems) ? lineItems : []).filter(
    (item) => item?.productId === GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
  );
  if (!matched.length) {
    return null;
  }
  return matched.reduce((best, item) => {
    const bestExpiry = parseApiExpiryTime(best?.expiryTime);
    const itemExpiry = parseApiExpiryTime(item?.expiryTime);
    if (!bestExpiry) {
      return item;
    }
    if (!itemExpiry) {
      return best;
    }
    return itemExpiry.getTime() >= bestExpiry.getTime() ? item : best;
  });
}

function deriveGooglePlayEntitlement({
  subscription,
  matchedLineItem,
  notificationType,
  forceExpired = false,
}) {
  const subscriptionState = String(subscription?.subscriptionState || "");
  const expiryDate = parseApiExpiryTime(matchedLineItem?.expiryTime);
  const now = new Date();
  const expiryIsFuture =
    expiryDate instanceof Date &&
    !Number.isNaN(expiryDate.getTime()) &&
    expiryDate.getTime() > now.getTime();

  if (forceExpired) {
    return {
      status: "expired",
      expiryTime: matchedLineItem?.expiryTime || null,
      expiryDate,
      subscriptionState,
      latestOrderId: subscription?.latestOrderId || "",
      acknowledgementState: subscription?.acknowledgementState || "",
      testPurchase: Boolean(subscription?.testPurchase),
      linkedPurchaseToken: subscription?.linkedPurchaseToken || "",
    };
  }

  if (
    subscriptionState === "SUBSCRIPTION_STATE_ACTIVE" &&
    expiryIsFuture
  ) {
    return {
      status: "active",
      expiryTime: matchedLineItem.expiryTime,
      expiryDate,
      subscriptionState,
      latestOrderId: subscription?.latestOrderId || "",
      acknowledgementState: subscription?.acknowledgementState || "",
      testPurchase: Boolean(subscription?.testPurchase),
      linkedPurchaseToken: subscription?.linkedPurchaseToken || "",
    };
  }

  if (
    subscriptionState === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" &&
    expiryIsFuture
  ) {
    return {
      status: "active",
      expiryTime: matchedLineItem.expiryTime,
      expiryDate,
      subscriptionState,
      latestOrderId: subscription?.latestOrderId || "",
      acknowledgementState: subscription?.acknowledgementState || "",
      testPurchase: Boolean(subscription?.testPurchase),
      linkedPurchaseToken: subscription?.linkedPurchaseToken || "",
    };
  }

  if (
    subscriptionState === "SUBSCRIPTION_STATE_CANCELED" &&
    expiryIsFuture
  ) {
    return {
      status: "active",
      expiryTime: matchedLineItem.expiryTime,
      expiryDate,
      subscriptionState,
      latestOrderId: subscription?.latestOrderId || "",
      acknowledgementState: subscription?.acknowledgementState || "",
      testPurchase: Boolean(subscription?.testPurchase),
      linkedPurchaseToken: subscription?.linkedPurchaseToken || "",
    };
  }

  if (subscriptionState === "SUBSCRIPTION_STATE_EXPIRED") {
    return {
      status: "expired",
      expiryTime: matchedLineItem?.expiryTime || null,
      expiryDate,
      subscriptionState,
      latestOrderId: subscription?.latestOrderId || "",
      acknowledgementState: subscription?.acknowledgementState || "",
      testPurchase: Boolean(subscription?.testPurchase),
      linkedPurchaseToken: subscription?.linkedPurchaseToken || "",
    };
  }

  if (subscriptionState === "SUBSCRIPTION_STATE_ON_HOLD") {
    return {
      status: "paused",
      expiryTime: matchedLineItem?.expiryTime || null,
      expiryDate,
      subscriptionState,
      latestOrderId: subscription?.latestOrderId || "",
      acknowledgementState: subscription?.acknowledgementState || "",
      testPurchase: Boolean(subscription?.testPurchase),
      linkedPurchaseToken: subscription?.linkedPurchaseToken || "",
    };
  }

  if (subscriptionState === "SUBSCRIPTION_STATE_PAUSED") {
    return {
      status: "paused",
      expiryTime: matchedLineItem?.expiryTime || null,
      expiryDate,
      subscriptionState,
      latestOrderId: subscription?.latestOrderId || "",
      acknowledgementState: subscription?.acknowledgementState || "",
      testPurchase: Boolean(subscription?.testPurchase),
      linkedPurchaseToken: subscription?.linkedPurchaseToken || "",
    };
  }

  if (!expiryIsFuture) {
    return {
      status: "expired",
      expiryTime: matchedLineItem?.expiryTime || null,
      expiryDate,
      subscriptionState,
      latestOrderId: subscription?.latestOrderId || "",
      acknowledgementState: subscription?.acknowledgementState || "",
      testPurchase: Boolean(subscription?.testPurchase),
      linkedPurchaseToken: subscription?.linkedPurchaseToken || "",
    };
  }

  return {
    status: "none",
    expiryTime: matchedLineItem?.expiryTime || null,
    expiryDate,
    subscriptionState,
    latestOrderId: subscription?.latestOrderId || "",
    acknowledgementState: subscription?.acknowledgementState || "",
    testPurchase: Boolean(subscription?.testPurchase),
    linkedPurchaseToken: subscription?.linkedPurchaseToken || "",
  };
}

function isPermanentGooglePlayApiError(error) {
  const status = Number(error?.code || error?.response?.status || 0);
  return status === 400 || status === 404 || status === 410;
}

async function createAndroidPublisherClient() {
  const auth = await google.auth.getClient({
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  return google.androidpublisher({
    version: "v3",
    auth,
  });
}

async function syncGooglePlaySubscriptionByPurchaseToken(packageName, purchaseToken) {
  const androidpublisher = await createAndroidPublisherClient();
  const response = await androidpublisher.purchases.subscriptionsv2.get({
    packageName,
    token: purchaseToken,
  });
  const subscription = response.data || {};
  const matchedLineItem = pickMatchedLineItem(subscription.lineItems);
  return { subscription, matchedLineItem };
}

function isRevocationNotification(forceExpired, notificationType) {
  return forceExpired || Number(notificationType) === REVOKED_NOTIFICATION_TYPE;
}

function collectTokensForRequery(existingData, notificationPurchaseToken) {
  const tokens = new Set();
  const primary = String(existingData?.googlePlayPrimaryPurchaseToken || "").trim();
  if (primary) {
    tokens.add(primary);
  }
  const notificationToken = String(notificationPurchaseToken || "").trim();
  if (notificationToken) {
    tokens.add(notificationToken);
  }
  for (const token of Array.isArray(existingData?.activePurchaseTokens)
    ? existingData.activePurchaseTokens
    : []) {
    const normalized = String(token || "").trim();
    if (normalized) {
      tokens.add(normalized);
    }
  }
  return [...tokens];
}

function isUsableGooglePlayEntitlement(derived) {
  return derived?.status === "active";
}

function buildDerivedFromExistingActiveUser(existingData) {
  const existingExpiry = parseFirestoreExpiryTime(existingData?.subscriptionExpiryTime);
  let expiryTime = null;
  if (typeof existingData?.subscriptionExpiryTime === "string") {
    expiryTime = existingData.subscriptionExpiryTime;
  } else if (existingExpiry instanceof Date && !Number.isNaN(existingExpiry.getTime())) {
    expiryTime = existingExpiry.toISOString();
  }

  return {
    status: "active",
    expiryTime,
    expiryDate: existingExpiry,
    subscriptionState: String(existingData?.googlePlaySubscriptionState || ""),
    latestOrderId: String(existingData?.googlePlayLatestOrderId || ""),
    acknowledgementState: String(existingData?.googlePlayAcknowledgementState || ""),
    testPurchase: existingData?.googlePlayTestPurchase === true,
    linkedPurchaseToken: "",
  };
}

function pickBestUsableEntitlement(tokenResults) {
  const usable = tokenResults.filter(
    (result) => result.ok && isUsableGooglePlayEntitlement(result.derived),
  );
  if (!usable.length) {
    return null;
  }
  return usable.reduce((best, item) => {
    const bestExpiry = best.derived?.expiryDate?.getTime() || 0;
    const itemExpiry = item.derived?.expiryDate?.getTime() || 0;
    return itemExpiry >= bestExpiry ? item : best;
  });
}

function resolveRevocationUserEntitlement({
  existingData,
  notificationPurchaseToken,
  notificationDerived,
  notificationTokenConfirmed,
  tokenResults,
}) {
  const usable = pickBestUsableEntitlement(tokenResults);
  if (usable) {
    return {
      action: "keep_active",
      derived: usable.derived,
      primaryPurchaseToken: usable.purchaseToken,
      revokedTokenIgnored: notificationPurchaseToken,
    };
  }

  const failed = tokenResults.filter((result) => !result.ok);
  const existingStatus = String(existingData?.subscriptionStatus || "")
    .trim()
    .toLowerCase();
  const existingExpiry = parseFirestoreExpiryTime(existingData?.subscriptionExpiryTime);
  const existingExpiryFuture =
    existingExpiry instanceof Date &&
    !Number.isNaN(existingExpiry.getTime()) &&
    existingExpiry.getTime() > Date.now();
  const tokenCount = tokenResults.length;

  if (
    failed.length > 0 &&
    existingStatus === "active" &&
    existingExpiryFuture &&
    tokenCount > 1
  ) {
    return {
      action: "keep_active_uncertain",
      derived: buildDerivedFromExistingActiveUser(existingData),
      primaryPurchaseToken:
        String(existingData?.googlePlayPrimaryPurchaseToken || "").trim() ||
        notificationPurchaseToken,
      revokedTokenIgnored: notificationPurchaseToken,
      uncertainApiFailures: failed.map((result) => tokenSuffix(result.purchaseToken)),
    };
  }

  if (notificationTokenConfirmed) {
    return {
      action: "expire",
      derived: notificationDerived,
      primaryPurchaseToken: "",
    };
  }

  if (existingStatus === "active" && existingExpiryFuture) {
    return {
      action: "keep_active_uncertain",
      derived: buildDerivedFromExistingActiveUser(existingData),
      primaryPurchaseToken:
        String(existingData?.googlePlayPrimaryPurchaseToken || "").trim() ||
        notificationPurchaseToken,
      revokedTokenIgnored: notificationPurchaseToken,
    };
  }

  return {
    action: "expire",
    derived: notificationDerived,
    primaryPurchaseToken: "",
  };
}

async function syncEntitlementForToken(packageName, purchaseToken) {
  try {
    const { subscription, matchedLineItem } =
      await syncGooglePlaySubscriptionByPurchaseToken(packageName, purchaseToken);
    const derived = deriveGooglePlayEntitlement({
      subscription,
      matchedLineItem,
      notificationType: null,
      forceExpired: false,
    });
    return {
      ok: true,
      purchaseToken,
      derived,
    };
  } catch (error) {
    if (isPermanentGooglePlayApiError(error)) {
      return {
        ok: true,
        purchaseToken,
        derived: {
          status: "expired",
          expiryTime: null,
          expiryDate: null,
          subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
          latestOrderId: "",
          acknowledgementState: "",
          testPurchase: false,
          linkedPurchaseToken: "",
        },
        permanentError: true,
      };
    }
    return {
      ok: false,
      purchaseToken,
      error,
    };
  }
}

async function resolveUserEntitlementAfterRevocation({
  packageName,
  existingData,
  notificationPurchaseToken,
  notificationDerived,
  notificationTokenConfirmed,
}) {
  const tokens = collectTokensForRequery(existingData, notificationPurchaseToken);
  const tokenResults = await Promise.all(
    tokens.map((token) => syncEntitlementForToken(packageName, token)),
  );
  return resolveRevocationUserEntitlement({
    existingData,
    notificationPurchaseToken,
    notificationDerived,
    notificationTokenConfirmed,
    tokenResults,
  });
}

async function writeSubscriptionEvent(db, eventId, fields) {
  if (!eventId) {
    return;
  }
  const ref = db.collection("subscription_events").doc(eventId);
  await ref.set(
    {
      ...fields,
      processedAt: fields.processedAt || new Date(),
    },
    { merge: true },
  );
}

async function beginNotificationProcessing(db, eventId, baseFields) {
  return db.runTransaction(async (tx) => {
    const ref = db.collection("subscription_events").doc(eventId);
    const snap = await tx.get(ref);
    if (snap.exists) {
      const existingStatus = snap.get("status");
      const receivedAt = snap.get("receivedAt");
      const receivedMillis =
        receivedAt && typeof receivedAt.toDate === "function"
          ? receivedAt.toDate().getTime()
          : 0;
      if (existingStatus === "processed") {
        return { action: "skip", reason: "already_processed" };
      }
      if (existingStatus === "processing") {
        const stale =
          receivedMillis > 0 &&
          Date.now() - receivedMillis > PROCESSING_STALE_MS;
        if (!stale) {
          return { action: "skip", reason: "processing_in_flight" };
        }
      }
      if (existingStatus !== "failed" && existingStatus !== "processing") {
        if (
          existingStatus === "rejected" ||
          existingStatus === "ambiguous" ||
          existingStatus === "unlinked"
        ) {
          return { action: "skip", reason: existingStatus };
        }
      }
    }

    tx.set(
      ref,
      {
        ...baseFields,
        status: "processing",
        receivedAt: baseFields.receivedAt,
        processedAt: new Date(),
      },
      { merge: true },
    );
    return { action: "continue" };
  });
}

async function findUserByPurchaseToken(db, purchaseToken, linkedPurchaseToken) {
  const users = db.collection("users");
  const tokens = [purchaseToken, linkedPurchaseToken]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const seen = new Set();
  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);

    const byToken = await users
      .where("activePurchaseTokens", "array-contains", token)
      .limit(2)
      .get();
    if (byToken.size === 1) {
      return {
        kind: "single",
        uid: byToken.docs[0].id,
        match: "activePurchaseTokens",
        matchedToken: token,
      };
    }
    if (byToken.size > 1) {
      return {
        kind: "ambiguous",
        uids: byToken.docs.map((doc) => doc.id),
      };
    }
  }

  return { kind: "unlinked" };
}

function shouldSkipStaleActiveUpdate(existingData, derived) {
  if (derived.status !== "active") {
    return false;
  }
  const existingExpiry = parseFirestoreExpiryTime(
    existingData?.subscriptionExpiryTime,
  );
  const newExpiry = derived.expiryDate;
  if (
    existingExpiry &&
    newExpiry &&
    newExpiry.getTime() < existingExpiry.getTime()
  ) {
    return true;
  }
  return false;
}

async function applyGoogleSubscriptionUpdateToUser(
  db,
  admin,
  uid,
  derived,
  purchaseToken,
  options = {},
) {
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const existingData = userSnap.exists ? userSnap.data() || {} : {};

  if (shouldSkipStaleActiveUpdate(existingData, derived)) {
    return { applied: false, reason: "stale_active_expiry" };
  }

  const update = {
    subscriptionStatus: derived.status,
    subscriptionProductId: GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
    subscriptionPlatform: "android",
    lastSubscriptionSource: "google_play_rtdn",
    lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
    updatedAt: admin.FieldValue.serverTimestamp(),
    googlePlaySubscriptionState: derived.subscriptionState || "",
    googlePlayLatestOrderId: derived.latestOrderId || "",
    googlePlayTestPurchase: derived.testPurchase === true,
    googlePlayAcknowledgementState: derived.acknowledgementState || "",
  };

  if (derived.expiryTime) {
    update.subscriptionExpiryTime = derived.expiryTime;
  }

  if (purchaseToken) {
    update.activePurchaseTokens = admin.FieldValue.arrayUnion(purchaseToken);
  }

  if (derived.status === "active") {
    const primaryToken = String(
      options.primaryPurchaseToken || purchaseToken || "",
    ).trim();
    if (primaryToken) {
      update.googlePlayPrimaryPurchaseToken = primaryToken;
    }
  } else if (options.clearPrimaryPurchaseToken === true) {
    update.googlePlayPrimaryPurchaseToken = "";
  }

  await userRef.set(update, { merge: true });
  return { applied: true };
}

function buildBaseEventFields({
  messageId,
  eventTimeMillis,
  notificationType,
  notificationTypeName: typeName,
  packageName,
  subscriptionId,
  purchaseToken,
  linkedPurchaseToken,
  testPurchase,
}) {
  return {
    platform: "google_play",
    messageId: messageId || "",
    eventTimeMillis: String(eventTimeMillis || ""),
    notificationType:
      notificationType === undefined || notificationType === null
        ? null
        : Number(notificationType),
    notificationTypeName: typeName || "",
    packageName: packageName || "",
    subscriptionId: subscriptionId || "",
    purchaseTokenSuffix: tokenSuffix(purchaseToken),
    linkedPurchaseTokenSuffix: tokenSuffix(linkedPurchaseToken),
    testPurchase: testPurchase === true,
    receivedAt: new Date(),
  };
}

function createGooglePlayRtdnHandler({ getDb, admin, logger }) {
  return async (event) => {
    const db = getDb();
    const message = event?.data?.message || {};
    const messageId = message.messageId || "";
    let developerNotification = null;
    let eventId = "";

    try {
      developerNotification = decodePubSubMessageData(message);
      if (!developerNotification) {
        eventId = buildEventId({
          eventTimeMillis: Date.now(),
          messageId,
          kind: "invalid",
        });
        await writeSubscriptionEvent(db, eventId, {
          ...buildBaseEventFields({ messageId }),
          status: "rejected",
          errorCode: "MISSING_MESSAGE_DATA",
          errorMessage: "Pub/Sub message data is empty.",
        });
        logger.warn(`${NOTIFICATION_TRACE} missing message data`, { messageId });
        return;
      }

      const packageName = String(developerNotification.packageName || "").trim();
      const eventTimeMillis = developerNotification.eventTimeMillis || "";

      if (developerNotification.testNotification) {
        eventId = buildEventId({
          eventTimeMillis,
          messageId,
          kind: "test",
        });
        const baseFields = buildBaseEventFields({
          messageId,
          eventTimeMillis,
          packageName,
        });
        const gate = await beginNotificationProcessing(db, eventId, baseFields);
        if (gate.action === "skip") {
          logger.info(`${NOTIFICATION_TRACE} test skipped`, {
            messageId,
            eventId,
            reason: gate.reason,
          });
          return;
        }
        await writeSubscriptionEvent(db, eventId, {
          ...baseFields,
          status: "processed",
          result: "test_notification",
        });
        logger.info(`${NOTIFICATION_TRACE} test notification processed`, {
          messageId,
          eventId,
        });
        return;
      }

      if (packageName !== GOOGLE_PLAY_PACKAGE_NAME) {
        eventId = buildEventId({
          eventTimeMillis,
          messageId,
          kind: "rejected-package",
        });
        await writeSubscriptionEvent(db, eventId, {
          ...buildBaseEventFields({ messageId, eventTimeMillis, packageName }),
          status: "rejected",
          errorCode: "PACKAGE_NAME_MISMATCH",
          errorMessage: "Unexpected package name.",
        });
        logger.warn(`${NOTIFICATION_TRACE} package rejected`, {
          messageId,
          packageName,
        });
        return;
      }

      const subscriptionNotification =
        developerNotification.subscriptionNotification || null;
      const voidedPurchaseNotification =
        developerNotification.voidedPurchaseNotification || null;

      if (!subscriptionNotification && !voidedPurchaseNotification) {
        eventId = buildEventId({
          eventTimeMillis,
          messageId,
          kind: "unsupported",
        });
        await writeSubscriptionEvent(db, eventId, {
          ...buildBaseEventFields({ messageId, eventTimeMillis, packageName }),
          status: "rejected",
          errorCode: "UNSUPPORTED_NOTIFICATION",
          errorMessage: "Notification type is not supported in phase 1.",
        });
        logger.warn(`${NOTIFICATION_TRACE} unsupported notification`, {
          messageId,
        });
        return;
      }

      let purchaseToken = "";
      let subscriptionId = "";
      let notificationType = null;
      let forceExpired = false;

      if (voidedPurchaseNotification) {
        purchaseToken = String(
          voidedPurchaseNotification.purchaseToken || "",
        ).trim();
        const productType = Number(voidedPurchaseNotification.productType || 0);
        notificationType = "voided";
        subscriptionId = String(voidedPurchaseNotification.orderId || "").trim();

        if (productType !== VOIDED_PRODUCT_TYPE_SUBSCRIPTION) {
          eventId = buildEventId({
            eventTimeMillis,
            notificationType: "voided-otp",
            purchaseToken,
            messageId,
          });
          await writeSubscriptionEvent(db, eventId, {
            ...buildBaseEventFields({
              messageId,
              eventTimeMillis,
              packageName,
              notificationType,
              notificationTypeName: "VOIDED_ONE_TIME_PRODUCT",
              subscriptionId,
              purchaseToken,
            }),
            status: "rejected",
            errorCode: "UNSUPPORTED_VOIDED_PRODUCT_TYPE",
          });
          return;
        }
        forceExpired = true;
      } else {
        purchaseToken = String(subscriptionNotification.purchaseToken || "").trim();
        subscriptionId = String(subscriptionNotification.subscriptionId || "").trim();
        notificationType = Number(subscriptionNotification.notificationType);
      }

      if (!purchaseToken) {
        eventId = buildEventId({
          eventTimeMillis,
          notificationType,
          messageId,
          kind: "missing-token",
        });
        await writeSubscriptionEvent(db, eventId, {
          ...buildBaseEventFields({
            messageId,
            eventTimeMillis,
            packageName,
            notificationType,
            notificationTypeName: notificationTypeName(notificationType),
            subscriptionId,
          }),
          status: "rejected",
          errorCode: "MISSING_PURCHASE_TOKEN",
        });
        return;
      }

      if (
        subscriptionNotification &&
        subscriptionId !== GOOGLE_PLAY_MONTHLY_PRODUCT_ID
      ) {
        eventId = buildEventId({
          eventTimeMillis,
          notificationType,
          purchaseToken,
          messageId,
        });
        await writeSubscriptionEvent(db, eventId, {
          ...buildBaseEventFields({
            messageId,
            eventTimeMillis,
            packageName,
            notificationType,
            notificationTypeName: notificationTypeName(notificationType),
            subscriptionId,
            purchaseToken,
          }),
          status: "rejected",
          errorCode: "PRODUCT_ID_MISMATCH",
        });
        return;
      }

      eventId = buildEventId({
        eventTimeMillis,
        notificationType,
        purchaseToken,
        messageId,
      });
      const baseFields = buildBaseEventFields({
        messageId,
        eventTimeMillis,
        notificationType,
        notificationTypeName:
          voidedPurchaseNotification
            ? "VOIDED_PURCHASE"
            : notificationTypeName(notificationType),
        packageName,
        subscriptionId,
        purchaseToken,
      });

      const gate = await beginNotificationProcessing(db, eventId, baseFields);
      if (gate.action === "skip") {
        logger.info(`${NOTIFICATION_TRACE} skipped`, {
          messageId,
          eventId,
          reason: gate.reason,
        });
        return;
      }

      let subscription = null;
      let matchedLineItem = null;
      let linkedPurchaseToken = "";

      try {
        const synced = await syncGooglePlaySubscriptionByPurchaseToken(
          packageName,
          purchaseToken,
        );
        subscription = synced.subscription;
        matchedLineItem = synced.matchedLineItem;
        linkedPurchaseToken = String(
          subscription?.linkedPurchaseToken || "",
        ).trim();
      } catch (apiError) {
        if (forceExpired && isPermanentGooglePlayApiError(apiError)) {
          subscription = {};
          matchedLineItem = null;
          linkedPurchaseToken = "";
        } else {
          throw apiError;
        }
      }

      if (!forceExpired) {
        if (!matchedLineItem) {
          await writeSubscriptionEvent(db, eventId, {
            ...baseFields,
            status: "rejected",
            errorCode: "PRODUCT_LINE_ITEM_NOT_FOUND",
            errorMessage: "Target subscription line item was not found.",
            linkedPurchaseTokenSuffix: tokenSuffix(linkedPurchaseToken),
          });
          return;
        }
      }

      const derived = deriveGooglePlayEntitlement({
        subscription,
        matchedLineItem,
        notificationType,
        forceExpired,
      });

      if (!linkedPurchaseToken && derived.linkedPurchaseToken) {
        linkedPurchaseToken = derived.linkedPurchaseToken;
      }

      const userLookup = await findUserByPurchaseToken(
        db,
        purchaseToken,
        linkedPurchaseToken,
      );

      if (userLookup.kind === "ambiguous") {
        await writeSubscriptionEvent(db, eventId, {
          ...baseFields,
          status: "ambiguous",
          uid: null,
          linkedPurchaseTokenSuffix: tokenSuffix(linkedPurchaseToken),
          subscriptionStatus: derived.status,
          expiryTime: derived.expiryTime || null,
          errorCode: "AMBIGUOUS_USER_MATCH",
          errorMessage: "Multiple users matched the purchase token.",
        });
        logger.warn(`${NOTIFICATION_TRACE} ambiguous user match`, {
          messageId,
          eventId,
          purchaseTokenSuffix: tokenSuffix(purchaseToken),
          uidCount: userLookup.uids.length,
        });
        return;
      }

      if (userLookup.kind === "unlinked") {
        await writeSubscriptionEvent(db, eventId, {
          ...baseFields,
          status: "unlinked",
          uid: null,
          linkedPurchaseTokenSuffix: tokenSuffix(linkedPurchaseToken),
          subscriptionStatus: derived.status,
          expiryTime: derived.expiryTime || null,
          errorCode: "UNLINKED_PURCHASE_TOKEN",
        });
        logger.warn(`${NOTIFICATION_TRACE} unlinked purchase token`, {
          messageId,
          eventId,
          purchaseTokenSuffix: tokenSuffix(purchaseToken),
        });
        return;
      }

      const isRevocation = isRevocationNotification(forceExpired, notificationType);
      let finalDerived = derived;
      let applyOptions = {};
      let revocationResolution = null;

      if (isRevocation) {
        const userRef = db.collection("users").doc(userLookup.uid);
        const userSnap = await userRef.get();
        const existingData = userSnap.exists ? userSnap.data() || {} : {};
        const notificationTokenConfirmed =
          forceExpired ||
          Boolean(matchedLineItem) ||
          derived.status === "expired";

        revocationResolution = await resolveUserEntitlementAfterRevocation({
          packageName,
          existingData,
          notificationPurchaseToken: purchaseToken,
          notificationDerived: derived,
          notificationTokenConfirmed,
        });

        finalDerived = revocationResolution.derived;
        applyOptions = {
          primaryPurchaseToken: revocationResolution.primaryPurchaseToken,
          clearPrimaryPurchaseToken:
            revocationResolution.action === "expire",
        };

        logger.info(`${NOTIFICATION_TRACE} revocation resolved`, {
          messageId,
          eventId,
          uid: userLookup.uid,
          action: revocationResolution.action,
          notificationPurchaseTokenSuffix: tokenSuffix(purchaseToken),
          revokedTokenIgnored: revocationResolution.revokedTokenIgnored
            ? tokenSuffix(revocationResolution.revokedTokenIgnored)
            : null,
          uncertainApiFailures: revocationResolution.uncertainApiFailures || [],
          finalSubscriptionStatus: finalDerived.status,
        });
      }

      const applyResult = await applyGoogleSubscriptionUpdateToUser(
        db,
        admin,
        userLookup.uid,
        finalDerived,
        purchaseToken,
        applyOptions,
      );

      await writeSubscriptionEvent(db, eventId, {
        ...baseFields,
        status: "processed",
        uid: userLookup.uid,
        userMatch: userLookup.match,
        linkedPurchaseTokenSuffix: tokenSuffix(linkedPurchaseToken),
        subscriptionStatus: finalDerived.status,
        expiryTime: finalDerived.expiryTime || null,
        result: applyResult.applied ? "user_updated" : applyResult.reason,
        googlePlaySubscriptionState: finalDerived.subscriptionState || "",
        googlePlayLatestOrderId: finalDerived.latestOrderId || "",
        revocationAction: revocationResolution?.action || null,
        revokedTokenIgnored: revocationResolution?.revokedTokenIgnored
          ? tokenSuffix(revocationResolution.revokedTokenIgnored)
          : null,
      });

      logger.info(`${NOTIFICATION_TRACE} processed`, {
        messageId,
        eventId,
        uid: userLookup.uid,
        purchaseTokenSuffix: tokenSuffix(purchaseToken),
        subscriptionStatus: finalDerived.status,
        result: applyResult.applied ? "user_updated" : applyResult.reason,
        revocationAction: revocationResolution?.action || null,
      });
    } catch (error) {
      const fallbackEventId =
        eventId ||
        buildEventId({
          eventTimeMillis: developerNotification?.eventTimeMillis || Date.now(),
          notificationType:
            developerNotification?.subscriptionNotification?.notificationType ||
            "error",
          purchaseToken:
            developerNotification?.subscriptionNotification?.purchaseToken ||
            developerNotification?.voidedPurchaseNotification?.purchaseToken ||
            "",
          messageId,
          kind: "failed",
        });

      logger.error(`${NOTIFICATION_TRACE} failed`, {
        messageId,
        eventId: fallbackEventId,
        errorMessage: error?.message || String(error),
        errorName: error?.name || null,
        errorStack: error?.stack || null,
        purchaseTokenSuffix: tokenSuffix(
          developerNotification?.subscriptionNotification?.purchaseToken ||
            developerNotification?.voidedPurchaseNotification?.purchaseToken ||
            "",
        ),
      });

      if (fallbackEventId) {
        await writeSubscriptionEvent(db, fallbackEventId, {
          platform: "google_play",
          messageId,
          status: "failed",
          errorCode: error?.message || "UNKNOWN_ERROR",
          errorMessage: error?.message || String(error),
          processedAt: new Date(),
        });
      }

      throw error;
    }
  };
}

module.exports = {
  createGooglePlayRtdnHandler,
  GOOGLE_PLAY_PACKAGE_NAME,
  GOOGLE_PLAY_MONTHLY_PRODUCT_ID,
  collectTokensForRequery,
  isUsableGooglePlayEntitlement,
  resolveRevocationUserEntitlement,
  deriveGooglePlayEntitlement,
  parseFirestoreExpiryTime,
};
