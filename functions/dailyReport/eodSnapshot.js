const admin = require("../firebaseAdmin");
const { FieldPath } = require("firebase-admin/firestore");
const { getReportWindowUtc, isTimestampInReportWindow, TIMEZONE } = require("./jstDate");
const {
  COLLECTION_ID,
  SCHEMA_VERSION,
  assertSafeDailyReportPayload,
  createBaseReportMetadata,
} = require("./schema");

const PROCESSING_STALE_MS = 15 * 60 * 1000;
const TOP_VERSION_LIMIT = 50;

function isDeletedUser(data = {}) {
  if (typeof data.accountDeletionState === "string") {
    return data.accountDeletionState === "deleted";
  }
  return data.deleted === true;
}

function incrementBucket(map, key, amount = 1) {
  const normalized = key || "unknown";
  map[normalized] = (map[normalized] || 0) + amount;
}

function trimTopBuckets(map, limit = TOP_VERSION_LIMIT) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (entries.length <= limit) {
    return Object.fromEntries(entries);
  }
  const kept = entries.slice(0, limit);
  const otherCount = entries.slice(limit).reduce((sum, [, count]) => sum + count, 0);
  if (otherCount > 0) kept.push(["other", otherCount]);
  return Object.fromEntries(kept);
}

async function scanUsersSnapshot(getDb) {
  const totals = {
    total: 0,
    active: 0,
    deleted: 0,
  };
  const billing = {
    byStatus: {},
    byPlatform: {},
    entitlementUsable: 0,
  };

  let lastDoc = null;
  while (true) {
    let query = getDb().collection("users").orderBy(FieldPath.documentId()).limit(500);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      totals.total += 1;
      const data = doc.data() || {};
      if (isDeletedUser(data)) {
        totals.deleted += 1;
      } else {
        totals.active += 1;
      }
      incrementBucket(billing.byStatus, data.subscriptionStatus || "unknown");
      incrementBucket(billing.byPlatform, data.subscriptionPlatform || "unknown");
      if (data.entitlementUsable === true) billing.entitlementUsable += 1;
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }

  return {
    users: totals,
    billing,
  };
}

async function scanDevicesSnapshot(getDb) {
  const byPlatform = {};
  const byAppVersion = {};
  const byBuildNumber = {};
  let totalDevices = 0;

  let lastDoc = null;
  while (true) {
    let query = getDb()
      .collectionGroup("devices")
      .orderBy(FieldPath.documentId())
      .limit(500);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      totalDevices += 1;
      const data = doc.data() || {};
      incrementBucket(byPlatform, data.platform || "unknown");
      incrementBucket(byAppVersion, data.appVersion || "unknown");
      incrementBucket(byBuildNumber, data.buildNumber || "unknown");
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }

  return {
    totalDevices,
    byPlatform,
    byAppVersion: trimTopBuckets(byAppVersion),
    byBuildNumber: trimTopBuckets(byBuildNumber),
  };
}

async function countTosAgreementsInWindow(getDb, reportDate) {
  const { windowStartUtc, windowEndUtc } = getReportWindowUtc(reportDate);
  const start = admin.Timestamp.fromDate(new Date(windowStartUtc));
  const end = admin.Timestamp.fromDate(new Date(windowEndUtc));
  let count = 0;
  let lastDoc = null;
  while (true) {
    let query = getDb()
      .collection("tos_agreements")
      .where("agreedAt", ">=", start)
      .where("agreedAt", "<=", end)
      .orderBy("agreedAt")
      .limit(500);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;
    count += snap.size;
    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }
  return count;
}

async function buildEodSnapshotSections(getDb, reportDate) {
  const [userSnapshot, devicesSnapshot, tosAgreements] = await Promise.all([
    scanUsersSnapshot(getDb),
    scanDevicesSnapshot(getDb),
    countTosAgreementsInWindow(getDb, reportDate).catch(() => null),
  ]);

  return {
    snapshot: {
      users: userSnapshot.users,
      billing: userSnapshot.billing,
    },
    devices: devicesSnapshot,
    activityUsers: {
      tosAgreements: typeof tosAgreements === "number" ? tosAgreements : null,
    },
    quality: {
      tosAgreementsSource:
        typeof tosAgreements === "number" ? "tos_agreements_query" : "unavailable",
    },
  };
}

async function finalizeDailyReport(reportDate, options = {}) {
  const getDb = options.getDb || (() => admin.getDb());
  const logger = options.logger || console;
  const now = options.now instanceof Date ? options.now : new Date();
  const source = options.source || "scheduled";
  const startedMs = Date.now();
  const { windowStartUtc, windowEndUtc } = getReportWindowUtc(reportDate);
  const ref = getDb().collection(COLLECTION_ID).doc(reportDate);
  const existing = await ref.get();
  const existingData = existing.exists ? existing.data() || {} : {};

  if (existingData.status === "processing") {
    const processingStartedAt = existingData.processingStartedAt;
    const processingMillis =
      processingStartedAt && typeof processingStartedAt.toDate === "function"
        ? processingStartedAt.toDate().getTime()
        : 0;
    if (processingMillis > 0 && now.getTime() - processingMillis < PROCESSING_STALE_MS) {
      return { ok: false, reason: "processing_in_flight", reportDate };
    }
  }

  await ref.set(
    {
      ...createBaseReportMetadata(reportDate, TIMEZONE),
      windowStartUtc,
      windowEndUtc,
      status: "processing",
      processingStartedAt: admin.FieldValue.serverTimestamp(),
      "generation.source": source,
    },
    { merge: true },
  );

  let sections;
  let completeness = {
    activity: "partial",
    snapshot: "partial",
  };
  let status = "partial";
  const quality = {
    warnings: [],
  };

  try {
    sections = await buildEodSnapshotSections(getDb, reportDate);
    completeness.snapshot = "complete";
    completeness.activity = sections.activityUsers.tosAgreements == null ? "partial" : "complete";
    status = completeness.activity === "complete" ? "complete" : "partial";
  } catch (error) {
    logger.error("dailyReport: eod_snapshot_failed", {
      reportDate,
      errorType: error?.constructor?.name || typeof error,
    });
    completeness.snapshot = "failed";
    status = "failed";
    quality.warnings.push("snapshot_build_failed");
    sections = {
      snapshot: existingData.snapshot || null,
      devices: existingData.devices || null,
      activityUsers: { tosAgreements: existingData.activity?.users?.tosAgreements ?? null },
      quality: { tosAgreementsSource: "unavailable" },
    };
  }

  const payload = {
    ...createBaseReportMetadata(reportDate, TIMEZONE),
    windowStartUtc,
    windowEndUtc,
    status,
    completeness,
    snapshot: sections.snapshot,
    devices: sections.devices,
    "activity.users.tosAgreements": sections.activityUsers.tosAgreements,
    quality: {
      ...(existingData.quality || {}),
      ...sections.quality,
      ...quality,
    },
    "generation.source": source,
    "generation.durationMs": Date.now() - startedMs,
    regeneratedAt: admin.FieldValue.serverTimestamp(),
  };

  if (!existing.exists || !existingData.generatedAt) {
    payload.generatedAt = admin.FieldValue.serverTimestamp();
  }

  assertSafeDailyReportPayload(payload);
  await ref.set(payload, { merge: true });
  await ref.update({
    status,
    processingStartedAt: admin.FieldValue.delete(),
  });

  return { ok: status !== "failed", reportDate, status, completeness };
}

module.exports = {
  isDeletedUser,
  trimTopBuckets,
  scanUsersSnapshot,
  scanDevicesSnapshot,
  countTosAgreementsInWindow,
  buildEodSnapshotSections,
  finalizeDailyReport,
  TOP_VERSION_LIMIT,
};
