import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore,IDBDatabase} from 'fake-indexeddb';
import {claimCheck,finishCheck,samePermit} from '../src/domain/background-policy.ts';
import type {BackgroundStore,CheckTarget} from '../src/domain/background-check.ts';
import type {BackgroundCoordinator,BackgroundRequest} from '../src/application/background-work.ts';
import {createBackgroundCoordinator} from '../src/platform/browser/background-coordinator.ts';
import {createRenderState} from '../src/scene/render-state.ts';
import {cardSourceKey} from '../shared/library-package-contract.ts';
import {createApplication,type Application} from '../src/application/application.ts';
import {createAccountClient} from '../src/data/account-client.ts';
import {createAccountLogoutStore} from '../src/data/account-logout-store.ts';
import {createAccountSession} from '../src/state/account-session.ts';
import {createAccountLibraryStore} from '../src/data/account-library-store.ts';
import {createAccountLibrary} from '../src/state/account-library.ts';
import {createChartClient} from '../src/data/chart-client.ts';
import {createChartStore} from '../src/data/chart-store.ts';
import {createChartActions} from '../src/state/chart-actions.ts';
import {createChartSession} from '../src/state/chart-session.ts';
import {createViewStore} from '../src/data/view-store.ts';
import {createViewCheckpoint} from '../src/state/view-checkpoint.ts';
import {createViewSession,viewForRoute} from '../src/state/view-session.ts';
import {createLiveTransit} from '../src/state/live-transit.ts';
import {createNatalDayExplorer} from '../src/state/natal-day.ts';
import {createTransitPlanetFilter} from '../src/state/transit-planets.ts';
import {createWorkspaceState} from '../src/state/workspace.ts';
import {createNavigation} from '../src/platform/browser/navigation.ts';
import {accountChart,chartId} from './helpers/account-chart.ts';
import type {SavedChart} from '../shared/chart-types.ts';
import type {ChartWriteIntent} from '../shared/chart-record-contract.ts';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(ready:()=>boolean,label:string){
 for(let turn=0;turn<100 && !ready();turn++)await tick();
 assert.ok(ready(),label);
}
type Coordination='shared'|'single'|'unavailable';
const now=Date.parse('2000-01-01T12:00:00Z'),sessionId=chartId(80);
// Test host: one bounded check per target/session, real durable permits, no leader election.
function singleCoordinator(store:BackgroundStore,online:()=>boolean):BackgroundCoordinator {
 let running=false,targets:readonly CheckTarget[]=[],receive:(request:BackgroundRequest)=>void=()=>{},queue=Promise.resolve();
 const issued=new Set<string>(),flights=new Map<string,AbortController>(),owner=crypto.randomUUID();
 const key=(target:CheckTarget)=>JSON.stringify([target.key,target.sessionId,target.instance]);
 const present=(target:CheckTarget)=>targets.some(next=>key(next)===key(target));
 return {
  start(listener){running=true;receive=listener;},
  update(next){
   targets=next;
   for(const [id,control] of flights)if(!targets.some(target=>key(target)===id))control.abort();
   for(const target of targets){
    const id=key(target);if(!running||!online()||issued.has(id))continue;issued.add(id);
    queue=queue.then(async()=>{
     if(!running||!online()||!present(target))return;
     const permit=await store.update(control=>claimCheck(control,target,owner,now,'changed',crypto.randomUUID()));
     if(!permit)return;
     const control=new AbortController();flights.set(id,control);let finished=false;
     const current=async()=>{const saved=await store.read();return running&&online()&&present(target)&&!control.signal.aborted&&!finished
      &&now<permit.expiresAt&&samePermit(saved?.checks[target.key]?.permit,permit);};
     if(!running||!present(target))control.abort();
     receive({kind:'check',target,authority:{permit,signal:control.signal,current},finish(result){
      if(finished)return;finished=true;flights.delete(id);
      queue=queue.then(async()=>{await store.update(value=>finishCheck(value,permit,control.signal.aborted?{kind:'cancelled'}:result.outcome,now));});
     }});
    });
   }
  },
  stop(){running=false;targets=[];for(const control of flights.values())control.abort();flights.clear();},
 };
}
function world(t:TestContext,coordination:Coordination){
 const chart=accountChart(7),{accountId:_,note:__,noteRevision:___,publicRevision:____,...publicChart}=chart;
 const {id:_id,accountId:_account,revision:_revision,noteRevision:_note,publicRevision:_public,...ready}=chart;
 const temporary:SavedChart={...ready,id:'temporary-ready',createdAt:'',updatedAt:''};
 const state={signedIn:false,online:true,loseWrite:false,committed:false,sessionId,intent:null as ChartWriteIntent|null,postReply:Promise.resolve()};
 const records=new Map<string,ReturnType<typeof accountChart>>();
 const counts={writes:0,recordWrites:0,calculations:0,chartUpdates:0,libraryUpdates:0};
 // Count completed IDB writes, not attempted calls or application events. Setup happens before runtime tracking.
 let tracking=false,transactions=0;
 const transaction=IDBDatabase.prototype.transaction;
 t.mock.method(IDBDatabase.prototype,'transaction',function(this:IDBDatabase,...args:Parameters<typeof transaction>){
  const tx=transaction.apply(this,args);transactions++;
  const finished=()=>{transactions--;};tx.addEventListener('complete',finished,{once:true});tx.addEventListener('abort',finished,{once:true});return tx;
 });
 for(const method of ['put','add','delete','clear'] as const){
  const original=IDBObjectStore.prototype[method];
  t.mock.method(IDBObjectStore.prototype,method,function(this:IDBObjectStore,...args:Parameters<typeof original>){
   const request=Reflect.apply(original,this,args) as IDBRequest;
   if(tracking)this.transaction.addEventListener('complete',()=>{
    if(!request.error){counts.writes++;if(this.name==='charts'&&(method==='put'||method==='add'))counts.recordWrites++;}
   },{once:true});
   return request;
  });
 }
 const protocolErrors:unknown[]=[],requests:{method:string;path:string}[]=[],storage=new Map<string,string>(),indexedDB=new IDBFactory();
 const confirmed=()=>({account:{id:'1',email:'a@example.org',telegramLinked:false,telegramHandle:null},session:{id:state.sessionId,expiresAt:now+86400000}});
 const receipt=()=>({kind:'created',chartId:chart.id,revision:chart.revision,chart,catalogMarker:'1'});
 const fetch:typeof globalThis.fetch=async(input,options)=>{
  const url=new URL(String(input),'https://forma.test'),path=url.pathname,method=options?.method??'GET';requests.push({method,path});
  try{
  assert.equal(state.online,true,'offline opening must not reach HTTP');
  const body=typeof options?.body==='string'?JSON.parse(options.body):null;
  switch(path){
   case '/api/account':return Response.json(state.signedIn?confirmed():{account:null,session:null});
   case '/api/auth/email/start':state.sessionId=chartId(Number.parseInt(state.sessionId,16)+1);return Response.json({delivery:'queued',attempt:{id:state.sessionId,expiresAt:now+600000,codeExpiresAt:now+300000,resendAt:now+1000}});
   case '/api/auth/email/verify':return Response.json({attemptId:state.sessionId,needsConfirmation:true});
   case '/api/auth/confirm':state.signedIn=true;return Response.json(confirmed());
   case '/api/auth/logout':state.signedIn=false;return Response.json({closed:true,contextId:body.sessionId});
   case '/api/charts/catalog':{
    assert.equal(state.signedIn,true);assert.equal(url.searchParams.get('accountId'),'1');
    const marker=String(records.size);
    if(url.searchParams.get('knownMarker')===marker)return Response.json({kind:'unchanged',accountId:'1',marker});
    const entries=[...records.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(({id,revision,name,source,birthDate,birthTime})=>{
     const entry={id,revision,name,source,birthDate,birthTime};return {...entry,packages:{card:{kind:'card',sourceKey:cardSourceKey(entry)},day:null,majorReturns:null}};
    });
    return Response.json({kind:'page',accountId:'1',marker,entries,nextCursor:null});
   }
   case '/api/charts/catalog/confirm':return Response.json({kind:'confirmed',accountId:'1',marker:String(records.size)});
   case '/api/charts':
    assert.equal(method,'POST');assert.equal(body.expectedAccountId,'1');assert.equal('activations' in body,false);
    state.committed=true;records.set(chart.id,chart);state.intent={operationId:body.operationId,expectedAccountId:body.expectedAccountId};
    await state.postReply;
    if(state.loseWrite){state.loseWrite=false;throw new TypeError('reply lost after commit');}
    return Response.json(receipt());
   case '/api/charts/'+chart.id:
   case '/api/charts/'+chartId(8):{const row=records.get(path.split('/').at(-1)!);assert.ok(row);return Response.json({chart:row,catalogMarker:String(records.size)});}
   case '/api/shared-charts/'+chart.id:return Response.json({chart:publicChart});
   default:
    if(path==='/api/charts/operations/'+state.intent?.operationId){assert.equal(method,'GET');assert.equal(state.committed,true);return Response.json(receipt());}
    assert.fail('unexpected HTTP: '+method+' '+path);
  }
  }catch(error){if(error instanceof assert.AssertionError)protocolErrors.push(error);throw error;}
 };
 return {chart,temporary,publicChart,state,requests,storage,indexedDB,fetch,records,counts,protocolErrors,coordination,busy:()=>transactions>0,track(){tracking=true;}};
}
type World=ReturnType<typeof world>;
async function runtime(t:TestContext,w:World,path='/chart'){
 w.track();const counts=w.counts,notices:string[]=[],logout=new Set<(ids:readonly string[])=>void>();
 const viewStore=createViewStore({getStorage:()=>({getItem:key=>w.storage.get(key)??null,setItem:(key,value)=>{w.storage.set(key,value);},removeItem:key=>{w.storage.delete(key);}})});
 if(!viewStore.read())viewStore.write({version:1,selectedId:w.temporary.id,temporaryChart:w.temporary,workspace:'chart'});
 const saved=viewStore.read(),chartStore=createChartStore({initialTemporaryChart:saved?.temporaryChart,initialPublicChart:saved?.publicChart});
 const account=createAccountSession({client:createAccountClient({fetch:w.fetch,now:()=>now}),logoutStore:createAccountLogoutStore({indexedDB:w.indexedDB}),
  connection:()=>w.state.online?'online':'offline',notify(notice){if(notice.kind==='logout')for(const listener of logout)listener(notice.ids);}});
 const accountReady=account.refresh();
 const client=createChartClient({fetch:w.fetch,getSession:account.getSession});
 const database=createAccountLibraryStore({indexedDB:w.indexedDB,now:()=>now});
 const library=createAccountLibrary({storage:database,client,online:()=>w.state.online});
 const location={pathname:path},events=new EventTarget(),history=[path];let index=0;
 const navigation=createNavigation({location,events,
  history:{pushState(_data,_unused,url){location.pathname=String(url);history.splice(++index,Infinity,location.pathname);},
   replaceState(_data,_unused,url){location.pathname=String(url);history[index]=location.pathname;}}});
 let lifecycleChanged:(returned:boolean)=>void=()=>{},shortTimers=0;
 const coordinator=w.coordination==='single'?singleCoordinator(database.background,()=>w.state.online):createBackgroundCoordinator({owner:crypto.randomUUID(),store:database.background,
  channel:w.coordination==='unavailable'?null:{postMessage(){},close(){},addEventListener(){},removeEventListener(){}},
  lifecycle:{get active(){return w.state.online;},subscribe(listener){lifecycleChanged=listener;return()=>{lifecycleChanged=()=>{};};}},clock:{now:()=>now,after(ms,callback){
   // Advance the initial rendezvous only; hourly time is frozen in this acceptance profile.
   if(ms>25)return()=>{};shortTimers++;let pending=true;
   const task=setImmediate(()=>{pending=false;shortTimers--;callback();});
   return()=>{if(pending){pending=false;shortTimers--;clearImmediate(task);}};
  }}});
 const workspace=createWorkspaceState(),planetFilter=createTransitPlanetFilter();
 const transit=createLiveTransit({now:()=>now,timeZone:()=> 'UTC',isVisible:()=>workspace.screen==='chart',
  dayClient:{async getDay(){counts.calculations++;assert.fail('ready charts need no transit calculation');}}});
 const natalDay=createNatalDayExplorer({connection:()=>w.state.online?'online':'offline',
  dayClient:{async getDay(){counts.calculations++;assert.fail('opening a card must not calculate its day');}}});
 let shown:{id:string|null;utc:string|undefined;state:ReturnType<typeof createRenderState>}|null=null;
 const session=createChartSession({store:chartStore,initialSelectedId:saved?.selectedId,getTransit:()=>transit,getNatalDay:()=>natalDay,
  onChange(){const chart=session.current;shown={id:chart.id,utc:chart.utc,state:createRenderState(chart,null,{})};counts.chartUpdates++;}});
 const checkpoint=createViewCheckpoint({store:viewStore,eventTarget:null,interactionTarget:null});
 let app:Application|undefined,view:ReturnType<typeof createViewSession>;
 const actions=createChartActions({client,library,getSession:account.getSession,newId:()=>chartId(90),initialPending:saved?.pendingChartWrites,
  prepareWrite:()=>view.checkpoint('write'),onPending:()=>{view?.flush();}});
 view=createViewSession({store:{read:()=>viewForRoute(navigation.snapshot.route,saved),write:viewStore.write},checkpoint,
  chartStore,session,workspace,transit,natalDay,planetFilter,eventTarget:null,interactionTarget:null,
  mandala:{enabled:false,restore(){}},camera:{getSavedView:()=>({x:0,y:0,k:1}),restoreView:()=>true},
  getPendingChartWrites:()=>[...actions.pending],getTemporaryChartSave:()=>app?app.write.binding:saved?.temporaryChartSave,
  onInterrupt:()=>app?.send({type:'StartupInterrupted'})});
 const emptyForm={pending:null,snapshot:null,opened:false,clearPending(){},discardInput(){},close(){},restore(){},refresh(){}};
 app=createApplication({runtimeId:crypto.randomUUID(),navigation,
  background:{coordinator,clock:{now:()=>now},library,release:null,journal:null,
   environment:{visible:()=>true,online:()=>w.state.online,connected:()=>w.state.online,busy:()=>false,transitTimeZone:()=>undefined},
   local:{changed(){},broadcast(){}}},
  account:{ready:accountReady,getSession:account.getSession,subscribeSession:account.subscribeSession,
   subscribeLogout(listener){logout.add(listener);return()=>{logout.delete(listener);};},library,writes:actions,
   binding:{get accountId(){return app?.write.binding?.expectedAccountId??null;},clear(){app?.send({type:'ClearTemporaryWrite'});}},
   form:emptyForm,editing:{reset(){}},checkpoint:{clearPersonal:()=>checkpoint.clearPersonal({temporaryChart:chartStore.temporaryChart,publicChart:chartStore.publicChart,selectedId:session.selectedId}),flush:view.flush},
   changed(){},storageUnavailable(){assert.fail('fakeIDB must be available');}},
  libraryProjection:{library,sources:chartStore,selection:session,form:emptyForm,
   view:{isChartScreen:()=>workspace.screen==='chart',changeChart:session.select,library(){counts.libraryUpdates++;},checkpoint:view.flush}},
  route:{library,sources:chartStore,session,online:()=>w.state.online,now:()=>now,readPublic:client.public,observe:()=>null,
   view:{workspace:workspace.setScreen,select:session.select,resetCamera(){},edit(){assert.fail('no edit');},interrupt:view.interrupt,
    settled(){},checkpoint:view.flush,report(error){notices.push(String(error));},firstTransit:()=>transit.start(null,{firstChart:true}),transitReady(){}}},
  startup:{library,view,form:emptyForm,report(){notices.push('restore failed');},changed(){}},
  write:{actions,online:()=>w.state.online,getSession:account.getSession,selection:session,temporary:()=>chartStore.temporaryChart,
   hasOwn:id=>!!library.get(id),initialBinding:saved?.temporaryChartSave??null,
   retire(source){chartStore.clearTemporary(source.id);chartStore.releasePublicSource(source);},public:client.public,acceptPublic:chartStore.acceptPublic,clearPublic:chartStore.clearPublic,
   view:{isChartScreen:()=>workspace.screen==='chart',showChart:()=>workspace.setScreen('chart'),changeChart:session.select,refresh(){},changed(){},checkpoint:view.flush,
    report(kind){notices.push(kind);}}},
  update:{restored:()=>session.hasCurrent,ready:()=>!account.flow.state.busy,selection:()=>session.selectedId,
   sources:{get temporaryId(){return chartStore.temporaryChart?.id??null;},get publicId(){return chartStore.publicChart?.id??null;},hasOwn:id=>!!library.get(id),canRestore:library.canRestore},checkpoint:view.flush},
 });
 const application=app,unsubscribe=library.subscribe(()=>application.libraryChanged());let stopped=false;
 async function stop(){if(stopped)return;stopped=true;view.flush();application.requestStop();unsubscribe();checkpoint.destroy();transit.stop();natalDay.select(null);account.destroy();library.close();navigation.destroy();}
 t.after(stop);application.start();await application.whenStartupSettled();assert.deepEqual(application.startup,{settled:true,failed:false});
 return {app:application,coordination:w.coordination,database,protocolErrors:w.protocolErrors,get shown(){return shown;},library,chartStore,session,account,actions,view,viewStore,workspace,navigation,counts,notices,stop,
  back(){assert.ok(index>0);location.pathname=history[--index];events.dispatchEvent(new Event('popstate'));},
  async settled(){
   await application.whenBackgroundIdle();await actions.whenIdle();let quiet=0;
   for(let turn=0;turn<200&&quiet<3;turn++){await tick();quiet=w.busy()||shortTimers?0:quiet+1;}
   assert.equal(quiet,3,'initial work settles without an endless short queue');
   await application.whenBackgroundIdle();await actions.whenIdle();
  },
  offline(){w.state.online=false;lifecycleChanged(false);application.environmentChanged({reason:'connection'});},
  async login(){await account.flow.begin();account.flow.input('email','a@example.org');await account.flow.submit();
   assert.equal(account.flow.state.step,'code');account.flow.input('code','123456');await account.flow.submit();assert.equal(account.getSession()?.accountId,'1');await until(()=>application.account.status==='ready'&&application.account.access?.sessionId===account.getSession()?.sessionId,'core observes the new login');},
  chartCounts(){return {http:w.requests.length,post:w.requests.filter(r=>r.method==='POST'&&r.path==='/api/charts').length,
   outcome:w.requests.filter(r=>r.path.startsWith('/api/charts/operations/')).length,
   own:w.requests.filter(r=>/^\/api\/charts\/[0-9a-f]{32}$/.test(r.path)).length,public:w.requests.filter(r=>r.path==='/api/shared-charts/'+w.chart.id).length,
   ...counts};},
 };
}

// The same scenarios run through the real coordinator, including its channel-unavailable path.
// Budgets bound observable work; no count depends on internal machine event traffic.
for(const coordination of ['shared','single','unavailable'] as const){
 test(`${coordination}: guest Save continues after real login exactly once`,async t=>{
  const w=world(t,coordination),h=await runtime(t,w);assert.equal(h.session.selectedId,w.temporary.id);
  await h.app.requestSave(h.chartStore.temporaryChart!);
  assert.equal(h.app.write.waitingForLogin,true);assert.equal(h.workspace.screen,'account');
  assert.equal(h.chartCounts().post,0);
  await h.login();await until(()=>h.session.selectedId===w.chart.id&&!h.app.write.busy,'automatic Save continuation');await h.settled();
  assert.equal(h.shown?.id,w.chart.id);assert.equal(h.shown?.utc,w.chart.utc);
  assert.equal(h.chartStore.temporaryChart,null);assert.equal(h.library.get(w.chart.id)?.name,w.chart.name);
  assert.deepEqual(h.navigation.snapshot.route,{kind:'chart',id:w.chart.id});assert.deepEqual(h.notices,[]);
  const before=h.chartCounts(),control=new AbortController();
  assert.equal(await h.app.prepareUpdate(control.signal),true);control.abort();await h.settled();
  assert.equal(h.viewStore.read()?.selectedId,w.chart.id);assert.deepEqual(h.viewStore.read()?.pendingChartWrites,[]);
  assert.equal(h.viewStore.read()?.temporaryChart,null);
  for(const key of ['post','outcome','own','public','calculations','chartUpdates'] as const)assert.equal(h.chartCounts()[key],before[key],key+' during update');check(t,h,'login');
 });
 test(`${coordination}: unknown Save survives only through durable state into new owners`,async t=>{
  const w=world(t,coordination);w.state.signedIn=true;w.state.loseWrite=true;
  const first=await runtime(t,w);await first.settled();await first.app.requestSave(first.chartStore.temporaryChart!);
  assert.deepEqual(first.notices,['unconfirmed']);assert.equal(first.actions.pending.length,1);
  assert.equal(await first.app.prepareUpdate(),true);assert.equal(first.viewStore.read()?.temporaryChartSave?.sourceId,w.temporary.id);
  await first.stop();const postBefore=w.requests.filter(r=>r.method==='POST'&&r.path==='/api/charts').length;
  const next=await runtime(t,w);
  for(const key of ['app','library','chartStore','session','account','actions','view','viewStore'] as const)assert.notEqual(next[key],first[key],key+' must be a fresh owner');
  await until(()=>next.session.selectedId===w.chart.id&&!next.app.write.recovering,'automatic outcome reconciliation');await next.settled();
  assert.equal(next.shown?.id,w.chart.id);
  assert.deepEqual(next.actions.pending,[]);assert.equal(next.app.write.binding,null);assert.equal(next.chartStore.temporaryChart,null);
  assert.equal(next.chartCounts().post,postBefore);assert.deepEqual(next.notices,[]);
  assert.equal(await next.app.prepareUpdate(),true);assert.equal(next.viewStore.read()?.selectedId,w.chart.id);check(t,next,'recovered');
 });
 test(`${coordination}: A → B → Back restores A; offline reopening does no HTTP or calculation`,async t=>{
  const w=world(t,coordination);w.state.signedIn=true;const second=accountChart(8);second.utc='2000-01-01T13:00:00Z';second.birthTime='13:00';
  second.personality=[...second.personality.slice(0,-1),40];
  second.activations.personality=second.activations.personality.map((value,index)=>index===12?{...value,gate:40}:value);
  w.records.set(w.chart.id,w.chart);w.records.set(second.id,second);
  const store=createAccountLibraryStore({indexedDB:w.indexedDB}),active=await store.activate('1');
  assert.equal(active.status,'stored');if(active.status!=='stored')throw Error('owner');
  await store.put(active.lease,[w.chart,second],'2');store.close();
  const h=await runtime(t,w,'/chart/'+w.chart.id);await h.settled();
  assert.equal(h.session.record?.name,w.chart.name);await h.app.openChart(second.id);await h.settled();assert.equal(h.session.selectedId,second.id);
  assert.equal(h.shown?.id,second.id);assert.equal(h.shown?.utc,'2000-01-01T13:00:00Z');assert.ok(h.shown?.state.personality.has(40));
  h.back();await until(()=>h.app.view.destination==='ready'&&h.session.selectedId===w.chart.id,'Back selects A');await h.settled();
  assert.equal(h.session.record?.name,w.chart.name);assert.equal(h.session.current.id,w.chart.id);
  assert.equal(h.shown?.id,w.chart.id);assert.equal(h.shown?.utc,'2000-01-01T12:00:00Z');assert.equal(h.shown?.state.personality.has(40),false);
  const before=w.requests.length;h.offline();
  h.app.navigateWorkspace('charts');h.navigation.navigate({kind:'chart',id:w.chart.id});
  await until(()=>h.app.view.destination==='ready'&&h.workspace.screen==='chart','offline opening');await h.settled();
  assert.equal(h.session.selectedId,w.chart.id);assert.equal(w.requests.length,before);assert.deepEqual(h.notices,[]);
  assert.equal(await h.app.prepareUpdate(),true);check(t,h,'navigation');
 });
 test(`${coordination}: public card reopens offline without HTTP or calculations`,async t=>{
  const w=world(t,coordination),h=await runtime(t,w,'/chart/'+w.chart.id);await h.settled();
  assert.equal(h.session.selectedId,w.chart.id);const before=w.requests.length;h.offline();
  h.app.navigateWorkspace('charts');h.navigation.navigate({kind:'chart',id:w.chart.id});
  await until(()=>h.app.view.destination==='ready'&&h.workspace.screen==='chart','offline public opening');await h.settled();
  assert.equal(h.session.selectedId,w.chart.id);assert.equal(w.requests.length,before);assert.deepEqual(h.notices,[]);
  assert.equal(await h.app.prepareUpdate(),true);check(t,h,'public');
 });
 test(`${coordination}: logout fences late POST; login discovers saved card without a duplicate`,async t=>{
  const w=world(t,coordination);w.state.signedIn=true;
  let release!:()=>void;w.state.postReply=new Promise<void>(resolve=>{release=resolve;});t.after(()=>release());
  const h=await runtime(t,w);await h.settled();const saving=h.app.requestSave(h.chartStore.temporaryChart!);
  await until(()=>w.state.committed,'server committed before logout');
  assert.equal(await h.app.prepareUpdate(),false,'in-flight Save prevents update');
  await h.account.flow.logout();
  await until(()=>h.app.account.status==='ready'&&h.app.account.access===null&&h.library.accountId===null,'core observes logout');
  assert.equal(h.library.accountId,null);assert.deepEqual(h.actions.pending,[]);
  const writesAtLogout=w.counts.recordWrites;release();await saving;await h.settled();
  assert.equal(h.library.get(w.chart.id),undefined);assert.equal(h.chartStore.get(w.chart.id),undefined);
  assert.notEqual(h.session.selectedId,w.chart.id);assert.equal(w.counts.recordWrites,writesAtLogout,'late receipt must not write cleared personal data');
  const durable=await h.database.read();assert.deepEqual(durable?.charts,[]);assert.equal(durable?.lease,null);
  await h.login();await until(()=>!!h.library.entries.find(row=>row.id===w.chart.id),'new login reconciles the server catalogue');await h.settled();
  await h.app.openChart(w.chart.id);await h.settled();assert.equal(h.session.selectedId,w.chart.id);
  assert.equal(h.library.charts.length,1);assert.equal(w.records.size,1);assert.deepEqual(h.actions.pending,[]);assert.deepEqual(h.notices,[]);
  assert.equal(await h.app.prepareUpdate(),true);check(t,h,'logout');
 });
}
const rules={
 login:{post:1,outcome:0,own:0,public:0,http:{shared:7,single:7,unavailable:7},writes:20,recordWrites:1,chartUpdates:2,libraryUpdates:5},
 recovered:{post:1,outcome:1,own:0,public:0,http:{shared:6,single:6,unavailable:8},writes:24,recordWrites:1,chartUpdates:3,libraryUpdates:9},
 navigation:{post:0,outcome:0,own:0,public:0,http:{shared:3,single:3,unavailable:3},writes:10,recordWrites:0,chartUpdates:4,libraryUpdates:5},
 public:{post:0,outcome:0,own:0,public:1,http:{shared:2,single:2,unavailable:2},writes:2,recordWrites:0,chartUpdates:2,libraryUpdates:0},
 logout:{post:1,outcome:0,own:1,public:0,http:{shared:11,single:11,unavailable:11},writes:40,recordWrites:1,chartUpdates:2,libraryUpdates:11},
};
function check(t:TestContext,h:Awaited<ReturnType<typeof runtime>>,name:keyof typeof rules){
 const actual=h.chartCounts(),rule=rules[name];t.diagnostic(JSON.stringify({scenario:name,...actual}));
 assert.deepEqual(h.protocolErrors,[]);
 for(const key of ['post','outcome','own','public','recordWrites'] as const)assert.equal(actual[key],rule[key],key);
 assert.equal(actual.calculations,0);assert.equal(actual.http,rule.http[h.coordination],'total HTTP');
 assert.equal(actual.chartUpdates,rule.chartUpdates,'prepared drawings');
 for(const key of ['writes','libraryUpdates'] as const)assert.ok(actual[key]<=rule[key],`${key}: ${actual[key]} exceeds ${rule[key]}`);
}
