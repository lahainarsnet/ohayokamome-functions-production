const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  ACCESS_MODE_NORMAL,
  ACCESS_MODE_BLOCK_ALL,
  BLOCKED_BY_ADMIN_CODE,
  loadAppGateAccessMode,
  assertAccessNotBlocked,
} = require("./appConfig");
const { runTranscribeAdminGateAfterAuth } = require("./transcribeExperiment");

function createMockDb(appGateMode, options = {}) {
  const { throwOnGateRead = false, configAppAccessMode = null } = options;
  return {
    collection: (collectionName) => ({
      doc: (docId) => ({
        get: async () => {
          if (collectionName === "admin" && docId === "app_gate") {
            if (throwOnGateRead) {
              throw new Error("firestore unavailable");
            }
            if (appGateMode === null) {
              return { exists: false, get: () => undefined };
            }
            return {
              exists: true,
              get: (field) => (field === "mode" ? appGateMode : undefined),
            };
          }
          if (collectionName === "config" && docId === "app") {
            return {
              exists: configAppAccessMode !== null,
              get: (field) =>
                field === "app_access_mode" ? configAppAccessMode : undefined,
            };
          }
          throw new Error(`unexpected read: ${collectionName}/${docId}`);
        },
      }),
    }),
  };
}

async function evaluateSendMessageAccessGate(options = {}) {
  const gate = await assertAccessNotBlocked(options);
  if (gate.blocked) {
    return { success: false, code: gate.code };
  }
  return { success: true };
}

async function simulateTranscribeDownstreamAfterAdminGate(request, deps = {}) {
  const gateResult = await runTranscribeAdminGateAfterAuth(request, deps);
  if (!gateResult.ok) {
    return gateResult;
  }
  if (deps.assertCallerSubscriptionUsable) {
    await deps.assertCallerSubscriptionUsable(gateResult.uid, deps);
  }
  if (deps.reserveDailyTranscribeQuota) {
    await deps.reserveDailyTranscribeQuota(gateResult.uid);
  }
  if (deps.invokeSttProvider) {
    await deps.invokeSttProvider();
  }
  return { ok: true };
}

async function runGateTests() {
  const normalGate = await loadAppGateAccessMode({
    getDb: () => createMockDb(ACCESS_MODE_NORMAL),
  });
  assert.strictEqual(normalGate.accessMode, ACCESS_MODE_NORMAL);
  assert.strictEqual(normalGate.readFailed, false);

  const blockGate = await loadAppGateAccessMode({
    getDb: () => createMockDb(ACCESS_MODE_BLOCK_ALL),
  });
  assert.strictEqual(blockGate.accessMode, ACCESS_MODE_BLOCK_ALL);

  const missingDocGate = await loadAppGateAccessMode({
    getDb: () => createMockDb(null),
  });
  assert.strictEqual(missingDocGate.accessMode, ACCESS_MODE_NORMAL);

  const failOpenGate = await loadAppGateAccessMode({
    getDb: () => createMockDb(ACCESS_MODE_BLOCK_ALL, { throwOnGateRead: true }),
  });
  assert.strictEqual(failOpenGate.accessMode, ACCESS_MODE_NORMAL);
  assert.strictEqual(failOpenGate.readFailed, true);
  assert.strictEqual(failOpenGate.source, "fail_open");
}

async function runAssertAccessTests() {
  const allowed = await assertAccessNotBlocked({
    getDb: () => createMockDb(ACCESS_MODE_NORMAL),
  });
  assert.strictEqual(allowed.blocked, false);

  const blocked = await assertAccessNotBlocked({
    getDb: () => createMockDb(ACCESS_MODE_BLOCK_ALL),
  });
  assert.strictEqual(blocked.blocked, true);
  assert.strictEqual(blocked.code, BLOCKED_BY_ADMIN_CODE);

  const failOpen = await assertAccessNotBlocked({
    getDb: () => createMockDb(ACCESS_MODE_BLOCK_ALL, { throwOnGateRead: true }),
  });
  assert.strictEqual(failOpen.blocked, false);
  assert.strictEqual(failOpen.readFailed, true);
}

async function runSendMessageGateTests() {
  const pass = await evaluateSendMessageAccessGate({
    getDb: () => createMockDb(ACCESS_MODE_NORMAL),
  });
  assert.strictEqual(pass.success, true);

  const blocked = await evaluateSendMessageAccessGate({
    getDb: () => createMockDb(ACCESS_MODE_BLOCK_ALL),
  });
  assert.strictEqual(blocked.success, false);
  assert.strictEqual(blocked.code, BLOCKED_BY_ADMIN_CODE);

  const legacyConfigIgnored = await evaluateSendMessageAccessGate({
    getDb: () =>
      createMockDb(ACCESS_MODE_NORMAL, {
        configAppAccessMode: ACCESS_MODE_BLOCK_ALL,
      }),
  });
  assert.strictEqual(legacyConfigIgnored.success, true);
}

async function runTranscribeGateTests() {
  const pass = await runTranscribeAdminGateAfterAuth(
    { auth: { uid: "user-normal" } },
    { getDb: () => createMockDb(ACCESS_MODE_NORMAL) },
  );
  assert.strictEqual(pass.ok, true);
  assert.strictEqual(pass.uid, "user-normal");

  const blocked = await runTranscribeAdminGateAfterAuth(
    { auth: { uid: "user-blocked" } },
    { getDb: () => createMockDb(ACCESS_MODE_BLOCK_ALL) },
  );
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.code, BLOCKED_BY_ADMIN_CODE);

  let subscriptionCalled = false;
  let quotaCalled = false;
  let openAiCalled = false;
  let googleCalled = false;

  const blockedDownstream = await simulateTranscribeDownstreamAfterAdminGate(
    { auth: { uid: "user-blocked" } },
    {
      getDb: () => createMockDb(ACCESS_MODE_BLOCK_ALL),
      assertCallerSubscriptionUsable: async () => {
        subscriptionCalled = true;
      },
      reserveDailyTranscribeQuota: async () => {
        quotaCalled = true;
      },
      invokeSttProvider: async () => {
        openAiCalled = true;
        googleCalled = true;
      },
    },
  );
  assert.strictEqual(blockedDownstream.ok, false);
  assert.strictEqual(blockedDownstream.code, BLOCKED_BY_ADMIN_CODE);
  assert.strictEqual(subscriptionCalled, false);
  assert.strictEqual(quotaCalled, false);
  assert.strictEqual(openAiCalled, false);
  assert.strictEqual(googleCalled, false);
}

function runHandlerOrderTests() {
  const transcribeSource = fs.readFileSync(
    path.join(__dirname, "transcribeExperiment.js"),
    "utf8",
  );
  const authIdx = transcribeSource.indexOf('code: "UNAUTHENTICATED"');
  const gateIdx = transcribeSource.indexOf("runTranscribeAdminGateAfterAuth(request)");
  const subscriptionIdx = transcribeSource.indexOf(
    "subscriptionCheck = await assertCallerSubscriptionUsable(uid",
  );
  const quotaIdx = transcribeSource.indexOf(
    "quota = await reserveDailyTranscribeQuota(uid",
  );
  const invokeIdx = transcribeSource.indexOf(
    "providerResult = await invokeSttProvider({",
  );

  assert.ok(authIdx >= 0, "UNAUTHENTICATED branch must exist");
  assert.ok(gateIdx > authIdx, "admin gate must run after auth");
  assert.ok(subscriptionIdx > gateIdx, "subscription check must run after admin gate");
  assert.ok(quotaIdx > subscriptionIdx, "quota must run after subscription check");
  assert.ok(invokeIdx > quotaIdx, "STT invoke must run after quota reservation");

  assert.ok(
    transcribeSource.includes("maxInstances: 30"),
    "transcribeExperiment must set maxInstances: 30",
  );
  assert.ok(
    transcribeSource.includes("concurrency: 10"),
    "transcribeExperiment must set concurrency: 10",
  );

  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const sendStart = indexSource.indexOf("exports.sendMessageWithLimit");
  const sendEnd = indexSource.indexOf("exports.deleteMyAccount");
  const sendBlock = indexSource.slice(sendStart, sendEnd);
  assert.ok(
    sendBlock.includes("maxInstances: 30"),
    "sendMessageWithLimit must set maxInstances: 30",
  );
}

function runExemptFunctionTests() {
  const indexSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const sendStart = indexSource.indexOf("exports.sendMessageWithLimit");
  const sendEnd = indexSource.indexOf("exports.deleteMyAccount");
  assert.ok(sendStart >= 0 && sendEnd > sendStart, "sendMessageWithLimit export must exist");

  const sendBlock = indexSource.slice(sendStart, sendEnd);
  assert.ok(
    sendBlock.includes("assertAccessNotBlocked"),
    "sendMessageWithLimit must use assertAccessNotBlocked",
  );

  const exemptExports = [
    "handleAppStoreServerNotification",
    "handleGooglePlayRtdn",
    "verifyAppStoreSubscriptionPurchase",
    "verifyGooglePlaySubscriptionPurchase",
    "ensureAppStoreAppAccountToken",
    "deleteMyAccount",
    "adminUpsertUserSubscription",
  ];
  for (const exportName of exemptExports) {
    const exportIdx = indexSource.indexOf(`exports.${exportName}`);
    assert.ok(exportIdx >= 0, `${exportName} export must exist`);
    const nextExportIdx = indexSource.indexOf("exports.", exportIdx + 1);
    const handlerSource = indexSource.slice(
      exportIdx,
      nextExportIdx >= 0 ? nextExportIdx : indexSource.length,
    );
    assert.ok(
      !handlerSource.includes("assertAccessNotBlocked"),
      `${exportName} must not use assertAccessNotBlocked`,
    );
  }
}

async function main() {
  await runGateTests();
  await runAssertAccessTests();
  await runSendMessageGateTests();
  await runTranscribeGateTests();
  runHandlerOrderTests();
  runExemptFunctionTests();
  console.log("appGateAccess.test.js: all tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
