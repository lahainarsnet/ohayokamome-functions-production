const assert = require("node:assert/strict");
const {
  CHAT_BLOCKED_CODE,
  CHAT_BLOCKED_SENDER_CODE,
  CHAT_BLOCKED_RECIPIENT_CODE,
  logChatBlockTrace,
  isUserChatBlocked,
  readUserChatBlocked,
  assertUidChatNotBlocked,
} = require("./chatBlockGuard");

assert.equal(CHAT_BLOCKED_CODE, "CHAT_BLOCKED");
assert.equal(CHAT_BLOCKED_SENDER_CODE, "CHAT_BLOCKED_SENDER");
assert.equal(CHAT_BLOCKED_RECIPIENT_CODE, "CHAT_BLOCKED_RECIPIENT");

assert.strictEqual(isUserChatBlocked(null), false);
assert.strictEqual(isUserChatBlocked(undefined), false);
assert.strictEqual(isUserChatBlocked({}), false);
assert.strictEqual(isUserChatBlocked({ chatBlocked: false }), false);
assert.strictEqual(isUserChatBlocked({ chatBlocked: "true" }), false);
assert.strictEqual(isUserChatBlocked({ chatBlocked: true }), true);

function createMockDb(userDocs) {
  return {
    collection: (name) => ({
      doc: (id) => ({
        get: async () => {
          if (name !== "users") {
            throw new Error(`unexpected collection ${name}`);
          }
          const data = userDocs[id];
          if (data === undefined) {
            return { exists: false, data: () => undefined };
          }
          return {
            exists: true,
            data: () => data,
          };
        },
      }),
    }),
  };
}

async function runAsyncTests() {
  const missing = await readUserChatBlocked(createMockDb({}), "uidA");
  assert.strictEqual(missing.blocked, false);
  assert.strictEqual(missing.exists, false);

  const blocked = await readUserChatBlocked(
    createMockDb({ uidB: { chatBlocked: true } }),
    "uidB",
  );
  assert.strictEqual(blocked.blocked, true);

  const allowed = await assertUidChatNotBlocked(
    createMockDb({ uidC: { chatBlocked: false } }),
    "uidC",
    "stt",
  );
  assert.strictEqual(allowed.ok, true);

  const denied = await assertUidChatNotBlocked(
    createMockDb({ uidD: { chatBlocked: true } }),
    "uidD",
    "stt",
  );
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, CHAT_BLOCKED_CODE);
}

runAsyncTests().then(() => {
  console.log("chatBlockGuard.test.js: ok");
});

const logger = require("firebase-functions/logger");
const originalInfo = logger.info;
const capturedLogs = [];
logger.info = (...args) => capturedLogs.push(args);
logChatBlockTrace({ uidSuffix: "sensitive-user-123456", operation: "stt", outcome: "allowed" });
logger.info = originalInfo;
assert.equal(capturedLogs[0][1].uidSuffix, "123456");
assert.equal(JSON.stringify(capturedLogs).includes("sensitive-user"), false);
