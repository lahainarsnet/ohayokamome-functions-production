/** Flutter 表示上限（整理後の目標件数）。 */
const CHAT_MESSAGE_TARGET = 200;

/** 互換のため残す。 */
const CHAT_MESSAGE_LIMIT = CHAT_MESSAGE_TARGET;

/** この件数以下なら削除しない（250件までは放置）。 */
const CHAT_MESSAGE_CLEANUP_HIGH_WATER = 250;

/** chat doc に保存する整理判定時刻フィールド名。 */
const LAST_MESSAGE_CLEANUP_AT_FIELD = "lastMessageCleanupAt";

/** 前回整理判定から次回までの最短間隔（約24時間）。 */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Firestore batch の 1 回あたり上限。 */
const FIRESTORE_BATCH_DELETE_LIMIT = 500;

/**
 * 整理対象件数を返す。250件以下なら 0、251件以上なら count - 200。
 * @param {number} currentMessageCount
 * @param {{ highWater?: number, target?: number }} [options]
 * @returns {number}
 */
function computeMessagesToDeleteCount(
  currentMessageCount,
  options = {}
) {
  const highWater = options.highWater ?? CHAT_MESSAGE_CLEANUP_HIGH_WATER;
  const target = options.target ?? CHAT_MESSAGE_TARGET;
  if (currentMessageCount <= highWater) {
    return 0;
  }
  return currentMessageCount - target;
}

/**
 * Firestore Timestamp / Date / millis を epoch ms に正規化する。
 * @param {unknown} value
 * @returns {number|null}
 */
function parseLastMessageCleanupAt(value) {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "object" && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date ? date.getTime() : null;
  }
  if (
    typeof value === "object" &&
    typeof value._seconds === "number"
  ) {
    return value._seconds * 1000;
  }
  return null;
}

/**
 * 整理判定を実行してよいか（未設定は初回として true）。
 * @param {number|null|undefined} lastCleanupAtMs
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function isMessageCleanupDue(lastCleanupAtMs, nowMs = Date.now()) {
  if (lastCleanupAtMs == null) {
    return true;
  }
  return nowMs - lastCleanupAtMs >= CLEANUP_INTERVAL_MS;
}

/**
 * 1 batch で削除する件数（500 上限）。
 * @param {number} remaining
 * @returns {number}
 */
function computeBatchDeleteSize(remaining) {
  if (remaining <= 0) {
    return 0;
  }
  return Math.min(remaining, FIRESTORE_BATCH_DELETE_LIMIT);
}

module.exports = {
  CHAT_MESSAGE_LIMIT,
  CHAT_MESSAGE_TARGET,
  CHAT_MESSAGE_CLEANUP_HIGH_WATER,
  LAST_MESSAGE_CLEANUP_AT_FIELD,
  CLEANUP_INTERVAL_MS,
  FIRESTORE_BATCH_DELETE_LIMIT,
  computeMessagesToDeleteCount,
  parseLastMessageCleanupAt,
  isMessageCleanupDue,
  computeBatchDeleteSize,
};
