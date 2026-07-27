"use strict";

const ACCOUNT_ID_GENERATION_MAX_ATTEMPTS = 8;

async function isAccountIdTakenByOtherUser(db, accountId, excludeUid) {
  const normalized = String(accountId || "").trim();
  if (!normalized) {
    return false;
  }
  const snap = await db
    .collection("users")
    .where("accountId", "==", normalized)
    .limit(1)
    .get();
  if (snap.empty) {
    return false;
  }
  return snap.docs[0].id !== excludeUid;
}

async function generateUniqueAccountId({
  db,
  excludeUid,
  randomUUID,
  maxAttempts = ACCOUNT_ID_GENERATION_MAX_ATTEMPTS,
  isTaken = isAccountIdTakenByOtherUser,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = randomUUID();
    const taken = await isTaken(db, candidate, excludeUid);
    if (!taken) {
      return { accountId: candidate, attempts: attempt };
    }
  }
  return { accountId: null, attempts: maxAttempts, exhausted: true };
}

function readExistingAccountId(userSnap) {
  if (!userSnap || !userSnap.exists) {
    return "";
  }
  const value = userSnap.get("accountId");
  return typeof value === "string" ? value.trim() : "";
}

async function resolveAccountIdForUpsert({
  db,
  excludeUid,
  userSnap,
  randomUUID,
  maxAttempts = ACCOUNT_ID_GENERATION_MAX_ATTEMPTS,
  isTaken = isAccountIdTakenByOtherUser,
}) {
  const existing = readExistingAccountId(userSnap);
  if (existing) {
    return { accountId: existing, source: "existing", attempts: 0 };
  }

  const generated = await generateUniqueAccountId({
    db,
    excludeUid,
    randomUUID,
    maxAttempts,
    isTaken,
  });
  if (generated.exhausted || !generated.accountId) {
    return { accountId: null, source: "generation_failed", attempts: generated.attempts };
  }
  return {
    accountId: generated.accountId,
    source: "generated",
    attempts: generated.attempts,
  };
}

function resolveGetUserInfoByAccountIdLookup(docs) {
  const matches = Array.isArray(docs) ? docs : [];
  if (matches.length === 0) {
    return { status: "not_found" };
  }
  if (matches.length === 1) {
    const uid = matches[0].id;
    return { status: "found", uid };
  }
  return { status: "duplicate", matchCount: matches.length };
}

module.exports = {
  ACCOUNT_ID_GENERATION_MAX_ATTEMPTS,
  isAccountIdTakenByOtherUser,
  generateUniqueAccountId,
  readExistingAccountId,
  resolveAccountIdForUpsert,
  resolveGetUserInfoByAccountIdLookup,
};
