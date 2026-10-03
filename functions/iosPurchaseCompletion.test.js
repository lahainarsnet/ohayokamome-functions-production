const assert = require("node:assert/strict");
const test = require("node:test");
const { HttpsError } = require("firebase-functions/v2/https");
const {
  readCompletion,
  completionWrite,
  createCompletionHandler,
} = require("./iosPurchaseCompletion");

const PRODUCT = "ohayo_kamome_monthly";
const TRANSACTION = "2000001234567890";
const OWNER_UID = "uid-owner";

function createDb() {
  const documents = new Map();
  const ref = path => ({
    path,
    collection(name) {
      return collection(`${path}/${name}`);
    },
    async get() {
      const value = documents.get(path);
      return snapshot(value);
    },
  });
  const snapshot = value => ({
    exists: value !== undefined,
    data: () => value,
    get: field => value?.[field],
  });
  const collection = path => ({
    doc(id) {
      return ref(path ? `${path}/${id}` : id);
    },
  });
  const db = {
    collection,
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        async get(documentRef) {
          return snapshot(documents.get(documentRef.path));
        },
        set(documentRef, data, options) {
          writes.push({ documentRef, data, options });
        },
      };
      const result = await callback(tx);
      for (const write of writes) {
        const prior = documents.get(write.documentRef.path) || {};
        documents.set(write.documentRef.path, write.options?.merge
          ? { ...prior, ...write.data }
          : write.data);
      }
      return result;
    },
    seed(path, data) {
      documents.set(path, data);
    },
    read(path) {
      return documents.get(path);
    },
  };
  return db;
}

const adminFor = db => ({
  getDb: () => db,
  FieldValue: {
    serverTimestamp: () => "SERVER_TIME",
    delete: () => "__DELETE__",
  },
});

const eventData = {
  productId: PRODUCT,
  transactionId: TRANSACTION,
};

function ownedRecord(db, admin, uid = OWNER_UID, state = "pending") {
  const write = completionWrite(db, admin, uid, {
    productId: PRODUCT,
    transactionId: TRANSACTION,
    originalTransactionId: "2000001234567890",
  }, "active");
  db.seed("subscription_ownership/ios_2000001234567890", { ownerUid: uid });
  db.seed(write.ref.path, { ...write.data, completionState: state });
  return write;
}

test("record stores a hashed transaction proof without receipt or token", () => {
  const db = createDb();
  const admin = adminFor(db);
  const write = completionWrite(db, admin, OWNER_UID, {
    productId: PRODUCT,
    transactionId: TRANSACTION,
    originalTransactionId: "2000001234567890",
    receipt: "must-not-be-stored",
    purchaseToken: "must-not-be-stored",
  }, "active");

  assert.match(write.ref.path, /^subscription_ownership\/ios_completion\/transactions\/[a-f0-9]{64}$/);
  assert.equal(write.data.verified, true);
  assert.equal(write.data.ownerUid, OWNER_UID);
  assert.equal(write.data.completionState, "pending");
  assert.equal(write.data.receipt, undefined);
  assert.equal(write.data.purchaseToken, undefined);
});

test("same owner reads pending record and marks it completed idempotently", async () => {
  const db = createDb();
  const admin = adminFor(db);
  const write = ownedRecord(db, admin);
  const read = createCompletionHandler(admin, "read");
  const mark = createCompletionHandler(admin, "complete");

  const pending = await read({ auth: { uid: OWNER_UID }, data: eventData });
  assert.equal(pending.state, "verified");
  assert.equal(pending.verified, true);
  assert.equal(pending.completed, false);

  const completed = await mark({ auth: { uid: OWNER_UID }, data: eventData });
  assert.equal(completed.completed, true);
  assert.equal(db.read(write.ref.path).completionState, "completed");

  const repeated = await mark({ auth: { uid: OWNER_UID }, data: eventData });
  assert.equal(repeated.completed, true);
  assert.equal(db.read(write.ref.path).completionState, "completed");
});

test("foreign UID cannot read or mark another owner's completion record", async () => {
  const db = createDb();
  const admin = adminFor(db);
  ownedRecord(db, admin);
  const read = createCompletionHandler(admin, "read");
  const mark = createCompletionHandler(admin, "complete");

  for (const handler of [read, mark]) {
    await assert.rejects(
      handler({ auth: { uid: "uid-other" }, data: eventData }),
      error => error instanceof HttpsError &&
        error.details?.code === "SUBSCRIPTION_ALREADY_LINKED",
    );
  }
});

test("series ownership mismatch blocks completion recovery even when the transaction record UID matches", async () => {
  const db = createDb();
  const admin = adminFor(db);
  const write = ownedRecord(db, admin);
  db.seed("subscription_ownership/ios_2000001234567890", { ownerUid: "uid-other" });
  const read = createCompletionHandler(admin, "read");
  await assert.rejects(
    read({ auth: { uid: OWNER_UID }, data: eventData }),
    error => error instanceof HttpsError &&
      error.details?.code === "SUBSCRIPTION_ALREADY_LINKED",
  );
  assert.equal(db.read(write.ref.path).ownerUid, OWNER_UID);
});

test("missing server record is reported absent for the exact transaction only", async () => {
  const db = createDb();
  const result = await readCompletion(db, OWNER_UID, eventData);
  assert.equal(result.state, "absent");
  assert.equal(result.transactionHash.length, 64);
  assert.equal(db.read("subscription_ownership/ios_completion/transactions"), undefined);
});

test("completed replay reads as completed and requires no second completion", async () => {
  const db = createDb();
  const admin = adminFor(db);
  const write = ownedRecord(db, admin, OWNER_UID, "completed");
  const read = createCompletionHandler(admin, "read");

  const replay = await read({ auth: { uid: OWNER_UID }, data: eventData });
  assert.equal(replay.state, "verified");
  assert.equal(replay.completed, true);
  assert.equal(db.read(write.ref.path).completionState, "completed");
});

test("invalid product or transaction identifiers are rejected", async () => {
  const db = createDb();
  await assert.rejects(
    readCompletion(db, OWNER_UID, { productId: "other", transactionId: TRANSACTION }),
    error => error instanceof HttpsError && error.code === "invalid-argument",
  );
  await assert.rejects(
    readCompletion(db, OWNER_UID, { productId: PRODUCT, transactionId: "short" }),
    error => error instanceof HttpsError && error.code === "invalid-argument",
  );
});
