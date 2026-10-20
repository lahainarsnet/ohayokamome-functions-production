const assert = require('node:assert/strict');
const {createClearDeviceFcmTokenHandler} = require('./clearDeviceFcmToken');
const DEVICE = '550e8400-e29b-41d4-a716-446655440000';
const VERSION = '550e8400-e29b-41d4-a716-446655440001';
const NEW = '550e8400-e29b-41d4-a716-446655440002';
const devicePath = `users/a/devices/${DEVICE}`;
function fixture({device = {fcmToken:'same-token', fcmRegistrationId:VERSION, modelName:'keep'},
  user = {fcmToken:'same-token', fcmRegistrationId:VERSION, email:'keep'}, retry} = {}) {
  const docs = new Map([['users/a', user], [devicePath, device]].filter(([,v]) => v));
  function ref(path) {return {path, collection:n => ({doc:id => ref(`${path}/${n}/${id}`)})};}
  const entries = [];
  const admin = { FieldValue:{delete:()=>'DELETE'}, getDb:()=>({
    collection:n=>({doc:id=>ref(`${n}/${id}`)}),
    async runTransaction(fn) {
      let writes;
      const tx = {get:async r=>({exists:docs.has(r.path), data:()=>docs.get(r.path)}),
        set:(r,data)=>writes.push([r.path,data])};
      writes=[]; let result=await fn(tx);
      if(retry){retry(docs);writes=[];result=await fn(tx);}
      for(const [path,data] of writes){const next={...docs.get(path)};
        for(const [k,v] of Object.entries(data)){if(v==='DELETE')delete next[k];else next[k]=v;}
        docs.set(path,next);
      }
      return result;
    }
  })};
  return {docs, entries, handler:createClearDeviceFcmTokenHandler({admin,logger:{info:(...v)=>entries.push(v)}})};
}
const request = {auth:{uid:'a'},data:{deviceId:DEVICE,expectedUid:'a',expectedRegistrationId:VERSION}};
async function run(){
  let cases=0;
  const normal=fixture();assert.equal((await normal.handler(request)).cleared,true);
  assert.deepEqual(normal.docs.get(devicePath),{modelName:'keep'});
  assert.deepEqual(normal.docs.get('users/a'),{email:'keep'});cases++;
  const fresh=fixture({device:{fcmToken:'same-token',fcmRegistrationId:NEW},user:{fcmToken:'same-token',fcmRegistrationId:NEW}});
  assert.equal((await fresh.handler(request)).reason,'registration_changed');
  assert.equal(fresh.docs.get('users/a').fcmToken,'same-token');cases++;
  const raced=fixture({retry:docs=>{for(const key of ['users/a',devicePath]) docs.set(key,{fcmToken:'same-token',fcmRegistrationId:NEW});}});
  assert.equal((await raced.handler(request)).cleared,false);
  assert.equal(raced.docs.get(devicePath).fcmToken,'same-token');cases++;
  const other=fixture({user:{fcmToken:'other-token',fcmRegistrationId:NEW}});
  assert.equal((await other.handler(request)).cleared,true);
  assert.equal(other.docs.get('users/a').fcmToken,'other-token');cases++;
  const missing=fixture({device:null});assert.equal((await missing.handler(request)).reason,'missing_doc');cases++;
  const noVersion=fixture({device:{fcmToken:'same-token'}});assert.equal((await noVersion.handler(request)).cleared,false);cases++;
  for(const invalid of [{auth:null,data:request.data}, {...request,data:{...request.data,expectedUid:'b'}},
    {...request,data:{deviceId:DEVICE}}, {...request,data:{...request.data,deviceId:'bad'}}]){
    await assert.rejects(()=>fixture().handler(invalid));cases++;
  }
  assert.equal(JSON.stringify(normal.entries).includes('same-token'),false);cases++;
  console.log(`clearDeviceFcmToken.test.js: ${cases} cases PASS`);
}
run().catch(e=>{console.error(e);process.exit(1);});
