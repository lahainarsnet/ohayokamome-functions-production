const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CHAT_MESSAGE_LIMIT,
  computeMessagesToDeleteCount,
} = require("./deleteOldMessagesLib");

assert.equal(CHAT_MESSAGE_LIMIT, 200);
assert.equal(computeMessagesToDeleteCount(200), 0);
assert.equal(computeMessagesToDeleteCount(201), 1);
assert.equal(computeMessagesToDeleteCount(205), 5);
assert.equal(computeMessagesToDeleteCount(199), 0);

const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const deleteOldMessagesBlock = indexSource.match(
  /exports\.deleteOldMessages[\s\S]*?\n\);/
);
assert.ok(deleteOldMessagesBlock, "deleteOldMessages export block not found");
const block = deleteOldMessagesBlock[0];
assert.ok(
  !block.includes("messagesRef.get()"),
  "deleteOldMessages must not use messagesRef.get()"
);
assert.ok(
  block.includes("getQueryCount(messagesRef)"),
  "deleteOldMessages must use getQueryCount(messagesRef)"
);
assert.ok(
  block.includes('orderBy("timestamp", "asc")'),
  "deleteOldMessages delete query must orderBy timestamp asc"
);
assert.ok(
  block.includes("computeMessagesToDeleteCount"),
  "deleteOldMessages must use computeMessagesToDeleteCount"
);

console.log("deleteOldMessages.test.js: ok");
