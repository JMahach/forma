import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../src/application/application.ts';
import {createNavigation} from '../src/platform/browser/navigation.ts';
import type {AccountAccess,AccountBoundaryRequest} from '../src/application/ports.ts';
import {createAccountBoundaryWork} from '../src/application/account-boundary.ts';

const a={accountId:'A',sessionId:'a'},b={accountId:'B',sessionId:'b'};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(withInitialSession=true){
 let access:AccountAccess|null=null;
 const sessionListeners=new Set<(value:AccountAccess|null)=>void>(), logoutListeners=new Set<(ids:readonly string[])=>void>();
 const requests:AccountBoundaryRequest[]=[], completed:string[]=[], releases:(()=>void)[]=[];
 let stops=0,retries=0,failCleanup=false;
 const location={pathname:'/account'};
 const navigation=createNavigation({location,history:{pushState(_s,_t,url){location.pathname=String(url);},replaceState(_s,_t,url){location.pathname=String(url);}},events:new EventTarget()});
 const app=createApplication({runtimeId:'account-boundary-test',navigation,route(){return {enter(){},async prepare(){},apply(){},async failed(){},settled(){},dispose(){}};},account:{
  subscribeSession(listener){sessionListeners.add(listener);if(withInitialSession)listener(access);return()=>{sessionListeners.delete(listener);};},
  subscribeLogout(listener){logoutListeners.add(listener);return()=>{logoutListeners.delete(listener);};},
  begin(request){requests.push(request);const ready=new Promise<void>((resolve,reject)=>releases.push(()=>failCleanup?reject(new Error('cleanup unavailable')):resolve()));
   return {ready,async retry(){retries++;if(failCleanup)throw new Error('cleanup unavailable');},settled(){completed.push(request.logoutIds?'logout':request.access?.accountId??'guest');}};},
  stop(){stops++;},
 }});
 return {app,navigation,requests,completed,releases,session(value:AccountAccess|null){access=value;for(const listener of sessionListeners)listener(value);},
  logout(ids:readonly string[]){for(const listener of logoutListeners)listener(ids);},fail(value:boolean){failCleanup=value;},
  get retries(){return retries;},get stops(){return stops;},get subscriptions(){return sessionListeners.size+logoutListeners.size;}};
}

test('account boundaries handle early logout, preserve A to B to A and reject old completion',async()=>{
 const h=fixture(false);h.app.start();h.logout(['old']);h.releases[0]();await turn();
 h.session(a);h.session(b);h.session(a);
 assert.deepEqual(h.requests.map(request=>request.access?.accountId??null),[null,'A','B','A']);
 h.session({...a});assert.equal(h.requests.length,4);
 h.releases[1]();h.releases[2]();await turn();assert.deepEqual(h.completed,['logout']);
 h.releases[3]();await turn();assert.deepEqual(h.completed,['logout','A']);
 assert.equal(new Set(h.requests.map(request=>request.generation)).size,4);
 await h.app.requestRoute(h.navigation.snapshot);h.session({...a});
 assert.equal(h.requests.length,4,'routing must preserve the account boundary actor');
 await h.app.stop();assert.equal(h.subscriptions,0);assert.equal(h.stops,1);
});

test('failed logout cleanup retries its existing work and cannot complete after stop',async()=>{
 const h=fixture();h.app.start();h.releases[0]();await turn();
 h.session(a);h.releases[1]();await turn();
 h.logout(['unrelated']);assert.equal(h.requests.length,2);
 h.logout(['a']);h.fail(true);h.releases[2]();await turn();
 assert.deepEqual(h.completed,['guest','A']);
 h.fail(false);h.app.send({type:'RetryAccountBoundary'});await turn();
 assert.equal(h.requests.length,3,'retry must not repeat the boundary resets');
 assert.equal(h.retries,1);assert.deepEqual(h.completed,['guest','A','logout']);
 h.logout(['a']);assert.equal(h.requests.length,3,'completed logout is idempotent');
 h.session(b);await h.app.stop();await h.app.stop();h.releases[3]();await turn();
 assert.deepEqual(h.completed,['guest','A','logout']);assert.equal(h.stops,1);
});

test('cleanup retries only unfinished stores and writes the current snapshot without another reset',async()=>{
 let clears=0,connections=0,resets=0,retries=0,libraryRetries=0,logouts=0,flushes=0;
 let libraryAvailable=false,personalAvailable=false,snapshotAvailable=false,current='old';
 const written:string[]=[];
 const work=createAccountBoundaryWork({runtimeId:'cleanup',generation:1,access:null,previous:a,logoutIds:['a']},{
  library:{accountId:'A',async connect(){connections++;},async clear(){clears++;return {accountId:'A',status:'unavailable'};},
   async retryClear(id){assert.equal(id,'A');libraryRetries++;return libraryAvailable?'cleared':'unavailable';}},
  calculations:{async resetPersonal(){resets++;return {status:'unavailable'};},
   async retryPersonalCleanup(){retries++;return {status:personalAvailable?'cleared':'unavailable'};}},
  pendingWrites:[],boundAccount:null,enter(){},logout(){logouts++;return false;},
  switchAccount(){assert.fail('logout must not repeat account switching');},
  flushSnapshot(){flushes++;written.push(current);return snapshotAvailable;},settled(){},
 });
 await assert.rejects(work.ready,{code:'storage_unavailable'});
 await assert.rejects(work.retry(),{code:'storage_unavailable'});
 assert.equal(retries,0);assert.equal(flushes,0,'later stages wait for successful library cleanup');
 libraryAvailable=true;await assert.rejects(work.retry(),{code:'storage_unavailable'});
 personalAvailable=true;current='new';await assert.rejects(work.retry(),{code:'storage_unavailable'});
 snapshotAvailable=true;await work.retry();
 assert.deepEqual({clears,connections,resets,retries,libraryRetries,logouts,flushes},
  {clears:1,connections:0,resets:1,retries:3,libraryRetries:2,logouts:1,flushes:2});
 assert.deepEqual(written,['new','new'],'retry reads current tab state instead of replaying the logout snapshot');
});
