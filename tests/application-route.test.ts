import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../src/application/application.ts';
import { createNavigation } from '../src/platform/browser/navigation.ts';
import {readAppRoute} from '../shared/app-routes.ts';
import {accountChart} from './helpers/account-chart.ts';
import {createChartStore} from '../src/data/chart-store.ts';
import { appRoutePath } from '../shared/app-routes.ts';
import type { AppRoute } from '../shared/app-routes.ts';
import type { NavigationPort, NavigationSnapshot, NavigationOrigin } from '../src/application/ports.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(adapter: 'memory' | 'browser', pathname = '/chart/1234567890',withNavigation=true) {
  const location = {pathname}, events = new EventTarget();
  const history = {
    pushState(_state: unknown, _title: string, url?: string | URL | null) { location.pathname = String(url); },
    replaceState(_state: unknown, _title: string, url?: string | URL | null) { location.pathname = String(url); },
  };
  let snapshot: NavigationSnapshot = {route:readAppRoute(pathname), revision:0};
  const listeners = new Set<(snapshot: NavigationSnapshot, origin: NavigationOrigin) => void>();
  const memory: NavigationPort & {destroy(): void} = {
    get snapshot() {return snapshot;},
    isCurrent(value) {return value === snapshot;},
    navigate(route: AppRoute, {origin = 'external'} = {}) {
      const path = appRoutePath(route);
      if (path === location.pathname) return false;
      location.pathname = path;
      snapshot = {route, revision: snapshot.revision + 1};
      for (const listener of listeners) listener(snapshot, origin);
      return true;
    },
    subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener);};},
    destroy() {listeners.clear();},
  };
  const navigation = adapter === 'browser' ? createNavigation({location, history, events}) : memory;
  const reads: {signal: AbortSignal; release: () => void;fail:(error:Error)=>void}[] = [];
  const applied: string[] = [], failures: unknown[] = [];
  const store=createChartStore();
  let disposals=0,offline=false,selected='current-transit',ownReads=0,holdOwn=false;
  const edited:string[]=[];
  const own=new Map<string,ReturnType<typeof accountChart>>();
  const createRuntime=()=>createApplication({runtimeId:crypto.randomUUID(),navigation:withNavigation?navigation:undefined,route:{
    library:{has:id=>own.has(id),get:id=>own.get(id),async open(id,signal){ownReads++;if(holdOwn)await new Promise<void>((release,fail)=>reads.push({signal:signal!,release,fail}));return own.get(id)!;}},
    sources:store,online:()=>!offline,now:Date.now,
    readPublic(id,signal){return new Promise((resolve,fail)=>reads.push({signal:signal!,fail,release(){
      const {accountId,note,noteRevision,publicRevision,...chart}=accountChart();resolve({...chart,id});
    }}));},
    session:{get selectedId(){return selected;}},
    view:{workspace(){},select(id){selected=id;applied.push(id);},resetCamera(){},edit(id){edited.push(id);},interrupt(){},settled(){},checkpoint(){},
      report:error=>failures.push(error),firstTransit:async()=>true,transitReady(){},markOpened(){},publicRead(){}},
    observe:()=>({failed(){},finish(){disposals++;}}),
  }});

  const application = createRuntime();
  return {application, createRuntime, navigation, reads, applied, failures, location, store,own,edited,holdOwn(){holdOwn=true;},offline(value:boolean){offline=value;},get ownReads(){return ownReads;},get disposals() {return disposals;}};
}

for (const adapter of ['memory', 'browser'] as const) {
test(`${adapter}: route replacement aborts its reader, remains responsive, and ignores a late result`, async () => {
  const h = fixture(adapter); h.application.start();
  const first = h.application.requestRoute(h.navigation.snapshot);
  await tick();assert.equal(h.reads.length, 1);
  h.navigation.navigate({kind: 'chart',id:'2345678901'});
  assert.equal(h.reads[0].signal.aborted, true);
  assert.equal(h.disposals, 1);
  await tick();assert.equal(h.reads.length, 2);
  h.reads[0].release(); await first;
  assert.deepEqual(h.applied, []);
  h.reads[1].release(); await h.application.requestRoute(h.navigation.snapshot);
  assert.deepEqual(h.applied, ['2345678901']);assert.equal(h.store.publicChart?.id,'2345678901');
  await h.application.stop(); h.navigation.destroy();
});

test(`${adapter}: repeated intent and publishing an already accepted address do not read again`, async () => {
  const h = fixture(adapter); h.application.start();
  const first = h.application.requestRoute(h.navigation.snapshot);
  const same = h.application.requestRoute(h.navigation.snapshot);
  await tick();assert.equal(h.reads.length, 1);
  h.application.send({type: 'RoutePublished', route: {kind: 'chart', id: '3456789012'}, replace: true});
  await Promise.all([first, same]);
  assert.equal(h.reads[0].signal.aborted, true);
  await tick();assert.equal(h.reads.length, 1);
  assert.equal(h.location.pathname, '/chart/3456789012');
  h.reads[0].release(); await Promise.resolve();
  assert.deepEqual(h.applied, []);
  await h.application.stop(); h.navigation.destroy();
});

test(`${adapter}: stop releases the navigation subscription and prevents an old runtime from applying`, async () => {
  const h = fixture(adapter); h.application.start();
  const first = h.application.requestRoute(h.navigation.snapshot);
  await tick();assert.equal(h.reads.length, 1);
  await h.application.stop(); await h.application.stop(); await first;
  assert.equal(h.reads[0].signal.aborted, true);
  h.reads[0].release(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.applied, []);
  h.navigation.navigate({kind:'chart',id:'2345678901'});
  await tick();assert.equal(h.reads.length, 1);
  assert.equal(h.application.view.lifecycle, 'stopped');
  assert.equal(h.disposals, 1);
  const replacement = h.createRuntime(); replacement.start();
  const restored = replacement.requestRoute(h.navigation.snapshot);
  await tick();assert.equal(h.reads.length, 2);
  h.reads[1].release(); await restored;
  assert.deepEqual(h.applied, ['2345678901']);assert.equal(h.store.publicChart?.id,'2345678901');
  await replacement.stop();
  assert.equal(h.disposals, 2);
  h.navigation.destroy();
});

test(`${adapter}: the same core chooses an owned card or the exact offline public copy without a public request`,async()=>{
 const h=fixture(adapter),own={...accountChart(),id:'1234567890'};
 h.own.set(own.id,own);h.application.start();await h.application.requestRoute(h.navigation.snapshot);
 assert.equal(h.ownReads,1);assert.equal(h.reads.length,0);assert.deepEqual(h.applied,[own.id]);
 const {accountId,note,noteRevision,publicRevision,...publicChart}=own;
 h.store.acceptPublic({...publicChart,id:'2345678901'});h.offline(true);
 h.navigation.navigate({kind:'chart',id:'2345678901'});await h.application.requestRoute(h.navigation.snapshot);
 assert.equal(h.reads.length,0);assert.deepEqual(h.applied,[own.id,'2345678901']);
 await h.application.stop();h.navigation.destroy();
});

test(`${adapter}: library opening and edit preparation share cancellation with address navigation`,async()=>{
 const h=fixture(adapter,'/account'),a={...accountChart(),id:'1234567890'},b={...accountChart(2),id:'2345678901'};
 h.own.set(a.id,a);h.own.set(b.id,b);h.holdOwn();h.application.start();
 const first=h.application.openChart(a.id);await tick();
 const edit=h.application.openChart(b.id,{edit:true});await tick();
 assert.equal(h.reads[0].signal.aborted,true);h.reads[1].release();await edit;
 assert.deepEqual(h.edited,[b.id]);assert.deepEqual(h.applied,[]);assert.equal(h.location.pathname,'/account');
 h.reads[0].release();await first;assert.deepEqual(h.applied,[]);
 const cancelled=h.application.openChart(a.id);await tick();h.application.selectChart('current-transit');
 assert.equal(h.reads[2].signal.aborted,true);h.reads[2].release();await cancelled;
 assert.deepEqual(h.applied,['current-transit']);
 const failed=h.application.openChart(a.id,{edit:true});await tick();h.reads[3].fail(new Error('read failed'));await failed;
 assert.equal(h.failures.length,1);assert.deepEqual(h.edited,[b.id]);assert.deepEqual(h.applied,['current-transit']);
 await h.application.stop();await h.application.openChart(a.id);assert.equal(h.reads.length,4);h.navigation.destroy();
});

}

test('a non-DOM assembly can open its library without an address adapter',async()=>{
 const h=fixture('memory','/account',false),chart={...accountChart(),id:'1234567890'};
 h.own.set(chart.id,chart);h.application.start();await h.application.openChart(chart.id);
 assert.deepEqual(h.applied,[chart.id]);assert.equal(h.ownReads,1);assert.equal(h.reads.length,0);
 await h.application.stop();h.navigation.destroy();
});
