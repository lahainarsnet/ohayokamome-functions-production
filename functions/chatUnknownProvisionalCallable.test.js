"use strict";
const assert = require('node:assert/strict');
const {
  createRecordChatUnknownProvisionalHandler, createClearChatUnknownProvisionalHandler,
  resolveChatEntitlementWithUnknownProvisional,
} = require('./chatUnknownProvisional');
const { platformFromAppCheckAppId, IOS_FIREBASE_APP_ID, ANDROID_FIREBASE_APP_ID } = require('./appCheckPlatform');
const DEVICE = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_DEVICE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const UID = 'test-owner-123456';
const DELETE = Symbol('delete');
const STAMP = Symbol('serverTimestamp');
const future = () => new Date(Date.now() + 86400000 * 2);
let cases = 0;

// Mirrors firebaseAdmin.js's exported interface: deliberately no admin.firestore.
function fixture(data, retries = []) {
  const docs = new Map([[`users/${UID}`, data], ['users/victim', { untouched: true }]]);
  const writes = [];
  const apply = (ref, patch) => {
    assert.equal(ref.path, `users/${UID}`);
    assert.deepEqual(Object.keys(patch).sort(), [
      'chatUnknownProvisionalUntil', 'chatUnknownProvisionalUnknownStreak', 'chatUnknownProvisionalUpdatedAt',
    ].sort());
    const next = { ...docs.get(ref.path) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === DELETE) delete next[key]; else next[key] = value;
    }
    docs.set(ref.path, next);
    writes.push(patch);
  };
  const db = {
    collection(name) {
      assert.equal(name, 'users');
      return { doc(uid) { return { path: `users/${uid}`,
        async get() { const d = docs.get(this.path); return { exists: !!d, data: () => d }; },
        async set(patch) { apply(this, patch); },
      }; } };
    },
    async runTransaction(fn) {
      // Real Firestore drops writes from a conflicted snapshot and reruns callback.
      for (const replacement of [...retries, null]) {
        const pending = [];
        const result = await fn({
          async get(ref) { const d = docs.get(ref.path); return { exists: !!d, data: () => d }; },
          set(ref, patch, options) { assert.equal(options.merge, true); pending.push([ref, patch]); },
        });
        if (replacement) { docs.set(`users/${UID}`, replacement); continue; }
        pending.forEach(([ref, patch]) => apply(ref, patch));
        return result;
      }
    },
  };
  const admin = { getDb: () => db,
    Timestamp: { fromDate: date => ({ toDate: () => new Date(date), seconds: Math.floor(date.getTime()/1000) }) },
    FieldValue: { delete: () => DELETE, serverTimestamp: () => STAMP },
  };
  const logs = [];
  const dependencies = { admin, platformFromAppCheckAppId, logger: { info: (...args) => logs.push(args) } };
  return { docs, writes, logs, dependencies,
    record: createRecordChatUnknownProvisionalHandler(dependencies),
    clear: createClearChatUnknownProvisionalHandler(dependencies) };
}
function request(platform = 'ios', overrides = {}) {
  return { auth: { uid: UID }, app: { appId: platform === 'ios' ? IOS_FIREBASE_APP_ID : ANDROID_FIREBASE_APP_ID },
    data: { deviceId: DEVICE, uid: 'victim', platform: platform === 'ios' ? 'android' : 'ios' }, ...overrides };
}
function user(platform, status = '', extra = {}) {
  return { activeDeviceId: DEVICE, subscriptions: { [platform]: { status, expiryTime: future() } }, ...extra };
}
async function rejects(f, req, code) {
  await assert.rejects(f.record(req), err => err.code === code);
  assert.equal(f.writes.length, 0); cases++;
}
async function main() {
  for (const platform of ['ios', 'android']) {
    for (const [status, outcome] of [['active', 'active'], ['expired', 'expired'], ['none', 'noPurchase'], ['paused', 'expired']]) {
      const initial = user(platform, status, { chatUnknownProvisionalUntil: future() });
      const f = fixture(initial);
      assert.equal((await f.record(request(platform))).outcome, outcome);
      assert.equal(f.docs.get(`users/${UID}`).chatUnknownProvisionalUntil, undefined);
      assert.deepEqual(f.docs.get(`users/${UID}`).subscriptions, initial.subscriptions);
      assert.deepEqual(f.docs.get('users/victim'), { untouched: true }); cases++;
    }
    const missingExpiry = fixture({ activeDeviceId: DEVICE, subscriptions: { [platform]: { status: 'active' } } });
    assert.equal((await missingExpiry.record(request(platform))).outcome, 'unknownRecorded'); cases++;
    const passedExpiry = fixture({ activeDeviceId: DEVICE, subscriptions: { [platform]: { status: 'active', expiryTime: new Date(Date.now()-1000) } } });
    assert.equal((await passedExpiry.record(request(platform))).outcome, 'expired'); cases++;
    const f = fixture(user(platform));
    const before = Date.now(); const result = await f.record(request(platform)); const after = Date.now();
    assert.equal(result.outcome, 'unknownRecorded');
    assert.ok(result.untilMillis >= before + 86400000 && result.untilMillis <= after + 86400000);
    assert.equal(result.unknownStreak, 1);
    assert.equal(f.docs.get(`users/${UID}`).chatUnknownProvisionalUpdatedAt, STAMP);
    assert.equal(resolveChatEntitlementWithUnknownProvisional(f.docs.get(`users/${UID}`), platform).allowed, true);
    // Expired provisional, same Unknown: server renews without a count ceiling.
    const stored = f.docs.get(`users/${UID}`);
    stored.chatUnknownProvisionalUntil = new Date(Date.now() - 86400000);
    stored.chatUnknownProvisionalUnknownStreak = 10000;
    assert.equal(resolveChatEntitlementWithUnknownProvisional(stored, platform).allowed, false);
    const renewed = await f.record(request(platform));
    assert.equal(renewed.unknownStreak, 10001);
    assert.ok(renewed.untilMillis > Date.now());
    await f.clear(request(platform));
    assert.equal(f.docs.get(`users/${UID}`).chatUnknownProvisionalUntil, undefined);
    assert.deepEqual(f.docs.get('users/victim'), { untouched: true }); cases += 3;

    const dedicated = fixture({ activeDeviceId: DEVICE, subscriptionPlatform: platform === 'ios' ? 'android' : 'ios', subscriptionStatus: 'active', subscriptionExpiryTime: future() });
    const stop = await dedicated.record(request(platform));
    assert.equal(stop.outcome, 'dedicatedStop'); assert.equal(stop.stopReason, 'legacy_other_platform'); cases++;
  }
  await rejects(fixture(user('ios')), request('ios', { auth: null }), 'unauthenticated');
  await rejects(fixture(user('ios')), request('ios', { app: null }), 'failed-precondition');
  await rejects(fixture(user('ios')), request('ios', { app: { appId: 'unrecognized' } }), 'failed-precondition');
  await rejects(fixture(user('ios')), request('ios', { data: { deviceId: OTHER_DEVICE } }), 'failed-precondition');
  await rejects(fixture(user('ios')), request('ios', { data: { deviceId: 'invalid' } }), 'invalid-argument');
  await rejects(fixture(user('ios')), request('ios', { auth: { uid: 'attacker' } }), 'not-found');
  for (const key of ['untilMillis','subscriptions','outcome','clientContractState']) {
    await rejects(fixture(user('ios')), request('ios', { data: { deviceId: DEVICE, [key]: 'forged' } }), 'invalid-argument');
  }
  const raced = fixture(user('ios'), [user('ios', 'expired')]);
  assert.equal((await raced.record(request())).outcome, 'expired');
  assert.equal(raced.writes.some(w => w.chatUnknownProvisionalUntil !== DELETE), false); cases++;
  const deviceRace = fixture(user('ios'), [user('ios', '', { activeDeviceId: OTHER_DEVICE })]);
  await rejects(deviceRace, request(), 'failed-precondition');
  const logFailure = fixture(user('ios'));
  logFailure.dependencies.logger.info = () => { throw Error('logger failure'); };
  assert.equal((await logFailure.record(request())).outcome, 'unknownRecorded'); cases++;
  console.log(`chatUnknownProvisionalCallable.test.js: ${cases} cases ok`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
