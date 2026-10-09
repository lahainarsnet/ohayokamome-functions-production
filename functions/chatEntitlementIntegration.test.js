'use strict';
const assert = require('node:assert/strict');
const admin = require('./firebaseAdmin');
const logger = require('firebase-functions/logger');
const { IOS_FIREBASE_APP_ID, ANDROID_FIREBASE_APP_ID } = require('./appCheckPlatform');
const DEVICE = '550e8400-e29b-41d4-a716-446655440000';
const SENDER = 'sender-test-123456';
const RECIPIENT = 'recipient-test-654321';
const future = () => new Date(Date.now() + 2*86400000);
const logs = [];
for (const level of ['info','warn','error','debug']) logger[level] = (...args) => logs.push(args);
let docs; let writes; let recipientChange;
function snap(path) {
  const data = docs[path];
  return { exists: data != null, data: () => data, get: field => data?.[field] };
}
function ref(path) {
  return { path, id: path.split('/').at(-1), collection: sub => collection(`${path}/${sub}`),
    get: async () => snap(path), set: async () => {} };
}
function collection(path) {
  return { doc: (id = 'message-test') => ref(`${path}/${id}`),
    async get() {
      assert.equal(path, `users/${RECIPIENT}/contacts`);
      return { docs: [{ data: () => ({ stableId: SENDER }) }] };
    },
  };
}
const db = { collection,
  async runTransaction(fn) {
    if (recipientChange) { recipientChange(); recipientChange = null; }
    return fn({ get: async reference => snap(reference.path), set: (reference, data) => writes.push({ path: reference.path, data }) });
  },
};
admin.getDb = () => db;
const { sendMessageWithLimit } = require('./index');
const { assertCallerSubscriptionUsable } = require('./transcribeExperiment');
function initial(senderOS, recipientOS, status, grace = true, verified = true) {
  const other = recipientOS === 'ios' ? 'android' : 'ios';
  docs = {
    [`users/${SENDER}`]: { activeDeviceId: DEVICE, accountId: 'sender-account', subscriptions: { [senderOS]: { status: 'active', expiryTime: future() } } },
    [`users/${RECIPIENT}`]: { activeDeviceId: DEVICE,
      entitlementUsable: true, entitlementExpiryTime: future(),
      subscriptions: { [recipientOS]: { status, expiryTime: future() }, [other]: { status: 'active', expiryTime: future() } },
      chatUnknownProvisionalUntil: grace ? future() : new Date(Date.now()-1),
    },
    [`users/${RECIPIENT}/devices/${DEVICE}`]: { deviceId: DEVICE, platform: recipientOS, platformAppCheckVerified: verified },
    'config/app': { dailySendLimit: 1000 },
  };
  writes = []; recipientChange = null;
}
function request(os) { return { auth: { uid: SENDER }, app: { appId: os === 'ios' ? IOS_FIREBASE_APP_ID : ANDROID_FIREBASE_APP_ID }, data: { senderId: SENDER, recipientId: RECIPIENT, text: 'test', deviceId: DEVICE } }; }
async function main() {
  let cases = 0;
  for (const sender of ['ios','android']) for (const receiver of ['ios','android']) {
    for (const [status,grace,allowed] of [['active',true,true],['expired',true,false],['none',true,false],['',true,true],['',false,false]]) {
      initial(sender, receiver, status, grace);
      const result = await sendMessageWithLimit.run(request(sender));
      assert.equal(result.success, allowed, `${sender}->${receiver}:${status}:${grace}`);
      assert.equal(writes.some(w => w.path.includes('/messages/')), allowed); cases++;
    }
    initial(sender, receiver, 'active');
    recipientChange = () => { docs[`users/${RECIPIENT}`].subscriptions[receiver].status = 'expired'; };
    assert.equal((await sendMessageWithLimit.run(request(sender))).code, 'RECIPIENT_SUBSCRIPTION_UNAVAILABLE');
    assert.equal(writes.length, 0); cases++;
    initial(sender, receiver, 'active');
    docs[`users/${RECIPIENT}/devices/${DEVICE}`].deviceId = 'different-device';
    assert.equal((await sendMessageWithLimit.run(request(sender))).success, false); cases++;
    initial(sender, receiver, 'active', true, false);
    // Old device metadata + trusted aggregate Active: compatible without grace.
    assert.equal((await sendMessageWithLimit.run(request(sender))).success, true); cases++;
    initial(sender, receiver, '', true, false);
    docs[`users/${RECIPIENT}`].entitlementUsable = false;
    assert.equal((await sendMessageWithLimit.run(request(sender))).success, false); cases++;
    initial(sender, receiver, 'active');
    docs[`users/${RECIPIENT}`].subscriptions = {};
    docs[`users/${RECIPIENT}`].subscriptionPlatform = receiver === 'ios' ? 'android' : 'ios';
    assert.equal((await sendMessageWithLimit.run(request(sender))).success, false); cases++;
  }
  for (const os of ['ios','android']) for (const [status,grace,allowed] of [['active',true,true],['expired',true,false],['none',true,false],['',true,true],['',false,false]]) {
    const data = { subscriptions: { [os]: { status, expiryTime: future() } }, chatUnknownProvisionalUntil: grace ? future() : new Date(Date.now()-1) };
    docs = { [`users/${SENDER}`]: data };
    const result = await assertCallerSubscriptionUsable(SENDER, { appId: os === 'ios' ? IOS_FIREBASE_APP_ID : ANDROID_FIREBASE_APP_ID, getDb: () => db });
    assert.equal(result.ok, allowed); cases++;
  }
  for (const os of ['ios','android']) {
    initial(os, os, 'active');
    delete docs[`users/${RECIPIENT}`].subscriptions[os].expiryTime;
    assert.equal((await sendMessageWithLimit.run(request(os))).success, true); cases++;
    docs = { [`users/${SENDER}`]: { subscriptions: { [os]: { status: 'active' } }, chatUnknownProvisionalUntil: future() } };
    assert.equal((await assertCallerSubscriptionUsable(SENDER, { platform: os, getDb: () => db })).ok, true); cases++;
  }
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(SENDER), false);
  assert.equal(serialized.includes(RECIPIENT), false);
  console.log(`chatEntitlementIntegration.test.js: ${cases} real send/STT gate cases ok`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
