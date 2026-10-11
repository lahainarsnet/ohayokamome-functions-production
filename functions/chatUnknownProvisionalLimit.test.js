"use strict";
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture, request, user, UID} = require('./chatUnknownProvisionalCallable.test');
const {resolveChatEntitlementWithUnknownProvisional: resolve, PROVISIONAL_LIMIT_CODE} = require('./chatUnknownProvisional');
const HOUR = 3600000;
const BASE = new Date('2026-10-10T00:00:00Z');
const at = hours => new Date(BASE.getTime() + hours * HOUR);
const date = value => value?.toDate ? value.toDate() : value;
const stored = f => f.docs.get(`users/${UID}`);
for (const os of ['ios', 'android']) {
  test(`${os} first issue, repeated renewal, exact 120h, days 6/7 and clear persistence`, async () => {
    let now = at(0);
    const f = fixture(user(os), [], () => now);
    const first = await f.record(request(os));
    assert.equal(first.outcome, 'unknownRecorded');
    assert.equal(first.untilMillis, at(24).getTime());
    assert.equal(date(stored(f).chatUnknownProvisionalStartedAt).getTime(), BASE.getTime());
    for (const hours of [24, 48, 96, 119]) {
      now = at(hours);
      const r = await f.record(request(os));
      assert.equal(r.untilMillis, at(Math.min(hours + 24, 120)).getTime());
      assert.equal(date(stored(f).chatUnknownProvisionalStartedAt).getTime(), BASE.getTime());
    }
    assert.equal(resolve(stored(f), os, at(120 - 1 / HOUR)).allowed, true);
    for (const hours of [120, 144, 168, 240]) {
      now = at(hours);
      // Even an old oversized cached until cannot override the server cap.
      stored(f).chatUnknownProvisionalUntil = at(300);
      assert.equal(resolve(stored(f), os, now).allowed, false);
      const r = await f.record(request(os));
      assert.equal(r.outcome, 'dedicatedStop');
      assert.equal(r.stopReason, PROVISIONAL_LIMIT_CODE);
      assert.equal(stored(f).subscriptions[os].status, '');
      await f.clear(request(os));
      assert.equal(date(stored(f).chatUnknownProvisionalStartedAt).getTime(), BASE.getTime());
      assert.equal((await f.record(request(os))).stopReason, PROVISIONAL_LIMIT_CODE);
    }
  });
  test(`${os} only authenticated current OS Active resets, then new Unknown starts anew`, async () => {
    let now = at(0);
    const f = fixture(user(os), [], () => now);
    await f.record(request(os));
    for (const status of ['expired', 'none', 'paused', 'refunded', 'revoked']) {
      stored(f).subscriptions[os] = {status, expiryTime: at(300)};
      // Definitive stops beat any provisional deadline and never reset its anchor.
      assert.equal(resolve(stored(f), os, at(1)).allowed, false);
      await f.clear(request(os));
      assert.equal(date(stored(f).chatUnknownProvisionalStartedAt).getTime(), BASE.getTime());
      assert.notEqual((await f.record(request(os))).outcome, 'unknownRecorded');
    }
    stored(f).subscriptions[os] = {status: ''};
    stored(f).subscriptionPlatform = os === 'ios' ? 'android' : 'ios';
    const own = stored(f).subscriptions[os]; delete stored(f).subscriptions[os];
    stored(f).subscriptionStatus = 'active'; stored(f).subscriptionExpiryTime = at(300);
    // Cases 13 and 14: an Active contract of the other OS under the same UID is carried, so there is nothing to stop.
    assert.notEqual((await f.record(request(os))).outcome, 'dedicatedStop');
    await f.clear(request(os));
    assert.equal(stored(f).chatUnknownProvisionalStartedAt, undefined, 'a carried Active resets the provisional anchor');
    stored(f).subscriptions[os] = {status: 'active', expirySource: 'grace', normalExpiryTime: at(-1), graceExpiryTime: at(300)};
    now = at(144);
    assert.equal(resolve(stored(f), os, now).allowed, true, 'Store grace is not the Unknown rescue');
    await f.clear(request(os));
    assert.equal(stored(f).chatUnknownProvisionalStartedAt, undefined);
    assert.equal(stored(f).subscriptions[os].graceExpiryTime.getTime(), at(300).getTime());
    // The other-OS legacy Active (carried, cases 13 and 14) is removed so the own Unknown is observed on its own.
    delete stored(f).subscriptionStatus; delete stored(f).subscriptionExpiryTime; delete stored(f).subscriptionPlatform;
    stored(f).subscriptions[os] = own;
    now = at(168);
    assert.equal((await f.record(request(os))).outcome, 'unknownRecorded');
    assert.equal(date(stored(f).chatUnknownProvisionalStartedAt).getTime(), now.getTime());
    assert.equal((await f.record(request(os))).untilMillis, at(192).getTime());
    stored(f).subscriptions[os] = {status: 'active', expiryTime: at(300)};
    assert.equal((await f.record(request(os))).outcome, 'active');
    assert.equal(stored(f).chatUnknownProvisionalStartedAt, undefined);
  });
  test(`${os} transaction conflict retains concurrently committed first issuance`, async () => {
    const committed = user(os, '', {chatUnknownProvisionalStartedAt: at(0), chatUnknownProvisionalUntil: at(24)});
    const f = fixture(user(os), [committed], () => at(1));
    assert.equal((await f.record(request(os))).untilMillis, at(25).getTime());
    assert.equal(date(stored(f).chatUnknownProvisionalStartedAt).getTime(), BASE.getTime());
    assert.equal(f.writes.length, 1);
  });
  test(`${os} legacy test data adopts original issued time before clear`, async () => {
    const f = fixture(user(os, '', {chatUnknownProvisionalUntil: at(24), chatUnknownProvisionalUpdatedAt: at(0)}), [], () => at(144));
    await f.clear(request(os));
    assert.equal(date(stored(f).chatUnknownProvisionalStartedAt).getTime(), BASE.getTime());
    assert.equal((await f.record(request(os))).stopReason, PROVISIONAL_LIMIT_CODE);
  });
  test(`${os} direct client start override and missing App Check cannot reset`, async () => {
    const f = fixture(user(os, '', {chatUnknownProvisionalStartedAt: at(0)}), [], () => at(144));
    await assert.rejects(f.record(request(os, {data: {deviceId: 'invalid', chatUnknownProvisionalStartedAt: at(144)}})), e => e.code === 'invalid-argument');
    await assert.rejects(f.clear(request(os, {app: null})), e => e.code === 'failed-precondition');
    assert.equal(date(stored(f).chatUnknownProvisionalStartedAt).getTime(), BASE.getTime());
  });
}
