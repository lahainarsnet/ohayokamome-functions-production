'use strict';
const assert=require('node:assert/strict');
const { fingerprint, permitsExpiredReassignment }=require('./expiredOwnershipProof');
const now=Date.now();
const owner={exists:true,data:()=>({ownerUid:'old',status:'active'})};
const proof={ownershipId:'android_id',ownerUid:'old',fingerprint:fingerprint(owner),ownerUserFingerprint:fingerprint(owner),expiryMs:now-10000};
const confirmation={state:'eligible',reason:'verified_current_series_ended',checkedAt:new Date(now-1000),expiredForeignSeries:[proof]};
const args={userData:{billingConfirmation:{android:confirmation}},platform:'android',purchase:{uidBound:true,active:true,purchasedAt:now-500},ownershipId:'android_id',ownerUid:'old',ownerSnapshot:owner,ownerUserSnapshot:owner,now};
assert.equal(permitsExpiredReassignment(args),true);
// Not bound to the requesting UID (and no matching tag), or not reported active by the Store: never accepted.
for(const purchase of [{uidBound:false,active:true,purchasedAt:now},{uidBound:true,active:false,purchasedAt:now-500}]) assert.equal(permitsExpiredReassignment({...args,purchase}),false);
assert.equal(permitsExpiredReassignment({...args,ownerUid:'other'}),false);
// Build 453: the shared decision never moves a series whose old owner's record still says active (dedicated transfer only).
assert.equal(permitsExpiredReassignment({...args,ownerSnapshot:{exists:true,data:()=>({ownerUid:'old',status:'active',updatedAt:now})}}),false);
// Build 453: with the Android active-transfer fallback removed, the 15-minute client-confirmation window gates the shared decision again.
assert.equal(permitsExpiredReassignment({...args,now:now+16*60*1000}),false);
// Build 453: without the 'eligible' ended-contract confirmation the shared decision does not move an Android series (dedicated transfer only).
for(const state of ['active','unknown','blocked']) assert.equal(permitsExpiredReassignment({...args,userData:{billingConfirmation:{android:{...confirmation,state}}}}),false);
// iPhone: the shared expired-reassignment decision never moves an ACTIVE contract (dedicated transfer only).
{
  const { evaluateOwnershipTransferProof, evaluateExpiredReassignment }=require('./expiredOwnershipProof');
  const TAG='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ownRec={exists:true,data:()=>({ownerUid:'old',status:'active',appAccountToken:TAG})};
  const ownUser={exists:true,data:()=>({subscriptions:{ios:{status:'active',expiryTime:new Date(now+3600000).toISOString()}}})};
  const base={platform:'ios',ownerUid:'old',ownerSnapshot:ownRec,ownerUserSnapshot:ownUser,ownershipId:'ios_id',now};
  const ok={active:true,uidBound:false,accountTag:TAG,proofVerified:true,ownershipType:'PURCHASED',purchasedAt:now-1000};
  assert.equal(evaluateOwnershipTransferProof({...base,purchase:ok}).proof!==null,true,'dedicated: owner tag + device proof + PURCHASED');
  for(const purchase of [{...ok,proofVerified:false},{...ok,proofVerified:undefined},{...ok,ownershipType:'FAMILY_SHARED'},{...ok,ownershipType:undefined},{...ok,accountTag:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},{...ok,accountTag:''},{...ok,active:false},{...ok,uidBound:true,accountTag:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}])
    assert.equal(evaluateOwnershipTransferProof({...base,purchase}).proof,null,'dedicated refuses '+JSON.stringify(purchase));
  for(const purchase of [ok,{...ok,uidBound:true},{...ok,uidBound:true,proofVerified:false}])
    assert.equal(evaluateExpiredReassignment({...base,userData:{},purchase}).proof,null,'shared iOS decision never moves an active contract '+JSON.stringify(purchase));
}
console.log('Expired ownership proof: policy assertions PASS');
