const assert = require('node:assert/strict');
const {
  androidEntitlementBasis,
  shouldRequeryNonPrimaryNotification,
  resolveRevocationUserEntitlement,
} = require('./googlePlaySubscriptionNotifications');
const future = new Date(Date.now() + 3600000).toISOString();
const past = new Date(Date.now() - 3600000).toISOString();
const expired = { status: 'expired', expiryTime: past, expiryDate: new Date(past), subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED' };
const active = { status: 'active', expiryTime: future, expiryDate: new Date(future), subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' };
const user = {
  subscriptionStatus: 'active', subscriptionExpiryTime: future, subscriptionPlatform: 'ios',
  subscriptions: { android: { status: 'active', expiryTime: future, primaryPurchaseToken: 'new', activePurchaseTokens: ['old', 'new'], subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' } },
};
function resolve(existingData, primaryResult) {
  return resolveRevocationUserEntitlement({
    existingData, notificationPurchaseToken: 'old', notificationDerived: expired,
    notificationTokenConfirmed: true, protectPrimary: true,
    tokenResults: [{ ok: true, purchaseToken: 'old', derived: expired }, primaryResult],
  });
}
// EXPIRED(type13), ON_HOLD and other nonactive old-token notifications share this gate.
assert.equal(shouldRequeryNonPrimaryNotification(user, 'old', expired), true);
assert.equal(shouldRequeryNonPrimaryNotification(user, 'new', expired), false);
assert.equal(shouldRequeryNonPrimaryNotification(user, 'old', active), false);
const preserved = resolve(user, { ok: true, purchaseToken: 'new', derived: active });
assert.equal(preserved.action, 'keep_active');
assert.equal(preserved.primaryPurchaseToken, 'new');
assert.equal(preserved.derived.status, 'active');
for (const unknown of [
  { ok: false, purchaseToken: 'new' },
  { ok: true, purchaseToken: 'new', derived: { status: 'unknown' } },
]) {
  const kept = resolve(user, unknown);
  assert.equal(kept.action, 'keep_active_uncertain');
  assert.equal(kept.primaryPurchaseToken, 'new');
  const androidExpired = { ...user, subscriptions: { android: { ...user.subscriptions.android, status: 'expired', expiryTime: past } } };
  assert.equal(androidEntitlementBasis(androidExpired).subscriptionStatus, 'expired');
  assert.equal(resolve(androidExpired, unknown).action, 'defer');
}
const iosOnlyActive = { subscriptionPlatform: 'ios', subscriptionStatus: 'active', subscriptionExpiryTime: future, googlePlayPrimaryPurchaseToken: 'new' };
assert.equal(resolve(iosOnlyActive, { ok: false, purchaseToken: 'new' }).action, 'defer');
const confirmedExpired = resolve(user, { ok: true, purchaseToken: 'new', derived: expired });
assert.equal(confirmedExpired.action, 'expire');
const revocationWithIosActive = resolveRevocationUserEntitlement({
  existingData: { ...user, subscriptions: { android: { ...user.subscriptions.android, status: 'expired', expiryTime: past } } },
  notificationPurchaseToken: 'old', notificationDerived: expired, notificationTokenConfirmed: true,
  tokenResults: [{ ok: true, purchaseToken: 'old', derived: expired }, { ok: false, purchaseToken: 'new' }],
});
assert.equal(revocationWithIosActive.action, 'expire');
assert.equal(revocationWithIosActive.derived.status, 'expired');
console.log('googlePlayDelayedExpiredSafety.test.js: all tests passed');

// Exercise the actual Publisher requery path, including unknown API responses.
(async () => {
  const { google } = require('googleapis');
  const { resolveUserEntitlementAfterRevocation } = require('./googlePlaySubscriptionNotifications');
  const originalAuth = google.auth.getClient;
  const originalPublisher = google.androidpublisher;
  let primaryState = 'SUBSCRIPTION_STATE_ACTIVE';
  const requests = [];
  google.auth.getClient = async () => ({});
  google.androidpublisher = () => ({ purchases: { subscriptionsv2: { get: async ({ token }) => {
    requests.push(token);
    return { data: {
      subscriptionState: token === 'new' ? primaryState : 'SUBSCRIPTION_STATE_EXPIRED',
      lineItems: [{ productId: 'ohayo_kamome_monthly', expiryTime: token === 'new' ? future : past }],
    } };
  } } } });
  try {
    const args = { packageName: 'com.lahainarsnet.ohayokamome.live', existingData: user,
      notificationPurchaseToken: 'old', notificationDerived: expired, notificationTokenConfirmed: true, protectPrimary: true };
    assert.equal((await resolveUserEntitlementAfterRevocation(args)).action, 'keep_active');
    assert.deepEqual(requests.sort(), ['new', 'old']);
    primaryState = 'SUBSCRIPTION_STATE_UNSPECIFIED';
    assert.equal((await resolveUserEntitlementAfterRevocation(args)).action, 'keep_active_uncertain');
    args.existingData = { ...user, subscriptions: { android: { ...user.subscriptions.android, status: 'expired', expiryTime: past } } };
    assert.equal((await resolveUserEntitlementAfterRevocation(args)).action, 'defer');
    primaryState = 'SUBSCRIPTION_STATE_EXPIRED';
    assert.equal((await resolveUserEntitlementAfterRevocation(args)).action, 'expire');
    console.log('googlePlayDelayedExpiredSafety.test.js: Publisher requery tests passed');
  } finally {
    google.auth.getClient = originalAuth;
    google.androidpublisher = originalPublisher;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
