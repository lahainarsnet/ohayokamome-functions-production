"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createClaimActiveDeviceHandler, validateClaimActiveDeviceInput } = require("./claimActiveDevice");
const { compareActiveDeviceOs } = require("./osTransferGate");
const { makeDb, adminFor, snapshotOf } = require("./ownershipTransferTestKit");
const { IOS_FIREBASE_APP_ID, ANDROID_FIREBASE_APP_ID } = require("./appCheckPlatform");
const UID="private-uid-abcdef", A="550e8400-e29b-41d4-a716-446655440000", B="6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const trace="og-123456789-1", logs=[];
const logger={info:(tag, fields)=>logs.push({tag,...fields}),warn() {},error() {}};
const request=(platform,mode="os_check")=>({auth:{uid:UID},app:{appId:platform==="ios"?IOS_FIREBASE_APP_ID:ANDROID_FIREBASE_APP_ID},
 data:{deviceId:B,platform,modelName:"test",appVersion:"6.0.0",buildNumber:"477",mode,claimGeneration:1,osGateTraceId:trace,expectedUid:UID}});
(async()=>{
 let count=0;
 for(const from of ["ios","android"]) for(const to of ["ios","android"]) for(const state of ["active","expired"]) {
  const db=makeDb({[`users/${UID}`]:{activeDeviceId:A,pendingActiveDeviceId:B,pendingActiveClaimGeneration:1,fcmToken:"PRIVATE_OLD_NOTIFICATION_TOKEN",
    subscriptions:{[to]:{status:state,expiryTime:new Date(Date.now()+86400000).toISOString()}}},
    [`users/${UID}/devices/${A}`]:{platform:from,platformAppCheckVerified:true,fcmToken:"PRIVATE_OLD_DEVICE_TOKEN"}});
  const ownToken="fixture-os-owned", ownId=to === "ios" ? require("./subscriptionOwnership").buildIosOwnershipId(ownToken) : require("./subscriptionOwnership").buildAndroidOwnershipId(ownToken);
  db.docs.get(`users/${UID}`).subscriptions[to][to === "ios" ? "originalTransactionId" : "primaryPurchaseToken"]=ownToken;
  db.docs.set("subscription_ownership/"+ownId,{ownerUid:UID});
  const before=snapshotOf(db);const handler=createClaimActiveDeviceHandler({admin:adminFor(db),logger});
  const decision=await handler(request(to));
  assert.equal(decision.allowed,from===to);assert.equal(decision.osCheck,true);assert.equal(decision.osGateTraceId,trace);
  assert.equal(decision.currentOs,to);assert.equal(decision.registeredOs,from);assert.equal(snapshotOf(db),before,"first check is read-only");
  if(from!==to){await assert.rejects(handler(request(to,"confirmed")),e=>e.details?.code==="OS_GATE_CROSS_OS");assert.equal(snapshotOf(db),before,"second rejection preserves all contract/device/FCM state");}
  else if(state==="active"){await handler(request(to,"confirmed"));assert.equal(db.docs.get(`users/${UID}`).activeDeviceId,B);}
  count++;
 }
 for(const shape of [null,{}, {platform:"ios"},{platform:"ios",platformAppCheckVerified:false},{platform:"unknown",platformAppCheckVerified:true}]){
  const initial={[`users/${UID}`]:{activeDeviceId:A,pendingActiveDeviceId:B,pendingActiveClaimGeneration:1,subscriptions:{ios:{status:"active",expiryTime:new Date(Date.now()+86400000).toISOString()}}}};if(shape)initial[`users/${UID}/devices/${A}`]=shape;
  const db=makeDb(initial), before=snapshotOf(db), handler=createClaimActiveDeviceHandler({admin:adminFor(db),logger});
  assert.equal((await handler(request("ios"))).reason,"OS_GATE_UNKNOWN");
  await assert.rejects(handler(request("ios","confirmed")), e=>e.details?.code==="OS_GATE_UNKNOWN");assert.equal(snapshotOf(db),before);
  await assert.rejects(handler(request("ios","auto")), e=>e.details?.code==="NEEDS_CONFIRMATION");assert.equal(snapshotOf(db),before);count++;
 }
 const db=makeDb({});const before=snapshotOf(db);
 const fresh=await createClaimActiveDeviceHandler({admin:adminFor(db),logger})(request("ios"));assert.equal(fresh.comparison,"new");assert.equal(snapshotOf(db),before);
 assert.throws(()=>validateClaimActiveDeviceInput(request("ios","os_check_typo").data), /Unknown claim mode/);
 // Require the dedicated public endpoint: older servers cannot interpret this as auto claim.
 const index=fs.readFileSync(require.resolve("./index.js"),"utf8");
 assert.match(index,/exports\.checkDeviceTransferOs = onCall\([\s\S]*?mode: "os_check"/);
 if (process.env.OS_GATE_REQUEST_FIXTURE) {
  const captured=JSON.parse(fs.readFileSync(process.env.OS_GATE_REQUEST_FIXTURE,"utf8"));
  const fixtureDb=makeDb({[`users/${captured.expectedUid}`]:{activeDeviceId:A},[`users/${captured.expectedUid}/devices/${A}`]:{platform:"ios",platformAppCheckVerified:true}});
  const result=await createClaimActiveDeviceHandler({admin:adminFor(fixtureDb),logger})({auth:{uid:captured.expectedUid},app:{appId:IOS_FIREBASE_APP_ID},data:{...captured,mode:"os_check"}});
  assert.equal(result.osGateTraceId,captured.osGateTraceId);assert.equal(result.allowed,true);
  console.log("client→server captured request trace correlation PASS");
 }
 const dump=JSON.stringify(logs);
 for(const secret of [UID,A,B,"PRIVATE_OLD_NOTIFICATION_TOKEN","PRIVATE_OLD_DEVICE_TOKEN"])assert.equal(dump.includes(secret),false);
 for(const event of ["OS_GATE_1_START","OS_GATE_1_ALLOW","OS_GATE_1_REJECT","OS_GATE_1_UNKNOWN","OS_GATE_2_START","OS_GATE_2_ALLOW","OS_GATE_2_REJECT","OS_GATE_2_COMMIT","OS_GATE_2_UNKNOWN"])assert(logs.some(l=>l.event===event),event);
 assert(logs.filter(l=>String(l.event).startsWith("OS_GATE_")).every(l=>l.osGateTraceId===trace));
 console.log(`Build477 OS gate: ${count+2} read-only/final-transaction cases PASS`);
 console.log("KAMOME_BILLING_OS_GATE "+JSON.stringify(logs.find(l=>l.event==="OS_GATE_1_REJECT")));
})().catch(e=>{console.error(e);process.exitCode=1});
