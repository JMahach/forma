import type { SavedChart } from '../shared/chart-types.ts';
import test from 'node:test';
import { accountChart, accountNatalChart } from './helpers/account-chart.ts';
import assert from 'node:assert/strict';
import { createChartStore } from '../src/data/chart-store.ts';
import { createChartSession } from '../src/state/chart-session.ts';
import { libraryRecordAtMinute } from './fixtures/natal-day.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';

const personal = { id: 'personal', name: 'Test chart', source: 'manual' as const, personality: [1], design: [8] } as unknown as SavedChart;

test('account projection owns the library and clearing it never restores an abandoned collection', () => {
  const store = createChartStore(), cloud = {...personal, id: 'cloud', name: 'Server chart'};
  const session = createChartSession({store});
  assert.equal(session.selectedId, 'current-transit');
  assert.equal(session.record, null);
  store.projectLibrary([cloud], true);
  assert.equal(store.has(personal.id), false); assert.equal(store.get('cloud'), cloud);
  session.select(cloud.id); assert.equal(session.record, cloud);
  store.projectLibrary([], true);
  assert.deepEqual(store.charts, []);
});


test('an account chart without restoration permission remains listed but cannot become the restored drawing', () => {
  const store = createChartStore();
  store.projectLibrary([personal], true, []);
  assert.equal(store.charts.length, 1);
  const session = createChartSession({store, initialSelectedId: personal.id});
  assert.equal(session.selectedId, 'current-transit'); assert.equal(session.hasCurrent, false);
});


test('an older private projection cannot borrow readiness from a public chart with the same ID', () => {
 const chart={id:'a'.repeat(32),name:'Shared'} as never;
 const store=createChartStore();
 store.showPublic(chart);assert.equal(store.has('a'.repeat(32)),true);
 store.projectLibrary([chart],true,[]);
 assert.equal(store.has('a'.repeat(32)),false);
});


test('a tab owns one temporary chart independently of legacy records, public viewing and account projection', () => {
  const first = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture({id:'temporary-one'}));
  const store = createChartStore({initialTemporaryChart:first});
  assert.equal(store.temporaryChart?.id, first.id);
  assert.equal(store.has(first.id), true);
  assert.equal(store.get(first.id), store.temporaryChart);
  assert.deepEqual(store.charts, []);
  store.projectLibrary([], true);
  store.showPublic({...first,id:'foreign'});
  assert.equal(store.has(first.id), true, 'sign-in projection does not remove the tab chart');
  assert.equal(store.has('foreign'), true);
  const replacement = {...first,id:'temporary-two',name:'New result'};
  store.setTemporary(replacement);
  assert.equal(store.has(first.id), false);
  assert.equal(store.get(replacement.id)?.name, 'New result');
  assert.equal(store.has('foreign'), true, 'own and foreign charts have separate owners');
  assert.deepEqual(store.charts, []);
  replacement.name='Changed outside owner';
  assert.equal(store.temporaryChart?.name, 'New result');
  assert.equal(store.clearTemporary(first.id), false, 'a late save cannot remove a newer temporary chart');
  assert.equal(store.clearTemporary('temporary-two'), true);
  assert.equal(store.temporaryChart, null);
});

test('a failed temporary replacement keeps the last ready result even when persistent storage is denied', () => {
  const first = libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture({id:'temporary'}));
  const store=createChartStore({initialTemporaryChart:first});
  assert.throws(()=>store.setTemporary({...first,personality:[65]}));
  assert.equal(store.temporaryChart?.id,first.id);
  assert.deepEqual(store.temporaryChart?.personality,first.personality);
  store.projectLibrary([],false);
  assert.equal(store.has(first.id),true);
  const session=createChartSession({store,initialSelectedId:first.id});
  assert.equal(session.selectedId,first.id);
  assert.equal(session.hasCurrent,true);
});


test('account projection keeps unchanged display records and order without ignoring availability', () => {
  const store = createChartStore();
  const first = accountChart(1), second = accountChart(2);
  store.projectLibrary([first, second], true);
  const list = store.charts, one = list[0], two = list[1];
  store.projectLibrary([first, second], false, [second.id]);
  assert.equal(store.charts, list, 'same source records retain the rendered list');
  assert.equal(store.storageAvailable, false);
  assert.equal(store.has(first.id), false, 'calculation readiness is independent of list identity');
  assert.equal(store.has(second.id), true);
  assert.equal(one!.createdAt, '', 'account records are adapted at their projection owner');
  assert.equal('createdAt' in first, false, 'the source record is not mutated');
  const changed = {...first, name: 'New name', revision: 2, publicRevision: 2};
  store.projectLibrary([changed, second], true);
  assert.notEqual(store.charts, list);
  assert.notEqual(store.charts[0], one);
  assert.equal(store.charts[1], two, 'the unchanged neighbour keeps its display record');
  const renamed = store.charts[0];
  store.projectLibrary([second, changed], true);
  assert.deepEqual(store.charts, [two, renamed], 'reordering retains the existing display records');
  store.projectLibrary([], true);
  assert.deepEqual(store.charts, []);
});


test('the navigation list excludes a temporary card without discarding the tab slot', () => {
  const store=createChartStore();
  const first=accountChart(1);store.projectLibrary([first],true);
  const saved=store.charts;
  assert.deepEqual(store.displayCharts,saved);
  const temporary=libraryRecordAtMinute(natalDayFixture(),754,personalChartFixture({id:'temporary-navigation'}));
  store.setTemporary(temporary);
  const menu=store.displayCharts;
  assert.deepEqual(menu, saved);assert.equal(store.get(temporary.id),store.temporaryChart);
  for(let i=0;i<10;i++)assert.equal(store.displayCharts,menu);
  store.projectLibrary([first],false,[]);
  assert.equal(store.displayCharts,menu,'a readiness change does not rebuild navigation');
  store.clearTemporary(temporary.id);
  assert.deepEqual(store.displayCharts,saved);
});


test('one public source stays outside both the tab temporary and the account library',()=>{
  const a=accountNatalChart(109,'2'),b=accountNatalChart(110,'2');
  const publicPart=(value:typeof a)=>{const {accountId,note,noteRevision,publicRevision,...result}=value;return result;};
  const temporary={...accountNatalChart(111),id:'own-temporary',createdAt:'',updatedAt:''};
  const store=createChartStore({initialTemporaryChart:temporary,initialPublicChart:publicPart(a)});store.projectLibrary([],false);
  assert.equal(store.has(a.id),true);assert.equal(store.get(a.id)?.note,'');assert.deepEqual(store.charts,[]);
  assert.deepEqual(store.displayCharts,[]);
  const input=publicPart(b);store.acceptPublic(input);input.name='Mutated outside';
  assert.equal(store.publicChart?.name,b.name);assert.equal(store.get(a.id),undefined);assert.equal(store.temporaryChart?.id,temporary.id);
  assert.throws(()=>store.acceptPublic({...publicPart(a),note:'private'} as unknown as ReturnType<typeof publicPart>));
  assert.equal(store.publicChart?.id,b.id);assert.equal(store.clearPublic(a.id),false);assert.equal(store.publicChart?.id,b.id);
  assert.equal(store.clearPublic(b.id),true);assert.equal(store.publicChart,null);assert.equal(store.temporaryChart?.id,temporary.id);
});


test('one alphabetical projection orders both library consumers and moves confirmed renamed cards', () => {
  const store = createChartStore();
  const z = {...accountChart(3), name: 'Яна'}, a = {...accountChart(1), name: 'Анна'}, b = {...accountChart(2), name: 'Борис'};
  store.projectLibrary([z, b, a], true);
  assert.deepEqual(store.displayCharts.map(chart => chart.name), ['Анна', 'Борис', 'Яна']);
  const initial = store.displayCharts;
  assert.equal(store.displayCharts, initial, 'unchanged rows keep their shared display projection');
  store.projectLibrary([{...z, name: 'Алексей', revision: 2}, b, a], true);
  assert.deepEqual(store.displayCharts.map(chart => chart.name), ['Алексей', 'Анна', 'Борис']);
  assert.deepEqual(store.charts.map(chart => chart.id), [z.id, b.id, a.id], 'presentation does not reorder stored records');
});

test('the current store never reads or writes the abandoned local collection', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map([
    ['liniya.charts.v1', JSON.stringify([personal])],
    ['liniya.trash.v1', '[{"id":"deleted"}]'],
    ['liniya.charts.v2:old', '{malformed legacy bytes'],
    ['liniya.deleted.v2:old', '1'],
    ['liniya.view.v1', 'pending input and pointers'],
  ]);
  const before = [...values];
  let reads = 0, writes = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { reads++; return values.size; }, key(index: number) { reads++; return [...values.keys()][index] ?? null; },
    getItem(key: string) { reads++; return values.get(key) ?? null; },
    setItem(key: string, value: string) { writes++; values.set(key, value); }, removeItem(key: string) { writes++; values.delete(key); },
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete (globalThis as {localStorage?: Storage}).localStorage; });
  const store = createChartStore();
  assert.deepEqual(store.charts, []);
  assert.equal(store.has(personal.id), false);
  assert.equal(reads, 0);
  store.projectLibrary([accountChart(20)], true);
  assert.equal(store.charts.length, 1);
  store.projectLibrary([], false);
  assert.deepEqual(store.charts, []);
  assert.equal(reads, 0); assert.equal(writes, 0);
  assert.deepEqual([...values], before, 'runtime detachment does not speculate about the rollout deletion');
});

test('releasing a save source removes only that pin even behind the library projection',()=>{
 const store=createChartStore(),source=accountNatalChart(94),next=accountNatalChart(116);
 store.showPublic(source);store.projectLibrary([{...source,name:'Accepted'}],true);
 store.releasePublicSource(source);store.projectLibrary([],true);
 assert.equal(store.get(source.id),undefined,'an accepted record must not leave an obsolete pin behind');
 store.showPublic(next);store.releasePublicSource(source);
 assert.equal(store.get(next.id),next,'another source keeps its working projection');
});

test('light catalogue rows show new metadata without replacing the current complete drawing',()=>{
 const store=createChartStore(),chart=accountChart(1);
 const light={id:chart.id,revision:2,name:'New name',source:chart.source,birthDate:chart.birthDate,birthTime:chart.birthTime,
  packages:{card:{kind:'card' as const,sourceKey:JSON.stringify([chart.id,2])},day:null,majorReturns:null}};
 store.projectLibrary([chart],true,[],[light]);
 assert.equal(store.displayCharts[0],light);
 assert.equal(store.get(chart.id)?.name,chart.name,'the accepted complete source remains separate');
 assert.equal(store.has(chart.id),false,'old numbers cannot make a new catalogue revision ready');
 const list=store.displayCharts;
 store.projectLibrary([chart],false,[],[light]);assert.equal(store.displayCharts,list);
 const ready={...chart,name:light.name,revision:2};
 store.projectLibrary([ready],true,[chart.id],[light]);
 assert.equal(store.has(chart.id),true);assert.equal(store.displayCharts[0],store.get(chart.id));
});
