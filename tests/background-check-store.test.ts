import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import type {BackgroundControl,CheckPermit,CheckRecord} from '../src/domain/background-check.ts';

const permit:CheckPermit={key:'library:1',token:'run-a',owner:'tab-a',startedAt:100,expiresAt:200,sessionId:'session-a'};
function record():CheckRecord {return {target:{key:'library:1',scope:{kind:'library',accountId:'1'},sessionId:'session-a'},
 lastAttemptAt:100,lastSuccessAt:null,nextDueAt:3600100,retryNotBefore:0,permit:{...permit}};}
function stores(t:test.TestContext) {
 const indexedDB=new IDBFactory(),a=createAccountLibraryStore({indexedDB,now:()=>150}),b=createAccountLibraryStore({indexedDB,now:()=>150});
 t.after(()=>{a.close();b.close();});return {indexedDB,a,b};
}
async function rawControl(indexedDB:IDBFactory,value:unknown) {
 const open=indexedDB.open('forma-account-library');
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);});
 try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('context','readwrite');tx.objectStore('context').put(value);
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}

test('background control is isolated, shared and returned only after atomic persistence',async t=>{
 const {a,b}=stores(t);assert.ok(a.background,'the library must expose its shared coordination store');
 assert.deepEqual(await a.background.read(),{leader:null,checks:{}});
 const results=await Promise.all([a,b].map(store=>store.background.update(control=>{
  if(control.leader)return false;
  control.leader={owner:'tab-a',token:'role-a',expiresAt:400};control.checks['library:1']=record();return true;
 })));
 assert.deepEqual(results,[true,false]);
 const read=await a.background.read();assert.ok(read);read.checks['library:1']!.nextDueAt=0;
 assert.equal((await b.background.read())!.checks['library:1']!.nextDueAt,3600100);
 let writes=0;const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){writes++;return put.apply(this,args);};
 try{assert.equal(await b.background.update(control=>control.checks['library:1']!.nextDueAt),3600100);}
 finally{IDBObjectStore.prototype.put=put;}
 assert.equal(writes,0,'checking an existing owner must not rewrite control');
 await a.activate('1');await a.clearAccount('1');
 assert.equal((await b.background.read())!.leader!.token,'role-a','account cleanup must not erase application coordination');
});

test('failed control commits return null and retain prior rights',async t=>{
 const {a,b}=stores(t);assert.ok(a.background);
 await a.background.update(control=>{control.checks['library:1']=record();});
 const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='context' && value.key==='background-checks')throw new DOMException('full','QuotaExceededError');return put.call(this,value,...args);};
 try{assert.equal(await a.background.update(control=>{control.checks={};return 'claimed';}),null);}
 finally{IDBObjectStore.prototype.put=put;}
 assert.equal((await b.background.read())!.checks['library:1']!.permit!.token,'run-a');
 assert.equal(await a.background.update(()=>{throw new Error('policy failed');}),null);
 const absent=createAccountLibraryStore({indexedDB:null});t.after(()=>absent.close());
 assert.equal(await absent.background.read(),null);assert.equal(await absent.background.update(()=>true),null);
});

test('damaged control cannot be treated as empty or silently grant new rights',async t=>{
 const {a,indexedDB}=stores(t);assert.ok(a.background);await a.background.read();
 const valid:BackgroundControl={leader:null,checks:{'library:1':record()}};
 const invalid=[null,{leader:null,checks:[]},{...valid,leader:{owner:'',token:'role',expiresAt:200}},
  {...valid,checks:{'wrong-key':record()}},
  {...valid,checks:{'library:1':{...record(),target:{...record().target,scope:{kind:'library',accountId:'2'}}}}},
  {...valid,checks:{'library:1':{...record(),target:{...record().target,scope:{kind:'app'}}}}},
  {...valid,checks:{'library:1':{...record(),target:{...record().target,scope:{kind:'public',chartId:'1234567890'}}}}},
  {...valid,checks:{'library:1':{...record(),target:{...record().target,scope:{kind:'other'}}}}},
  {...valid,checks:{'library:1':{...record(),target:{...record().target,scope:{kind:'library',accountId:'bad'}}}}},
  {...valid,checks:{'library:1':{...record(),target:{...record().target,scope:{kind:'public',chartId:'bad/id'}}}}},
  {...valid,checks:{'library:1':{...record(),nextDueAt:Infinity}}},
  {...valid,checks:{'library:1':{...record(),permit:{...permit,expiresAt:100}}}},
  {...valid,checks:{'library:1':{...record(),permit:{...permit,sessionId:'other'}}}}];
 for(const value of invalid){
  await rawControl(indexedDB,{key:'background-checks',value});
  assert.equal(await a.background.read(),null);let ran=false;
  assert.equal(await a.background.update(()=>{ran=true;return true;}),null);assert.equal(ran,false);
 }
});
test('app, account and public deadlines remain distinct across reopening',async t=>{
 const {a,b}=stores(t);
 const app:CheckRecord={target:{key:'app',scope:{kind:'app'}},lastAttemptAt:0,lastSuccessAt:0,nextDueAt:10,retryNotBefore:0,
  permit:{key:'app',owner:'tab-a',token:'app-run',startedAt:100,expiresAt:200}};
 const publicCheck:CheckRecord={...app,target:{key:'public:1234567890',scope:{kind:'public',chartId:'1234567890'},instance:'opening-one'},permit:undefined,nextDueAt:20};
 assert.equal(await a.background.update(control=>{control.checks={app,'public:1234567890':publicCheck,'library:1':{...record(),blockedSessionId:'old-session'}};return 'saved';}),'saved');
 a.close();const result=await b.background.read();assert.ok(result);
 assert.equal(result.checks.app!.nextDueAt,10);assert.equal(result.checks['public:1234567890']!.nextDueAt,20);
 assert.equal(result.checks['public:1234567890']!.target.instance,'opening-one');
 assert.equal(result.checks['library:1']!.blockedSessionId,'old-session');
});
