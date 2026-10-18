"use strict";
const { HttpsError } = require("firebase-functions/v2/https");
const { tokenSuffix } = require("./billingFinalTrace");
const OS_GATE_CROSS_OS = "OS_GATE_CROSS_OS";
const OS_GATE_UNKNOWN = "OS_GATE_UNKNOWN";
function safeIdentifier(value) { const s=String(value||"");return !s ? "empty" : s.length<=6 ? "(short-id)" : tokenSuffix(s); }
function safeTrace(value) { return /^og-[0-9]{1,20}-[0-9]{1,8}$/.test(String(value || "")) ? value : null; }
function compareActiveDeviceOs(activeDeviceId, deviceData, currentOs) {
  if (!["ios", "android"].includes(currentOs)) return { allowed: false, reason: OS_GATE_UNKNOWN, comparison: "unknown", registeredOs: "unknown", lookup: "invalid_current_os" };
  if (!activeDeviceId) return { allowed: true, reason: "no_active_device", comparison: "new", registeredOs: null, lookup: "no_active_device" };
  const registeredOs = deviceData?.platform;
  if (deviceData?.platformAppCheckVerified !== true || !["ios", "android"].includes(registeredOs))
    return { allowed: false, reason: OS_GATE_UNKNOWN, comparison: "unknown", registeredOs: "unknown", lookup: deviceData ? "unverified_or_unknown_os" : "active_device_missing" };
  return { allowed: registeredOs === currentOs, reason: registeredOs === currentOs ? "same_os" : OS_GATE_CROSS_OS,
    comparison: registeredOs === currentOs ? "same" : "different", registeredOs, lookup: "found_verified" };
}
function emit(logger, fields) { try { logger.info("KAMOME_BILLING_OS_GATE", fields); } catch (_) { /* diagnostics never authorize or abort a transaction */ } }
function logOsDecision({ logger, stage, path, uid, deviceId, activeDeviceId, deviceData, currentOs, traceId, loginKind }) {
  const startedAt = new Date().toISOString();
  const common = { osGateTraceId: safeTrace(traceId), path, loginKind, uidSuffix: safeIdentifier(uid),
    currentDeviceSuffix: tokenSuffix(deviceId), registeredDeviceSuffix: tokenSuffix(activeDeviceId), currentOs, startedAt };
  emit(logger, { event: `OS_GATE_${stage}_START`, ...common });
  const result = compareActiveDeviceOs(activeDeviceId, deviceData, currentOs);
  emit(logger,
    { event: `OS_GATE_${stage}_${result.allowed ? "ALLOW" : result.comparison === "unknown" ? "UNKNOWN" : "REJECT"}`, ...common, ...result, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(startedAt),
      transactionResult: stage === 2 ? (result.allowed ? "pending_commit" : "aborted_before_writes") : "read_only",
      activeDeviceChanged: false, ownershipChanged: false, oldDeviceStopIssued: false, notificationChanged: false,
      effectsScope: "this_check_only", priorPurchaseEffects: "not_observed" });
  return result;
}
function enforceOsDecision(options) {
  const result = logOsDecision({ ...options, stage: 2 });
  if (!result.allowed) throw new HttpsError("failed-precondition", result.reason, { code: result.reason, osGateTraceId: safeTrace(options.traceId) });
  return result;
}
module.exports = { OS_GATE_CROSS_OS, OS_GATE_UNKNOWN, safeTrace, compareActiveDeviceOs, logOsDecision, enforceOsDecision };
