const crypto = require("node:crypto");
const path = require("node:path");

const FUNCTIONS_NODE_MODULES = path.resolve(__dirname, "../functions/node_modules");

function requireFromFunctions(moduleName) {
  const resolved = require.resolve(moduleName, { paths: [FUNCTIONS_NODE_MODULES] });
  return require(resolved);
}

const TOS_VERSIONS_COLLECTION = "tos_versions";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * Compute SHA-256 of the ToS message body (UTF-8, lowercase hex).
 * Document ID and announcements/tos.sha256_hash must use the same algorithm.
 */
function computeTosSha256(message) {
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("message must be a non-empty string");
  }
  return crypto.createHash("sha256").update(message, "utf8").digest("hex");
}

/**
 * Parse a calendar date in YYYY-MM-DD (JST) and return Firestore Timestamp args.
 * Stored instant is JST 00:00:00 converted to UTC.
 */
function parseCalendarDateJst(dateText, fieldName) {
  if (typeof dateText !== "string") {
    throw new Error(`${fieldName} must be a YYYY-MM-DD string`);
  }
  const normalized = dateText.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) {
    throw new Error(`${fieldName} must use YYYY-MM-DD format (received: ${dateText})`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} is not a valid calendar date: ${dateText}`);
  }
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - JST_OFFSET_MS);
}

function parseRequireReaccept(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") {
    throw new Error("requireReaccept must be true or false");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("requireReaccept must be true or false");
}

function parseConsentKey(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("consentKey must be a non-empty string");
  }
  return value.trim();
}

function parseVersionNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("versionNumber must be a non-empty string or number");
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function buildTosVersionDocument({
  message,
  consentKey,
  versionNumber,
  issuedAt,
  effectiveAt,
  requireReaccept,
  archivedBy,
  FieldValue,
  Timestamp,
}) {
  const sha256Hash = computeTosSha256(message);
  const issuedAtDate = parseCalendarDateJst(issuedAt, "issuedAt");
  const effectiveAtDate = parseCalendarDateJst(effectiveAt, "effectiveAt");

  if (typeof archivedBy !== "string" || archivedBy.trim().length === 0) {
    throw new Error("archivedBy must be a non-empty string");
  }

  return {
    docId: sha256Hash,
    data: {
      sha256_hash: sha256Hash,
      consentKey: parseConsentKey(consentKey),
      versionNumber: parseVersionNumber(versionNumber),
      issuedAt: Timestamp.fromDate(issuedAtDate),
      effectiveAt: Timestamp.fromDate(effectiveAtDate),
      message,
      requireReaccept: parseRequireReaccept(requireReaccept),
      archivedAt: FieldValue.serverTimestamp(),
      archivedBy: archivedBy.trim(),
    },
  };
}

function loadFirestoreTypes(deps) {
  if (deps.FieldValue && deps.Timestamp) {
    return { FieldValue: deps.FieldValue, Timestamp: deps.Timestamp };
  }
  const firestore = requireFromFunctions("firebase-admin/firestore");
  return {
    FieldValue: deps.FieldValue || firestore.FieldValue,
    Timestamp: deps.Timestamp || firestore.Timestamp,
  };
}

async function archiveTosVersion(db, input, deps = {}) {
  const { FieldValue, Timestamp } = loadFirestoreTypes(deps);
  const { docId, data } = buildTosVersionDocument({ ...input, FieldValue, Timestamp });
  const ref = db.collection(TOS_VERSIONS_COLLECTION).doc(docId);

  if (deps.dryRun) {
    return { docId, data, dryRun: true };
  }

  try {
    await ref.create(data);
  } catch (error) {
    if (error.code === 6 || error.code === "already-exists") {
      throw new Error(`tos_versions/${docId} already exists; refusing to overwrite`);
    }
    throw error;
  }

  return { docId, data, dryRun: false };
}

function resolveMessageFromArgs(args) {
  if (typeof args.message === "string" && args.message.length > 0) {
    return args.message;
  }
  if (typeof args.messageFile === "string" && args.messageFile.length > 0) {
    const fs = require("node:fs");
    const absolutePath = path.resolve(args.messageFile);
    return fs.readFileSync(absolutePath, "utf8");
  }
  throw new Error("Provide --message or --message-file");
}

function parseCliArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--message":
        options.message = argv[++i];
        break;
      case "--message-file":
        options.messageFile = argv[++i];
        break;
      case "--version-number":
        options.versionNumber = argv[++i];
        break;
      case "--issued-at":
        options.issuedAt = argv[++i];
        break;
      case "--effective-at":
        options.effectiveAt = argv[++i];
        break;
      case "--require-reaccept":
        options.requireReaccept = argv[++i];
        break;
      case "--archived-by":
        options.archivedBy = argv[++i];
        break;
      case "--consent-key":
        options.consentKey = argv[++i];
        break;
      case "--project":
        options.project = argv[++i];
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`Usage: node tool/archive_tos_version.js [options]

Required:
  --message "<text>"           ToS body text
    or
  --message-file <path>        ToS body file (UTF-8)
  --version-number <value>     Version label (number or string)
  --issued-at YYYY-MM-DD       Issue date (JST calendar date)
  --effective-at YYYY-MM-DD    Effective date (JST calendar date)
  --require-reaccept true|false
  --archived-by "<executor>"   Operator identifier (email or name)
  --consent-key "<key>"        Existing consent identifier (e.g. announcements/tos.sha256_hash)

Optional:
  --project <firebaseProject>  Firebase project ID
  --dry-run                    Validate and print payload without writing

Environment:
  GOOGLE_APPLICATION_CREDENTIALS  Service account JSON for Admin SDK
`);
}

module.exports = {
  TOS_VERSIONS_COLLECTION,
  computeTosSha256,
  parseCalendarDateJst,
  parseRequireReaccept,
  parseConsentKey,
  parseVersionNumber,
  buildTosVersionDocument,
  archiveTosVersion,
  resolveMessageFromArgs,
  parseCliArgs,
  printUsage,
};
