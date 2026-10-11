"use strict";
const { fixed, operationId, dryRun } = require("./core");
(async () => {
  if (process.argv.length !== 2 || ["MODE", "UID", "TARGET_UID", "PLATFORM", "EXPECTED_REVISION", "REPAIR_MODE", "GOOGLE_APPLICATION_CREDENTIALS", "FIRESTORE_EMULATOR_HOST"].some(k => process.env[k]) ||
    (process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT !== fixed.project)) throw Error("fixed_scope_violation");
  const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email", { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
  if (!response.ok || (await response.text()).trim() !== fixed.runtimeServiceAccount) throw Error("runtime_identity_mismatch");
  const projectResponse = await fetch("http://metadata.google.internal/computeMetadata/v1/project/project-id", { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
  if (!projectResponse.ok || (await projectResponse.text()).trim() !== fixed.project) throw Error("runtime_project_mismatch");
  const firebase = require("firebase-admin");
  if (!firebase.apps.length) firebase.initializeApp({ projectId: fixed.project });
  const db = firebase.firestore();
  db.settings({ projectId: fixed.project });
  const timeout = new Promise(resolve => setTimeout(() => resolve({ operationId: operationId(), uidSuffix: fixed.uid.slice(-6), platform: "android", expectedRevision: 7, dryRun: true, result: "blocked", reason: "read_deadline" }), 45000));
  const result = await Promise.race([dryRun({ db, admin: { FieldValue: firebase.firestore.FieldValue, Timestamp: firebase.firestore.Timestamp } }), timeout]);
  console.log(JSON.stringify(result));
  process.exit(result.result === "ready_no_write" || result.result === "already_completed" ? 0 : 1);
})().catch(() => { console.log(JSON.stringify({ operationId: operationId(), uidSuffix: fixed.uid.slice(-6), platform: "android", dryRun: true, result: "blocked", reason: "startup_or_auth_failed" })); process.exit(1); });
