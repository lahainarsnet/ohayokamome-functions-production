"use strict";

const assert = require("node:assert/strict");
const {
  ACCOUNT_ID_GENERATION_MAX_ATTEMPTS,
  generateUniqueAccountId,
  readExistingAccountId,
  resolveAccountIdForUpsert,
  resolveGetUserInfoByAccountIdLookup,
} = require("./accountIdGuard");

function mockSnap(exists, data) {
  return {
    exists,
    get(field) {
      return data[field];
    },
  };
}

async function runTests() {
  assert.equal(readExistingAccountId(mockSnap(true, { accountId: " abc " })), "abc");
  assert.equal(readExistingAccountId(mockSnap(true, { accountId: "" })), "");
  assert.equal(readExistingAccountId(mockSnap(false, {})), "");

  const kept = await resolveAccountIdForUpsert({
    db: {},
    excludeUid: "uid-a",
    userSnap: mockSnap(true, { accountId: "existing-id" }),
    randomUUID: () => "should-not-be-used",
    isTaken: async () => {
      throw new Error("should not check uniqueness for existing accountId");
    },
  });
  assert.deepEqual(kept, {
    accountId: "existing-id",
    source: "existing",
    attempts: 0,
  });

  let generatedCount = 0;
  const generated = await resolveAccountIdForUpsert({
    db: {},
    excludeUid: "uid-a",
    userSnap: mockSnap(false, {}),
    randomUUID: () => {
      generatedCount += 1;
      return `uuid-${generatedCount}`;
    },
    isTaken: async (_db, accountId) => accountId === "uuid-1",
  });
  assert.equal(generated.source, "generated");
  assert.equal(generated.accountId, "uuid-2");
  assert.equal(generated.attempts, 2);

  const exhausted = await generateUniqueAccountId({
    db: {},
    excludeUid: "uid-a",
    randomUUID: () => "dup-id",
    maxAttempts: 3,
    isTaken: async () => true,
  });
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.accountId, null);
  assert.equal(exhausted.attempts, 3);

  assert.equal(ACCOUNT_ID_GENERATION_MAX_ATTEMPTS, 8);

  assert.deepEqual(resolveGetUserInfoByAccountIdLookup([]), { status: "not_found" });
  assert.deepEqual(resolveGetUserInfoByAccountIdLookup([{ id: "uid-1" }]), {
    status: "found",
    uid: "uid-1",
  });
  assert.deepEqual(
    resolveGetUserInfoByAccountIdLookup([{ id: "uid-1" }, { id: "uid-2" }]),
    { status: "duplicate", matchCount: 2 },
  );

  console.log("accountIdGuard.test.js: all tests passed");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
