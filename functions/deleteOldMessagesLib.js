/** Firestore 上で保持するチャットメッセージ数の上限（Flutter 表示上限と一致）。 */
const CHAT_MESSAGE_LIMIT = 200;

/**
 * 超過分の削除件数を返す。上限以下なら 0。
 * @param {number} currentMessageCount
 * @param {number} [messageLimit]
 * @returns {number}
 */
function computeMessagesToDeleteCount(
  currentMessageCount,
  messageLimit = CHAT_MESSAGE_LIMIT
) {
  if (currentMessageCount <= messageLimit) {
    return 0;
  }
  return currentMessageCount - messageLimit;
}

module.exports = {
  CHAT_MESSAGE_LIMIT,
  computeMessagesToDeleteCount,
};
