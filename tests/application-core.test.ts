import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
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
const expected={
 login:{http:5,post:1,outcome:0,own:0,public:0,libraryReads:2,recordWrites:1,calculations:0,selections:2},
 recovered:{http:4,post:1,outcome:1,own:0,public:0,libraryReads:2,recordWrites:1,calculations:0,selections:2},
 own:{http:2,post:0,outcome:0,own:1,public:0,libraryReads:2,recordWrites:1,calculations:0,selections:2},
 public:{http:2,post:0,outcome:0,own:0,public:1,libraryReads:1,recordWrites:0,calculations:0,selections:2},
};
const now=Date.parse('2000-01-01T12:00:00Z'),sessionId=chartId(80);
function world(){
 const chart=accountChart(7),{accountId:_,note:__,noteRevision:___,publicRevision:____,...publicChart}=chart;
 const {id:_id,accountId:_account,revision:_revision,noteRevision:_note,publicRevision:_public,...ready}=chart;
 const temporary:SavedChart={...ready,id:'temporary-ready',createdAt:'',updatedAt:''};
 const state={signedIn:false,online:true,loseWrite:false,committed:false,intent:null as ChartWriteIntent|null};
 const requests:{method:string;path:string}[]=[],storage=new Map<string,string>(),indexedDB=new IDBFactory();
 const confirmed=()=>({account:{id:'1',email:'a@example.org',telegramLinked:false,telegramHandle:null},session:{id:sessionId,expiresAt:now+86400000}});
 const receipt=()=>({kind:'created',chartId:chart.id,revision:chart.revision,chart,catalogMarker:'1'});
 const fetch:typeof globalThis.fetch=async(input,options)=>{
  const path=new URL(String(input),'https://forma.test').pathname,method=options?.method??'GET';requests.push({method,path});
  assert.equal(state.online,true,'offline opening must not reach HTTP');
  const body=typeof options?.body==='string'?JSON.parse(options.body):null;
  switch(path){
   case '/api/account':return Response.json(state.signedIn?confirmed():{account:null,session:null});
   case '/api/auth/email/start':return Response.json({delivery:'queued',attempt:{id:sessionId,expiresAt:now+600000,codeExpiresAt:now+300000,resendAt:now+1000}});
   case '/api/auth/email/verify':return Response.json({attemptId:sessionId,needsConfirmation:true});
   case '/api/auth/confirm':state.signedIn=true;return Response.json(confirmed());
   case '/api/charts':
    assert.equal(method,'POST');assert.equal(body.expectedAccountId,'1');assert.equal('activations' in body,false);
    state.committed=true;state.intent={operationId:body.operationId,expectedAccountId:body.expectedAccountId};
    if(state.loseWrite){state.loseWrite=false;throw new TypeError('reply lost after commit');}
    return Response.json(receipt());
   case '/api/charts/'+chart.id:return Response.json({chart,catalogMarker:'1'});
   case '/api/shared-charts/'+chart.id:return Response.json({chart:publicChart});
   default:
    if(path==='/api/charts/operations/'+state.intent?.operationId){assert.equal(method,'GET');assert.equal(state.committed,true);return Response.json(receipt());}
    assert.fail('unexpected HTTP: '+method+' '+path);
  }
 };
 return {chart,temporary,publicChart,state,requests,storage,indexedDB,fetch};
}
type World=ReturnType<typeof world>;
async function runtime(t:TestContext,w:World,path='/chart'){
 const counts={libraryReads:0,recordWrites:0,calculations:0,selections:0},notices:string[]=[],logout=new Set<(ids:readonly string[])=>void>();
 const viewStore=createViewStore({getStorage:()=>({getItem:key=>w.storage.get(key)??null,setItem:(key,value)=>{w.storage.set(key,value);},removeItem:key=>{w.storage.delete(key);}})});
 if(!viewStore.read())viewStore.write({version:1,selectedId:w.temporary.id,temporaryChart:w.temporary,workspace:'chart'});
 const saved=viewStore.read(),chartStore=createChartStore({initialTemporaryChart:saved?.temporaryChart,initialPublicChart:saved?.publicChart});
 const account=createAccountSession({client:createAccountClient({fetch:w.fetch,now:()=>now}),logoutStore:createAccountLogoutStore({indexedDB:w.indexedDB}),
  connection:()=>w.state.online?'online':'offline',notify(notice){if(notice.kind==='logout')for(const listener of logout)listener(notice.ids);}});
 const accountReady=account.refresh();
 const client=createChartClient({fetch:w.fetch,getSession:account.getSession});
 const database=createAccountLibraryStore({indexedDB:w.indexedDB});
 const read=database.read,put=database.put;
 t.mock.method(database,'read',(...args:Parameters<typeof read>)=>{counts.libraryReads++;return read(...args);});
 t.mock.method(database,'put',(...args:Parameters<typeof put>)=>{counts.recordWrites++;return put(...args);});
 const library=createAccountLibrary({storage:database,client,online:()=>w.state.online});
 const location={pathname:path},navigation=createNavigation({location,events:new EventTarget(),
  history:{pushState(_data,_unused,url){location.pathname=String(url);},replaceState(_data,_unused,url){location.pathname=String(url);}}});
 const workspace=createWorkspaceState(),planetFilter=createTransitPlanetFilter();
 const transit=createLiveTransit({now:()=>now,timeZone:()=> 'UTC',isVisible:()=>workspace.screen==='chart',
  dayClient:{async getDay(){counts.calculations++;assert.fail('ready charts need no transit calculation');}}});
 const natalDay=createNatalDayExplorer({connection:()=>w.state.online?'online':'offline',
  dayClient:{async getDay(){counts.calculations++;assert.fail('opening a card must not calculate its day');}}});
 const session=createChartSession({store:chartStore,initialSelectedId:saved?.selectedId,getTransit:()=>transit,getNatalDay:()=>natalDay,
  onChange(change){if(change==='record')counts.selections++;}});
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
  account:{ready:accountReady,getSession:account.getSession,subscribeSession:account.subscribeSession,
   subscribeLogout(listener){logout.add(listener);return()=>{logout.delete(listener);};},library,writes:actions,
   binding:{get accountId(){return app?.write.binding?.expectedAccountId??null;},clear(){app?.send({type:'ClearTemporaryWrite'});}},
   form:emptyForm,editing:{reset(){}},checkpoint:{clearPersonal:()=>checkpoint.clearPersonal({temporaryChart:chartStore.temporaryChart,publicChart:chartStore.publicChart,selectedId:session.selectedId}),flush:view.flush},
   closeDelete(){},changed(){},storageUnavailable(){assert.fail('fakeIDB must be available');}},
  libraryProjection:{library,sources:chartStore,selection:session,form:emptyForm,
   view:{isChartScreen:()=>workspace.screen==='chart',changeChart:session.select,library(){},checkpoint:view.flush}},
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
 async function stop(){if(stopped)return;stopped=true;view.flush();await application.stop();unsubscribe();checkpoint.destroy();transit.stop();natalDay.select(null);account.destroy();library.close();navigation.destroy();}
 t.after(stop);application.start();await application.whenRestored();assert.deepEqual(application.startup,{restored:true,failed:false});
 return {app:application,library,chartStore,session,account,actions,view,viewStore,workspace,navigation,counts,notices,stop,
  async login(){await account.flow.begin();account.flow.input('email','a@example.org');await account.flow.submit();
   assert.equal(account.flow.state.step,'code');account.flow.input('code','123456');await account.flow.submit();assert.equal(account.getSession()?.accountId,'1');},
  chartCounts(){return {http:w.requests.length,post:w.requests.filter(r=>r.method==='POST'&&r.path==='/api/charts').length,
   outcome:w.requests.filter(r=>r.path.startsWith('/api/charts/operations/')).length,
   own:w.requests.filter(r=>r.path==='/api/charts/'+w.chart.id).length,public:w.requests.filter(r=>r.path==='/api/shared-charts/'+w.chart.id).length,
   ...counts};},
 };
}

test('core guest Save continues after real login and prepares a restorable update without repeating acquisition',async t=>{
 const w=world(),h=await runtime(t,w);assert.equal(h.session.selectedId,w.temporary.id);
 await h.app.requestSave(h.chartStore.temporaryChart!);
 assert.equal(h.app.write.waitingForLogin,true);assert.equal(h.workspace.screen,'account');assert.equal(h.navigation.snapshot.route?.kind,'account');
 assert.equal(h.chartCounts().post,0);
 await h.login();await until(()=>h.session.selectedId===w.chart.id && !h.app.write.busy,'core resumes Save after the account boundary');
 assert.equal(h.chartStore.temporaryChart,null);assert.equal(h.library.get(w.chart.id)?.name,w.chart.name);
 assert.deepEqual(h.navigation.snapshot.route,{kind:'chart',id:w.chart.id});assert.deepEqual(h.notices,[]);
 assert.deepEqual(h.chartCounts(),expected.login);
 const before=h.chartCounts(),control=new AbortController();
 assert.equal(await h.app.prepareUpdate(control.signal),true);control.abort();assert.deepEqual(h.chartCounts(),before);
 assert.equal(h.viewStore.read()?.selectedId,w.chart.id);assert.deepEqual(h.viewStore.read()?.pendingChartWrites,[]);
 assert.equal(h.viewStore.read()?.temporaryChart,null);
});

test('core restores an unknown Save in a new runtime by outcome only, without sending the command again',async t=>{
 const w=world();w.state.signedIn=true;w.state.loseWrite=true;
 const first=await runtime(t,w);await first.app.requestSave(first.chartStore.temporaryChart!);
 assert.deepEqual(first.notices,['unconfirmed']);assert.equal(first.actions.pending.length,1);
 assert.equal(await first.app.prepareUpdate(),true);assert.equal(first.viewStore.read()?.temporaryChartSave?.sourceId,w.temporary.id);
 await first.stop();
 const next=await runtime(t,w);await until(()=>next.session.selectedId===w.chart.id&&!next.app.write.recovering,'new runtime reconciles the stored pointer');
 assert.deepEqual(next.actions.pending,[]);assert.equal(next.app.write.binding,null);assert.equal(next.chartStore.temporaryChart,null);
 assert.deepEqual(next.chartCounts(),expected.recovered);
 assert.deepEqual(next.notices,[]);assert.equal(await next.app.prepareUpdate(),true);assert.equal(next.viewStore.read()?.selectedId,w.chart.id);
});

for(const kind of ['own','public'] as const)test(`core opens ${kind} and reopens it offline without HTTP or calculations`,async t=>{
 const w=world();w.state.signedIn=kind==='own';
 if(kind==='own'){
  const store=createAccountLibraryStore({indexedDB:w.indexedDB});const active=await store.activate('1');assert.equal(active.status,'stored');
  if(active.status!=='stored')throw Error('owner');await store.put(active.lease,[w.chart],'1');store.close();
 }
 const h=await runtime(t,w,'/chart/'+w.chart.id);assert.equal(h.session.selectedId,w.chart.id);
 assert.equal(h.chartCounts().own,kind==='own'?1:0);assert.equal(h.chartCounts().public,kind==='public'?1:0);
 const before=w.requests.length,selected=h.counts.selections;w.state.online=false;
 h.app.navigateWorkspace('charts');h.navigation.navigate({kind:'chart',id:w.chart.id});
 await until(()=>h.app.view.destination==='ready'&&h.workspace.screen==='chart','offline route finishes');
 assert.equal(h.session.selectedId,w.chart.id);assert.equal(h.counts.selections,selected+1);
 assert.equal(w.requests.length,before);assert.deepEqual(h.chartCounts(),expected[kind]);assert.deepEqual(h.notices,[]);
 assert.equal(await h.app.prepareUpdate(),true);
});
