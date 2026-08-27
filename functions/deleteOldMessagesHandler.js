const admin = require("./firebaseAdmin");
const {
  CHAT_MESSAGE_CLEANUP_HIGH_WATER,
  CHAT_MESSAGE_TARGET,
  LAST_MESSAGE_CLEANUP_AT_FIELD,
  computeMessagesToDeleteCount,
  parseLastMessageCleanupAt,
  isMessageCleanupDue,
  computeBatchDeleteSize,
} = require("./deleteOldMessagesLib");

async function getQueryCount(query) {
  if (typeof query.count === "function") {
    const countSnap = await query.count().get();
    return countSnap.data().count || 0;
  }
  const snap = await query.get();
  return snap.size;
}

/**
 * 最古メッセージから順に batch 削除する（500 件単位で分割）。
 * @param {FirebaseFirestore.Firestore} db
 * @param {FirebaseFirestore.CollectionReference} messagesRef
 * @param {number} deleteCount
 * @returns {Promise<number>}
 */
async function deleteOldestMessagesInBatches(db, messagesRef, deleteCount) {
  let remaining = deleteCount;
  let totalDeleted = 0;

  while (remaining > 0) {
    const batchSize = computeBatchDeleteSize(remaining);
    if (batchSize <= 0) {
      break;
    }

    const snapshot = await messagesRef
      .orderBy("timestamp", "asc")
      .limit(batchSize)
      .get();
    if (snapshot.empty) {
      break;
    }

    const batch = db.batch();
    snapshot.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    totalDeleted += snapshot.size;
    remaining -= snapshot.size;

    if (snapshot.size < batchSize) {
      break;
    }
  }

  return totalDeleted;
}

/**
 * transaction で整理担当を 1 インスタンスだけ確保する。
 * @param {FirebaseFirestore.DocumentReference} chatRef
 * @param {number} nowMs
 * @returns {Promise<{ claimed: boolean }>}
 */
async function claimMessageCleanupSlot(chatRef, nowMs) {
  const db = admin.getDb();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(chatRef);
    const lastCleanupAtMs = parseLastMessageCleanupAt(
      snap.get(LAST_MESSAGE_CLEANUP_AT_FIELD)
    );
    if (!isMessageCleanupDue(lastCleanupAtMs, nowMs)) {
      return { claimed: false };
    }

    tx.set(
      chatRef,
      {
        [LAST_MESSAGE_CLEANUP_AT_FIELD]: admin.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return { claimed: true };
  });
}

/**
 * chats/{chatId} の古いメッセージ整理（約24時間に1回、250件超のみ削除）。
 */
async function runChatMessageCleanup({
  chatId,
  nowMs = Date.now(),
  logIdTailForLog = (id) => id,
  logger = console,
}) {
  const db = admin.getDb();
  const chatRef = db.collection("chats").doc(chatId);
  const messagesRef = chatRef.collection("messages");

  const chatSnap = await chatRef.get();
  const lastCleanupAtMs = parseLastMessageCleanupAt(
    chatSnap.get(LAST_MESSAGE_CLEANUP_AT_FIELD)
  );

  if (!isMessageCleanupDue(lastCleanupAtMs, nowMs)) {
    logger.info(
      `[Auto-Delete] Skipped cleanup check for chatTail=${logIdTailForLog(chatId)} (within 24h window).`
    );
    return {
      success: true,
      skipped: true,
      reason: "not_due",
      countQueryExecuted: false,
    };
  }

  const claim = await claimMessageCleanupSlot(chatRef, nowMs);
  if (!claim.claimed) {
    logger.info(
      `[Auto-Delete] Cleanup already claimed for chatTail=${logIdTailForLog(chatId)}.`
    );
    return {
      success: true,
      skipped: true,
      reason: "claim_lost",
      countQueryExecuted: false,
    };
  }

  const currentMessageCount = await getQueryCount(messagesRef);
  logger.info(
    `[Auto-Delete] Cleanup check for chatTail=${logIdTailForLog(chatId)}: ` +
      `count=${currentMessageCount}, highWater=${CHAT_MESSAGE_CLEANUP_HIGH_WATER}, ` +
      `target=${CHAT_MESSAGE_TARGET}.`
  );

  const messagesToDeleteCount = computeMessagesToDeleteCount(currentMessageCount);
  if (messagesToDeleteCount <= 0) {
    logger.info(
      `[Auto-Delete] No delete needed for chatTail=${logIdTailForLog(chatId)} ` +
        `(count=${currentMessageCount}).`
    );
    return {
      success: true,
      skipped: false,
      deleted: 0,
      count: currentMessageCount,
      countQueryExecuted: true,
    };
  }

  logger.info(
    `[Auto-Delete] Deleting ${messagesToDeleteCount} oldest message(s) ` +
      `from chatTail=${logIdTailForLog(chatId)}.`
  );

  const deleted = await deleteOldestMessagesInBatches(
    db,
    messagesRef,
    messagesToDeleteCount
  );

  logger.info(
    `[Auto-Delete] Deleted ${deleted} old message(s) from chatTail=${logIdTailForLog(chatId)}.`
  );

  return {
    success: true,
    skipped: false,
    deleted,
    count: currentMessageCount,
    countQueryExecuted: true,
  };
}

module.exports = {
  runChatMessageCleanup,
  deleteOldestMessagesInBatches,
  claimMessageCleanupSlot,
  getQueryCount,
};
