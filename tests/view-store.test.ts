import {accountNatalChart} from './helpers/account-chart.ts';
import {libraryRecordAtMinute,natalDayFixture,personalChartFixture} from './fixtures/natal-day.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartStore } from '../src/data/chart-store.ts';
import { createViewStore, VIEW_STORAGE_KEY } from '../src/data/view-store.ts';

function memory(value: unknown = null) {
  const records = new Map(value ? [[VIEW_STORAGE_KEY, JSON.stringify(value)]] : []), writes: string[][] = [];
  return { records, writes, getItem: (key: string) => records.get(key) ?? null,
    setItem(key: string, value: string) { writes.push([key, value]); records.set(key, value); } };
}
const snapshot = { version: 1, selectedId: 'saved-chart', mandala: true,
  camera: { x: -320, y: -410, k: 2 },
  lifetime: { opened: true, mode: 'lifetime', fromDate: '2020-10-04', toDate: '2027-10-04', requestedUtc: 1604811600000 },
  transit: { live: false, date: '2026-10-04', timeZone: 'Europe/Moscow', index: 400 },
  natalDay: { opened: false, exactOriginal: true, index: 0 },
  planets: { selectedPlanets: ['sun', 'moon'], selectedDesignPlanets: ['earth'] } };

test('legacy archive mode alias restores as lifetime without losing the saved moment or rewriting storage on read', () => {
  const old = { ...snapshot, lifetime: { ...snapshot.lifetime, mode: 'archive' } };
  const storage = memory(old), store = createViewStore({ getStorage: () => storage });
  assert.deepEqual(store.read(), snapshot);
  assert.equal(storage.writes.length, 0);
  assert.equal(store.write({ ...snapshot, mandala: false }), true);
  assert.equal(JSON.parse(storage.records.get(VIEW_STORAGE_KEY)!).lifetime.mode, 'lifetime');
});

test('a fresh view store restores presentation without touching chart-library records', () => {
  const storage = memory(); storage.records.set('liniya.charts.v1', 'personal library');
  const first = createViewStore({ getStorage: () => storage });
  assert.equal(first.read(), null); assert.equal(first.write(snapshot), true);
  assert.deepEqual(createViewStore({ getStorage: () => storage }).read(), snapshot);
  assert.equal(storage.records.get('liniya.charts.v1'), 'personal library');
  assert.equal(storage.writes.length, 1);
  first.write(snapshot); assert.equal(storage.writes.length, 1, 'unchanged minute notifications do not rewrite storage');
});

test('malformed and obsolete stored views fall back safely and cannot inject chart data', () => {
  const storage = memory(); const store = createViewStore({ getStorage: () => storage });
  for (const value of ['{', 'null', '[]', '{"version":8,"mandala":true}'] as const) {
    storage.records.set(VIEW_STORAGE_KEY, value); assert.equal(store.read(), null);
  }
  storage.records.set(VIEW_STORAGE_KEY, JSON.stringify({ ...snapshot, camera: { x: 'bad', y: 0, k: 0 },
    selectedId: '../bad', lifetime: { opened: true, mode: 'lifetime', fromDate: '2020-02-31', toDate: '2027-10-04', index: -4 },
    arbitrary: { library: 'replace' } }));
  const read = store.read();
  assert.equal(read!.mandala, true); assert.equal(read!.selectedId, 'current-transit');
  assert.equal(read!.camera, null); assert.equal(read!.lifetime, null); assert.equal('arbitrary' in read!, false);
});

test('denied storage remains usable in memory and warns only once', () => {
  const warnings = []; const store = createViewStore({ getStorage() { throw new Error('Denied'); }, onStorageError: text => warnings.push(text) });
  assert.equal(store.read(), null); assert.equal(store.write(snapshot), false);
  store.write({ ...snapshot, mandala: false }); assert.equal(warnings.length, 1);
  assert.equal(store.read()!.mandala, false);
});


test('the empty-end meaning survives storage without losing its effective final date', () => {
  const storage = memory(); const store = createViewStore({ getStorage: () => storage });
  store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, openEnded: true } });
  const restored = createViewStore({ getStorage: () => storage }).read();
  assert.equal(restored!.lifetime!.openEnded, true); assert.equal(restored!.lifetime!.toDate, '2027-10-04');
});


test('same-tab reload restores the view while a new tab starts fresh and shares only the chart library', t => {
  const persistent = memory(snapshot), firstTab = memory(), nextTab = memory();
  persistent.records.set('liniya.charts.v1', JSON.stringify([{ id: 'saved-chart', name: 'My chart', personality: [1], design: [2] }]));
  const previous = new Map(['localStorage', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: persistent });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: firstTab });
  const view = createViewStore();
  assert.equal(view.read(), null, 'a new tab must not revive the legacy persistent view');
  view.write(snapshot);
  assert.equal(createViewStore().read()!.mandala, true, 'reload uses the same tab storage');
  assert.equal(createChartStore().get('saved-chart')!.name, 'My chart');
  globalThis.sessionStorage = nextTab as unknown as Storage;
  assert.equal(createViewStore().read(), null, 'a new tab has no presentation snapshot');
  assert.equal(createChartStore().get('saved-chart')!.name, 'My chart');
  createViewStore().write({ ...snapshot, mandala: false });
  globalThis.sessionStorage = firstTab as unknown as Storage;
  assert.equal(createViewStore().read()!.mandala, true, 'another tab cannot overwrite this tab');
  assert.equal(persistent.writes.length, 0, 'view writes never alter persistent library or legacy view data');
});


test('return exploration saves only navigation metadata and cannot inject a computed overlay', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  const returns = { opened: true, year: 2050, bodies: ['saturn'], eventId: 'saturn:2050-01-01T12:00:00Z' };
  store.write({ ...snapshot, returns: { ...returns, chart: { injected: true } } });
  assert.deepEqual(createViewStore({ getStorage: () => storage }).read()!.returns, returns);
  store.write({ ...snapshot, returns: { ...returns, bodies: ['injected'], eventId: '<script>' } });
  assert.equal(createViewStore({ getStorage: () => storage }).read()!.returns, undefined);
});

test('old return descriptors are ignored while their exact target and filters survive read and write', () => {
  const returns = { opened: false, year: 2050, bodies: ['saturn'], eventId: 'saturn:2050-01-01T12:00:00.123456Z' };
  const event = { id: returns.eventId, body: 'saturn', utc: '2050-01-01T12:00:00.123456Z',
    cycle: 99, cycleId: 'saturn:99', pass: 9, direction: 'retrograde' };
  const old = { ...snapshot, returns: { ...returns, event } };
  const storage = memory(old), store = createViewStore({ getStorage: () => storage });
  assert.deepEqual(store.read()!.returns, returns);
  assert.equal(storage.writes.length, 0, 'reading an old tab does not rewrite its snapshot');
  assert.deepEqual(JSON.parse(storage.records.get(VIEW_STORAGE_KEY)!), old);
  store.write({ ...old, mandala: false });
  assert.deepEqual(JSON.parse(storage.records.get(VIEW_STORAGE_KEY)!).returns, returns);
});

test('closed empty return filters round-trip without inventing default planets or a year', () => {
  const returns = { opened: false, year: null, bodies: [], eventId: null };
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  store.write({ ...snapshot, returns });
  assert.deepEqual(createViewStore({ getStorage: () => storage }).read()!.returns, returns);
});

test('legacy return modes become one combined filter only at the storage boundary', () => {
  for (const [group, year, bodies] of [
    ['major', null, ['north_node', 'saturn', 'uranus_opposition', 'chiron', 'uranus']],
    ['year', 2050, ['sun', 'mercury', 'venus', 'mars']], ['planet', null, ['moon']],
  ] as const) {
    const storage = memory({ ...snapshot, returns: { opened: false, group, year: 2050, body: 'moon', eventId: null } });
    const store = createViewStore({ getStorage: () => storage }), result = store.read();
    assert.deepEqual(result!.returns, { opened: false, year, bodies, eventId: null });
    assert.equal(storage.writes.length, 0);
    store.write({ ...result, mandala: false });
    assert.equal('group' in JSON.parse(storage.records.get(VIEW_STORAGE_KEY)!).returns, false);
  }
});

test('modern filters do not fall back to legacy values and reject malformed bodies or years', () => {
  for (const bad of [{ bodies: ['unknown'], year: null }, { bodies: 'moon', year: null },
    { bodies: [], year: '2050' }, { bodies: [], year: 2400 }] as const) {
    const storage = memory({ ...snapshot, returns: { opened: false, group: 'major', body: 'saturn', eventId: null, ...bad } });
    assert.equal(createViewStore({ getStorage: () => storage }).read()!.returns, undefined);
  }
  const storage = memory({ ...snapshot, returns: { opened: false, bodies: ['moon', 'sun', 'moon'], year: null, eventId: null } });
  assert.deepEqual(createViewStore({ getStorage: () => storage }).read()!.returns!.bodies, ['sun', 'moon']);
});


test('personal timeline distinguishes birth view from a scrubbed preview across refresh', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  for (const personalPreview of [false, true] as const) {
    store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, personalPreview } });
    assert.equal(createViewStore({ getStorage: () => storage }).read()!.lifetime!.personalPreview, personalPreview);
  }
});

test('following the current minute remains distinct from a manually selected lifetime moment', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  for (const personalLive of [true, false] as const) {
    store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, personalPreview: true, personalLive } });
    const restored = createViewStore({ getStorage: () => storage }).read();
    assert.equal(restored!.lifetime!.personalLive, personalLive);
  }
  store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, personalLive: 'true' } });
  assert.equal(createViewStore({ getStorage: () => storage }).read()!.lifetime!.personalLive, undefined);
});


test('lifetime UTC survives storage exactly and supersedes a legacy transport index', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  const requestedUtc = Date.parse('2026-10-04T12:37:29.432Z');
  store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, requestedUtc, index: 5040 } });
  const saved = createViewStore({ getStorage: () => storage }).read()!.lifetime;
  assert.equal(saved!.requestedUtc, requestedUtc); assert.equal('index' in saved!, false);
  assert.equal('index' in JSON.parse(storage.records.get(VIEW_STORAGE_KEY)!).lifetime, false);
});

test('legacy lifetime indices remain readable until metadata can convert them', () => {
  const legacy = { ...snapshot, lifetime: { ...snapshot.lifetime, requestedUtc: undefined, index: 5040 } };
  const storage = memory(legacy), saved = createViewStore({ getStorage: () => storage }).read();
  assert.equal(saved!.lifetime!.index, 5040); assert.equal('requestedUtc' in saved!.lifetime!, false);
});

test('lifetime UTC rejects invalid timestamps while accepting dates before the Unix epoch', () => {
  for (const requestedUtc of [Infinity, NaN, '2026-10-04', 8640000000000001] as const) {
    const storage = memory({ ...snapshot, lifetime: { ...snapshot.lifetime, requestedUtc } });
    assert.equal(createViewStore({ getStorage: () => storage }).read()!.lifetime, null);
  }
  const storage = memory({ ...snapshot, lifetime: { ...snapshot.lifetime, requestedUtc: -60000 } });
  assert.equal(createViewStore({ getStorage: () => storage }).read()!.lifetime!.requestedUtc, -60000);
});


test('the empty-start meaning survives storage without losing its effective first date', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, openStart: true } });
  const restored = createViewStore({ getStorage: () => storage }).read();
  assert.equal(restored!.lifetime!.openStart, true); assert.equal(restored!.lifetime!.fromDate, '2020-10-04');
});


test('panel visibility shares the tab snapshot and ignores malformed or absent panel values', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  store.write({ ...snapshot, panels: { left: true, right: true, extra: 'discard' } });
  assert.deepEqual(createViewStore({ getStorage: () => storage }).read()!.panels, { left: true, right: true });
  store.write({ ...snapshot, panels: { left: 'yes', right: true } });
  assert.equal(store.read()!.panels, undefined);
  store.write(snapshot);
  assert.equal(store.read()!.panels, undefined, 'legacy snapshots remain readable without inventing panel state');
});

test('legacy camera ceilings are discarded while the saved pose stays readable', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  store.write({ ...snapshot, camera: { ...snapshot.camera, maxK: 8 } });
  assert.deepEqual(store.read()!.camera, snapshot.camera);
  store.write({ ...snapshot, camera: { ...snapshot.camera, maxK: 8, zoomLimit: 4.05 } });
  assert.deepEqual(store.read()!.camera, snapshot.camera);
  for (const zoomLimit of [0, -1, 101, Infinity, '4.05'] as const) {
    store.write({ ...snapshot, camera: { ...snapshot.camera, zoomLimit } });
    assert.deepEqual(store.read()!.camera, snapshot.camera);
  }
  for (const maxK of [1, 101, Infinity, '8'] as const) {
    store.write({ ...snapshot, camera: { ...snapshot.camera, maxK } });
    assert.deepEqual(store.read()!.camera, snapshot.camera);
  }
});


test('workspace screen shares the existing tab snapshot and validates legacy and malformed values', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  for (const workspace of ['chart', 'library', 'charts', 'account'] as const) {
    store.write({ ...snapshot, workspace });
    assert.equal(createViewStore({ getStorage: () => storage }).read()!.workspace, workspace);
  }
  for (const workspace of [undefined, null, '', 'settings', { screen: 'charts' }, ['chart'], 1] as const) {
    store.write({ ...snapshot, workspace });
    assert.equal(store.read()!.workspace, undefined);
    assert.deepEqual(store.read()!.camera, snapshot.camera, 'bad navigation does not discard a valid camera');
  }
  store.write(snapshot);
  assert.deepEqual(store.read(), snapshot, 'legacy snapshots keep their existing shape');
  assert.deepEqual([...storage.records.keys()], [VIEW_STORAGE_KEY], 'navigation needs no separate storage entry');
});


test('retired phone sheet heights are ignored without losing the saved view', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  for (const phoneSheetMode of ['collapsed', 'medium', 'expanded', null]) {
    storage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ ...snapshot, phoneSheetMode }));
    assert.deepEqual(store.read(), snapshot);
    store.write({ ...store.read()!, panels: { left: false, right: true } });
    assert.equal('phoneSheetMode' in JSON.parse(storage.getItem(VIEW_STORAGE_KEY)!), false);
  }
  assert.deepEqual([...storage.records.keys()], [VIEW_STORAGE_KEY]);
});


test('legacy open Returns supplies shell visibility only when the snapshot has no panel state', () => {
  const returns = { opened: true, bodies: ['saturn'], year: null, eventId: null };
  const legacy = memory({ ...snapshot, returns });
  const restored = createViewStore({ getStorage: () => legacy }).read()!;
  assert.deepEqual(restored.panels, { left: false, right: true });
  assert.equal(legacy.writes.length, 0, 'reading migration does not rewrite the tab');
  for (const panels of [{ left: false, right: false }, { left: true, right: false }, { left: true, right: true }]) {
    const storage = memory({ ...snapshot, returns, panels });
    assert.deepEqual(createViewStore({ getStorage: () => storage }).read()!.panels, panels);
  }
  const closed = memory({ ...snapshot, returns: { ...returns, opened: false } });
  assert.equal(createViewStore({ getStorage: () => closed }).read()!.panels, undefined);
  const malformed = memory({ ...snapshot, returns, panels: null });
  assert.equal(createViewStore({ getStorage: () => malformed }).read()!.panels, undefined);
});


test('one tab snapshot stores independent search and article metadata, excluding reading history and pixels', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  const knowledge = { query: ' Красное ', searchOpen: true, collection: 'gates', entryId: 'concept.personality-design', view: 'article' };
  const charts = { query: 'Анна', searchOpen: false };
  store.write({ ...snapshot, knowledge: { ...knowledge, scrollTop: 234, history: ['gate.1'] }, charts: { ...charts, svg: '<svg/>' } });
  const restored = createViewStore({ getStorage: () => storage }).read()!;
  assert.deepEqual(restored.knowledge, knowledge);
  assert.deepEqual(restored.charts, charts);
  assert.equal(storage.records.size, 1, 'no separate storage key');
  store.write({ ...restored, charts: { query: '', searchOpen: false } });
  assert.deepEqual(store.read()!.knowledge, knowledge);
  assert.equal(store.read()!.charts!.query, '');
});

test('invalid page snapshots cannot spoil the chart or revive unknown fields', () => {
  for (const invalid of [null, [], 'oops', { query: 42, searchOpen: true }, { query: 'ok', searchOpen: 'yes' }]) {
    const storage = memory({ ...snapshot, knowledge: invalid, charts: invalid });
    const restored = createViewStore({ getStorage: () => storage }).read()!;
    assert.deepEqual(restored, snapshot);
  }
});


test('saved library selection survives reload independently of the displayed card', () => {
  const storage = memory(); const store = createViewStore({getStorage: () => storage});
  store.write({...snapshot, librarySelection: ['first', 'saved-chart', 'third']});
  assert.deepEqual(createViewStore({getStorage: () => storage}).read()?.librarySelection, ['first', 'saved-chart', 'third']);
  store.write({...snapshot, librarySelection: []}); assert.deepEqual(store.read()?.librarySelection, []);
  store.write({...snapshot, librarySelection: ['first', 42]}); assert.equal(store.read()?.librarySelection, undefined);
});


test('account restoration stores only the draft and public attempt pointer, never the code or session', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  const account = { email: 'a@example.org', attemptEmail: 'a@example.org', attemptId: 'a'.repeat(32), step: 'code', verificationPending: true };
  store.write({ ...snapshot, account: { ...account, code: '123456', session: { secret: 'never-save' } } });
  assert.deepEqual(store.read()?.account, account);
  assert.equal(storage.records.get(VIEW_STORAGE_KEY)!.includes('123456'), false);
  assert.equal(storage.records.get(VIEW_STORAGE_KEY)!.includes('never-save'), false);
  store.write({ ...snapshot, account: null });
  assert.equal(store.read()?.account, null);
});

test('unknown chart writes survive reload as account-bound IDs without command content', () => {
  const storage = memory(), store = createViewStore({getStorage: () => storage});
  const operationId = 'a'.repeat(32);
  store.write({...snapshot, pendingChartWrites: [
    {operationId, expectedAccountId: '12', command: {note: 'must not be stored'}},
    {operationId, expectedAccountId: '12'}, {operationId: 'bad', expectedAccountId: '12'},
  ]});
  assert.deepEqual(createViewStore({getStorage: () => storage}).read()!.pendingChartWrites,
    [{operationId, expectedAccountId: '12'}]);
});

test('Telegram restoration stores only its public attempt and phase, stripping SDK secrets and user claims',()=>{
  const storage=memory(),store=createViewStore({getStorage:()=>storage});
  const account={email:'typed@example.org',attemptEmail:'',attemptId:'a'.repeat(32),step:'telegram',verificationPending:true,telegramPending:true};
  store.write({...snapshot,account:{...account,nonce:'private-nonce',id_token:'private-token',user:{id:'private-user'},session:{id:'private-session'}}});
  assert.deepEqual(createViewStore({getStorage:()=>storage}).read()?.account,account);
  assert.doesNotMatch(storage.records.get(VIEW_STORAGE_KEY)!,/private-|id_token|nonce/);
});


const birthDraft={editingId:null,accountId:null,calculationMode:'calculated',
  fields:{chartName:'  Не закончено  ',birthDate:'12.0',birthTime:'1:',birthPlace:'Мос',chartNote:'Своя заметка\n'},
  city:null,fold:null,base:null,focus:{field:'chartNote',start:2,end:7,direction:'backward'}};

test('the tab snapshot preserves unfinished birth input and selection without retaining calculation or secret fields',()=>{
  const storage=memory(),first=createViewStore({getStorage:()=>storage});
  assert.equal(first.write({...snapshot,birthForm:{...birthDraft,code:'123456',activations:[1],history:['old'],
    fields:{...birthDraft.fields,password:'private'}}}),true);
  const restored=createViewStore({getStorage:()=>storage}).read();
  assert.deepEqual(restored?.birthForm,birthDraft);
  const raw=storage.records.get(VIEW_STORAGE_KEY)!;assert.doesNotMatch(raw,/123456|activations|history|password/);
  assert.deepEqual([...storage.records.keys()],[VIEW_STORAGE_KEY]);
});

test('a malformed draft is discarded independently from the valid page state',()=>{
  const storage=memory({...snapshot,birthForm:{...birthDraft,fields:{...birthDraft.fields,birthTime:42}}});
  const restored=createViewStore({getStorage:()=>storage}).read();
  assert.equal(restored?.birthForm,null);assert.equal(restored?.selectedId,snapshot.selectedId);
});

test('writing a closed birth form removes its private draft from the one saved record',()=>{
  const storage=memory(),store=createViewStore({getStorage:()=>storage});
  store.write({...snapshot,birthForm:birthDraft});store.write({...snapshot,birthForm:null});
  assert.equal(createViewStore({getStorage:()=>storage}).read()?.birthForm,null);
  assert.doesNotMatch(storage.records.get(VIEW_STORAGE_KEY)!,/Своя заметка|Не закончено/);
});

test('a rejected view write cannot discard the latest in-memory draft on a later read',()=>{
  const storage=memory(snapshot);let fail=true;
  const store=createViewStore({getStorage:()=>({...storage,setItem(key,value){if(fail)throw new Error('full');storage.setItem(key,value);}})});
  store.read();assert.equal(store.write({...snapshot,birthForm:birthDraft}),false);
  assert.deepEqual(store.read()?.birthForm,birthDraft);
  fail=false;assert.equal(store.write({...snapshot,birthForm:birthDraft}),true);
  assert.deepEqual(createViewStore({getStorage:()=>storage}).read()?.birthForm,birthDraft);
});

test('an unchanged write is durable only while the actual saved record is still present',()=>{
  const storage=memory(),store=createViewStore({getStorage:()=>storage});
  assert.equal(store.write(snapshot),true);storage.records.delete(VIEW_STORAGE_KEY);
  assert.equal(store.write(snapshot),true);assert.deepEqual(createViewStore({getStorage:()=>storage}).read(),snapshot);
});

test('clear removes the whole tab record and reports a refused durable deletion honestly',()=>{
  const storage=memory({...snapshot,birthForm:birthDraft});let fail=true;
  const store=createViewStore({getStorage:()=>({...storage,removeItem(key:string){if(fail)throw new Error('denied');storage.records.delete(key);}})});
  store.read();assert.equal(store.clear(),false);assert.equal(store.read(),null);
  fail=false;assert.equal(store.clear(),true);assert.equal(storage.records.has(VIEW_STORAGE_KEY),false);
  assert.equal(createViewStore({getStorage:()=>storage}).read(),null);
});


test('unfinished searches, account email caret and active date draft share the one tab record', () => {
  const storage=memory(), store=createViewStore({getStorage:()=>storage});
  const focus={start:1,end:3,direction:'backward'};
  const account={email:'draft@',attemptEmail:'',attemptId:null,step:'email',verificationPending:false,focus};
  const lifetimeDraft={fromDate:'04.1',toDate:'04.10.2027',focus:{field:'fromDate',...focus}};
  store.write({...snapshot,charts:{query:'Анна',searchOpen:true,focus},account:{...account,code:'123456'},lifetimeDraft});
  const restored=createViewStore({getStorage:()=>storage}).read();
  assert.deepEqual(restored?.charts,{query:'Анна',searchOpen:true,focus});
  assert.deepEqual(restored?.account,account);
  assert.deepEqual(restored?.lifetimeDraft,lifetimeDraft);
  assert.equal(storage.records.size,1);
  assert.equal(JSON.stringify(restored).includes('123456'),false);
  store.write({...restored,charts:{query:'',searchOpen:true},account:null,lifetimeDraft:null});
  assert.equal(store.read()?.charts?.focus,undefined);
  assert.equal(store.read()?.lifetimeDraft,null);
});

test('input restoration bounds the caret and never retains a code-field selection or unknown date field', () => {
  const storage=memory({...snapshot,charts:{query:'ab',searchOpen:true,focus:{start:1,end:99,direction:'backward'}},
    account:{email:'draft@',attemptEmail:'',attemptId:null,step:'code',verificationPending:false,focus:{start:1,end:6,direction:'none'}},
    lifetimeDraft:{fromDate:'04.1',toDate:'',focus:{field:'secret',start:0,end:1,direction:'none'}}});
  const restored=createViewStore({getStorage:()=>storage}).read();
  assert.deepEqual(restored?.charts?.focus,{start:1,end:2,direction:'backward'});
  assert.equal(restored?.account?.focus,null);
  assert.equal(restored?.lifetimeDraft,null);
});


test('invalid unfinished email text remains a draft instead of being discarded by storage validation', () => {
  const storage=memory(), store=createViewStore({getStorage:()=>storage});
  const email='not yet an address '.repeat(20), focus={start:5,end:email.length,direction:'forward'};
  const account={email,attemptEmail:'',attemptId:null,step:'email',verificationPending:false,focus};
  store.write({...snapshot,account});
  assert.deepEqual(createViewStore({getStorage:()=>storage}).read()?.account,account);
});


test('the ready temporary result and unfinished form survive reload as independent tab state', () => {
  const chart=libraryRecordAtMinute(natalDayFixture(),754,personalChartFixture({id:'temporary'}));
  const receipt='receipt.payload';
  const storage=memory(),first=createViewStore({getStorage:()=>storage});
  assert.equal(first.write({...snapshot,temporaryChart:{...chart,calculationReceipt:receipt},birthForm:null}),true);
  const restored=createViewStore({getStorage:()=>storage}).read()!;
  assert.equal(restored.temporaryChart?.id,chart.id);
  assert.equal(restored.temporaryChart?.calculationReceipt,receipt);
  assert.deepEqual(restored.temporaryChart?.activations,chart.activations);
  assert.equal(restored.birthForm,null);
  assert.deepEqual([...storage.records.keys()],[VIEW_STORAGE_KEY]);
  first.write({...restored,workspace:'account',account:{email:'test@example.org',attemptEmail:'',attemptId:null,step:'email',verificationPending:false}});
  assert.equal(first.read()?.temporaryChart?.id,chart.id);
  first.write({...first.read(),temporaryChart:null});
  assert.equal(createViewStore({getStorage:()=>storage}).read()?.temporaryChart,null);
});

test('fresh tabs have no guest collection and duplicated tab snapshots diverge independently', () => {
  const chart=libraryRecordAtMinute(natalDayFixture(),754,personalChartFixture({id:'temporary',name:'First'}));
  const firstStorage=memory(),first=createViewStore({getStorage:()=>firstStorage});
  first.write({...snapshot,temporaryChart:chart});
  const duplicateStorage=memory(JSON.parse(firstStorage.records.get(VIEW_STORAGE_KEY)!));
  const duplicate=createViewStore({getStorage:()=>duplicateStorage});
  const other=createViewStore({getStorage:()=>memory()});
  assert.equal(other.read(),null);
  assert.equal(duplicate.read()?.temporaryChart?.name,'First');
  first.write({...first.read(),temporaryChart:{...chart,name:'First edited'}});
  duplicate.write({...duplicate.read(),temporaryChart:{...chart,name:'Duplicate edited'}});
  assert.equal(first.read()?.temporaryChart?.name,'First edited');
  assert.equal(duplicate.read()?.temporaryChart?.name,'Duplicate edited');
});

test('malformed or account-owned snapshot data cannot masquerade as a temporary result', () => {
  const chart=libraryRecordAtMinute(natalDayFixture(),754,personalChartFixture({id:'temporary'}));
  const invalidStorage=memory(),store=createViewStore({getStorage:()=>invalidStorage});
  for(const temporaryChart of [{...chart,personality:[65]}, {...chart,id:'current-transit'}, {...chart,source:'manual'}]) {
    store.write({...snapshot,temporaryChart});
    assert.equal(store.read()?.temporaryChart,null);
  }
  const storage=memory(),ready=createViewStore({getStorage:()=>storage});
  ready.write({...snapshot,temporaryChart:{...chart,accountId:'123',revision:4,noteRevision:2}});
  const restored=ready.read()?.temporaryChart;
  assert.ok(restored);
  assert.equal('accountId' in restored,false);assert.equal('revision' in restored,false);
});


test('temporary save recovery keeps only the operation linked to the current tab source',()=>{
  const chart=libraryRecordAtMinute(natalDayFixture(),754,personalChartFixture({id:'temporary'}));
  const storage=memory(),store=createViewStore({getStorage:()=>storage});
  const binding={operationId:'a'.repeat(32),expectedAccountId:'12',sourceId:'temporary'};
  store.write({...snapshot,temporaryChart:chart,temporaryChartSave:{...binding,command:{note:'not a queued command'}}});
  assert.deepEqual(createViewStore({getStorage:()=>storage}).read()?.temporaryChartSave,binding);
  assert.equal(storage.records.get(VIEW_STORAGE_KEY)!.includes('not a queued command'),false);
  for(const temporaryChartSave of [{...binding,sourceId:'another'}, {...binding,operationId:'bad'}, {...binding,expectedAccountId:'bad'}, null]) {
    store.write({...snapshot,temporaryChart:chart,temporaryChartSave});assert.equal(store.read()?.temporaryChartSave,null);
  }
  store.write({...snapshot,temporaryChart:null,temporaryChartSave:binding});assert.equal(store.read()?.temporaryChartSave,null);
  store.write({...snapshot,temporaryChart:chart});assert.equal(store.read()?.temporaryChartSave,undefined);
});


test('the tab snapshot keeps one validated public chart without private fields or previous views',()=>{
  const record=accountNatalChart(112,'2'),{accountId,note,noteRevision,publicRevision,...publicFields}=record;
  const storage=memory(),store=createViewStore({getStorage:()=>storage});
  store.write({...snapshot,publicChart:{...publicFields,secret:'never persist'}});
  assert.deepEqual(createViewStore({getStorage:()=>storage}).read()?.publicChart,publicFields);
  assert.equal(storage.records.get(VIEW_STORAGE_KEY)!.includes('never persist'),false);
  for(const publicChart of [{...publicFields,note:'private'},record,{...publicFields,revision:0},{...publicFields,activations:null}]) {
    store.write({...snapshot,publicChart});assert.equal(store.read()?.publicChart,null);
  }
  const next={...publicFields,id:'b'.repeat(32),name:'Last public'};store.write({...snapshot,publicChart:next});
  assert.equal(store.read()?.publicChart?.id,next.id);assert.equal(storage.records.get(VIEW_STORAGE_KEY)!.includes(record.id),false);
  store.write({...snapshot,publicChart:null});assert.equal(store.read()?.publicChart,null);
  store.write(snapshot);assert.equal(store.read()?.publicChart,undefined);
});

test('short chart IDs preserve the restored selection and editing draft without changing operation IDs',()=>{
 const id='191015375284462255641074847741010754715',operationId='1'.repeat(32);
 const birthForm={editingId:id,accountId:'1',calculationMode:'calculated',fields:{chartName:'Unfinished name',birthDate:'2000-01-01',birthTime:'12:00',birthPlace:'City',chartNote:'Private draft'},city:null,fold:null,base:{note:'Original note',revision:1,noteRevision:1},focus:null};
 const state=createViewStore({getStorage:()=>memory({...snapshot,selectedId:id,librarySelection:[id],birthForm,
   pendingChartWrites:[{operationId,expectedAccountId:'1'}]})}).read();
 assert.equal(state?.selectedId,id.slice(0,10));assert.deepEqual(state?.librarySelection,[id.slice(0,10)]);
 assert.deepEqual(state?.birthForm,{...birthForm,editingId:id.slice(0,10)});
 assert.equal(state?.pendingChartWrites?.[0].operationId,operationId);
});
