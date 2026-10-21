import test from 'node:test';
import assert from 'node:assert/strict';
import { attachBirthForm } from '../src/views/birth-form.ts';
import { createChartStore } from '../src/data/chart-store.ts';
import { STORAGE_KEY, CHART_RECORD_PREFIX, readCharts } from '../src/data/storage.ts';
import { libraryRecordAtMinute } from './fixtures/natal-day.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';
import type { SavedChart, Activation } from '../shared/chart-types.ts';
import type { ChartStore } from '../src/data/chart-store.ts';
type TestRecord = Omit<Partial<SavedChart>, 'activations'> & { id: string; name: string; calculation?: unknown; activations?: { personality: readonly Partial<Activation>[]; design: readonly Partial<Activation>[] } };
type BirthOptions = Parameters<typeof attachBirthForm>[0];
interface FormNode {
  id: string; value: string; textContent: string; hidden: boolean; open: boolean; disabled: boolean;
  dataset: DOMStringMap; selectionStart: number; selectionEnd: number; innerHTML: string;
  elements?: Record<string, FormNode>;
  classList: { add(value: unknown): void; remove(value: unknown): void; contains(value: unknown): boolean; toggle(value: unknown, force?: boolean): boolean };
  setAttribute(name: string, value: unknown): void; getAttribute(name: string): string | null; removeAttribute(name: string): void;
  focus(): void; setSelectionRange(start: number, end: number): void; scrollIntoView(): void;
  showModal(): void; close(): void; reset(): void;
  addEventListener(type: string, handler: (event: FormEvent) => unknown): void;
  emit(type: string, options?: Record<string, unknown>): Promise<void>;
  dispatchEvent(event: { type: string }): Promise<void>;
  querySelector(selector: unknown): FormNode; querySelectorAll(selector: unknown): FormNode[];
}
interface FormEvent { target: FormNode; defaultPrevented: boolean; preventDefault(): void; stopPropagation(): void }
interface RequestRecord { url: string; options: RequestInit; resolve(value: unknown): void; reject(error: unknown): void }


const city = (id: string|number, name: string) => ({ id, name, country: 'DE', region: '', timezone: 'Europe/Berlin' });
const manualChart = () => ({ id: 'manual-1', name: 'Исходная карта', source: 'manual' as const, birthDate: '2000-01-02', birthTime: '03:04', birthPlace: 'Берлин', personality: [20], design: [57], note: 'Заметка', createdAt: '2020-01-01T00:00:00.000Z' });
const natalChart = () => ({ ...manualChart(), id: 'natal-1', source: 'calculated' as const, birthDate: '2025-10-26', birthTime: '02:30', city: city(1, 'Берлин') });
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

function persistentStore(charts: readonly TestRecord[]) {
  const values = new Map([[STORAGE_KEY, JSON.stringify(charts)]]);
  const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index],
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  return { values, storage, chartStore: createChartStore({ getStorage: () => storage }) };
}

function formHarness(t: test.TestContext, { charts = [], selectedId = charts[0]?.id || 'current-transit', persist = true, chartStore = null }: { charts?: readonly TestRecord[]; selectedId?: string; persist?: boolean; chartStore?: ChartStore | null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const elements = new Map<string, FormNode>(), requests: RequestRecord[] = [];
  const calls = { beforeOpen: 0, saved: [] as string[], saveOptions: [] as Parameters<BirthOptions['onSave']>[1][], persisted: [] as (readonly TestRecord[])[], replaced: [] as (readonly TestRecord[])[], toasts: [] as string[] };
  const fields = { name: 'chartName', birthDate: 'birthDate', birthTime: 'birthTime', birthPlace: 'birthPlace', note: 'chartNote', personality: 'personalityGates', design: 'designGates' };
  const document = {
    activeElement: null as FormNode | null,
    getElementById(id: string) { return element(id); },
    querySelectorAll(selector: unknown) { assert.equal(selector, '[data-calculation-mode]'); return modes; },
  };
  function element(id: string): FormNode {
    if (elements.has(id)) return elements.get(id)!;
    const attributes = new Map<string, string>(), classes = new Set<unknown>(), handlers = new Map<string, ((event: FormEvent) => unknown)[]>();
    let markup = '';
    const node: FormNode = {
      id, value: '', textContent: '', hidden: true, open: false, disabled: false, dataset: {} as DOMStringMap, selectionStart: 0, selectionEnd: 0,
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
      setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
      scrollIntoView() {},
      showModal() { this.open = true; }, close() { this.open = false; },
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
  const modes = ['calculated', 'manual'].map(mode => { const node = element(`mode-${mode}`); node.dataset.calculationMode = mode; return node; });
  let records = charts;
  const store = chartStore || {
    get charts() { return records; }, get selectedId() { return selectedId; },
    get current() { return records.find(chart => chart.id === selectedId) || { id: 'current-transit', source: 'transit' as const, personality: [], design: [] }; },
    persist(next: readonly TestRecord[]) { calls.persisted.push(next); if (persist) records = next; return persist; },
    replace(next: readonly TestRecord[]) { calls.replaced.push(next); records = next; },
  };
  const form = attachBirthForm({
    document: document as unknown as Document, store: store as ChartStore, session: { get selectedId() { return selectedId; }, get original() { return store.charts.find(chart => chart.id === selectedId); } } as unknown as BirthOptions['session'],
    onSave: (id, options) => { calls.saved.push(id); calls.saveOptions.push(options); }, beforeOpen: () => calls.beforeOpen++, toast: text => calls.toasts.push(text),
    getFormData: () => new Map(Object.entries(fields).map(([name, id]) => [name, element(id).value])) as unknown as FormData,
    requestJSON<T = unknown>(url: string, options: RequestInit = {}) {
      let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes as (value: unknown) => void; reject = no; });
      requests.push({ url, options, resolve, reject });
      return promise;
    },
  });
  t.after(() => form.close());
  return {
    form, document, element, store, calls, requests,
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

test('changing mode or opening another form invalidates an in-flight city response and clears its selection', async t => {
  const h = formHarness(t); h.form.open();
  const first = await h.search('Берлин');
  await h.mode('manual');
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

test('new manual cards get distinct UUIDs while a later edit preserves their identity and creation time', async t => {
  const h = formHarness(t);
  const ids: string[] = [];
  for (const name of ['первая карта', 'вторая карта'] as const) {
    h.form.open(); await h.mode('manual');
    h.element('chartName').value = name;
    h.element('personalityGates').value = '20';
    h.element('designGates').value = '57';
    await h.submit();
    assert.equal(h.store.charts.at(-1)!.name, name[0].toUpperCase() + name.slice(1));
    const id = h.calls.saved.at(-1)!;
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    ids.push(id);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(h.store.charts.length, 2);
  const original = h.store.charts.find(chart => chart.id === ids[0])!;
  assert.ok(Number.isFinite(Date.parse(original.createdAt!)));
  h.form.open(true, original.id);
  h.element('chartName').value = 'переименованная карта';
  await h.submit();
  const updated = h.store.charts.find(chart => chart.id === ids[0])!;
  assert.equal(updated.name, 'Переименованная карта');
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(h.store.charts.length, 2);
  assert.equal(h.calls.saved.at(-1), original.id);
  assert.equal(h.requests.length, 0);
});

test('legacy manual editing retains its gates and identity after removing gate inputs', async t => {
  const original = Object.freeze(manualChart());
  const h = formHarness(t, { charts: Object.freeze([original]) });
  h.form.open(true, original.id);
  assert.equal(h.element('birthDate').value, '02.01.2000');
  h.element('chartName').value = '  новое имя  ';
  h.element('birthDate').value = '29022000'; h.element('birthTime').value = '07:05';
  h.element('birthPlace').value = '  Казань  '; h.element('chartNote').value = '  Новая заметка  ';
  h.element('personalityGates').value = '34, 20; 34'; h.element('designGates').value = '57 10';
  await h.submit();
  assert.equal(h.requests.length, 0);
  const saved = h.store.charts[0];
  assert.equal(saved.id, original.id); assert.equal(saved.createdAt, original.createdAt);
  assert.equal(saved.name, 'Новое имя'); assert.equal(saved.source, 'manual');
  assert.equal(saved.birthDate, '2000-02-29'); assert.equal(saved.birthTime, '07:05');
  assert.equal(saved.birthPlace, 'Казань'); assert.equal(saved.note, 'Новая заметка');
  assert.deepEqual(saved.personality, original.personality); assert.deepEqual(saved.design, original.design);
  assert.equal(original.name, 'Исходная карта');
  assert.deepEqual(h.calls.saved, [original.id]);
  assert.equal(h.form.opened, false);
  assert.deepEqual(h.calls.toasts, []);
});

test('editing a saved manual card advances its timestamp while preserving its saved data', async t => {
  const original = { ...manualChart(), updatedAt: '2020-01-01T00:00:00.000Z', calculation: { legacyVersion: 1, extra: 'kept' } };
  const { chartStore, storage } = persistentStore([original]);
  const h = formHarness(t, { chartStore, selectedId: original.id });
  h.form.open(true, original.id);
  h.element('chartName').value = 'Новое имя';
  await h.submit();
  const saved = readCharts(storage)[0];
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
  const original = Object.freeze(manualChart());
  const h = formHarness(t, { charts: [original], persist: false });
  h.form.open(true, original.id); h.element('chartName').value = 'Несохранённая карта';
  await h.submit();
  assert.equal(h.calls.persisted.length, 1); assert.equal(h.calls.replaced.length, 1);
  assert.equal(h.calls.replaced[0], h.calls.persisted[0]);
  assert.equal(h.store.charts[0].name, 'Несохранённая карта');
  assert.equal(original.name, 'Исходная карта');
  assert.deepEqual(h.calls.saved, [original.id]);
  assert.equal(h.form.opened, false);
  assert.deepEqual(h.calls.toasts, ['Карта открыта, но не сохранена в браузере.']);
});

for (const failure of ['deleted', 'corrupt'] as const) test(`a ${failure} chart cannot become an in-memory save from a stale editor`, async t => {
  const original = manualChart(), { chartStore, storage, values } = persistentStore([original]);
  const h = formHarness(t, { chartStore, selectedId: original.id });
  h.form.open(true, original.id); h.element('chartName').value = 'Несохранённая правка';
  if (failure === 'deleted') createChartStore({ getStorage: () => storage }).remove(original.id);
  else values.set(`${CHART_RECORD_PREFIX}${original.id}`, '{damaged record');
  await h.submit();
  assert.equal(h.form.opened, true, 'the action error stays inside the open form');
  assert.match(h.element('formError').textContent, failure === 'deleted' ? /удалена/ : /повреждена/);
  assert.notEqual(chartStore.get(original.id)?.name, 'Несохранённая правка');
  assert.deepEqual(h.calls.saved, []); assert.deepEqual(h.calls.toasts, []);
  assert.deepEqual(readCharts(storage), [], 'the rejected edit cannot restore the record');
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
  const { chartStore, storage } = persistentStore([exact]);
  const original = chartStore.get(exact.id)!;
  assert.equal(original!.birthTime, '12:34:45'); assert.deepEqual(Reflect.get(original!, 'calculation'), exact.calculation);
  const h = formHarness(t, { chartStore, selectedId: exact.id });
  h.form.open(true, exact.id); h.element('chartName').value = 'Новое имя'; h.element('chartNote').value = 'Новая заметка';
  await h.submit();
  assert.equal(h.requests.length, 0);
  const saved = readCharts(storage)[0];
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
  const original = { ...manualChart(), name: 'Я'.repeat(31) };
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
