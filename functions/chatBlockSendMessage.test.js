const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const transcribeSource = fs.readFileSync(
  path.join(__dirname, "transcribeExperiment.js"),
  "utf8",
);

function exportBlock(source, exportName) {
  const start = source.indexOf(`exports.${exportName}`);
  assert.ok(start >= 0, `${exportName} export must exist`);
  const nextExport = source.indexOf("\nexports.", start + 1);
  const end = nextExport >= 0 ? nextExport : source.length;
  return source.slice(start, end);
}

const sendBlock = exportBlock(indexSource, "sendMessageWithLimit");
assert.ok(
  sendBlock.includes("CHAT_BLOCKED_SENDER_CODE"),
  "sendMessageWithLimit must block sender via CHAT_BLOCKED_SENDER_CODE",
);
assert.ok(
  sendBlock.includes("CHAT_BLOCKED_RECIPIENT_CODE"),
  "sendMessageWithLimit must block recipient via CHAT_BLOCKED_RECIPIENT_CODE",
);
assert.ok(
  sendBlock.includes("senderChatBlockedInTx"),
  "sendMessageWithLimit must re-check sender chatBlocked in transaction",
);
assert.ok(
  sendBlock.includes("recipientChatBlockedInTx"),
  "sendMessageWithLimit must re-check recipient chatBlocked in transaction",
);
assert.ok(
  !sendBlock.includes("readPreChatBillingConfirmation"),
  "sendMessageWithLimit must not touch PRE-CHAT",
);

assert.ok(
  transcribeSource.includes("assertUidChatNotBlocked"),
  "transcribeExperiment must check chatBlocked via assertUidChatNotBlocked",
);

console.log("chatBlockSendMessage.test.js: ok");
