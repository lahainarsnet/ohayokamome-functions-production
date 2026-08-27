const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
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
} = require("./deleteOldMessagesLib");
const {
  runChatMessageCleanup,
  deleteOldestMessagesInBatches,
  claimMessageCleanupSlot,
} = require("./deleteOldMessagesHandler");

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const ONE_HOUR = 60 * 60 * 1000;

assert.equal(CHAT_MESSAGE_LIMIT, 200);
assert.equal(CHAT_MESSAGE_TARGET, 200);
assert.equal(CHAT_MESSAGE_CLEANUP_HIGH_WATER, 250);

for (const count of [199, 200, 249, 250]) {
  assert.equal(
    computeMessagesToDeleteCount(count),
    0,
    `count ${count} should not trigger delete`
  );
}
assert.equal(computeMessagesToDeleteCount(251), 51);
assert.equal(computeMessagesToDeleteCount(300), 100);
assert.equal(computeMessagesToDeleteCount(400), 200);

assert.equal(parseLastMessageCleanupAt(null), null);
assert.equal(parseLastMessageCleanupAt(undefined), null);
assert.equal(
  parseLastMessageCleanupAt(new Date(NOW - CLEANUP_INTERVAL_MS)),
  NOW - CLEANUP_INTERVAL_MS
);
assert.equal(parseLastMessageCleanupAt(NOW - 1000), NOW - 1000);
assert.equal(
  parseLastMessageCleanupAt({ toDate: () => new Date(NOW) }),
  NOW
);
assert.equal(
  parseLastMessageCleanupAt({ _seconds: Math.floor(NOW / 1000) }),
  Math.floor(NOW / 1000) * 1000
);

assert.equal(isMessageCleanupDue(null, NOW), true, "unset is first run");
assert.equal(
  isMessageCleanupDue(NOW - CLEANUP_INTERVAL_MS + ONE_HOUR, NOW),
  false,
  "within 24h"
);
assert.equal(
  isMessageCleanupDue(NOW - CLEANUP_INTERVAL_MS, NOW),
  true,
  "exactly 24h"
);
assert.equal(
  isMessageCleanupDue(NOW - CLEANUP_INTERVAL_MS - 1, NOW),
  true,
  "over 24h"
);

assert.equal(computeBatchDeleteSize(100), 100);
assert.equal(computeBatchDeleteSize(500), 500);
assert.equal(computeBatchDeleteSize(501), 500);
assert.equal(computeBatchDeleteSize(600), 500);
assert.equal(computeBatchDeleteSize(0), 0);

function makeTimestamp(ms) {
  return { toDate: () => new Date(ms) };
}

function createInMemoryCleanupEnv({
  chatId = "chat-1",
  lastCleanupAtMs = null,
  messageCount = 0,
  messages = [],
  nowMs = NOW,
} = {}) {
  const chatData = {};
  if (lastCleanupAtMs != null) {
    chatData[LAST_MESSAGE_CLEANUP_AT_FIELD] = makeTimestamp(lastCleanupAtMs);
  }

  let countQueryCalls = 0;
  let deleteCommits = 0;
  const deletedIds = [];

  const messagesRef = {
    count() {
      countQueryCalls += 1;
      return {
        get: async () => ({ data: () => ({ count: messageCount }) }),
      };
    },
    orderBy(field, direction) {
      assert.equal(field, "timestamp");
      assert.equal(direction, "asc");
      return {
        limit(limit) {
          return {
            async get() {
              const slice = messages.slice(0, limit);
              return {
                empty: slice.length === 0,
                size: slice.length,
                forEach(fn) {
                  slice.forEach((doc) => fn(doc));
                },
              };
            },
          };
        },
      };
    },
  };

  const chatRef = {
    async get() {
      return {
        get(field) {
          return chatData[field];
        },
      };
    },
  };

  let txChain = Promise.resolve();

  const db = {
    collection(name) {
      assert.equal(name, "chats");
      return {
        doc(id) {
          assert.equal(id, chatId);
          return {
            ...chatRef,
            collection(sub) {
              assert.equal(sub, "messages");
              return messagesRef;
            },
            async get() {
              return chatRef.get();
            },
          };
        },
      };
    },
    batch() {
      const ops = [];
      return {
        delete(ref) {
          ops.push(ref);
        },
        async commit() {
          deleteCommits += 1;
          for (const ref of ops) {
            deletedIds.push(ref.id);
          }
        },
      };
    },
    async runTransaction(fn) {
      const run = async () => {
        const tx = {
          async get(ref) {
            return ref.get();
          },
          set(ref, data, options) {
            if (options?.merge && data[LAST_MESSAGE_CLEANUP_AT_FIELD] != null) {
              chatData[LAST_MESSAGE_CLEANUP_AT_FIELD] = makeTimestamp(nowMs);
            }
          },
        };
        return fn(tx);
      };
      const result = txChain.then(run);
      txChain = result.catch(() => {});
      return result;
    },
  };

  return {
    db,
    get countQueryCalls() {
      return countQueryCalls;
    },
    get deleteCommits() {
      return deleteCommits;
    },
    get deletedIds() {
      return deletedIds;
    },
    get lastCleanupAtMs() {
      return parseLastMessageCleanupAt(chatData[LAST_MESSAGE_CLEANUP_AT_FIELD]);
    },
  };
}

async function withMockDb(env, fn) {
  const admin = require("./firebaseAdmin");
  const originalGetDb = admin.getDb;
  admin.getDb = () => env.db;
  try {
    return await fn();
  } finally {
    admin.getDb = originalGetDb;
  }
}

(async () => {
  {
    const env = createInMemoryCleanupEnv({
      lastCleanupAtMs: NOW - ONE_HOUR,
      messageCount: 999,
    });
    const result = await withMockDb(env, () =>
      runChatMessageCleanup({ chatId: "chat-1", nowMs: NOW })
    );
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "not_due");
    assert.equal(result.countQueryExecuted, false);
    assert.equal(env.countQueryCalls, 0);
    assert.equal(env.deletedIds.length, 0);
  }

  for (const count of [199, 200, 249, 250]) {
    const env = createInMemoryCleanupEnv({
      lastCleanupAtMs: null,
      messageCount: count,
    });
    const result = await withMockDb(env, () =>
      runChatMessageCleanup({ chatId: "chat-1", nowMs: NOW })
    );
    assert.equal(result.deleted, 0, `count ${count}`);
    assert.equal(result.countQueryExecuted, true);
    assert.equal(env.deletedIds.length, 0, `count ${count}`);
    assert.equal(env.lastCleanupAtMs, NOW, `count ${count} updates cleanup time`);
  }

  {
    const messages = Array.from({ length: 251 }, (_, i) => ({
      id: `msg-${i}`,
      ref: { id: `msg-${i}` },
    }));
    const env = createInMemoryCleanupEnv({
      lastCleanupAtMs: NOW - CLEANUP_INTERVAL_MS - 1,
      messageCount: 251,
      messages,
    });
    const result = await withMockDb(env, () =>
      runChatMessageCleanup({ chatId: "chat-1", nowMs: NOW })
    );
    assert.equal(result.deleted, 51);
    assert.equal(env.deletedIds.length, 51);
    assert.deepEqual(env.deletedIds, messages.slice(0, 51).map((m) => m.id));
  }

  {
    const messages = Array.from({ length: 300 }, (_, i) => ({
      id: `old-${i}`,
      ref: { id: `old-${i}` },
    }));
    const env = createInMemoryCleanupEnv({
      messageCount: 300,
      messages,
    });
    const result = await withMockDb(env, () =>
      runChatMessageCleanup({ chatId: "chat-1", nowMs: NOW })
    );
    assert.equal(result.deleted, 100);
    assert.equal(env.deletedIds.length, 100);
  }

  {
    const messages = Array.from({ length: 400 }, (_, i) => ({
      id: `m-${i}`,
      ref: { id: `m-${i}` },
    }));
    const env = createInMemoryCleanupEnv({
      messageCount: 400,
      messages,
    });
    const result = await withMockDb(env, () =>
      runChatMessageCleanup({ chatId: "chat-1", nowMs: NOW })
    );
    assert.equal(result.deleted, 200);
    assert.equal(env.deletedIds.length, 200);
  }

  {
    const env = createInMemoryCleanupEnv({
      lastCleanupAtMs: null,
      messageCount: 300,
    });
    const [first, second] = await withMockDb(env, () =>
      Promise.all([
        runChatMessageCleanup({ chatId: "chat-1", nowMs: NOW }),
        runChatMessageCleanup({ chatId: "chat-1", nowMs: NOW }),
      ])
    );
    const claimed = [first, second].filter((r) => r.reason !== "claim_lost" && !r.skipped);
    const lost = [first, second].filter((r) => r.reason === "claim_lost");
    assert.equal(claimed.length, 1, "only one cleanup should run");
    assert.equal(lost.length, 1, "second should lose claim");
    assert.equal(env.countQueryCalls, 1, "count query once");
  }

  {
    let remaining = 600;
    const allMessages = Array.from({ length: 600 }, (_, i) => ({
      id: `wide-${i}`,
      ref: { id: `wide-${i}` },
    }));
    const messagesRef = {
      orderBy(field, direction) {
        return {
          limit(limit) {
            return {
              async get() {
                const slice = allMessages.splice(0, Math.min(limit, remaining));
                remaining -= slice.length;
                return {
                  empty: slice.length === 0,
                  size: slice.length,
                  forEach(fn) {
                    slice.forEach((doc) => fn(doc));
                  },
                };
              },
            };
          },
        };
      },
    };
    let commits = 0;
    const deletedIds = [];
    const db = {
      batch() {
        const ops = [];
        return {
          delete(ref) {
            ops.push(ref);
          },
          async commit() {
            commits += 1;
            deletedIds.push(...ops.map((ref) => ref.id));
          },
        };
      },
    };
    const deleted = await deleteOldestMessagesInBatches(db, messagesRef, 600);
    assert.equal(deleted, 600);
    assert.equal(commits, 2, "600 deletes split into 500 + 100 batches");
    assert.equal(deletedIds.length, 600);
    assert.equal(deletedIds[0], "wide-0", "oldest first");
    assert.equal(deletedIds[599], "wide-599");
  }

  {
    const env = createInMemoryCleanupEnv({ lastCleanupAtMs: null, messageCount: 100 });
    await withMockDb(env, () =>
      claimMessageCleanupSlot(
        env.db.collection("chats").doc("chat-1"),
        NOW
      )
    );
    assert.equal(env.lastCleanupAtMs, NOW);
  }

  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const deleteOldMessagesBlock = indexSource.match(
    /exports\.deleteOldMessages[\s\S]*?\n\);/
  );
  assert.ok(deleteOldMessagesBlock, "deleteOldMessages export block not found");
  const block = deleteOldMessagesBlock[0];
  assert.ok(
    block.includes("runChatMessageCleanup"),
    "deleteOldMessages must delegate to runChatMessageCleanup"
  );
  assert.ok(
    !block.includes("getQueryCount(messagesRef)"),
    "deleteOldMessages must not call getQueryCount directly"
  );
  assert.ok(
    !block.includes('orderBy("timestamp", "asc")'),
    "deleteOldMessages must not embed delete query"
  );

  const pushBlockStart = indexSource.indexOf("exports.sendPushNotification");
  const deleteStart = indexSource.indexOf("exports.deleteOldMessages");
  assert.ok(pushBlockStart >= 0 && deleteStart > pushBlockStart, "sendPushNotification must remain");

  const sendStart = indexSource.indexOf("exports.sendMessageWithLimit");
  assert.ok(sendStart >= 0, "sendMessageWithLimit must remain unchanged region");

  console.log("deleteOldMessages.test.js: ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
