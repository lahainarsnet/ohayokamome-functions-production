"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { fixed, operationId, fingerprint, prepare, dryRun, repairAdapter } = require("./core");
const { buildAndroidOwnershipId } = require("../../subscriptionOwnership");
const now = Date.now();
const admin = { FieldValue: { serverTimestamp: () => new Date(now) }, Timestamp: { fromDate: d => d, fromMillis: n => new Date(n) } };
const quietInspect = async () => ({ decision: "match" });
function merged(a, b) {
  const result = { ...a };
  for (const [k, v] of Object.entries(b)) result[k] = v && Object.getPrototypeOf(v) === Object.prototype ? merged(result[k] || {}, v) : v;
  return result;
}
function fixture(extra = {}) {
  const docs = new Map(); let counter = 1;
  const uid = fixed.uid;
  docs.set(`users/${uid}`, { billingRevision: 7, subscriptionStatus: "expired", subscriptionPlatform: "android",
    googlePlayPrimaryPurchaseToken: "test-token", activePurchaseTokens: ["test-token"],
    "subscriptions.android": { primaryPurchaseToken: "test-token", activePurchaseTokens: ["test-token"], status: "expired", expiryTime: new Date(now - 1000) }, ...extra });
  docs.set(`subscription_ownership/${buildAndroidOwnershipId("test-token")}`, { ownerUid: uid, platform: "android", productId: "ohayo_kamome_monthly" });
  const versions = new Map([...docs.keys()].map(k => [k, counter]));
  const writes = [];
  const db = { docs, writes, beforeTransaction: null };
  const snap = path => ({ exists: docs.has(path), data: () => docs.get(path), get: k => docs.get(path)?.[k],
    updateTime: versions.get(path), ref: ref(path) });
  function ref(path) { return { path, id: path.split('/').at(-1), get: async () => snap(path), set: async value => { docs.set(path,value);writes.push(path); } }; }
  db.collection = name => ({ doc: id => ref(`${name}/${id}`) });
  let tail = Promise.resolve();
  db.runTransaction = run => {
    const result = tail.then(async () => {
      if(db.beforeTransaction) await db.beforeTransaction();
      const pending=[];
      const tx={get: async r=>snap(r.path),set:(r,d,o)=>pending.push([r.path,d,o])};
      const result=await run(tx);
      for(const [p,d,o]of pending){docs.set(p,o?.merge?merged(docs.get(p)||{},d):d);versions.set(p,++counter);writes.push(p);}
      return result;
    }); tail=result.catch(()=>{});return result;
  };
  db.change=(p,d)=>{docs.set(p,d);versions.set(p,++counter);};
  const verify = async () => ({ subscription: { subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED" },
    matchedLineItem: { productId: "ohayo_kamome_monthly", expiryTime: new Date(now-1000).toISOString() } });
  return {db,admin,verify,inspect:quietInspect};
}
let passed=0; async function test(name, fn){await fn();console.log(`ok ${++passed}: ${name}`);}
(async()=>{
 await test("one UID/platform/project/revision/dry-run allowlist rejects overrides",async()=>{
  for(const override of [{uid:'other'},{platform:'ios'},{project:'other'},{expectedRevision:8},{mode:'repair'}]){
   const f=fixture();assert.equal((await dryRun({...f,request:{...fixed,...override}})).reason,'fixed_scope_violation');assert.equal(f.db.writes.length,0);
  }
 });
 await test("dry-run expired exact Store state leaves all documents and operation ledger untouched",async()=>{
  const f=fixture();const before=fingerprint([...f.db.docs]);const result=await dryRun(f);
  assert.equal(result.result,'ready_no_write');assert.equal(result.storeState,'ended');assert.equal(result.plannedRevision,8);
  assert.equal(result.plannedBillingConfirmation,'unknown');assert.equal(result.literalFieldDeletionPlanned,false);
  assert.equal(fingerprint([...f.db.docs]),before);assert.equal(f.db.writes.length,0);assert.equal(f.db.docs.has('subscriptionShapeRepairOperations/'+operationId()),false);
  assert.equal(JSON.stringify(result).includes(fixed.uid),false);assert.equal(JSON.stringify(result).includes('test-token'),false);
 });
 await test("active Store verification is reported active and does not trigger purchase or write",async()=>{
  const f=fixture();f.verify=async()=>({subscription:{subscriptionState:'SUBSCRIPTION_STATE_ACTIVE'},matchedLineItem:{productId:'ohayo_kamome_monthly',expiryTime:new Date(now+100000).toISOString()}});
  const result=await dryRun(f);assert.equal(result.storeState,'active');assert.equal(result.entitlementWouldBeUsable,true);assert.equal(f.db.writes.length,0);
 });
 await test("pending on-hold paused unknown and invalid expiry fail closed",async()=>{
  for(const state of ['SUBSCRIPTION_STATE_PENDING','SUBSCRIPTION_STATE_ON_HOLD','SUBSCRIPTION_STATE_PAUSED','UNKNOWN','SUBSCRIPTION_STATE_ACTIVE']){
   const f=fixture();f.verify=async()=>({subscription:{subscriptionState:state},matchedLineItem:{productId:'ohayo_kamome_monthly',expiryTime:'invalid'}});
   assert.equal((await dryRun(f)).reason,'store_blocked_or_unknown');assert.equal(f.db.writes.length,0);
  }
 });
 await test("Store API errors are not disclosed or converted into expired",async()=>{
  const f=fixture();f.verify=async()=>{throw Error('secret-token-error');};const result=await dryRun(f);
  assert.equal(result.reason,'read_or_verification_failed');assert.equal(JSON.stringify(result).includes('secret'),false);assert.equal(f.db.writes.length,0);
 });
 await test("wrong missing owner or mismatched product blocks",async()=>{
  for(const owner of [null,{ownerUid:'other',platform:'android',productId:'ohayo_kamome_monthly'},{ownerUid:fixed.uid,platform:'android',productId:'other'}]){
   const f=fixture();const p='subscription_ownership/'+buildAndroidOwnershipId('test-token');if(owner)f.db.change(p,owner);else f.db.docs.delete(p);
   assert.equal((await dryRun(f)).reason,'owner_mismatch_or_missing');assert.equal(f.db.writes.length,0);
  }
 });
 await test("linked token is formally reverified and every owner must match",async()=>{
  const f=fixture();f.verify=async(_p,t)=>({subscription:{subscriptionState:'SUBSCRIPTION_STATE_EXPIRED',...(t==='test-token'?{linkedPurchaseToken:'linked'}:{})},matchedLineItem:{productId:'ohayo_kamome_monthly',expiryTime:new Date(now-1000).toISOString()}});
  assert.equal((await dryRun(f)).reason,'owner_mismatch_or_missing');
  f.db.change('subscription_ownership/'+buildAndroidOwnershipId('linked'),{ownerUid:fixed.uid,platform:'android',productId:'ohayo_kamome_monthly'});
  assert.equal((await dryRun(f)).checkedSeries,2);assert.equal(f.db.writes.length,0);
 });
 await test("missing token unresolved token and conflicting nested state block",async()=>{
  for(const extra of [{googlePlayPrimaryPurchaseToken:''},{activePurchaseTokens:['unresolved']},{subscriptions:{android:{primaryPurchaseToken:'different'}}},{subscriptionProductId:'other'},{subscriptions:{android:{packageId:'other'}}}]){
   const f=fixture(extra);assert.equal((await dryRun(f)).result,'blocked');assert.equal(f.db.writes.length,0);
  }
 });
 await test("revision and user fingerprint races invalidate dry-run",async()=>{
  const f=fixture({billingRevision:8});assert.equal((await dryRun(f)).reason,'revision_changed');
  const g=fixture();const verify=g.verify;g.verify=async(...args)=>{g.db.change('users/'+fixed.uid,{...g.db.docs.get('users/'+fixed.uid),email:'changed'});return verify(...args);};
  assert.equal((await dryRun(g)).reason,'user_changed_during_check');assert.equal(g.db.writes.length,0);
 });
 await test("owner race and malicious inspect write cannot pass dry-run",async()=>{
  const f=fixture();const verify=f.verify;f.verify=async(...args)=>{f.db.change('subscription_ownership/'+buildAndroidOwnershipId('test-token'),{ownerUid:'other'});return verify(...args);};
  assert.equal((await dryRun(f)).reason,'owner_changed_during_check');
  const g=fixture();g.inspect=async db=>{await db.collection('users').doc(fixed.uid).set({bad:true});return {decision:'match'};};
  assert.equal((await dryRun(g)).reason,'dry_run_write_forbidden');assert.equal(g.db.writes.length,0);
 });
 await test("future adapter writes nested + operation atomically once; duplicates do not write again",async()=>{
  const f=fixture();const plan=await prepare(f);const results=await Promise.all([repairAdapter({...f,plan}),repairAdapter({...f,plan})]);
  assert.equal(results.filter(x=>x.result==='completed').length,1);assert.equal(results.filter(x=>x.result==='already_completed').length,1);
  const saved=f.db.docs.get('users/'+fixed.uid);assert.equal(saved.subscriptions.android.status,'expired');assert.equal(saved.billingRevision,8);
  assert.equal(saved.billingConfirmation.android.state,'unknown');assert.ok(saved['subscriptions.android']);
  assert.equal(f.db.writes.filter(p=>p==='users/'+fixed.uid).length,1);assert.equal(f.db.docs.get('subscriptionShapeRepairOperations/'+operationId()).state,'completed');
  assert.equal((await dryRun(f)).result,'already_completed');
 });
 await test("future adapter rejects stale plan or changed official Store result",async()=>{
  const f=fixture();const plan=await prepare(f);await assert.rejects(repairAdapter({...f,plan:{...plan,createdAt:Date.now()-31000}}),/repair_plan_stale/);
  await assert.rejects(repairAdapter({...f,plan,verify:async()=>({subscription:{subscriptionState:'SUBSCRIPTION_STATE_ACTIVE'},matchedLineItem:{productId:'ohayo_kamome_monthly',expiryTime:new Date(now+100000).toISOString()}})}),/store_changed_before_repair/);assert.equal(f.db.writes.length,0);
 });
 await test("transaction revision/owner race and failed save roll back user and ledger",async()=>{
  for(const kind of ['revision','owner','save']){
   const f=fixture();const plan=await prepare(f);
   if(kind==='revision')f.db.beforeTransaction=async()=>f.db.change('users/'+fixed.uid,{...f.db.docs.get('users/'+fixed.uid),billingRevision:8});
   if(kind==='owner')f.db.beforeTransaction=async()=>f.db.change('subscription_ownership/'+buildAndroidOwnershipId('test-token'),{ownerUid:'other'});
   if(kind==='save')await assert.rejects(repairAdapter({...f,plan,commit:async()=>{throw Error('save_failed');}}),/save_failed/);
   else await assert.rejects(repairAdapter({...f,plan}));
   assert.equal(f.db.writes.length,0);assert.equal(f.db.docs.has('subscriptionShapeRepairOperations/'+operationId()),false);
  }
 });
 await test("production entry cannot invoke future repair adapter or accept input overrides",()=>{
  const s=fs.readFileSync(require.resolve('./entry'),'utf8');assert.equal(s.includes('repairAdapter'),false);
  assert.match(s,/process\.argv\.length !== 2/);assert.match(s,/FIRESTORE_EMULATOR_HOST/);assert.match(s,/GOOGLE_APPLICATION_CREDENTIALS/);
  assert.match(s,/project\/project-id/);assert.match(s,/runtimeServiceAccount/);
 });
 console.log(`billingDryRun/core.test.js: ${passed} tests passed; no production write or Store network call`);
})().catch(e=>{console.error(e.safeCode||e.message);process.exitCode=1;});
