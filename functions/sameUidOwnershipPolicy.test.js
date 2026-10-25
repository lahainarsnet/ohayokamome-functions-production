'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeDb, adminFor, snapshotOf } = require('./ownershipTransferTestKit');
const { claimOwnershipDocument, claimAndroidSubscriptionOwnership, claimIosSubscriptionOwnership,
  buildAndroidOwnershipId, buildIosOwnershipId, assertUidSeriesAllowed,
  SUBSCRIPTION_ALREADY_LINKED_CODE } = require('./subscriptionOwnership');
const { createClaimActiveDeviceHandler } = require('./claimActiveDevice');
const { createInspectSubscriptionSeriesOwnershipHandler } = require('./inspectSubscriptionSeriesOwnership');
const { IOS_FIREBASE_APP_ID, ANDROID_FIREBASE_APP_ID } = require('./appCheckPlatform');
const UID='owner-private-abcdef', OTHER='other-private-ghijkl';
const A='550e8400-e29b-41d4-a716-446655440000', B='6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const past=new Date(Date.now()-86400000).toISOString(), future=new Date(Date.now()+86400000).toISOString();
const trace='ds-123456789-1', logs=[];
const logger={info:(tag,fields)=>logs.push({tag,...fields}),warn:(tag,fields)=>logs.push({tag,...fields}),error() {}};
let count=0;
const deny=p=>assert.rejects(p,e=>e.details?.code===SUBSCRIPTION_ALREADY_LINKED_CODE);
function fixture(platform,state='active',owner=UID,options={}) {
 const token='private-purchase-token-'+platform, id=platform==='ios'?buildIosOwnershipId(token):buildAndroidOwnershipId(token);
 const user={activeDeviceId:A,pendingActiveDeviceId:B,pendingActiveClaimGeneration:1,
   subscriptions:{[platform]:{status:state,expiryTime:state==='expired'?past:future,
     ...(platform==='ios'?{originalTransactionId:token}:{primaryPurchaseToken:token})}},
   boundSubscriptionSeries:{[platform]:{ownershipId:id}}};
 const docs={['users/'+UID]:user,['users/'+UID+'/devices/'+A]:{platform,platformAppCheckVerified:true},
   ['subscription_ownership/'+id]:{ownerUid:owner,status:state}};
 const db=makeDb(docs,options);
 // The real inspector performs users queries. This fixture has no historical matches.
 const collection=db.collection.bind(db);
 db.collection=name=>({...collection(name),where:()=>({limit:()=>({get:async()=>({docs:[]})})})});
 return {db,id,token,user};
}
function request(platform,mode='confirmed') {return {auth:{uid:UID},app:{appId:platform==='ios'?IOS_FIREBASE_APP_ID:ANDROID_FIREBASE_APP_ID},
 data:{deviceId:B,platform,modelName:'test',appVersion:'6.0.0',buildNumber:'478',mode,claimGeneration:1,
 expectedUid:UID,deviceSwitchTraceId:trace,osGateTraceId:'og-123456789-1'}};}
function claim(db,id,platform,extra={}) {return claimOwnershipDocument(db,adminFor(db),{uid:UID,ownershipId:id,platform,
 ownershipFields:{productId:'test'},log:logger,traceId:trace,...extra});}
(async()=>{
 // All eight allowed conditions: Store-account identity is intentionally absent from the request.
 for(const platform of ['android','ios'])for(const state of ['active','expired'])for(const changedStore of [false,true]){
  const {db,id,user}=fixture(platform,state); const handler=createClaimActiveDeviceHandler({admin:adminFor(db),logger});
  if(state==='expired'){
   const next='new-private-token-'+platform, nextId=platform==='ios'?buildIosOwnershipId(next):buildAndroidOwnershipId(next);
   // Legitimate same-UID purchase can use an entirely new series after expiry.
   if(platform==='android') await claimAndroidSubscriptionOwnership(db,adminFor(db),{uid:UID,purchaseToken:next,log:logger,traceId:trace});
   else await claimIosSubscriptionOwnership(db,adminFor(db),{uid:UID,update:{appStoreOriginalTransactionId:next},transactionInfo:{},log:logger,traceId:trace});
   db.docs.set('users/'+UID,{...user,boundSubscriptionSeries:{[platform]:{ownershipId:nextId}},
    subscriptions:{[platform]:{status:'active',expiryTime:future,...(platform==='ios'?{originalTransactionId:next}:{primaryPurchaseToken:next})}}});
  }
  await handler(request(platform));
  assert.equal(db.docs.get('users/'+UID).activeDeviceId,B,`${platform}/${state}/${changedStore}`);
  assert.equal(db.docs.get('subscription_ownership/'+id).ownerUid,UID);count++;
 }
 // Cross-UID ownership is rejected before purchase/restore and again at commit, even if expired.
 for(const platform of ['android','ios'])for(const state of ['active','expired']){
  const {db,id,token}=fixture(platform,state,OTHER);let before=snapshotOf(db);
  const inspect=createInspectSubscriptionSeriesOwnershipHandler({admin:adminFor(db),logger,verifySeriesState:async()=>state==='active'?'active':'ended'});
  const result=await inspect({auth:{uid:UID},data:{platform,billingTraceId:trace,...(platform==='ios'?{originalTransactionId:token}:{purchaseToken:token})}});
  assert.equal(result.decision,'mismatch');assert.equal(snapshotOf(db),before);
  await deny(claim(db,id,platform,{verifiedPurchase:{active:true,uidBound:true,purchasedAt:Date.now()}}));
  assert.equal(snapshotOf(db),before);
  await assert.rejects(createClaimActiveDeviceHandler({admin:adminFor(db),logger})(request(platform)), e => e.details?.code === (state === 'active' ? SUBSCRIPTION_ALREADY_LINKED_CODE : 'DEVICE_SWITCH_CONTRACT_NOT_ACTIVE'));
  assert.equal(snapshotOf(db),before);count++;
 }
 // Both OS directions: entry and final transaction refuse without changing the old device.
 for(const platform of ['android','ios']){
  const {db}=fixture(platform);const other=platform==='ios'?'android':'ios';
  const handler=createClaimActiveDeviceHandler({admin:adminFor(db),logger}); const before=snapshotOf(db);
  assert.equal((await handler(request(other,'os_check'))).reason,'OS_GATE_CROSS_OS');
  await assert.rejects(handler(request(other)),e=>e.details?.code==='OS_GATE_CROSS_OS');
  assert.equal(snapshotOf(db),before);count++;
 }
 // Normal first purchase and replay keep the same owner; no previous contract is needed.
 for(const platform of ['android','ios']){
  const {db}=fixture(platform,'expired');db.docs.delete('users/'+UID);
  const id=platform==='ios'?buildIosOwnershipId('brand-new'):buildAndroidOwnershipId('brand-new');
  await claim(db,id,platform);await claim(db,id,platform);assert.equal(db.docs.get('subscription_ownership/'+id).ownerUid,UID);count++;
 }
 // A new token must not hide another UID's linked series, including historical terminal contracts.
 for(const state of ['active','expired']){
  const {db,id}=fixture('android',state,OTHER);const before=snapshotOf(db), next=buildAndroidOwnershipId('new-linked');
  await deny(claim(db,next,'android',{linkedOwnershipId:id,verifiedPurchase:{active:true,uidBound:true,linkedState:'ended'}}));
  assert.equal(snapshotOf(db),before);count++;
 }
 // Unknown contract and missing ownership cannot authorize the switch.
 for(const condition of ['unknown','missingOwner','missingSeries']){
  const {db,id,user}=fixture('android',condition==='unknown'?'unknown':'active');
  if(condition==='missingOwner')db.docs.delete('subscription_ownership/'+id);
  if(condition==='missingSeries'){delete user.boundSubscriptionSeries;delete user.subscriptions.android.primaryPurchaseToken;db.docs.set('users/'+UID,user);}
  const before=snapshotOf(db);await assert.rejects(createClaimActiveDeviceHandler({admin:adminFor(db),logger})(request('android')));
  assert.equal(snapshotOf(db),before);count++;
 }
 // Old Active contract disallows a different new series; no purchase/ownership write is committed.
 for(const platform of ['android','ios']){
  const {db}=fixture(platform);const before=snapshotOf(db), next=platform==='ios'?buildIosOwnershipId('different'):buildAndroidOwnershipId('different');
  await deny(claim(db,next,platform));assert.equal(snapshotOf(db),before);count++;
 }
 // Failure at final commit keeps both ownership and old activeDeviceId intact.
 {const {db}=fixture('ios','active',UID,{failCommit:true});const before=snapshotOf(db);
 await assert.rejects(createClaimActiveDeviceHandler({admin:adminFor(db),logger})(request('ios')));assert.equal(snapshotOf(db),before);count++;}
 // Optimistic transaction conflicts: two UIDs race for one unowned series, only one wins.
 {const {db}=fixture('android','expired');const id=buildAndroidOwnershipId('racing-series');
 const result=await Promise.allSettled([UID,OTHER].map(uid=>claimOwnershipDocument(db,adminFor(db),{uid,ownershipId:id,platform:'android',ownershipFields:{},log:logger,traceId:trace})));
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);count++;}
 // Log evidence is emitted after commit / on rejection with safe identifiers and correlation IDs.
 for(const event of ['ownership.created','ownership.retained','ownership.uid_rejected','ownership.claim_aborted','ownership.device_owner_confirmed']){
  assert(logs.some(l=>l.event===event),event);count++;
 }
 const dump=JSON.stringify(logs);for(const secret of [UID,OTHER,A,B,'private-purchase-token-android'])assert(!dump.includes(secret));
 assert(logs.some(l=>l.billingTraceId===trace));count++;
 const secretError = new Error('purchaseToken=SECRET_PURCHASE_PAYLOAD email=secret@example.com');
 secretError.code = 'SECRET_PURCHASE_PAYLOAD';
 secretError.stack = 'Error: SECRET_PURCHASE_PAYLOAD\n    at unsafe (/private/personal-name/server.js:10:4)';
 const details = require('./subscriptionOwnership').ownershipErrorDetails(secretError);
 assert.deepEqual(details.errorStackLocations,['server.js:10:4']);
 assert(!JSON.stringify(details).includes('SECRET_PURCHASE_PAYLOAD'));assert(!JSON.stringify(details).includes('personal-name'));count++;
 const index=fs.readFileSync(require.resolve('./index.js'),'utf8');
 // Build 486 consolidation: the dedicated transfer Callable and its handler module are part of the deployed set.
 assert(index.includes('exports.transferActiveContractOwnership'));assert(fs.existsSync(__dirname+'/ownershipTransferAtomic.js'));count++;
 console.log(`Build478 same-UID ownership: ${count} checks PASS (14-case policy matrix included; no device tests)`);
})().catch(e=>{console.error(e);process.exitCode=1});
