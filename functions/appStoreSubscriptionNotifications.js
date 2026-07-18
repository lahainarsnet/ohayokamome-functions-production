/**
 * App Store Server Notifications V2 handler (phase 1).
 */
const {
  Environment,
  SignedDataVerifier,
} = require("@apple/app-store-server-library");
const {
  APP_STORE_BUNDLE_ID,
  APP_STORE_PRODUCT_ID,
  peekJwsPayload,
  fetchAppStoreAllSubscriptionStatuses,
  loadAppleRootCertificates,
  deriveSubscriptionState,
  pickLatestTransactionEntry,
} = require("./appStoreServerCommon");
const {
  buildIosStoreState,
  commitUserSubscriptionDualWrite,
} = require("./subscriptionEntitlement");

const NOTIFICATION_TRACE = "APP_STORE_NOTIFICATION_TRACE";
const PROCESSING_STALE_MS = 10 * 60 * 1000;

function normalizeEnvironment(value) {
  const normalized = String(value || "").trim();
  if (normalized === "Sandbox") {
    return "Sandbox";
  }
  if (normalized === "Production") {
    return "Production";
  }
  return "";
}

function resolveNotificationEnvironment(decodedOrPeeked, fallback = "") {
  return (
    normalizeEnvironment(decodedOrPeeked?.data?.environment) ||
    normalizeEnvironment(decodedOrPeeked?.environment) ||
    normalizeEnvironment(fallback) ||
    ""
  );
}

function toLibraryEnvironment(environment) {
  return environment === "Sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
}

function parseAppAppleId(raw) {
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readAppAppleId(getAppAppleId) {
  const raw =
    typeof getAppAppleId === "function"
      ? getAppAppleId()
      : process.env.APP_STORE_CONNECT_APP_APPLE_ID;
  return parseAppAppleId(raw);
}

function createSignedDataVerifier(environment, getAppAppleId) {
  const appAppleId = readAppAppleId(getAppAppleId);
  if (environment === "Production" && appAppleId === undefined) {
    throw new Error("APP_STORE_CONNECT_APP_APPLE_ID_REQUIRED_FOR_PRODUCTION");
  }
  return new SignedDataVerifier(
    loadAppleRootCertificates(),
    true,
    toLibraryEnvironment(environment),
    APP_STORE_BUNDLE_ID,
    appAppleId
  );
}

function buildVerifierForSignedPayload(signedPayload, getAppAppleId) {
  const peeked = peekJwsPayload(signedPayload);
  const environment = resolveNotificationEnvironment(peeked);
  if (!environment) {
    return {
      verifier: createSignedDataVerifier("Production", getAppAppleId),
      environment: "Production",
      fallbackVerifier: createSignedDataVerifier("Sandbox", getAppAppleId),
    };
  }
  return {
    verifier: createSignedDataVerifier(environment, getAppAppleId),
    environment,
    fallbackVerifier:
      environment === "Production"
        ? createSignedDataVerifier("Sandbox", getAppAppleId)
        : createSignedDataVerifier("Production", getAppAppleId),
  };
}

async function verifyNotificationPayload(signedPayload, getAppAppleId) {
  const { verifier, environment, fallbackVerifier } =
    buildVerifierForSignedPayload(signedPayload, getAppAppleId);
  try {
    const decoded = await verifier.verifyAndDecodeNotification(signedPayload);
    return { decoded, environment: resolveNotificationEnvironment(decoded, environment) };
  } catch (primaryError) {
    try {
      const decoded = await fallbackVerifier.verifyAndDecodeNotification(
        signedPayload
      );
      return {
        decoded,
        environment: resolveNotificationEnvironment(decoded, environment),
      };
    } catch (fallbackError) {
      const error = new Error("JWS_VERIFICATION_FAILED");
      error.primaryMessage = primaryError?.message;
      error.fallbackMessage = fallbackError?.message;
      throw error;
    }
  }
}

async function decodeSignedTransaction(verifier, signedTransactionInfo) {
  if (!signedTransactionInfo) {
    return null;
  }
  return verifier.verifyAndDecodeTransaction(signedTransactionInfo);
}

async function decodeSignedRenewal(verifier, signedRenewalInfo) {
  if (!signedRenewalInfo) {
    return null;
  }
  return verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo);
}

function eventBaseFields(decodedNotification, environment) {
  return {
    notificationUUID: decodedNotification?.notificationUUID || "",
    notificationType: decodedNotification?.notificationType || "",
    subtype: decodedNotification?.subtype || "",
    environment: resolveNotificationEnvironment(decodedNotification, environment),
    receivedAt: new Date(),
  };
}

async function writeSubscriptionEvent(db, notificationUUID, fields) {
  if (!notificationUUID) {
    return;
  }
  const ref = db.collection("subscription_events").doc(notificationUUID);
  await ref.set(
    {
      ...fields,
      processedAt: fields.processedAt || new Date(),
    },
    { merge: true }
  );
}

async function beginNotificationProcessing(db, notificationUUID, baseFields) {
  return db.runTransaction(async (tx) => {
    const ref = db.collection("subscription_events").doc(notificationUUID);
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
          receivedMillis > 0 && Date.now() - receivedMillis > PROCESSING_STALE_MS;
        if (!stale) {
          return { action: "skip", reason: "processing_in_flight" };
        }
      }
      if (existingStatus !== "failed" && existingStatus !== "processing") {
        if (existingStatus === "rejected" || existingStatus === "ambiguous" || existingStatus === "unlinked") {
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
      { merge: true }
    );
    return { action: "continue" };
  });
}

async function findTargetUser(db, originalTransactionId, transactionId) {
  const users = db.collection("users");
  const originalId = String(originalTransactionId || "").trim();
  const latestTransactionId = String(transactionId || "").trim();

  if (originalId) {
    const byOriginal = await users
      .where("appStoreOriginalTransactionId", "==", originalId)
      .limit(2)
      .get();
    if (byOriginal.size === 1) {
      return { kind: "single", uid: byOriginal.docs[0].id, match: "appStoreOriginalTransactionId" };
    }
    if (byOriginal.size > 1) {
      return { kind: "ambiguous", uids: byOriginal.docs.map((doc) => doc.id) };
    }
  }

  const tokenCandidates = [latestTransactionId, originalId].filter(Boolean);
  for (const token of tokenCandidates) {
    const byToken = await users
      .where("activePurchaseTokens", "array-contains", token)
      .limit(2)
      .get();
    if (byToken.size === 1) {
      return { kind: "single", uid: byToken.docs[0].id, match: "activePurchaseTokens" };
    }
    if (byToken.size > 1) {
      return { kind: "ambiguous", uids: byToken.docs.map((doc) => doc.id) };
    }
  }

  if (latestTransactionId) {
    const byTransaction = await users
      .where("appStoreTransactionId", "==", latestTransactionId)
      .limit(2)
      .get();
    if (byTransaction.size === 1) {
      return { kind: "single", uid: byTransaction.docs[0].id, match: "appStoreTransactionId" };
    }
    if (byTransaction.size > 1) {
      return { kind: "ambiguous", uids: byTransaction.docs.map((doc) => doc.id) };
    }
  }

  return { kind: "unlinked" };
}

function autoRenewingFromRenewalInfo(renewalInfo) {
  if (
    renewalInfo == null ||
    renewalInfo.autoRenewStatus === undefined ||
    renewalInfo.autoRenewStatus === null
  ) {
    return null;
  }
  return Number(renewalInfo.autoRenewStatus) === 1;
}

async function applyUserSubscriptionUpdate(
  db,
  admin,
  uid,
  derived,
  source,
  options = {}
) {
  const update = {
    subscriptionStatus: derived.status,
    subscriptionProductId: APP_STORE_PRODUCT_ID,
    subscriptionPlatform: "ios",
    appStoreOriginalTransactionId: derived.originalTransactionId,
    appStoreTransactionId: derived.latestTransactionId,
    appStoreEnvironment: derived.environment,
    appStoreValidationCode: derived.validationCode,
    activePurchaseTokens: derived.latestTransactionId
      ? [derived.latestTransactionId]
      : [],
    lastSubscriptionSource: source,
    lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
    updatedAt: admin.FieldValue.serverTimestamp(),
  };

  let expiryTime = null;
  if (derived.expiresDate > 0) {
    expiryTime = admin.Timestamp.fromMillis(derived.expiresDate);
    update.subscriptionExpiryTime = expiryTime;
  }

  const storeState = buildIosStoreState({
    status: derived.status,
    expiryTime,
    autoRenewing:
      typeof options.autoRenewing === "boolean" ? options.autoRenewing : null,
    originalTransactionId: derived.originalTransactionId || "",
    transactionId: derived.latestTransactionId || "",
    environment: derived.environment || "",
    source,
    updatedAt: admin.FieldValue.serverTimestamp(),
  });

  await commitUserSubscriptionDualWrite({
    db,
    admin,
    uid,
    source: "apple_notification",
    platform: "ios",
    storeState,
    legacyUpdate: update,
    log: options.logger || console,
    meta: {
      eventId: options.notificationUUID || "",
      transactionId: derived.latestTransactionId || "",
      originalTransactionId: derived.originalTransactionId || "",
    },
  });
}

function isTestNotification(decodedNotification) {
  const type = String(decodedNotification?.notificationType || "").trim();
  return type === "TEST";
}

function createAppStoreNotificationHandler({
  getDb,
  admin,
  logger,
  secrets,
  getAppAppleId,
}) {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const signedPayload =
      typeof req.body?.signedPayload === "string" ? req.body.signedPayload : "";
    if (!signedPayload) {
      res.status(400).send("Missing signedPayload");
      return;
    }

    const db = getDb();

    try {
      const { decoded, environment } = await verifyNotificationPayload(
        signedPayload,
        getAppAppleId
      );
      const notificationUUID = decoded?.notificationUUID || "";
      const baseFields = eventBaseFields(decoded, environment);

      if (!notificationUUID) {
        await writeSubscriptionEvent(db, `missing-uuid-${Date.now()}`, {
          ...baseFields,
          status: "rejected",
          errorCode: "MISSING_NOTIFICATION_UUID",
        });
        res.status(200).send("OK");
        return;
      }

      const gate = await beginNotificationProcessing(db, notificationUUID, baseFields);
      if (gate.action === "skip") {
        logger.info(`${NOTIFICATION_TRACE} skipped`, {
          notificationUUID,
          reason: gate.reason,
        });
        res.status(200).send("OK");
        return;
      }

      if (isTestNotification(decoded)) {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          status: "processed",
          result: "test_notification",
        });
        logger.info(`${NOTIFICATION_TRACE} test notification processed`, {
          notificationUUID,
        });
        res.status(200).send("OK");
        return;
      }

      const verifier = createSignedDataVerifier(
        environment === "Sandbox" ? "Sandbox" : "Production",
        getAppAppleId
      );
      const signedTransactionInfo = decoded?.data?.signedTransactionInfo || null;
      const signedRenewalInfo = decoded?.data?.signedRenewalInfo || null;

      let transactionInfo = null;
      let renewalInfo = null;
      if (signedTransactionInfo) {
        transactionInfo = await decodeSignedTransaction(
          verifier,
          signedTransactionInfo
        );
      }
      if (signedRenewalInfo) {
        renewalInfo = await decodeSignedRenewal(verifier, signedRenewalInfo);
      }

      const originalTransactionId =
        transactionInfo?.originalTransactionId ||
        renewalInfo?.originalTransactionId ||
        "";
      const transactionId = transactionInfo?.transactionId || "";

      if (!originalTransactionId) {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId: "",
          transactionId,
          status: "rejected",
          errorCode: "MISSING_ORIGINAL_TRANSACTION_ID",
        });
        res.status(200).send("OK");
        return;
      }

      const precheck = deriveSubscriptionState(transactionInfo || {});
      if (precheck.validationCode === "BUNDLE_ID_MISMATCH" || precheck.validationCode === "PRODUCT_ID_MISMATCH") {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          status: "rejected",
          errorCode: precheck.validationCode,
        });
        res.status(200).send("OK");
        return;
      }

      const userLookup = await findTargetUser(
        db,
        originalTransactionId,
        transactionId
      );

      if (userLookup.kind === "ambiguous") {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          status: "ambiguous",
          errorCode: "MULTIPLE_USERS_MATCHED",
          errorMessage: userLookup.uids.join(","),
        });
        res.status(200).send("OK");
        return;
      }

      if (userLookup.kind === "unlinked") {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          status: "unlinked",
          errorCode: "USER_NOT_FOUND",
        });
        res.status(200).send("OK");
        return;
      }

      const userSnap = await db.collection("users").doc(userLookup.uid).get();
      const userData = userSnap.exists ? userSnap.data() || {} : {};
      const storedEnvironment = normalizeEnvironment(userData.appStoreEnvironment);
      const notificationEnvironment = normalizeEnvironment(
        transactionInfo?.environment || environment
      );
      if (
        storedEnvironment &&
        notificationEnvironment &&
        storedEnvironment !== notificationEnvironment
      ) {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          uid: userLookup.uid,
          status: "rejected",
          errorCode: "ENVIRONMENT_MISMATCH",
          errorMessage: `${storedEnvironment}!=${notificationEnvironment}`,
        });
        res.status(200).send("OK");
        return;
      }

      const apiResult = await fetchAppStoreAllSubscriptionStatuses(
        originalTransactionId,
        notificationEnvironment,
        secrets
      );
      const latestEntry = await pickLatestTransactionEntry(
        apiResult.body,
        (signedInfo) => verifier.verifyAndDecodeTransaction(signedInfo)
      );

      if (!latestEntry?.transactionInfo) {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          uid: userLookup.uid,
          status: "failed",
          errorCode: "SUBSCRIPTION_STATUS_NOT_FOUND",
        });
        res.status(200).send("OK");
        return;
      }

      const derived = deriveSubscriptionState(latestEntry.transactionInfo);
      if (derived.validationCode === "BUNDLE_ID_MISMATCH" || derived.validationCode === "PRODUCT_ID_MISMATCH") {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...baseFields,
          originalTransactionId,
          transactionId,
          uid: userLookup.uid,
          status: "rejected",
          errorCode: derived.validationCode,
        });
        res.status(200).send("OK");
        return;
      }

      derived.environment =
        normalizeEnvironment(latestEntry.transactionInfo?.environment) ||
        apiResult.environment ||
        notificationEnvironment;

      let latestRenewalInfo = renewalInfo;
      if (!latestRenewalInfo && latestEntry.renewalInfoSigned) {
        try {
          latestRenewalInfo = await decodeSignedRenewal(
            verifier,
            latestEntry.renewalInfoSigned
          );
        } catch (renewalError) {
          logger.warn(`${NOTIFICATION_TRACE} renewal decode failed`, {
            uid: userLookup.uid,
            notificationUUID,
            message: renewalError?.message || String(renewalError),
          });
        }
      }

      await applyUserSubscriptionUpdate(
        db,
        admin,
        userLookup.uid,
        derived,
        "app_store_notification_v2",
        {
          autoRenewing: autoRenewingFromRenewalInfo(latestRenewalInfo),
          notificationUUID,
          logger,
        }
      );

      await writeSubscriptionEvent(db, notificationUUID, {
        ...baseFields,
        originalTransactionId: derived.originalTransactionId || originalTransactionId,
        transactionId: derived.latestTransactionId || transactionId,
        uid: userLookup.uid,
        status: "processed",
        result: derived.validationCode,
        subscriptionStatus: derived.status,
        userMatch: userLookup.match,
      });

      logger.info(`${NOTIFICATION_TRACE} processed`, {
        notificationUUID,
        uid: userLookup.uid,
        notificationType: baseFields.notificationType,
        subtype: baseFields.subtype,
        validationCode: derived.validationCode,
        subscriptionStatus: derived.status,
      });

      res.status(200).send("OK");
    } catch (error) {
      const peeked = peekJwsPayload(signedPayload);
      const notificationUUID = peeked?.notificationUUID || "";
      logger.error(`${NOTIFICATION_TRACE} failed`, {
        notificationUUID: notificationUUID || null,
        errorMessage: error?.message || String(error),
        errorName: error?.name || null,
        errorStack: error?.stack || null,
        errorStatus: error?.status ?? null,
        errorCauseMessage: error?.cause?.message ?? null,
        primaryMessage: error?.primaryMessage,
        fallbackMessage: error?.fallbackMessage,
        lookupErrors: error?.lookupErrors || null,
      });

      if (notificationUUID) {
        await writeSubscriptionEvent(db, notificationUUID, {
          ...eventBaseFields(
            peeked || {},
            resolveNotificationEnvironment(peeked)
          ),
          status: "failed",
          errorCode: error?.message || "UNKNOWN_ERROR",
          errorMessage: error?.message || String(error),
        });
      }

      res.status(200).send("OK");
    }
  };
}

module.exports = {
  createAppStoreNotificationHandler,
  NOTIFICATION_TRACE,
};
