#!/usr/bin/env node
/**
 * Archive one ToS version into Firestore tos_versions/{sha256_hash}.
 *
 * Does NOT update announcements/tos (Stage 2).
 * Requires Admin SDK credentials (GOOGLE_APPLICATION_CREDENTIALS).
 */
const path = require("node:path");
const admin = (() => {
  const resolved = require.resolve("firebase-admin", {
    paths: [path.join(__dirname, "../functions/node_modules")],
  });
  return require(resolved);
})();
const {
  archiveTosVersion,
  parseCliArgs,
  printUsage,
  resolveMessageFromArgs,
} = require("./archiveTosVersionLib");

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const required = [
    "versionNumber",
    "issuedAt",
    "effectiveAt",
    "requireReaccept",
    "archivedBy",
    "consentKey",
  ];
  for (const key of required) {
    if (options[key] === undefined) {
      throw new Error(`Missing required option: --${key.replace(/([A-Z])/g, "-$1").toLowerCase()}`);
    }
  }
  if (typeof options.consentKey !== "string" || options.consentKey.trim().length === 0) {
    throw new Error("consentKey must be a non-empty string");
  }

  const message = resolveMessageFromArgs(options);
  if (options.project) {
    process.env.GCLOUD_PROJECT = options.project;
    process.env.GOOGLE_CLOUD_PROJECT = options.project;
  }

  if (!admin.apps.length) {
    admin.initializeApp();
  }
  const db = admin.firestore();

  const result = await archiveTosVersion(
    db,
    {
      message,
      versionNumber: options.versionNumber,
      issuedAt: options.issuedAt,
      effectiveAt: options.effectiveAt,
      requireReaccept: options.requireReaccept,
      archivedBy: options.archivedBy,
      consentKey: options.consentKey,
    },
    { dryRun: options.dryRun === true },
  );

  const payload = {
    collection: "tos_versions",
    docId: result.docId,
    consentKey: result.data.consentKey,
    fields: Object.keys(result.data).sort(),
    dryRun: result.dryRun,
  };
  console.log(JSON.stringify(payload, null, 2));

  if (result.dryRun) {
    console.log("Dry run only. No Firestore write performed.");
    return;
  }

  console.log(`Archived to tos_versions/${result.docId}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
