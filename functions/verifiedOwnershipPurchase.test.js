'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {verifiedGoogleOwnershipFacts}=require('./verifiedOwnershipPurchase');
const {buildAndroidOwnershipId,claimAndroidSubscriptionOwnership}=require('./subscriptionOwnership');
const {fingerprint}=require('./expiredOwnershipProof');
const now=Date.now();const oldId=buildAndroidOwnershipId('old-token'),newId=buildAndroidOwnershipId('new-token');
const docs={['subscription_ownership/'+oldId]:{ownerUid:'old'},['subscription_ownership/'+newId]:{ownerUid:'user'},'users/old':{},'users/user':{}};
const snap=(path)=>({exists:!!docs[path],get:(key)=>docs[path]?.[key],data:()=>docs[path]});
const db = {
 collection(name) {
   return {
     doc(id) { return {path: `${name}/${id}`, get: async () => snap(`${name}/${id}`)}; },
     where(field, op, value) {
       return { limit() { return { get: async () => ({docs: Object.keys(docs)
         .filter(path => path.startsWith('users/') && (op === 'array-contains' ? docs[path][field]?.includes(value) : docs[path][field] === value))
         .map(path => ({id: path.split('/')[1]}))}) }; } };
     },
   };
 },
 runTransaction: async fn => fn({get: async ref => snap(ref.path), set() { throw Error('unexpected write'); }}),
};
const admin={FieldValue:{serverTimestamp:()=>new Date(),delete:()=>({__deleted:true})},Timestamp:{fromMillis:(ms)=>new Date(ms),fromDate:(date)=>date}};
const subscription={subscriptionState:'SUBSCRIPTION_STATE_ACTIVE',startTime:new Date(now).toISOString(),linkedPurchaseToken:'old-token',externalAccountIdentifiers:{obfuscatedExternalAccountId:crypto.createHash('sha256').update('kamome-account:user').digest('hex')}};
const matchedLineItem={productId:'ohayo_kamome_monthly',expiryTime:new Date(now+100000).toISOString()};
(async()=>{
 for(const state of ['SUBSCRIPTION_STATE_ACTIVE','UNKNOWN','SUBSCRIPTION_STATE_EXPIRED']){
   const args={db,uid:'user',purchaseToken:'new-token',subscription,matchedLineItem,verifyLinked:async()=>({subscription:{subscriptionState:state},matchedLineItem:{...matchedLineItem,expiryTime:new Date(state==='SUBSCRIPTION_STATE_ACTIVE'?now+100000:now-100000).toISOString()}})};
   if(state==='SUBSCRIPTION_STATE_EXPIRED'){
     const facts=await verifiedGoogleOwnershipFacts(args);assert.equal(facts.active,true);assert.equal(facts.linkedState,'ended');assert.equal(facts.linkedObservation.fingerprint,fingerprint(snap('subscription_ownership/'+oldId)));
     // A directly invoked verification cannot exploit an existing primary owner to ignore a foreign link.
     await assert.rejects(()=>claimAndroidSubscriptionOwnership(db,admin,{uid:'user',purchaseToken:'new-token',linkedPurchaseToken:'old-token',verifiedPurchase:facts}),/conflicting linked ownership/);
     docs['subscription_ownership/'+oldId].latestOwnershipId=newId;
     const historyFacts=await verifiedGoogleOwnershipFacts(args);
     await assert.rejects(()=>claimAndroidSubscriptionOwnership(db,admin,{uid:'user',purchaseToken:'new-token',linkedPurchaseToken:'old-token',verifiedPurchase:historyFacts}),/unexpected write/);
     docs['users/old'].changedAfterRead=true;
     await assert.rejects(()=>claimAndroidSubscriptionOwnership(db,admin,{uid:'user',purchaseToken:'new-token',linkedPurchaseToken:'old-token',verifiedPurchase:historyFacts}),/changed or is unconfirmed/);
   } else await assert.rejects(()=>verifiedGoogleOwnershipFacts(args));
 }
 delete docs['subscription_ownership/'+oldId];
 docs['users/old']={googlePlayPrimaryPurchaseToken:'old-token',subscriptionPlatform:'android',subscriptionStatus:'active'};
 for(const state of ['SUBSCRIPTION_STATE_ACTIVE','UNKNOWN','SUBSCRIPTION_STATE_EXPIRED']) {
   const args={db,uid:'user',purchaseToken:'new-token',subscription,matchedLineItem,verifyLinked:async()=>({subscription:{subscriptionState:state},matchedLineItem:{...matchedLineItem,expiryTime:new Date(state==='SUBSCRIPTION_STATE_ACTIVE'?now+100000:now-100000).toISOString()}})};
   if(state!=='SUBSCRIPTION_STATE_EXPIRED') await assert.rejects(()=>verifiedGoogleOwnershipFacts(args));
   else {const facts=await verifiedGoogleOwnershipFacts(args);assert.equal(facts.linkedLegacyOwners[0].ownerUid,'old');
     await assert.rejects(()=>claimAndroidSubscriptionOwnership(db,admin,{uid:'user',purchaseToken:'new-token',linkedPurchaseToken:'old-token',verifiedPurchase:facts}),/unexpected write/);
     docs['users/old'].changed=true;
     await assert.rejects(()=>claimAndroidSubscriptionOwnership(db,admin,{uid:'user',purchaseToken:'new-token',linkedPurchaseToken:'old-token',verifiedPurchase:facts}),/changed or is unconfirmed/);
   }
 }
 console.log('verifiedOwnershipPurchase: primary existing + foreign linked Active/Unknown/Expired/freshness checks PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
