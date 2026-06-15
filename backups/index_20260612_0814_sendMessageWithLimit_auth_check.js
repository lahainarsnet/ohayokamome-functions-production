// functions/index.js
// 正本リポジトリ: github.com/lahainars/ohayou-kamome（cloud_functions 配下）※ Flutter リポジトリと混同しないこと。
//
// トップレベルは軽量に保ち、Firestore / FieldValue 等は firebaseAdmin 経由で
// 初回実行時まで遅延（デプロイ時のコードロードタイムアウト対策）。

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { randomUUID } = require("node:crypto");
const admin = require("./firebaseAdmin");
const { transcribeExperiment } = require("./transcribeExperiment");

/* =========================================================
 * ユーティリティ：JST の日付キー (YYYY-MM-DD) を得る
 *  - Cloud Functions のサーバ時刻を基準
 * =======================================================*/
function getJstDateKey(baseDate = new Date()) {
  // UTC → JST (+9h)
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jst = new Date(baseDate.getTime() + JST_OFFSET_MS);
  // "YYYY-MM-DD" を取り出す
  return jst.toISOString().slice(0, 10);
}

/* =========================================================
 * 共通：config/app を読み込み
 *  - dailyLimit: 1日の送信上限（デフォルト200）
 *  - accessMode: "normal" | "block_all"
 * =======================================================*/
/**
 * 受信者の contacts に送信者が登録されているか（双方向登録の受信者側）。
 * - stableId === senderId（現行 Flutter 想定）
 * - stableId が空/欠損かつ partnerId === senderId（旧 Kotlin レガシー）
 */
function recipientContactAcceptsSender(data, senderId) {
  const stableRaw = data.stableId;
  const stableId =
    typeof stableRaw === "string" ? stableRaw.trim() : "";
  const partnerId =
    typeof data.partnerId === "string" ? data.partnerId.trim() : "";
  if (stableId === senderId) {
    return true;
  }
  if (stableId === "" && partnerId === senderId) {
    return true;
  }
  return false;
}

async function loadAppConfig() {
  const defaults = { dailyLimit: 200, accessMode: "normal" };
  try {
    const doc = await admin.getDb().collection("config").doc("app").get();
    const dailySendLimit = doc?.get("dailySendLimit");
    const appAccessMode = doc?.get("app_access_mode");
    const dailyLimit =
      typeof dailySendLimit === "number" && dailySendLimit > 0
        ? (dailySendLimit | 0)
        : defaults.dailyLimit;
    const accessMode =
      typeof appAccessMode === "string" && appAccessMode.length > 0
        ? appAccessMode
        : defaults.accessMode;

    return { dailyLimit, accessMode };
  } catch (e) {
    logger.warn("Failed to read config/app; using defaults.", e);
    return defaults;
  }
}

/* =========================================================
 * ★新規：送信後インクリメント（当日送信数の+1と上限判定）
 *  - クライアントは「メッセージ送信」直後に本関数を呼ぶ
 *  - users/{uid} に dailyCount / lastSentDate を保持
 *  - 返り値で exceeded を通知（newCount > LIMIT）
 *  - 端末時計に依存せず、Cloud Functions のサーバ時刻から JST 日付キーを生成
 * =======================================================*/
exports.postSendIncrementUsage = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const uid = request.auth.uid;
  const { dailyLimit: LIMIT, accessMode } = await loadAppConfig();

  // 管理者が全ブロック設定中なら、送信自体は既に終わっている前提だが通知は返す
  if (accessMode === "block_all") {
    logger.warn("Access mode is block_all; returning BLOCKED_BY_ADMIN info.");
    return { success: true, code: "BLOCKED_BY_ADMIN", exceeded: true, limit: LIMIT };
  }

  const userRef = admin.getDb().collection("users").doc(uid);

  try {
    const result = await admin.getDb().runTransaction(async (tx) => {
      const snap = await tx.get(userRef);

      // JST 今日の日付キー（サーバ時刻基準）
      const todayKey = getJstDateKey(new Date());

      let dailyCount = 0;
      let lastSentDate = todayKey;

      if (snap.exists) {
        dailyCount = snap.get("dailyCount") || 0;
        lastSentDate = snap.get("lastSentDate") || todayKey;

        // 日付が変わっていたらカウントをリセット
        if (lastSentDate !== todayKey) {
          dailyCount = 0;
          lastSentDate = todayKey;
        }
      } else {
        // users/{uid} が未作成でも処理継続（このタイミングで作る）
        logger.info("User doc did not exist. Creating a new one.", { uid });
      }

      const newCount = dailyCount + 1;
      const exceeded = newCount > LIMIT;

      tx.set(
        userRef,
        {
          dailyCount: newCount,
          lastSentDate: todayKey,
          updatedAt: admin.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return { newCount, exceeded, limit: LIMIT, dateKey: todayKey };
    });

    logger.info("postSendIncrementUsage result", { uid, ...result });
    return {
      success: true,
      count: result.newCount,
      exceeded: result.exceeded,
      limit: result.limit,
      dateKey: result.dateKey,
    };
  } catch (error) {
    logger.error("postSendIncrementUsage failed:", { uid, error });
    throw new HttpsError("internal", "Failed to increment usage.");
  }
});

/* =========================================================
 * プッシュ通知（Android 8+ は channelId 必須。未設定だと Miscellaneous＝サイレントになりやすい）
 * - chats/{chatId}/messages 作成をトリガに
 * - HIGH優先度 + notificationペイロード + android.notification.channelId
 * - チャネル ID はアプリ側 NotificationHelper.NEW_MESSAGE_CHANNEL_ID と同一文字列
 * =======================================================*/
exports.sendPushNotification = onDocumentCreated(
  "chats/{chatId}/messages/{messageId}",
  async (event) => {
    const message = event.data.data();
    const chatId = event.params.chatId;
    const messageId = event.params.messageId;

    // chatId は "uid1_uid2"（UID を辞書順でソートしたもの）
    // senderId からチャットの受信者 UID を特定し、Firestore から最新 FCM トークンを取得する。
    // これにより、連絡先登録後にトークンが更新されても正しく通知が届く。
    const senderId = message.senderId || "";
    const participants = chatId.split("_");
    const recipientId = participants.find((id) => id !== senderId) || "";

    let toToken = message.token || ""; // フォールバック（旧メッセージとの互換性）

    if (recipientId) {
      try {
        const recipientDoc = await admin.getDb().collection("users").doc(recipientId).get();
        const latestToken = recipientDoc.get("fcmToken") || "";
        if (latestToken) {
          toToken = latestToken;
          logger.info("Using latest FCM token from Firestore.", { recipientId });
        } else {
          logger.warn("Recipient fcmToken is empty in Firestore; falling back to embedded token.", { recipientId });
        }
      } catch (e) {
        logger.warn("Failed to fetch recipient FCM token; falling back to embedded token.", { recipientId, e });
      }
    } else {
      logger.warn("Could not determine recipientId from chatId.", { chatId, senderId });
    }

    if (!toToken || typeof toToken !== "string") {
      logger.warn("FCM token missing; skip send.", { chatId, messageId });
      return { success: false, reason: "MISSING_TOKEN" };
    }

    // 通知タイトル・本文（必要に応じて整形）
    const title = "新しいメッセージ";
    const body = message.text || "メッセージが届きました";

    // Admin SDK の send() フォーマット（channelId はアプリの NotificationChannel と一致させる）
    // ルートに notification を含めると FCM が全プラットフォームで「通知」として分類しやすく、
    // 特に iOS クライアントの RemoteMessage.notification の有無に影響する。
    const ANDROID_MESSAGE_CHANNEL_ID = "com.lahainars.tonikaku.new_message_alerts";
    const msg = {
      token: toToken,
      notification: {
        title,
        body,
      },
      android: {
        priority: "high",            // ★ Doze中の遅延を抑制
        ttl: 6 * 3600 * 1000,  // ★ 6時間（ミリ秒）

        collapseKey: "chat",         // ★ 連投時は上書き
        notification: {
          channelId: ANDROID_MESSAGE_CHANNEL_ID,
          title,
          body,
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
          "apns-push-type": "alert",
        },
        payload: {
          // content-available を付けたデータ＋アラート混在は端末によって優先順位が曖昧になることがあるため、
          // 通常のチャット通知（バナー・音）では aps はアラート中心にする。
          aps: {
            alert: {
              title,
              body,
            },
            sound: "default",
            badge: 1,
          },
        },
      },
      // 既存アプリ側の処理互換のため data は維持
      data: {
        senderId: message.senderId || "",
        senderAccountId: message.senderAccountId || "",
        userName: message.userName || "",
        text: message.text || "",
        chatId: chatId,
        messageId: messageId,
      },
    };

    logger.info("Attempting to send notification message", {
      chatId,
      messageId,
      toToken: toToken.slice(0, 12) + "...",
      collapseKey: msg.android.collapseKey,
      ttlMs: msg.android.ttl,
      priority: msg.android.priority,
      channelId: ANDROID_MESSAGE_CHANNEL_ID,
    });

    try {
      const response = await admin.getMessagingClient().send(msg);
      logger.info("Successfully sent message:", response);
      return { success: true };
    } catch (error) {
      logger.error("Error sending message:", error);
      return { success: false };
    }
  }
);

/* =========================================================
 * 既存機能：古いメッセージ自動削除
 * =======================================================*/
exports.deleteOldMessages = onDocumentCreated(
  "chats/{chatId}/messages/{messageId}",
  async (event) => {
    const chatId = event.params.chatId;
    logger.info(
      `[Auto-Delete] New message in chat: ${chatId}. Checking message count.`
    );

    const MESSAGE_LIMIT = 300;
    const messagesRef = admin.getDb().collection("chats").doc(chatId).collection("messages");

    try {
      const snapshot = await messagesRef.get();
      const currentMessageCount = snapshot.size;

      logger.info(
        `[Auto-Delete] Current message count in ${chatId} is ${currentMessageCount}. Limit is ${MESSAGE_LIMIT}.`
      );

      if (currentMessageCount > MESSAGE_LIMIT) {
        const messagesToDeleteCount = currentMessageCount - MESSAGE_LIMIT;
        logger.info(
          `[Auto-Delete] Deleting ${messagesToDeleteCount} oldest message(s).`
        );

        const query = messagesRef.orderBy("timestamp", "asc").limit(messagesToDeleteCount);
        const messagesToDeleteSnapshot = await query.get();

        const batch = admin.getDb().batch();
        messagesToDeleteSnapshot.forEach((doc) => {
          batch.delete(doc.ref);
        });

        await batch.commit();
        logger.info(
          `[Auto-Delete] Deleted ${messagesToDeleteSnapshot.size} old message(s) from chat ${chatId}.`
        );
      } else {
        logger.info(`[Auto-Delete] No action needed.`);
      }

      return { success: true };
    } catch (error) {
      logger.error(`[Auto-Delete] Error deleting old messages in chat ${chatId}:`, error);
      return { success: false };
    }
  }
);

/* =========================================================
 * （参考）旧：送信前ブロック型
 * - 今回のUX方針（送信は即時）と異なるため未使用推奨
 * - 必要なら accessMode 等で分岐して使い分け可
 * =======================================================*/
exports.sendMessageWithLimit = onCall(async (request) => {
  const { senderId, recipientId, text, userName, token } = request.data || {};
  if (!senderId || !recipientId || !text) {
    return { success: false, code: "INVALID_REQUEST" };
  }
  if (!request.auth || request.auth.uid !== senderId) {
    logger.warn("sendMessageWithLimit: SENDER_AUTH_MISMATCH", {
      authUid: request.auth?.uid || null,
      senderId,
    });
    return { success: false, code: "SENDER_AUTH_MISMATCH" };
  }

  const { dailyLimit: LIMIT, accessMode } = await loadAppConfig();
  if (accessMode === "block_all") {
    return { success: false, code: "BLOCKED_BY_ADMIN" };
  }

  const contactsSnap = await admin
    .getDb()
    .collection("users")
    .doc(recipientId)
    .collection("contacts")
    .get();

  let recipientAllowsSender = false;
  for (const doc of contactsSnap.docs) {
    const data = doc.data() || {};
    if (recipientContactAcceptsSender(data, senderId)) {
      recipientAllowsSender = true;
      break;
    }
  }
  if (!recipientAllowsSender) {
    logger.warn(
      "sendMessageWithLimit: RECIPIENT_CONTACT_MISSING",
      { recipientId, senderId },
    );
    return { success: false, code: "RECIPIENT_CONTACT_MISSING" };
  }

  const today = getJstDateKey(new Date());
  const userRef = admin.getDb().collection("users").doc(senderId);

  try {
    await admin.getDb().runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userRef);
      let dailyCount = 0;
      let lastSentDate = today;

      if (userDoc.exists) {
        dailyCount = userDoc.get("dailyCount") || 0;
        lastSentDate = userDoc.get("lastSentDate") || today;
        if (lastSentDate !== today) {
          dailyCount = 0;
          lastSentDate = today;
        }
      } else {
        throw new Error("SENDER_DOCUMENT_NOT_FOUND");
      }

      if (dailyCount >= LIMIT) {
        const err = new Error("DAILY_LIMIT_EXCEEDED");
        err.limit = LIMIT;
        throw err;
      }

      const senderAccountId = userDoc.get("accountId");
      if (!senderAccountId) {
        throw new Error("SENDER_MISSING_ACCOUNT_ID");
      }

      // 送信カウント更新
      transaction.set(
        userRef,
        { dailyCount: dailyCount + 1, lastSentDate: today },
        { merge: true }
      );

      const chatRoomId = [senderId, recipientId].sort().join("_");
      const chatRef = admin.getDb().collection("chats").doc(chatRoomId);

      transaction.set(
        chatRef,
        { participants: admin.FieldValue.arrayUnion(senderId, recipientId) },
        { merge: true }
      );

      const msgRef = chatRef.collection("messages").doc();
      const messageData = {
        senderId: senderId,
        senderAccountId: senderAccountId,
        text,
        timestamp: admin.FieldValue.serverTimestamp(),
        isRead: false,
        userName: userName || "名無し",
        token: token || "",
      };
      transaction.set(msgRef, messageData);
    });

    return { success: true };
  } catch (error) {
    const code =
      (error && typeof error.message === "string" && error.message) || "UNKNOWN";
    const extra = {};
    if (code === "DAILY_LIMIT_EXCEEDED" && typeof error.limit === "number") {
      extra.limit = error.limit;
    }
    logger.error("sendMessageWithLimit failed:", { code, ...extra, error });
    return { success: false, code, ...extra };
  }
});

/* =========================================================
 * 既存機能：利用規約同意の保存
 * =======================================================*/
exports.recordTosConsent = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { tosHash, appVersionCode } = request.data || {};
  if (typeof tosHash !== "string" || tosHash.length === 0) {
    throw new HttpsError("invalid-argument", "Parameter 'tosHash' required.");
  }
  if (typeof appVersionCode !== "number") {
    throw new HttpsError("invalid-argument", "Parameter 'appVersionCode' must be number.");
  }

  const uid = request.auth.uid;
  const email = request.auth.token.email || null;

  const consentData = {
    uid,
    email,
    tosHash,
    appVersionCode,
    consentTimestamp: admin.FieldValue.serverTimestamp(),
  };

  try {
    await admin.getDb().collection("tos_consents").add(consentData);
    logger.info(`Recorded ToS consent for user ${uid}`);
    return { success: true };
  } catch (error) {
    logger.error(`Failed to write ToS consent for user ${uid}`, error);
    throw new HttpsError("internal", "Failed to save consent record.");
  }
});

/* =========================================================
 * 既存機能：メール保存 + accountId の補完
 * =======================================================*/
exports.upsertUserEmailAndAccount = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const uid = request.auth.uid;
  const { email, accountId: accountIdFromClient } = request.data || {};

  if (typeof email !== "string" || email.length === 0) {
    throw new HttpsError("invalid-argument", "Parameter 'email' is required.");
  }

  const userRef = admin.getDb().collection("users").doc(uid);

  try {
    const snap = await userRef.get();
    let accountIdToUse = null;

    if (snap.exists && typeof snap.get("accountId") === "string" && snap.get("accountId")) {
      accountIdToUse = snap.get("accountId");
    } else if (typeof accountIdFromClient === "string" && accountIdFromClient.length > 0) {
      accountIdToUse = accountIdFromClient;
    } else {
      accountIdToUse = randomUUID();
    }

    const update = {
      email,
      accountId: accountIdToUse,
      updatedAt: admin.FieldValue.serverTimestamp(),
    };

    await userRef.set(update, { merge: true });

    logger.info("upsertUserEmailAndAccount succeeded.", { uid, accountId: accountIdToUse });
    return { success: true, accountId: accountIdToUse };
  } catch (error) {
    logger.error("upsertUserEmailAndAccount failed.", { uid, error });
    throw new HttpsError("internal", "Failed to upsert user email/accountId.");
  }
});

/* =========================================================
 * 既存機能：accountIdからユーザー情報を安全に取得する
 * =======================================================*/
exports.getUserInfoByAccountId = onCall(async (request) => {
  let callerUid = request.auth?.uid || null;
  if (!callerUid) {
    const fallbackIdToken =
      typeof request.data?.idToken === "string" ? request.data.idToken : "";
    if (fallbackIdToken) {
      try {
        const decoded = await admin.getAuthClient().verifyIdToken(fallbackIdToken);
        callerUid = decoded.uid || null;
        logger.warn(
          "getUserInfoByAccountId: request.auth missing; verified fallback idToken.",
          { uid: callerUid }
        );
      } catch (error) {
        logger.warn("getUserInfoByAccountId: fallback idToken verification failed.", { error });
      }
    }
  }

  if (!callerUid) {
    logger.warn("getUserInfoByAccountId: unauthenticated request.", {
      hasRequestAuth: !!request.auth,
      hasFallbackIdToken:
        typeof request.data?.idToken === "string" && request.data.idToken.length > 0,
    });
    throw new HttpsError("unauthenticated", "Authentication is required.");
  }

  const { accountId } = request.data || {};
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new HttpsError("invalid-argument", "Parameter 'accountId' is required.");
  }

  try {
    const querySnapshot = await admin.getDb()
      .collection("users")
      .where("accountId", "==", accountId)
      .limit(1)
      .get();

    if (querySnapshot.empty) {
      logger.warn("User not found for accountId:", { accountId });
      return { uid: null, fcmToken: null };
    }

    const userDoc = querySnapshot.docs[0];
    const uid = userDoc.id;

    const tokens = Array.isArray(userDoc.get("fcmTokens")) ? userDoc.get("fcmTokens") : [];
    let fcmToken = tokens.length > 0 ? tokens[0] : null;
    if (!fcmToken) {
      fcmToken = userDoc.get("fcmToken") || null;
    }

    logger.info("Successfully retrieved user info for accountId:", { accountId, uid });
    return { uid: uid, fcmToken: fcmToken };
  } catch (error) {
    logger.error("Error retrieving user info by accountId:", { accountId, error });
    throw new HttpsError("internal", "Failed to retrieve user information.");
  }
});

/* =========================================================
 * Subscription: admin callable updater (temporary)
 *  - 管理者のみが users/{uid} のサブスク状態を更新するための簡易関数
 *  - カスタムクレーム（admin: true）を前提
 * =======================================================*/
exports.adminUpsertUserSubscription = onCall(async (request) => {
  // 要: 管理者のみ（またはデプロイ者のみ）使えるように制限
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Admin privileges required.");
  }

  const {
    uid,
    subscriptionStatus = "none",
    subscriptionProductId = "",
    subscriptionBasePlanId = "",
    subscriptionOfferId = "",
    expiryTimeMillis = null,     // 例: Date.now() + 30*24*60*60*1000
    activePurchaseTokens = [],   // string[]
    source = "manual_test"
  } = request.data || {};

  if (typeof uid !== "string" || uid.length === 0) {
    throw new HttpsError("invalid-argument", "Parameter 'uid' is required.");
  }

  const allowedStatuses = ["active", "grace", "paused", "expired", "canceled", "none"];
  if (!allowedStatuses.includes(subscriptionStatus)) {
    throw new HttpsError("invalid-argument", "Invalid 'subscriptionStatus'.");
  }

  const userRef = admin.getDb().collection("users").doc(uid);

  const update = {
    subscriptionStatus,
    subscriptionProductId,
    subscriptionBasePlanId,
    subscriptionOfferId,
    activePurchaseTokens: Array.isArray(activePurchaseTokens) ? activePurchaseTokens : [],
    lastSubscriptionSource: source,
    lastSubscriptionCheckedAt: admin.FieldValue.serverTimestamp(),
  };

  if (expiryTimeMillis !== null) {
    const n = Number(expiryTimeMillis);
    if (Number.isNaN(n) || n <= 0) {
      throw new HttpsError("invalid-argument", "expiryTimeMillis must be a positive number.");
    }
    update.subscriptionExpiryTime = admin.Timestamp.fromMillis(n);
  }

  await userRef.set(update, { merge: true });
  return { success: true };
});

exports.transcribeExperiment = transcribeExperiment;
