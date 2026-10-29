import test from 'node:test';
import assert from 'node:assert/strict';
import type {BirthSubmission} from '../src/views/birth-form.ts';
import { attachBirthForm } from '../src/views/birth-form.ts';
import { getConnectionMode, subscribeConnection } from '../src/data/http-transport.ts';
import { createBirthClient } from '../src/data/birth-client.ts';
import { RANDOM_CHART_NAMES } from '../src/views/random-chart.ts';
import { createChartStore } from '../src/data/chart-store.ts';
import { createViewStore } from '../src/data/view-store.ts';
import { libraryRecordAtMinute } from './fixtures/natal-day.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';
import type { SavedChart, Activation } from '../shared/chart-types.ts';
import type { ChartStore } from '../src/data/chart-store.ts';
import {accountChart} from './helpers/account-chart.ts';
type TestRecord = Omit<Partial<SavedChart>, 'activations'> & { id: string; name: string; revision?: number; noteRevision?: number; calculation?: unknown; activations?: { personality: readonly Partial<Activation>[]; design: readonly Partial<Activation>[] } };
type BirthOptions = Parameters<typeof attachBirthForm>[0];
interface FormNode {
  ownerDocument: {createElement(name: string): FormNode}; className: string;
  replaceChildren(...nodes: FormNode[]): void; append(node: FormNode): void; style: {whiteSpace?: string};
  id: string; value: string; textContent: string; hidden: boolean; open: boolean; disabled: boolean;
  dataset: DOMStringMap; selectionStart: number; selectionEnd: number; selectionDirection?:'forward'|'backward'|'none'; innerHTML: string;
  elements?: Record<string, FormNode>;
  classList: { add(value: unknown): void; remove(value: unknown): void; contains(value: unknown): boolean; toggle(value: unknown, force?: boolean): boolean };
  setAttribute(name: string, value: unknown): void; getAttribute(name: string): string | null; removeAttribute(name: string): void;
  focus(): void; setSelectionRange(start: number, end: number,direction?:'forward'|'backward'|'none'): void; scrollIntoView(): void;
  showModal(): void; close(): void; reset(): void; requestSubmit(): void;
  addEventListener(type: string, handler: (event: FormEvent) => unknown): void;
  emit(type: string, options?: Record<string, unknown>): Promise<void>;
  dispatchEvent(event: { type: string }): Promise<void>;
  querySelector(selector: unknown): FormNode; querySelectorAll(selector: unknown): FormNode[];
}
interface FormEvent { target: FormNode; defaultPrevented: boolean; preventDefault(): void; stopPropagation(): void }
interface RequestRecord { url: string; options: RequestInit; resolve(value: unknown): void; reject(error: unknown): void }


const city = (id: string|number, name: string) => ({ id, name, country: 'DE', region: '', timezone: 'Europe/Berlin' });
const manualChart = () => ({ id: 'manual-1', name: 'Исходная карта', source: 'manual' as const, birthDate: '2000-01-02', birthTime: '03:04', birthPlace: 'Берлин', personality: [20], design: [57], note: 'Заметка', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
const transitChart=()=>{const {accountId,revision,noteRevision,publicRevision,...record}=accountChart();return {...record,id:'transit-1',createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z'};};
const natalChart = () => ({ ...manualChart(), id: 'natal-1', source: 'calculated' as const, birthDate: '2025-10-26', birthTime: '02:30', city: city(1, 'Берлин') });
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test('saved transit metadata uses the existing submit port without birth input or calculation',async t=>{
  const record={...accountChart(),birthPlace:'',birthDate:'',birthTime:'',createdAt:'',updatedAt:''};
  const sent:BirthSubmission[]=[];
  const h=formHarness(t,{charts:[record],canCalculate:()=>false,submitChart:async input=>{sent.push(input);return {id:record.id,persisted:true,metadataOnly:true};}});
  h.form.open(true,record.id);assert.equal(h.form.opened,true);
  h.element('chartName').value='Новое имя';h.element('chartNote').value='Новая заметка';
  assert.notEqual(h.element('birthDate').getAttribute('readonly'),null);h.element('birthDate').value='Not a birth date';await h.submit();
  assert.equal(sent.length,1);assert.equal(sent[0].birth,undefined);assert.equal(sent[0].previous,record);
  assert.equal(sent[0].previous?.utc,record.utc);assert.equal(sent[0].previous?.source,'transit');
  assert.equal(h.requests.length,0);assert.equal(h.form.opened,false);
});

test('a legacy manual draft keeps its raw fields and restores into supported natal validation',async t=>{
  const h=formHarness(t),fields={chartName:'Legacy draft',birthDate:'12.',birthTime:'3',birthPlace:'Unresolved city',chartNote:'Keep this note'};
  assert.equal(h.form.restore({editingId:null,accountId:null,calculationMode:'manual',fields,city:null,fold:null,base:null,focus:null}),true);
  assert.deepEqual(h.form.snapshot?.fields,fields);assert.equal(h.form.snapshot?.calculationMode,'calculated');
  await h.submit();assert.equal(h.calls.persisted.length,0);assert.equal(h.requests.length,0);
  assert.ok(h.element('birthDateError').textContent);assert.ok(h.element('birthPlaceError').textContent);
});

for (const [port, accountId] of [['36', null], ['3636', null], ['', null], ['', 'signed-in-account']] as const)
test(`random example calculates a local record on ${port || 'production'} for ${accountId ? 'an account' : 'a guest'}`, async t => {
  t.mock.method(Math, 'random', () => 0);
  const original = manualChart();
  let accountWrites = 0;
  const h = formHarness(t, { charts: [original], port, getAccountId: () => accountId,
    submitChart: async () => { accountWrites++; return {id:'unexpected-account-write',persisted:true}; } });
  const creating = h.element('randomChartButton').emit('click');
  assert.equal(h.form.opened, false, 'one click never opens or modifies the birth dialog');
  assert.equal(h.requests.length, 1);
  assert.ok(h.requests[0].url.startsWith('/api/cities?q='));
  await h.element('randomChartButton').emit('click');
  assert.equal(h.requests.length, 1, 'busy clicks cannot start another city request');
  h.requests[0].resolve({ cities: [{ ...city('524901', 'Москва'), country: 'RU', timezone: 'Europe/Moscow' }] });
  await settle();
  const calculation = h.requests[1];
  assert.equal(calculation.url, '/api/calculate');
  const payload = JSON.parse(String(calculation.options.body));
  assert.equal(payload.mode, 'natal'); assert.equal(payload.cityId, '524901');
  assert.equal(payload.date, '1950-01-01'); assert.equal(payload.time, '03:00'); assert.equal(payload.fold, 0);
  assert.equal(payload.name, RANDOM_CHART_NAMES[0]);
  assert.ok(payload.date >= '1950-01-01' && payload.date <= '2005-12-31');
  assert.deepEqual(h.calls.persisted, [], 'no invented gates are saved while the server is pending');
  calculation.resolve({ chart: { name: payload.name, birthDate: payload.date, birthTime: payload.time, birthPlace: 'Москва', personality: [20], design: [57], utc: '1950-01-01T00:00:00Z' } });
  await creating;
  assert.equal(h.store.charts.length, 2);
  assert.deepEqual(h.store.charts[0], original);
  assert.deepEqual(h.store.charts[1].personality, [20]); assert.deepEqual(h.store.charts[1].design, [57]);
  assert.equal(h.store.charts[1].source, 'calculated');
  assert.equal(h.store.charts[1].name, payload.name);
  assert.equal(h.calls.saved.length, 1); assert.equal(h.form.opened, false);
  assert.equal(accountWrites, 0, 'a random example never creates a record in the account');
  assert.equal(h.element('randomChartButton').disabled, false);
});

test('opening a normal form supersedes a random example without accepting a late lookup', async t => {
  const h = formHarness(t, { port: '3636' });
  const creating = h.element('randomChartButton').emit('click');
  h.form.open();
  h.requests[0].resolve({ cities: [{ ...city('524901', 'Москва'), country: 'RU' }] });
  await creating; await settle();
  assert.equal(h.requests[0].options.signal!.aborted, true);
  assert.equal(h.requests.length, 1); assert.deepEqual(h.calls.saved, []);
  assert.equal(h.form.opened, true); assert.equal(h.element('chartName').value, '');
});

test('random lookup errors are a toast with no dialog and allow a fresh one-click retry', async t => {
  const h = formHarness(t, { port: '36' });
  const creating = h.element('randomChartButton').emit('click');
  h.requests[0].reject(new Error('Нет соединения'));
  await creating;
  assert.equal(h.form.opened, false); assert.deepEqual(h.calls.saved, []);
  assert.deepEqual(h.calls.toasts, ['Нет соединения']);
  assert.equal(h.element('randomChartButton').disabled, false);
  const retry = h.element('randomChartButton').emit('click');
  assert.equal(h.requests.length, 2);
  h.form.open(); h.requests[1].resolve({ cities: [] }); await retry;
});

test('a random temporary example replaces one ready tab result even beside 500 projected account records', async t => {
  t.mock.method(Math,'random',()=>0);
  const original=libraryRecordAtMinute(natalDayFixture(),754,personalChartFixture({id:'old-temporary'}));
  const legacy=Array.from({length:500},(_,i)=>({...manualChart(),id:`saved-${i}`}));
  const store=createChartStore({initialTemporaryChart:original});
  store.projectLibrary(legacy as readonly SavedChart[], true);
  const tabValues=new Map<string,string>();
  const tab=createViewStore({getStorage:()=>({getItem:key=>tabValues.get(key)??null,setItem:(key,value)=>{tabValues.set(key,value);}})});
  const h=formHarness(t,{chartStore:store,getChart:id=>id?store.get(id):undefined,saveChart:chart=>{
    store.setTemporary(chart);return tab.write({version:1,selectedId:chart.id,temporaryChart:store.temporaryChart});
  }});
  const creating=h.element('randomChartButton').emit('click');
  assert.equal(h.requests.length,1);
  assert.equal(store.temporaryChart?.id,original.id,'the ready chart stays while the city is loading');
  h.requests[0].resolve({cities:[{...city('524901','Москва'),country:'RU',timezone:'Europe/Moscow'}]});
  await settle();
  assert.equal(store.temporaryChart?.id,original.id,'the ready chart stays while calculation is pending');
  h.requests[1].resolve({chart:libraryRecordAtMinute(natalDayFixture({date:'1950-01-01'}),0)});
  await creating;
  assert.notEqual(store.temporaryChart?.id,original.id);
  assert.equal(store.has(original.id),false);
  assert.equal(store.charts.length,500);
  assert.equal(tab.read()?.temporaryChart?.id,store.temporaryChart?.id);
  assert.deepEqual(h.calls.toasts,[]);
});

test('a mismatched server UTC is never saved and a late random calculation cannot replace an opened form', async t => {
  t.mock.method(Math, 'random', () => 0);
  const h = formHarness(t, { port: '36' });
  for (const superseded of [false, true]) {
    const start = h.requests.length;
    const creating = h.element('randomChartButton').emit('click');
    h.requests[start].resolve({ cities: [{ ...city('524901', 'Москва'), country: 'RU', timezone: 'Europe/Moscow' }] });
    await settle();
    assert.equal(h.element('randomChartButton').disabled, true);
    if (superseded) h.form.open();
    h.requests[start + 1].resolve({ chart: { name: 'Пример', birthDate: '1950-01-01', birthTime: '03:00', birthPlace: 'Москва', personality: [20], design: [57], utc: '1950-01-01T01:00:00Z' } });
    await creating;
    assert.deepEqual(h.calls.saved, []); assert.equal(h.store.charts.length, 0);
    assert.equal(h.element('randomChartButton').disabled, false);
    assert.equal(h.form.opened, superseded);
  }
  assert.equal(h.calls.toasts.length, 1, 'only the current operation can report a UTC mismatch');
});

test('random generation cancels offline without saving a late result and permits a server retry', async t => {
  const {createStandConnection} = await import('./helpers/preview/stand-connection.ts');
  const {configureTransportSimulation} = await import('../src/data/http-transport.ts');
  const connection = createStandConnection();
  configureTransportSimulation(connection); t.after(() => configureTransportSimulation(null));
  connection.set('offline');
  const h = formHarness(t);
  await h.element('randomChartButton').emit('click');
  assert.equal(h.requests.length, 0);
  assert.equal(h.element('randomChartButton').disabled, true);
  connection.set('online');
  const creating = h.element('randomChartButton').emit('click');
  assert.equal(h.requests.length, 1);
  connection.set('offline');
  assert.equal(h.requests[0].options.signal!.aborted, true);
  h.requests[0].resolve({cities:[{...city('524901','Москва'),country:'RU',timezone:'Europe/Moscow'}]});
  await creating;
  assert.equal(h.requests.length, 1); assert.equal(h.store.charts.length, 0);
  assert.deepEqual(h.calls.saved, []);
  connection.set('server');
  const retry = h.element('randomChartButton').emit('click');
  assert.equal(h.requests.length, 2, 'server failure permits an explicit retry');
  h.requests[1].reject(Object.assign(new Error('server unavailable'), {code:'server_unavailable'}));
  await retry;
  assert.equal(h.element('randomChartButton').disabled, false);
  assert.equal(h.calls.toasts.length, 1); assert.equal(h.store.charts.length, 0);
});

function projectedStore(charts: readonly TestRecord[]) {
  const chartStore = createChartStore(); chartStore.projectLibrary(charts as readonly SavedChart[], true);
  return chartStore;
}

function formHarness(t: test.TestContext, { charts = [], selectedId = charts[0]?.id || 'current-transit', persist = true, chartStore = null, port = '', saveChart, getChart, submitChart, isCheckingSubmission, noteComparisonLabel, getAccountId, onDraftChange, reuseTimers=false }: { charts?: readonly TestRecord[]; selectedId?: string; persist?: boolean; chartStore?: ChartStore | null; port?: string; saveChart?:BirthOptions['saveChart']; getChart?:BirthOptions['getChart']; submitChart?: BirthOptions['submitChart']; isCheckingSubmission?: BirthOptions['isCheckingSubmission']; noteComparisonLabel?: string; getAccountId?:()=>string|null; onDraftChange?:()=>void; reuseTimers?:boolean } = {}) {
  if(!reuseTimers)t.mock.timers.enable({ apis: ['setTimeout'] });
  const elements = new Map<string, FormNode>(), requests: RequestRecord[] = [];
  const documentHandlers=new Map<string,(()=>void)[]>();
  const calls = { beforeOpen: 0, saved: [] as string[], saveOptions: [] as Parameters<BirthOptions['onSave']>[1][], persisted: [] as (readonly TestRecord[])[], replaced: [] as (readonly TestRecord[])[], toasts: [] as string[] };
  const fields = { name: 'chartName', birthDate: 'birthDate', birthTime: 'birthTime', birthPlace: 'birthPlace', note: 'chartNote', personality: 'personalityGates', design: 'designGates' };
  const document = {
    defaultView: { location: { port } },
    activeElement: null as FormNode | null,
    addEventListener(type:string,callback:()=>void) {documentHandlers.set(type,[...documentHandlers.get(type)??[],callback]);},
    createElement: () => element('generated-' + elements.size),
    getElementById(id: string) { return element(id); },
    querySelectorAll() {return [];},
  };
  function element(id: string): FormNode {
    if (elements.has(id)) return elements.get(id)!;
    const attributes = new Map<string, string>(), classes = new Set<unknown>(), handlers = new Map<string, ((event: FormEvent) => unknown)[]>();
    let markup = '', ownText = ''; let children: FormNode[] = [];
    const node: FormNode = {
      id, value: '', ownerDocument:document, className:'', style:{},
      get textContent(){return ownText + children.map(child=>child.textContent).join('');},
      set textContent(value){ownText=value;children=[];},
      replaceChildren(...nodes:FormNode[]){ownText='';children=nodes;},append(node:FormNode){children.push(node);},
      hidden: true, open: false, disabled: false, dataset: {} as DOMStringMap, selectionStart: 0, selectionEnd: 0,
      get innerHTML() { return markup; },
      set innerHTML(value) { markup = String(value); if (id === 'foldChoice') this.value = ''; },
      classList: {
        add(value: unknown) { classes.add(value); }, remove(value: unknown) { classes.delete(value); }, contains(value: unknown) { return classes.has(value); },
        toggle(value: unknown, force?: boolean) { const enabled = force ?? !classes.has(value); if (enabled) classes.add(value); else classes.delete(value); return enabled; },
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      focus() { document.activeElement = this; },
      setSelectionRange(start: number, end: number,direction:'forward'|'backward'|'none'='none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection=direction; },
      scrollIntoView() {},
      showModal() { this.open = true; }, close() { this.open = false; }, requestSubmit() { void this.emit('submit'); },
      addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type)!.push(handler); },
      async emit(type: string, options = {}) {
        const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
        const pending = (handlers.get(type) || []).map(handler => handler(event));
        if (id === 'chartDialog' && type === 'cancel' && !event.defaultPrevented) this.close();
        await Promise.all(pending);
      },
      dispatchEvent(event: { type: string; }) { return this.emit(event.type); },
      querySelector(selector: unknown) { assert.equal(selector, '.form-extras'); return element('formExtras'); },
      querySelectorAll(selector: unknown) {
        if (selector === '[role="option"]') return [...markup.matchAll(/data-city-index="(\d+)"/g)].map(([, index]) => element(`city-option-${index}`));
        assert.equal(selector, 'input, textarea, select, button');
        return [...Object.values(fields).map(element), element('foldChoice'), element('saveChartButton'), element('cancelDialog')];
      },
      reset() { for (const input of Object.values(fields).map(element)) input.value = ''; element('foldChoice').value = ''; },
    };
    elements.set(id, node);
    return node;
  }
  element('chartForm').elements = Object.fromEntries(Object.entries(fields).map(([name, id]) => [name, element(id)]));
  let records = charts;
  function replaceRecords(next: readonly TestRecord[]) {
    assert.equal(chartStore, null, 'fixture replacement is only available for the in-memory form harness');
    calls.replaced.push(next); records = next;
  }
  const store = chartStore || {
    get charts() { return records; }, get selectedId() { return selectedId; },
    get current() { return records.find(chart => chart.id === selectedId) || { id: 'current-transit', source: 'transit' as const, personality: [], design: [] }; },
  };
  const form = attachBirthForm({
    document: document as unknown as Document,
    getChart: getChart ?? (id => store.charts.find(chart => chart.id === id) as SavedChart | undefined),
    saveChart: saveChart ?? ((chart, id) => {
      const next = id ? store.charts.map(item => item.id === id ? chart : item) : [...store.charts, chart];
      calls.persisted.push(next);
      if ('projectLibrary' in store) { if (!persist) calls.replaced.push(next); store.projectLibrary(next as readonly SavedChart[], persist); }
      else replaceRecords(next);
      return persist;
    }),
    submitChart, isCheckingSubmission, noteComparisonLabel, getAccountId, onDraftChange, getConnectionMode, subscribeConnection, session: { get selectedId() { return selectedId; }, get original() { return store.charts.find(chart => chart.id === selectedId); } } as unknown as BirthOptions['session'],
    onSave: (id, options) => { calls.saved.push(id); calls.saveOptions.push(options); }, beforeOpen: () => calls.beforeOpen++, toast: text => calls.toasts.push(text),
    getFormData: () => new Map(Object.entries(fields).map(([name, id]) => [name, element(id).value])) as unknown as FormData,
    ...createBirthClient(function requestJSON<T = unknown>(url: string, options: RequestInit = {}) {
      let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes as (value: unknown) => void; reject = no; });
      requests.push({ url, options, resolve, reject });
      return promise;
    }),
  });
  t.after(() => form.close());
  return {
    form, document, element, store, calls, requests, replaceRecords,
    selectionChanged(){for(const callback of documentHandlers.get('selectionchange')??[])callback();},
    submit: () => element('chartForm').emit('submit'),
    mode: (mode: string) => element(`mode-${mode}`).emit('click'),
    async search(query: string) {
      element('birthPlace').value = query;
      await element('birthPlace').emit('input');
      t.mock.timers.tick(220);
      await settle();
      return requests.at(-1);
    },
    chooseCity(index = 0) {
      return element('cityResults').emit('click', { target: { closest(selector: unknown) { assert.equal(selector, '[data-city-index]'); return { dataset: { cityIndex: String(index) } }; } } });
    },
  };
}

for (const { key, options, selectedName } of [
  { key: 'ArrowUp', options: ['city-option-2', 'city-option-1', 'city-option-0', 'city-option-2'], selectedName: 'Мюнхен' },
  { key: 'ArrowDown', options: ['city-option-0', 'city-option-1', 'city-option-2', 'city-option-0'], selectedName: 'Берлин' },
] as const) test(`city suggestions start at the correct end for ${key} and wrap cyclically`, async t => {
  const h = formHarness(t); h.form.open();
  const request = await h.search('Город');
  request!.resolve!({ cities: [city(1, 'Берлин'), city(2, 'Гамбург'), city(3, 'Мюнхен')] }); await settle();
  const input = h.element('birthPlace');
  assert.equal(input.getAttribute('aria-activedescendant'), null);
  for (const option of options) {
    await input.emit('keydown', { key });
    assert.equal(input.getAttribute('aria-activedescendant'), option);
  }
  await input.emit('keydown', { key: 'Enter' });
  assert.match(input.value, new RegExp(selectedName));
  assert.equal(h.element('cityResults').hidden, true);
});

test('city search debounces input and discards an older response even when it ignores cancellation', async t => {
  const h = formHarness(t); h.form.open();
  h.element('birthPlace').value = 'Б';
  await h.element('birthPlace').emit('input');
  t.mock.timers.tick(220);
  assert.equal(h.requests.length, 0, 'one letter never sends a city request');
  const first = await h.search('Бер');
  const second = await h.search('Гам');
  assert.equal(first!.options.signal!.aborted, true);
  assert.equal(second!.url, '/api/cities?q=%D0%93%D0%B0%D0%BC');
  second!.resolve!({ cities: [city(2, 'Гамбург')] }); await settle();
  const latestMarkup = h.element('cityResults').innerHTML;
  assert.match(latestMarkup, /Гамбург/);
  first!.resolve!({ cities: [city(1, 'Берлин')] }); await settle();
  assert.equal(h.element('cityResults').innerHTML, latestMarkup, 'late results cannot replace the current query');
  await h.chooseCity();
  assert.match(h.element('birthPlace').value, /Гамбург/);
  assert.equal(h.element('cityResults').hidden, true);
  assert.equal(h.element('birthPlace').getAttribute('aria-expanded'), 'false');
});

test('opening metadata or another natal form invalidates an in-flight city response and clears its selection', async t => {
  const record=transitChart(),h = formHarness(t,{charts:[record]}); h.form.open();
  const first = await h.search('Берлин');
  h.form.open(true,record.id);
  assert.equal(first!.options.signal!.aborted, true);
  first!.resolve!({ cities: [city(1, 'Берлин')] }); await settle();
  assert.equal(h.element('cityResults').hidden, true);
  assert.doesNotMatch(h.element('cityResults').innerHTML, /Берлин/);
  assert.equal(h.element('birthPlace').getAttribute('role'), null);
  h.form.open();
  const second = await h.search('Гамбург');
  h.form.open();
  assert.equal(second!.options.signal!.aborted, true);
  second!.resolve!({ cities: [city(2, 'Гамбург')] }); await settle();
  assert.equal(h.element('cityResults').hidden, true);
  assert.equal(h.element('birthPlace').value, '');
  h.element('chartName').value = 'Новая карта';
  h.element('birthDate').value = '01.01.2000'; h.element('birthTime').value = '12:00';
  await h.submit();
  assert.match(h.element('birthPlaceError').textContent, /Выберите город/);
  assert.equal(h.requests.length, 2, 'a stale city does not authorize a birth calculation');
});

test('cancel aborts pending city search and every calculation exit without saving or surfacing AbortError', async t => {
  const h = formHarness(t, { charts: [natalChart()] });
  h.form.open(); const search = await h.search('Берлин');
  await h.element('cancelDialog').emit('click');
  assert.equal(search!.options.signal!.aborted, true);
  search!.reject!(abortError()); await settle();
  assert.equal(h.form.opened, false);
  assert.equal(h.element('cityStatus').classList.contains('is-error'), false);
  for (const exit of ['cancel-button', 'native-cancel', 'new-form'] as const) {
    h.form.open(true, 'natal-1');
    const submitting = h.submit(), request = h.requests.at(-1);
    assert.equal(h.element('chartForm').getAttribute('aria-busy'), 'true');
    assert.equal(h.element('cancelDialog').disabled, false, 'a busy calculation still allows cancellation');
    if (exit === 'cancel-button') await h.element('cancelDialog').emit('click');
    else if (exit === 'native-cancel') await h.element('chartDialog').emit('cancel');
    else h.form.open();
    assert.equal(request!.options.signal!.aborted, true, exit);
    request!.reject!(abortError()); await submitting;
    assert.equal(h.element('formError').textContent, '', exit);
    assert.equal(h.form.opened, exit === 'new-form');
  }
  assert.deepEqual(h.calls.persisted, []);
  assert.deepEqual(h.calls.saved, []);
  assert.deepEqual(h.calls.toasts, []);
});

test('a late calculation success cannot save after cancellation or mutate a newly opened form', async t => {
  const h = formHarness(t, { charts: [natalChart()] });
  for (const exit of ['cancel-button', 'native-cancel', 'new-form'] as const) {
    h.form.open(true, 'natal-1');
    const submitting = h.submit(), request = h.requests.at(-1);
    if (exit === 'cancel-button') await h.element('cancelDialog').emit('click');
    else if (exit === 'native-cancel') await h.element('chartDialog').emit('cancel');
    else h.form.open();
    assert.equal(request!.options.signal!.aborted, true, exit);
    // Deliberately model a transport whose completed response wins the abort race.
    request!.resolve!({ chart: { personality: [25], design: [10] } });
    await submitting;
    assert.deepEqual(h.calls.persisted, [], `${exit}: a canceled result must not be saved`);
    assert.deepEqual(h.calls.saved, [], `${exit}: a canceled result must not select a chart`);
    assert.deepEqual(h.calls.toasts, [], exit);
    assert.equal(h.element('formError').textContent, '', exit);
    assert.equal(h.form.opened, exit === 'new-form');
  }
});

test('late calculation errors cannot change validation or DST choices after cancellation', async t => {
  const h = formHarness(t, { charts: [natalChart()] });
  for (const exit of ['cancel-button', 'native-cancel', 'new-form'] as const) {
    h.form.open(true, 'natal-1');
    const submitting = h.submit(), request = h.requests.at(-1);
    if (exit === 'cancel-button') await h.element('cancelDialog').emit('click');
    else if (exit === 'native-cancel') await h.element('chartDialog').emit('cancel');
    else h.form.open();
    request!.reject!(Object.assign(new Error('Устаревшая ошибка'), {
      code: 'ambiguous_time', choices: [{ fold: 0, label: 'Старая дата' }],
    }));
    await submitting;
    assert.equal(h.element('formError').textContent, '', exit);
    assert.equal(h.element('foldField').hidden, true, exit);
    assert.doesNotMatch(h.element('foldChoice').innerHTML, /Старая дата/);
    assert.equal(h.form.opened, exit === 'new-form');
  }
  assert.deepEqual(h.calls.persisted, []);
  assert.deepEqual(h.calls.saved, []);
  assert.deepEqual(h.calls.toasts, []);
});

test('late city responses cannot reopen suggestions or show errors after the dialog has been canceled', async t => {
  const h = formHarness(t);
  for (const exit of ['cancel-button', 'native-cancel'] as const) {
    for (const outcome of ['success', 'error'] as const) {
      h.form.open();
      const request = await h.search('Берлин');
      if (exit === 'cancel-button') await h.element('cancelDialog').emit('click');
      else await h.element('chartDialog').emit('cancel');
      assert.equal(request!.options.signal!.aborted, true);
      if (outcome === 'success') request!.resolve!({ cities: [city(1, 'Берлин')] });
      else request!.reject!(new Error('Устаревшая ошибка поиска'));
      await settle();
      assert.equal(h.form.opened, false);
      assert.equal(h.element('cityResults').hidden, true, exit);
      assert.doesNotMatch(h.element('cityResults').innerHTML, /Берлин/);
      assert.equal(h.element('birthPlace').getAttribute('aria-expanded'), 'false');
      assert.equal(h.element('cityStatus').classList.contains('is-error'), false);
      assert.doesNotMatch(h.element('cityStatus').textContent, /Устаревшая ошибка поиска/);
    }
  }
});

test('legacy manual records require supported natal validation before producing a ready result',async t=>{
  const original=Object.freeze(manualChart()),h=formHarness(t,{charts:[original]});
  h.form.open(true,original.id);h.element('chartName').value='Новое имя';
  h.element('chartNote').value='Сохранить ввод';await h.submit();
  assert.equal(h.requests.length,0);assert.equal(h.calls.persisted.length,0);
  assert.match(h.element('birthPlaceError').textContent,/Выберите город/);
  assert.equal(h.element('chartNote').value,'Сохранить ввод');assert.equal(h.store.charts[0],original);
});

test('editing saved transit metadata advances its timestamp while preserving its exact data', async t => {
  const original = { ...transitChart(), updatedAt: '2020-01-01T00:00:00.000Z', calculation: { legacyVersion: 1, extra: 'kept' } };
  const chartStore = projectedStore([original]);
  const h = formHarness(t, { chartStore, selectedId: original.id });
  h.form.open(true, original.id);
  h.element('chartName').value = 'Новое имя';
  await h.submit();
  const saved = chartStore.charts[0];
  assert.equal(saved.name, 'Новое имя');
  assert.ok(Date.parse(saved.updatedAt) > Date.parse(original.updatedAt));
  assert.equal(saved.id, original.id);
  assert.equal(saved.createdAt, original.createdAt);
  assert.deepEqual(saved.personality, original.personality);
  assert.deepEqual(saved.design, original.design);
  assert.deepEqual(Reflect.get(saved, 'calculation'), original.calculation);
  assert.equal(h.requests.length, 0);
});

test('failed browser persistence keeps the edited chart only in memory and explicitly warns instead of claiming success', async t => {
  const original = Object.freeze(transitChart());
  const h = formHarness(t, { charts: [original], persist: false });
  h.form.open(true, original.id); h.element('chartName').value = 'Несохранённая карта';
  await h.submit();
  assert.equal(h.calls.persisted.length, 1); assert.equal(h.calls.replaced.length, 1);
  assert.equal(h.calls.replaced[0], h.calls.persisted[0]);
  assert.equal(h.store.charts[0].name, 'Несохранённая карта');
  assert.equal(original.name, transitChart().name);
  assert.deepEqual(h.calls.saved, [original.id]);
  assert.equal(h.form.opened, false);
  assert.deepEqual(h.calls.toasts, ['Карта открыта, но не сохранена в браузере.']);
});

for (const failure of ['deleted', 'corrupt'] as const) test(`a ${failure} chart cannot become an in-memory save from a stale editor`, async t => {
  const original = transitChart(), chartStore = projectedStore([original]);
  const h = formHarness(t, { chartStore, selectedId: original.id, saveChart() { throw Object.assign(new Error(failure === 'deleted' ? 'Карта удалена' : 'Карта повреждена'), {code: failure}); } });
  h.form.open(true, original.id); h.element('chartName').value = 'Несохранённая правка';
  await h.submit();
  assert.equal(h.form.opened, true, 'the action error stays inside the open form');
  assert.match(h.element('formError').textContent, failure === 'deleted' ? /удалена/ : /повреждена/);
  assert.notEqual(chartStore.get(original.id)?.name, 'Несохранённая правка');
  assert.deepEqual(h.calls.saved, []); assert.deepEqual(h.calls.toasts, []);
  assert.equal(chartStore.charts[0], original, 'the rejected save cannot replace the current projected record');
});

test('ambiguous local time exposes only valid DST choices and retries with the explicit fold', async t => {
  const original = natalChart(), h = formHarness(t, { charts: [original] });
  h.form.open(true, original.id);
  const firstSubmit = h.submit(), first = h.requests.at(-1);
  assert.deepEqual(JSON.parse(first!.options.body as string), { name: original.name, date: '2025-10-26', time: '02:30', cityId: '1', cityName: 'Берлин', mode: 'natal' });
  first!.reject!(Object.assign(new Error('Выберите местное время'), { code: 'ambiguous_time', choices: [
    { fold: 0, label: 'Летнее <UTC+02>' }, { fold: 1, label: 'Зимнее UTC+01' }, { fold: 2, label: 'Invalid choice' },
  ] }));
  await firstSubmit;
  assert.equal(h.element('foldField').hidden, false);
  assert.match(h.element('foldChoice').innerHTML, /value="0"/); assert.match(h.element('foldChoice').innerHTML, /value="1"/);
  assert.match(h.element('foldChoice').innerHTML, /&lt;UTC\+02&gt;/); assert.doesNotMatch(h.element('foldChoice').innerHTML, /Invalid choice|value="2"/);
  assert.equal(h.document.activeElement, h.element('foldChoice'));
  assert.equal(h.element('chartForm').getAttribute('aria-busy'), 'false');
  await h.submit();
  assert.equal(h.requests.length, 1, 'no retry is sent until a fold is chosen');
  assert.match(h.element('foldChoiceError').textContent, /Выберите один/);
  h.element('foldChoice').value = '1';
  const retrying = h.submit(), retry = h.requests.at(-1);
  assert.equal(JSON.parse(retry!.options.body as string).fold, 1);
  retry!.resolve!({ chart: { personality: [25], design: [10], birthDate: '2025-10-26', birthTime: '02:30', timezone: 'Europe/Berlin' } });
  await retrying;
  assert.equal(h.store.charts[0].id, original.id); assert.equal(h.store.charts[0].createdAt, original.createdAt);
  assert.deepEqual(h.store.charts[0].city, original.city); assert.equal(h.store.charts[0].source, 'calculated');
  assert.deepEqual(h.calls.saved, [original.id]);
  assert.equal(h.form.opened, false);
  assert.deepEqual(h.calls.toasts, []);
});

test('calculated names are normalized before the request and retained when a response supplies another name', async t => {
  const original = natalChart(), h = formHarness(t, { charts: [original] });
  h.form.open(true, original.id); h.element('chartName').value = '  мАРат & "друг"  ';
  const submitting = h.submit(), request = h.requests.at(-1);
  assert.equal(JSON.parse(request!.options.body as string).name, 'МАРат & "друг"');
  request!.resolve!({ chart: { ...original, name: 'серверное имя' } });
  await submitting;
  assert.equal(h.store.charts[0].name, 'МАРат & "друг"');
  assert.equal(h.store.charts[0].id, original.id);
});

test('editing only the name and note preserves the full exact calculated chart without a new calculation or success notice', async t => {
  const original = Object.freeze({ ...natalChart(), utc: '2025-10-26T01:30:43.321Z', birthTime: '02:30:43',
    fold: 1, utcOffset: 'UTC+01:00', timezone: 'Europe/Berlin', updatedAt: '2020-01-01T00:00:00.000Z',
    designUtc: '2025-07-30T03:24:15.678Z', activations: { personality: [{ planet: 'sun', longitude: 217.345 }], design: [{ planet: 'sun', longitude: 129.345 }] },
    calculation: { engine: 'swiss', version: 'fixture', residual: 1e-11 } });
  const h = formHarness(t, { charts: [original] });
  h.form.open(true, original.id);
  h.element('chartName').value = 'Новое имя'; h.element('chartNote').value = 'Новая заметка';
  const submitting = h.submit();
  assert.equal(h.requests.length, 0, 'descriptive fields do not invalidate the astronomical calculation');
  await submitting;
  const saved = h.store.charts[0];
  assert.equal(saved.name, 'Новое имя'); assert.equal(saved.note, 'Новая заметка');
  for (const key of ['utc', 'birthTime', 'fold', 'utcOffset', 'timezone', 'designUtc', 'activations', 'calculation', 'personality', 'design', 'createdAt'] as const) assert.deepEqual(Reflect.get(saved, key), Reflect.get(original, key), key);
  assert.notEqual(saved.updatedAt, original.updatedAt);
  assert.deepEqual(h.calls.saved, [original.id]); assert.deepEqual(h.calls.toasts, []);
  assert.deepEqual(h.calls.saveOptions, [{ metadataOnly: true }]);
});

test('metadata editing with the real store retains every supported saved calculation field and exact UTC', async t => {
  const exact = { ...libraryRecordAtMinute(natalDayFixture(), 754, personalChartFixture()), utc: '2026-09-24T12:34:45.321Z', birthTime: '12:34:45', city: city('test-city', 'Берлин'), calculation: { unknown: true } };
  const chartStore = projectedStore([exact]);
  const original = chartStore.get(exact.id)!;
  assert.equal(original!.birthTime, '12:34:45'); assert.deepEqual(Reflect.get(original!, 'calculation'), exact.calculation);
  const h = formHarness(t, { chartStore, selectedId: exact.id });
  h.form.open(true, exact.id); h.element('chartName').value = 'Новое имя'; h.element('chartNote').value = 'Новая заметка';
  await h.submit();
  assert.equal(h.requests.length, 0);
  const saved = chartStore.charts[0];
  for (const key of Object.keys(original).filter(key => !['name', 'note', 'updatedAt'].includes(key))) assert.deepEqual(Reflect.get(saved, key), Reflect.get(original!, key), key);
  assert.equal(saved.utc, exact.utc); assert.equal(saved.name, 'Новое имя'); assert.equal(saved.note, 'Новая заметка');
  assert.equal(saved.birthTime, exact.birthTime); assert.deepEqual(Reflect.get(saved, 'calculation'), exact.calculation);
  assert.deepEqual(h.calls.saveOptions, [{ metadataOnly: true }]);
});

for (const field of ['birthDate', 'birthTime', 'city'] as const) test(`changing calculated ${field} still requests and saves a fresh calculation`, async t => {
  const original = { ...natalChart(), utc: '2025-10-26T01:30:00Z' };
  const h = formHarness(t, { charts: [original] });
  h.form.open(true, original.id);
  if (field === 'city') {
    const search = await h.search('Гамбург'); search!.resolve!({ cities: [city(2, 'Гамбург')] }); await settle(); await h.chooseCity();
  } else h.element(field).value = field === 'birthDate' ? '27.10.2025' : '02:31';
  const submitting = h.submit();
  const requests = h.requests.filter(request => request.url === '/api/calculate');
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].options.body as string);
  assert.equal(payload.date, field === 'birthDate' ? '2025-10-27' : '2025-10-26');
  assert.equal(payload.time, field === 'birthTime' ? '02:31' : '02:30');
  assert.equal(payload.cityId, field === 'city' ? '2' : '1');
  requests[0].resolve!({ chart: { ...original, utc: '2025-10-27T01:31:00Z', personality: [25], design: [10] } });
  await submitting;
  assert.equal(h.store.charts[0].utc, '2025-10-27T01:31:00Z');
  assert.deepEqual(h.store.charts[0].personality, [25]);
  assert.deepEqual(h.calls.toasts, []);
});


test('new natal calculations reject dates outside the hundred-year creation window before transport', async t => {
  const h = formHarness(t, { charts: [natalChart()] });
  for (const value of ['31.12.1800', '01.01.2300', '01.01.2500'] as const) {
    h.form.open(true, 'natal-1'); h.element('birthDate').value = value;
    const submitting = h.submit(); await settle();
    assert.equal(h.requests.length, 0, 'invalid natal dates never start a calculation');
    await submitting;
    assert.match(h.element('birthDateError').textContent, /1801.*2299/);
    assert.equal(h.document.activeElement, h.element('birthDate'));
  }
});

test('creation limits retain both boundary dates and metadata edits of older saved charts', async t => {
  const old = { ...natalChart(), utc: '2350-01-01T12:00:00Z', birthDate: '2350-01-01', birthTime: '13:00' };
  const h = formHarness(t, { charts: [old] });
  h.form.open(true, old.id); h.element('chartName').value = 'Новое имя'; await h.submit();
  assert.equal(h.requests.length, 0); assert.equal(h.calls.persisted.at(-1)![0].utc, old.utc);
  for (const value of ['01.01.1801', '31.12.2299'] as const) {
    h.form.open(true, old.id); h.element('birthDate').value = value;
    const submitting = h.submit(); const request = h.requests.at(-1);
    assert.equal(request?.url, '/api/calculate');
    request!.resolve!({ chart: { personality: [], design: [] } }); await submitting;
  }
});


test('compact form reports validation beside each field without starting a request', async t => {
  const h = formHarness(t);
  h.form.open();
  await h.submit();
  assert.match(h.element('chartNameError').textContent, /имя/);
  assert.match(h.element('birthDateError').textContent, /дату/);
  assert.match(h.element('birthTimeError').textContent, /время/);
  assert.match(h.element('birthPlaceError').textContent, /город/);
  assert.equal(h.element('chartName').getAttribute('aria-invalid'), 'true');
  assert.equal(h.element('formError').textContent, '');
  assert.equal(h.requests.length, 0);
  assert.equal(h.document.activeElement, h.element('chartName'));
  h.element('chartName').value = 'Анна';
  await h.element('chartName').emit('input');
  assert.equal(h.element('chartNameError').textContent, '');
  assert.match(h.element('birthDateError').textContent, /дату/);
});

test('the name limit is thirty and opening an old card never truncates its name', async t => {
  const original = { ...transitChart(), name: 'Я'.repeat(31) };
  const h = formHarness(t, { charts: [original] });
  h.form.open(true, original.id);
  assert.equal(h.element('chartName').value, original.name);
  await h.submit();
  assert.equal(h.element('chartNameError').textContent, 'Не больше 30 символов');
  assert.equal(h.calls.persisted.length, 0);
  h.element('chartName').value = 'Я'.repeat(30);
  await h.submit();
  assert.equal(h.calls.persisted.length, 1);
  assert.equal(h.calls.persisted[0][0].name.length, 30);
});


test('city transport failure uses the agreed copy and clears on the next query', async t => {
  const h = formHarness(t); h.form.open();
  const first = await h.search('Москва');
  first!.reject(Object.assign(new Error('transport details'), { code: 'connection_failed' }));
  await settle();
  assert.equal(h.element('cityStatus').textContent, 'Нет соединения. Не можем найти город');
  assert.equal(h.element('cityStatus').classList.contains('is-error'), true);
  assert.equal(h.element('cityResults').hidden, true);
  const next = await h.search('Казань');
  assert.equal(h.element('cityStatus').textContent, 'Ищем город…');
  assert.equal(h.element('cityStatus').classList.contains('is-error'), false);
  next!.resolve({ cities: [] }); await settle();
  assert.equal(h.element('cityStatus').textContent, 'Город не найден. Попробуйте другое написание.');
});

test('offline blocks new requests and preserves an open draft until explicit retry', async t => {
 const {createStandConnection}=await import('./helpers/preview/stand-connection.ts');
 const {configureTransportSimulation}=await import('../src/data/http-transport.ts');
 const connection=createStandConnection();configureTransportSimulation(connection);t.after(()=>configureTransportSimulation(null));
 const h=formHarness(t);h.form.open();h.element('chartName').value='Анна';
 connection.set('offline');assert.equal(h.element('chartName').disabled,true);assert.equal(h.element('saveChartButton').disabled,true);
 await h.submit();assert.equal(h.requests.length,0);assert.equal(h.element('chartName').value,'Анна');
 connection.set('online');assert.equal(h.element('chartName').disabled,false);assert.equal(h.requests.length,0);assert.equal(h.element('chartName').value,'Анна');
});
test('offline while city search waits invalidates late options; server mode explains its failure', async t => {
 const {createStandConnection}=await import('./helpers/preview/stand-connection.ts');
 const {configureTransportSimulation}=await import('../src/data/http-transport.ts');
 const connection=createStandConnection();configureTransportSimulation(connection);t.after(()=>configureTransportSimulation(null));
 const h=formHarness(t);h.form.open();const pending=await h.search('Москва');connection.set('offline');
 pending!.resolve({cities:[city(1,'Москва')]});await settle();assert.equal(h.element('cityResults').hidden,true);
 connection.set('server');const retry=await h.search('Москва');retry!.reject({code:'server_unavailable'});await settle();
 assert.equal(h.element('cityStatus').textContent,'Нет соединения. Не можем найти город');
});


test('queue admission keeps the same form waiting and completes after capacity returns without another click', async t => {
 const h=formHarness(t,{charts:[natalChart()]});
 h.form.open(true,'natal-1');h.element('chartName').value='Черновик';
 const submitting=h.submit(),first=h.requests.at(-1)!;
 first.reject(Object.assign(new Error('Server is busy'),{code:'busy',status:503}));
 await settle();
 assert.equal(h.element('formError').textContent,'Готовим карту…');
 assert.equal(h.element('formError').getAttribute('aria-busy'),'true');
 assert.equal(h.element('chartForm').getAttribute('aria-busy'),'true');
 assert.equal(h.element('cancelDialog').disabled,false);
 assert.equal(h.element('chartName').value,'Черновик');
 await h.submit(); assert.equal(h.requests.length,1);
 assert.deepEqual(h.calls.persisted,[]);
 t.mock.timers.tick(500);await settle();
 assert.equal(h.requests.length,2);
 assert.equal(h.requests[1].options.body,first.options.body);
 h.requests[1].resolve({chart:{personality:[25],design:[10],birthDate:'2025-10-26',birthTime:'02:30'}});
 await submitting;
 assert.equal(h.calls.saved.length,1);assert.equal(h.form.opened,false);
});
test('closing the form during admission cancels its continuation and preserves the existing chart', async t => {
 const original=natalChart(),h=formHarness(t,{charts:[original]});
 h.form.open(true,original.id);
 const submitting=h.submit();
 h.requests[0].reject(Object.assign(new Error('Server is busy'),{code:'busy',status:503}));
 await settle();await h.element('cancelDialog').emit('click');await submitting;
 t.mock.timers.tick(60_000);await settle();
 assert.equal(h.requests.length,1);
 assert.deepEqual(h.store.charts,[original]);assert.deepEqual(h.calls.persisted,[]);
 assert.deepEqual(h.calls.saved,[]);
});

test('an actually held calculation shows preparing and cancel keeps the existing chart', async t => {
 const original=natalChart(),h=formHarness(t,{charts:[original]});
 h.form.open(true,original.id);h.element('chartName').value='Сохранённый ввод';
 const submitting=h.submit(),request=h.requests.at(-1)!;
 assert.equal(h.element('formError').textContent,'Готовим карту…');
 assert.equal(h.element('formError').dataset.tone,'neutral');
 assert.equal(h.element('formError').getAttribute('aria-busy'),'true');
 assert.equal(h.element('cancelDialog').disabled,false);
 await h.submit();
 assert.equal(h.requests.length,1);
 await h.element('cancelDialog').emit('click');
 request.reject(abortError());await submitting;
 assert.equal(request.options.signal!.aborted,true);
 assert.deepEqual(h.store.charts,[original]);
 assert.deepEqual(h.calls.persisted,[]);
 assert.deepEqual(h.calls.saved,[]);
 assert.equal(h.element('formError').textContent,'');
});

test('the server submission port owns the result without an earlier calculation or local save', async t => {
  let calls = 0;
  const h = formHarness(t, {charts: [natalChart()], submitChart: async () => { calls++; return {id: 'server-card', persisted: true}; }});
  h.form.open(true, 'natal-1');
  const saving = h.submit(); await settle();
  assert.equal(calls, 1); await saving;
  assert.deepEqual(h.calls.saved, ['server-card']); assert.equal(h.requests.length, 0);
  assert.equal(h.store.charts[0]!.name, 'Исходная карта');
});


test('a newer confirmed record refreshes open birth fields while preserving the private note draft', async t => {
  const original = {...natalChart(), revision: 1, noteRevision: 1, note: 'Initial note'};
  let submitted: Parameters<NonNullable<BirthOptions['submitChart']>>[0] | undefined;
  const h = formHarness(t, {charts: [original], submitChart: input => {
    submitted = input; return Promise.resolve({id: original.id, persisted: true});
  }});
  h.form.open(true, original.id);
  h.element('chartName').value = 'Unfinished name'; h.element('chartNote').value = 'My private draft';
  const updated = {...original, name: 'Confirmed name', birthDate: '2001-02-03', birthTime: '14:15', revision: 2, noteRevision: 2, note: 'Other saved note'};
  h.replaceRecords([updated]); h.form.refresh();
  assert.equal(h.element('chartName').value, updated.name);
  assert.equal(h.element('birthDate').value, '03.02.2001'); assert.equal(h.element('birthTime').value, '14:15');
  assert.equal(h.element('chartNote').value, 'My private draft'); assert.equal(h.form.opened, true);
  h.element('chartName').value = 'Continued typing'; h.form.refresh();
  assert.equal(h.element('chartName').value, 'Continued typing', 'the same revision cannot repeatedly reset a new draft');
  await h.submit();
  assert.equal(submitted?.name, 'Continued typing'); assert.equal(submitted?.note, 'My private draft');
  assert.equal((submitted?.previous as SavedChart & {noteRevision: number}).noteRevision, 2, 'only the saved note now rendered beside the draft authorizes this revision');
  assert.match(h.element('savedChartNote').textContent, /Other saved note/);
});


for (const checking of [false, true]) test(`server submission describes its actual ${checking ? 'lookup' : 'saving'} phase`, async t => {
  const original = natalChart(); let finish!: (value: {id: string; persisted: boolean}) => void;
  const result = new Promise<{id: string; persisted: boolean}>(resolve => {finish = resolve;});
  const h = formHarness(t, {charts: [original], submitChart: () => result, isCheckingSubmission: () => checking});
  h.form.open(true, original.id); const pending = h.submit();
  const label = checking ? 'Проверяем сохранение…' : 'Сохраняем карту…';
  assert.equal(h.element('formError').textContent, label);
  assert.equal(h.element('saveChartButton').textContent, label);
  finish({id: original.id, persisted: true}); await pending;
});


test('shown saved note updates comparison revision but never overwrites the draft or cursor', async t => {
  const original={...natalChart(),revision:1,noteRevision:1,note:'Original'};
  let submitted: Parameters<NonNullable<BirthOptions['submitChart']>>[0] | undefined;
  const h=formHarness(t,{charts:[original],noteComparisonLabel:'Saved note',submitChart:input=>{
    submitted=input;return Promise.resolve({id:original.id,persisted:true});
  }});
  h.form.open(true,original.id);
  const draft=h.element('chartNote');draft.value='Own draft';draft.setSelectionRange(3,5);draft.focus();
  const updated={...original,name:'New name',revision:2,noteRevision:2,note:'Remote <script>plain text</script>\nSecond line'};
  h.replaceRecords([updated]);h.form.refresh();
  const panel=h.element('savedChartNote');
  assert.equal(panel.hidden,false);assert.match(panel.textContent,/Remote <script>plain text<\/script>/);
  assert.equal(draft.value,'Own draft');assert.equal(draft.selectionStart,3);assert.equal(draft.selectionEnd,5);
  assert.equal(h.document.activeElement,draft);assert.equal(h.calls.saved.length,0);
  await h.submit();
  assert.equal((submitted?.previous as SavedChart & {noteRevision: number}).noteRevision,2);
  assert.equal(submitted?.previous?.name,'New name');assert.equal(submitted?.note,'Own draft');
});

test('newer note conflict refreshes the displayed version and keeps the editor open without another write', async t => {
  const original={...natalChart(),revision:1,noteRevision:1,note:'Original'};
  let writes=0;
  const h=formHarness(t,{charts:[original],noteComparisonLabel:'Saved note',submitChart:async()=>{
    writes++;h.replaceRecords([{...original,revision:3,noteRevision:3,note:'Latest saved'} as typeof original]);
    throw Object.assign(new Error('Do not display an extra conflict warning'),{code:'note_conflict'});
  }});
  h.form.open(true,original.id);h.element('chartNote').value='Keep this draft';
  await h.submit();
  assert.equal(h.form.opened,true);assert.equal(writes,1);assert.equal(h.element('chartNote').value,'Keep this draft');
  assert.match(h.element('savedChartNote').textContent,/Latest saved/);assert.equal(h.element('formError').textContent,'');
  h.replaceRecords([{...original,revision:2,noteRevision:2,note:'Older'} as typeof original]);h.form.refresh();
  assert.match(h.element('savedChartNote').textContent,/Latest saved/);
  h.form.close();h.form.open(false);
  assert.equal(h.element('savedChartNote').hidden,true);assert.equal(h.element('savedChartNote').textContent,'');
});


test('matching the shown note hides comparison and retyping does not lose its saved revision',async t=>{
  const original={...natalChart(),revision:1,noteRevision:1,note:'Original'};
  let submitted: Parameters<NonNullable<BirthOptions['submitChart']>>[0] | undefined;
  const h=formHarness(t,{charts:[original],noteComparisonLabel:'Saved note',submitChart:input=>{
    submitted=input;return Promise.resolve({id:original.id,persisted:true});
  }});
  h.form.open(true,original.id);h.element('chartNote').value='Own draft';
  const next={...original,revision:2,noteRevision:2,note:'Latest'};h.replaceRecords([next]);h.form.refresh();
  h.element('chartNote').value='Latest';await h.element('chartNote').emit('input');
  assert.equal(h.element('savedChartNote').hidden,true);
  h.element('chartNote').value='Continued';await h.element('chartNote').emit('input');
  assert.equal(h.element('savedChartNote').hidden,false);assert.match(h.element('savedChartNote').textContent,/Latest/);
  await h.submit();assert.equal((submitted?.previous as SavedChart & {noteRevision:number}).noteRevision,2);
});


test('closing the editor clears private input and saved-note comparison without changing the stored card',async t=>{
  const original={...natalChart(),revision:1,noteRevision:1,note:'Stored private text'};
  const h=formHarness(t,{charts:[original],noteComparisonLabel:'Saved note'});
  h.form.open(true,original.id);h.element('chartNote').value='Private draft';
  h.form.close();
  assert.equal(h.element('chartName').value,'');assert.equal(h.element('birthDate').value,'');
  assert.equal(h.element('chartNote').value,'');assert.equal(h.element('savedChartNote').textContent,'');
  assert.equal(h.store.charts[0].note,'Stored private text');assert.equal(h.calls.saved.length,0);
});

test('a native dialog close rejects a late save before its close event is delivered',async t=>{
  let finish!:(value:{id:string;persisted:boolean})=>void;
  const h=formHarness(t,{charts:[natalChart()],submitChart:()=>new Promise(resolve=>{finish=resolve;})});
  h.form.open(true);const submit=h.submit();h.element('chartDialog').close();
  finish({id:'server-card',persisted:true});await submit;
  assert.deepEqual(h.calls.saved,[]);
  await h.element('chartDialog').emit('close');assert.equal(h.element('chartNote').value,'');
});


test('an older comparison is not presented as the fresh conflicting note when its read failed',async t=>{
  const original={...natalChart(),revision:1,noteRevision:1,note:'Original'};
  const h=formHarness(t,{charts:[original],noteComparisonLabel:'Saved note',submitChart:async()=>{
    throw Object.assign(new Error('read failed'),{code:'note_conflict'});
  }});
  h.form.open(true,original.id);h.element('chartNote').value='Keep draft';
  h.replaceRecords([{...original,revision:2,noteRevision:2,note:'Previously shown'} as typeof original]);h.form.refresh();
  await h.submit();
  assert.equal(h.element('formError').textContent,'Не удалось сохранить карту');
  assert.equal(h.element('chartNote').value,'Keep draft');assert.equal(h.form.opened,true);
});

test('an untouched note follows the confirmed note before saving another field',async t=>{
  const original={...natalChart(),revision:1,noteRevision:1,note:'Original'};
  let submitted: BirthSubmission | undefined;
  const h=formHarness(t,{charts:[original],submitChart:input=>{
    submitted=input;return Promise.resolve({id:original.id,persisted:true,metadataOnly:true});
  }});
  h.form.open(true,original.id);
  const updated={...original,revision:2,noteRevision:2,note:'New from another tab'};
  h.replaceRecords([updated]);
  h.form.refresh();
  assert.equal(h.element('chartNote').value,'New from another tab');
  assert.equal(h.element('savedChartNote').hidden,true);
  h.element('chartName').value='Only name changed';await h.submit();
  assert.equal(submitted?.note,'New from another tab');
  assert.equal(submitted?.previous?.note,'New from another tab');
});
test('confirmed disappearance of the edited card closes and clears the private draft',async t=>{
  const original={...natalChart(),revision:1,noteRevision:1,note:'Private'};
  const h=formHarness(t,{charts:[original]});h.form.open(true,original.id);
  h.element('chartNote').value='Unsent';h.replaceRecords([]);h.form.refresh();
  assert.equal(h.element('chartDialog').open,false);assert.equal(h.element('chartNote').value,'');
});


test('ordinary reload restores unfinished birth fields and the active text selection without a request',async t=>{
  const h=formHarness(t);h.form.open();
  h.element('chartName').value='  Черновик  ';h.element('birthDate').value='12.0';h.element('birthTime').value='1:';
  h.element('birthPlace').value='Мос';h.element('chartNote').value='Моя заметка\n';
  h.element('chartNote').focus();h.element('chartNote').setSelectionRange(2,7,'backward');
  const records=new Map<string,string>(),storage={getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>{records.set(key,value);}};
  const view=createViewStore({getStorage:()=>storage});assert.equal(view.write({version:1,birthForm:h.form.snapshot}),true);
  const next=formHarness(t,{reuseTimers:true});
  assert.equal(next.form.restore(createViewStore({getStorage:()=>storage}).read()!.birthForm),true);
  for(const id of ['chartName','birthDate','birthTime','birthPlace','chartNote'])assert.equal(next.element(id).value,h.element(id).value);
  assert.equal(next.form.opened,true);assert.equal(next.document.activeElement,next.element('chartNote'));
  assert.deepEqual([next.element('chartNote').selectionStart,next.element('chartNote').selectionEnd,next.element('chartNote').selectionDirection],[2,7,'backward']);
  assert.equal(next.requests.length,0);assert.deepEqual(next.calls.saved,[]);
});

test('closing the form forgets its draft and reopening starts with confirmed values',async t=>{
  let changes=0;const record=natalChart(),h=formHarness(t,{charts:[record],onDraftChange:()=>{changes++;}});
  h.form.open(true);h.element('chartNote').value='Private draft';h.element('chartNote').focus();await h.element('chartNote').emit('input');
  assert.equal(h.form.snapshot?.fields.chartNote,'Private draft');const before=changes;
  h.form.clearDraft();assert.equal(h.form.snapshot,null);assert.equal(h.form.opened,false);assert.ok(changes>before);
  h.form.open(true);assert.equal(h.element('chartNote').value,record.note);
});

test('birth drafts cannot restore private editing into another account but independent temporary input can',t=>{
  let owner:string|null='1';const record={...natalChart(),accountId:'1',revision:1,noteRevision:1};
  const h=formHarness(t,{charts:[record],getAccountId:()=>owner});h.form.open(true);h.element('chartNote').value='Private';
  const personal=h.form.snapshot!;h.form.clearDraft();owner='2';
  assert.equal(h.form.restore(personal),false);assert.equal(h.form.opened,false);assert.equal(h.form.snapshot,null);
  owner=null;h.form.open();h.element('chartName').value='Temporary';const temporary=h.form.snapshot!;
  h.form.clearDraft();owner='2';assert.equal(h.form.restore(temporary),true);assert.equal(h.element('chartName').value,'Temporary');
});

test('restoring an edited chart follows a newer confirmed birth record and preserves only its own changed note',t=>{
  const record={...natalChart(),revision:1,noteRevision:1},h=formHarness(t,{charts:[record]});
  h.form.open(true);h.element('chartName').value='Old unfinished name';h.element('chartNote').value='Own unfinished note';const draft=h.form.snapshot;
  const fresh={...record,revision:2,noteRevision:2,name:'Confirmed new name',note:'Confirmed new note',birthTime:'03:45'};
  const next=formHarness(t,{charts:[fresh],reuseTimers:true});assert.equal(next.form.restore(draft),true);
  assert.equal(next.element('chartName').value,fresh.name);assert.equal(next.element('birthTime').value,'03:45');
  assert.equal(next.element('chartNote').value,'Own unfinished note');assert.equal(next.element('savedChartNote').hidden,false);
  assert.equal(next.element('savedChartNote').textContent,fresh.note);assert.equal(next.requests.length,0);
});


test('pending exposes an active server write and becomes false when that form is explicitly cancelled',async t=>{
  let finish!:(value:{id:string;persisted:boolean})=>void;
  const record=transitChart(),h=formHarness(t,{charts:[record],submitChart:()=>new Promise(resolve=>{finish=resolve;})});
  h.form.open(true);assert.equal(h.form.pending,false);
  const work=h.submit();assert.equal(h.form.pending,true);
  h.form.clearDraft();assert.equal(h.form.pending,false);assert.equal(h.form.snapshot,null);
  finish({id:record.id,persisted:true});await work;assert.deepEqual(h.calls.saved,[]);
});

test('focus and selection changes publish the actual current caret to the tab snapshot owner',async t=>{
  let changed=0;const h=formHarness(t,{onDraftChange:()=>{changed++;}});h.form.open();
  const note=h.element('chartNote');note.value='abcdefgh';note.focus();const before=changed;await note.emit('focus');
  assert.ok(changed>before);assert.equal(h.form.snapshot?.focus?.field,'chartNote');
  note.setSelectionRange(2,5,'backward');const focused=changed;h.selectionChanged();assert.ok(changed>focused);
  assert.deepEqual(h.form.snapshot?.focus,{field:'chartNote',start:2,end:5,direction:'backward'});
});

test('a reloaded DST choice keeps its selected catalog city and requires a fresh explicit submission',async t=>{
  const record=natalChart(),h=formHarness(t,{charts:[record]});h.form.open(true);
  const first=h.submit();h.requests.at(-1)!.reject(Object.assign(new Error('Choose time'),{code:'ambiguous_time',
    choices:[{fold:0,label:'Летнее <UTC+02>'},{fold:1,label:'Зимнее UTC+01'}]}));await first;
  h.element('foldChoice').value='1';const draft=h.form.snapshot;
  const next=formHarness(t,{charts:[record],reuseTimers:true});assert.equal(next.form.restore(draft),true);
  assert.equal(next.element('foldField').hidden,false);assert.equal(next.element('foldChoice').value,'1');
  assert.match(next.element('foldChoice').innerHTML,/&lt;UTC\+02&gt;/);assert.equal(next.requests.length,0);
  assert.equal(next.form.pending,false);const submit=next.submit(),request=next.requests.at(-1)!;
  assert.equal(JSON.parse(request.options.body as string).fold,1);assert.equal(JSON.parse(request.options.body as string).cityId,'1');
  next.form.clearDraft();request.reject(abortError());await submit;
});

test('late restoration cannot replace a form that the person has already opened',t=>{
  const h=formHarness(t);h.form.open();h.element('chartName').value='First';const previous=h.form.snapshot;
  h.form.clearDraft();h.form.open();h.element('chartName').value='Current input';
  assert.equal(h.form.restore(previous),false);assert.equal(h.element('chartName').value,'Current input');
});


test('new temporary form keeps the ready chart on failure and cancellation and replaces it only on success',async t=>{
  const original=libraryRecordAtMinute(natalDayFixture(),754,personalChartFixture({id:'ready-temporary'}));
  const store=createChartStore({initialTemporaryChart:original});
  const h=formHarness(t,{chartStore:store,getChart:id=>id?store.get(id):undefined,
    saveChart:chart=>{store.setTemporary(chart);return true;}});
  async function fill(){
    h.form.open();h.element('chartName').value='Новая карта';
    h.element('birthDate').value='24.09.2026';h.element('birthTime').value='12:34';
    const search=await h.search('Берлин');search!.resolve({cities:[city('2950159','Берлин')]});await settle();await h.chooseCity();
  }
  await fill();
  const failed=h.submit();h.requests.at(-1)!.reject(new Error('Нет соединения'));await failed;
  assert.equal(store.temporaryChart?.id,original.id);assert.equal(h.form.opened,true);
  const cancelled=h.submit(),late=h.requests.at(-1)!;
  h.form.close();late.resolve({chart:original});await cancelled;
  assert.equal(store.temporaryChart?.id,original.id);assert.equal(h.form.snapshot,null);
  await fill();const successful=h.submit();
  assert.equal(store.temporaryChart?.id,original.id);
  h.requests.at(-1)!.resolve({chart:original});await successful;
  assert.notEqual(store.temporaryChart?.id,original.id);
  assert.equal(store.temporaryChart?.name,'Новая карта');
  assert.equal(h.form.opened,false);
});

test('command close and delayed native close discard one draft exactly once', async t => {
  let changes = 0;
  const h = formHarness(t, { onDraftChange: () => { changes++; } });
  h.form.open();
  let resets = 0;
  const form = h.element('chartForm'), reset = form.reset;
  form.reset = () => { resets++; reset(); };
  const before = changes;
  h.form.close();
  assert.equal(resets, 1);
  assert.equal(changes, before + 1);
  await h.element('chartDialog').emit('close');
  h.form.close();
  assert.equal(resets, 1);
  assert.equal(changes, before + 1);
  h.form.open();
  h.element('chartDialog').open = false;
  await h.element('chartDialog').emit('close');
  assert.equal(resets, 3, 'new open reset plus native-close discard');
});
