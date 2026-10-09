const logger = require("firebase-functions/logger");

const CHAT_BLOCKED_CODE = "CHAT_BLOCKED";
const CHAT_BLOCKED_SENDER_CODE = "CHAT_BLOCKED_SENDER";
const CHAT_BLOCKED_RECIPIENT_CODE = "CHAT_BLOCKED_RECIPIENT";

function isUserChatBlocked(userData) {
  if (!userData || typeof userData !== "object") {
    return false;
  }
  return userData.chatBlocked === true;
}

function logChatBlockTrace({ uidSuffix, operation, outcome, reason }) {
  logger.info("KAMOME_CHAT_BLOCK_TRACE", {
    uidSuffix: uidSuffix ? String(uidSuffix).slice(-6) : "empty",
    operation: operation || "unknown",
    outcome: outcome || "unknown",
    reason: reason || "chat_blocked",
  });
}

async function readUserChatBlocked(db, uid) {
  if (!uid) {
    return { blocked: false, exists: false };
  }
  const snap = await db.collection("users").doc(uid).get();
  const data = snap.exists ? snap.data() || {} : null;
  return {
    blocked: isUserChatBlocked(data),
    exists: snap.exists,
  };
}

async function assertUidChatNotBlocked(db, uid, operation) {
  const state = await readUserChatBlocked(db, uid);
  if (state.blocked) {
    logChatBlockTrace({
      uidSuffix: uid,
      operation,
      outcome: "blocked",
      reason: "chat_blocked",
    });
    return { ok: false, code: CHAT_BLOCKED_CODE, blocked: true };
  }
  logChatBlockTrace({
    uidSuffix: uid,
    operation,
    outcome: "allowed",
    reason: "chat_not_blocked",
  });
  return { ok: true, code: null, blocked: false };
}

module.exports = {
  CHAT_BLOCKED_CODE,
  CHAT_BLOCKED_SENDER_CODE,
  CHAT_BLOCKED_RECIPIENT_CODE,
  isUserChatBlocked,
  logChatBlockTrace,
  readUserChatBlocked,
  assertUidChatNotBlocked,
};
