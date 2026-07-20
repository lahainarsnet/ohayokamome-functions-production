const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const functionsDir = path.resolve(__dirname, "../functions");
const { FieldValue, Timestamp } = (() => {
  const resolved = require.resolve("firebase-admin/firestore", {
    paths: [path.join(functionsDir, "node_modules")],
  });
  return require(resolved);
})();
const {
  TOS_VERSIONS_COLLECTION,
  computeTosSha256,
  parseCalendarDateJst,
  parseConsentKey,
  buildTosVersionDocument,
  archiveTosVersion,
  parseCliArgs,
  resolveMessageFromArgs,
} = require("./archiveTosVersionLib");

const sampleMessage = "おはようカモメ 利用規約\n第1条\n";

const expectedHash = computeTosSha256(sampleMessage);
assert.equal(
  expectedHash,
  "68d65c52e8b4fde91e50c84570899506b28e7d3a822040a09f9bda69e2e521fa",
);
assert.match(expectedHash, /^[0-9a-f]{64}$/);

const issuedAtDate = parseCalendarDateJst("2026-07-20", "issuedAt");
assert.equal(issuedAtDate.toISOString(), "2026-07-19T15:00:00.000Z");

const { docId, data } = buildTosVersionDocument({
  message: sampleMessage,
  consentKey: "tos_2026_06_20_v2",
  versionNumber: "3",
  issuedAt: "2026-07-20",
  effectiveAt: "2026-07-21",
  requireReaccept: "true",
  archivedBy: "ops@example.com",
  FieldValue,
  Timestamp,
});

assert.equal(docId, expectedHash);
assert.equal(data.sha256_hash, expectedHash);
assert.equal(data.consentKey, "tos_2026_06_20_v2");
assert.equal(data.versionNumber, 3);
assert.equal(data.requireReaccept, true);
assert.equal(data.archivedBy, "ops@example.com");
assert.equal(data.message, sampleMessage);
assert.ok(data.issuedAt instanceof Timestamp);
assert.ok(data.effectiveAt instanceof Timestamp);
assert.equal(data.issuedAt.toDate().toISOString(), "2026-07-19T15:00:00.000Z");
assert.equal(data.effectiveAt.toDate().toISOString(), "2026-07-20T15:00:00.000Z");
assert.deepEqual(data.archivedAt, FieldValue.serverTimestamp());

assert.throws(() => parseCalendarDateJst("2026-13-01", "issuedAt"));
assert.throws(() => buildTosVersionDocument({
  message: "",
  consentKey: "tos_v1",
  versionNumber: 1,
  issuedAt: "2026-07-20",
  effectiveAt: "2026-07-21",
  requireReaccept: false,
  archivedBy: "ops@example.com",
  FieldValue,
  Timestamp,
}));
assert.throws(() => parseConsentKey(""));
assert.throws(() => parseConsentKey("   "));
assert.throws(() => buildTosVersionDocument({
  message: sampleMessage,
  consentKey: "",
  versionNumber: 1,
  issuedAt: "2026-07-20",
  effectiveAt: "2026-07-21",
  requireReaccept: false,
  archivedBy: "ops@example.com",
  FieldValue,
  Timestamp,
}));

const cli = parseCliArgs([
  "--message-file",
  "sample.txt",
  "--version-number",
  "2",
  "--issued-at",
  "2026-01-01",
  "--effective-at",
  "2026-01-02",
  "--require-reaccept",
  "false",
  "--archived-by",
  "admin",
  "--consent-key",
  "tos_2026_06_20_v2",
  "--dry-run",
]);
assert.equal(cli.messageFile, "sample.txt");
assert.equal(cli.consentKey, "tos_2026_06_20_v2");
assert.equal(cli.dryRun, true);

assert.equal(resolveMessageFromArgs({ message: sampleMessage }), sampleMessage);
assert.throws(() => resolveMessageFromArgs({}));

class FakeDocRef {
  constructor(id) {
    this.id = id;
    this.created = false;
  }

  async create(data) {
    if (this.created) {
      const error = new Error("already exists");
      error.code = 6;
      throw error;
    }
    this.created = true;
    this.data = data;
  }
}

class FakeDb {
  constructor() {
    this.docs = new Map();
  }

  collection(name) {
    assert.equal(name, TOS_VERSIONS_COLLECTION);
    return {
      doc: (id) => {
        if (!this.docs.has(id)) {
          this.docs.set(id, new FakeDocRef(id));
        }
        return this.docs.get(id);
      },
    };
  }
}

(async () => {
  const db = new FakeDb();
  const first = await archiveTosVersion(db, {
    message: sampleMessage,
    consentKey: "tos_2026_06_20_v2",
    versionNumber: 1,
    issuedAt: "2026-07-20",
    effectiveAt: "2026-07-21",
    requireReaccept: false,
    archivedBy: "ops@example.com",
  });
  assert.equal(first.docId, expectedHash);
  assert.equal(first.data.consentKey, "tos_2026_06_20_v2");

  await assert.rejects(
    () =>
      archiveTosVersion(db, {
        message: sampleMessage,
        consentKey: "tos_2026_06_20_v2",
        versionNumber: 1,
        issuedAt: "2026-07-20",
        effectiveAt: "2026-07-21",
        requireReaccept: false,
        archivedBy: "ops@example.com",
      }),
    /already exists/,
  );

  const dryRun = await archiveTosVersion(
    db,
    {
      message: "other message",
      consentKey: "tos_other",
      versionNumber: 2,
      issuedAt: "2026-07-20",
      effectiveAt: "2026-07-21",
      requireReaccept: true,
      archivedBy: "ops@example.com",
    },
    { dryRun: true },
  );
  assert.equal(dryRun.dryRun, true);
  assert.notEqual(dryRun.docId, expectedHash);
})();

const firestoreRulesPath = path.resolve(
  __dirname,
  "../../ohayokamome_dart_production/firestore.rules",
);
assert.ok(fs.existsSync(firestoreRulesPath), `Missing firestore.rules at ${firestoreRulesPath}`);
const rules = fs.readFileSync(firestoreRulesPath, "utf8");
assert.match(rules, /match \/tos_versions\/\{versionId\}/);
assert.match(rules, /allow read, write: if false;/);

console.log("archive_tos_version.test.js: ok");
