import test from 'node:test';
import assert from 'node:assert/strict';
import { attachBirthForm } from '../src/charts/birth-form.js';

const city = (id, name) => ({ id, name, country: 'DE', region: '', timezone: 'Europe/Berlin' });
const manualChart = () => ({ id: 'manual-1', name: 'Исходная карта', source: 'manual', birthDate: '2000-01-02', birthTime: '03:04', birthPlace: 'Берлин', personality: [20], design: [57], note: 'Заметка', createdAt: '2020-01-01T00:00:00.000Z' });
const natalChart = () => ({ ...manualChart(), id: 'natal-1', source: 'calculated', birthDate: '2025-10-26', birthTime: '02:30', city: city(1, 'Берлин') });
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

function formHarness(t, { charts = [], selectedId = charts[0]?.id || 'current-transit', persist = true } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const elements = new Map(), requests = [];
  const calls = { beforeOpen: 0, saved: [], persisted: [], replaced: [], toasts: [] };
  const fields = { name: 'chartName', birthDate: 'birthDate', birthTime: 'birthTime', birthPlace: 'birthPlace', note: 'chartNote', personality: 'personalityGates', design: 'designGates' };
  const document = {
    activeElement: null,
    getElementById(id) { return element(id); },
    querySelectorAll(selector) { assert.equal(selector, '[data-calculation-mode]'); return modes; },
  };
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const attributes = new Map(), classes = new Set(), handlers = new Map();
    let markup = '';
    const node = {
      id, value: '', textContent: '', hidden: true, open: false, disabled: false, dataset: {}, selectionStart: 0, selectionEnd: 0,
      get innerHTML() { return markup; },
      set innerHTML(value) { markup = String(value); if (id === 'foldChoice') this.value = ''; },
      classList: {
        add(value) { classes.add(value); }, remove(value) { classes.delete(value); }, contains(value) { return classes.has(value); },
        toggle(value, force) { const enabled = force ?? !classes.has(value); if (enabled) classes.add(value); else classes.delete(value); return enabled; },
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      focus() { document.activeElement = this; },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      scrollIntoView() {},
      showModal() { this.open = true; }, close() { this.open = false; },
      addEventListener(type, handler) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
      async emit(type, options = {}) {
        const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
        const pending = (handlers.get(type) || []).map(handler => handler(event));
        if (id === 'chartDialog' && type === 'cancel' && !event.defaultPrevented) this.close();
        await Promise.all(pending);
      },
      dispatchEvent(event) { return this.emit(event.type); },
      querySelector(selector) { assert.equal(selector, '.form-extras'); return element('formExtras'); },
      querySelectorAll(selector) {
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
  const store = {
    get charts() { return records; }, get selectedId() { return selectedId; },
    get current() { return records.find(chart => chart.id === selectedId) || { id: 'current-transit', source: 'transit', personality: [], design: [] }; },
    persist(next) { calls.persisted.push(next); if (persist) records = next; return persist; },
    replace(next) { calls.replaced.push(next); records = next; },
  };
  const form = attachBirthForm({
    document, store, onSave: id => calls.saved.push(id), beforeOpen: () => calls.beforeOpen++, toast: text => calls.toasts.push(text),
    getFormData: () => new Map(Object.entries(fields).map(([name, id]) => [name, element(id).value])),
    requestJSON(url, options = {}) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ url, options, resolve, reject });
      return promise;
    },
  });
  t.after(() => form.close());
  return {
    form, document, element, store, calls, requests,
    submit: () => element('chartForm').emit('submit'),
    mode: mode => element(`mode-${mode}`).emit('click'),
    async search(query) {
      element('birthPlace').value = query;
      await element('birthPlace').emit('input');
      t.mock.timers.tick(220);
      await settle();
      return requests.at(-1);
    },
    chooseCity(index = 0) {
      return element('cityResults').emit('click', { target: { closest(selector) { assert.equal(selector, '[data-city-index]'); return { dataset: { cityIndex: String(index) } }; } } });
    },
  };
}

test('city search debounces input and discards an older response even when it ignores cancellation', async t => {
  const h = formHarness(t); h.form.open();
  h.element('birthPlace').value = 'Б';
  await h.element('birthPlace').emit('input');
  t.mock.timers.tick(220);
  assert.equal(h.requests.length, 0, 'one letter never sends a city request');
  const first = await h.search('Бер');
  const second = await h.search('Гам');
  assert.equal(first.options.signal.aborted, true);
  assert.equal(second.url, '/api/cities?q=%D0%93%D0%B0%D0%BC');
  second.resolve({ cities: [city(2, 'Гамбург')] }); await settle();
  const latestMarkup = h.element('cityResults').innerHTML;
  assert.match(latestMarkup, /Гамбург/);
  first.resolve({ cities: [city(1, 'Берлин')] }); await settle();
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
  assert.equal(first.options.signal.aborted, true);
  first.resolve({ cities: [city(1, 'Берлин')] }); await settle();
  assert.equal(h.element('cityResults').hidden, true);
  assert.doesNotMatch(h.element('cityResults').innerHTML, /Берлин/);
  assert.equal(h.element('birthPlace').getAttribute('role'), null);
  h.form.open();
  const second = await h.search('Гамбург');
  h.form.open();
  assert.equal(second.options.signal.aborted, true);
  second.resolve({ cities: [city(2, 'Гамбург')] }); await settle();
  assert.equal(h.element('cityResults').hidden, true);
  assert.equal(h.element('birthPlace').value, '');
  h.element('chartName').value = 'Новая карта';
  h.element('birthDate').value = '01.01.2000'; h.element('birthTime').value = '12:00';
  await h.submit();
  assert.match(h.element('formError').textContent, /Выберите город/);
  assert.equal(h.requests.length, 2, 'a stale city does not authorize a birth calculation');
});

test('cancel aborts pending city search and every calculation exit without saving or surfacing AbortError', async t => {
  const h = formHarness(t, { charts: [natalChart()] });
  h.form.open(); const search = await h.search('Берлин');
  await h.element('cancelDialog').emit('click');
  assert.equal(search.options.signal.aborted, true);
  search.reject(abortError()); await settle();
  assert.equal(h.form.opened, false);
  assert.equal(h.element('cityStatus').classList.contains('is-error'), false);
  for (const exit of ['cancel-button', 'native-cancel', 'new-form']) {
    h.form.open(true, 'natal-1');
    const submitting = h.submit(), request = h.requests.at(-1);
    assert.equal(h.element('chartForm').getAttribute('aria-busy'), 'true');
    assert.equal(h.element('cancelDialog').disabled, false, 'a busy calculation still allows cancellation');
    if (exit === 'cancel-button') await h.element('cancelDialog').emit('click');
    else if (exit === 'native-cancel') await h.element('chartDialog').emit('cancel');
    else h.form.open();
    assert.equal(request.options.signal.aborted, true, exit);
    request.reject(abortError()); await submitting;
    assert.equal(h.element('formError').textContent, '', exit);
    assert.equal(h.form.opened, exit === 'new-form');
  }
  assert.deepEqual(h.calls.persisted, []);
  assert.deepEqual(h.calls.saved, []);
  assert.deepEqual(h.calls.toasts, []);
});

test('a late calculation success cannot save after cancellation or mutate a newly opened form', async t => {
  const h = formHarness(t, { charts: [natalChart()] });
  for (const exit of ['cancel-button', 'native-cancel', 'new-form']) {
    h.form.open(true, 'natal-1');
    const submitting = h.submit(), request = h.requests.at(-1);
    if (exit === 'cancel-button') await h.element('cancelDialog').emit('click');
    else if (exit === 'native-cancel') await h.element('chartDialog').emit('cancel');
    else h.form.open();
    assert.equal(request.options.signal.aborted, true, exit);
    // Deliberately model a transport whose completed response wins the abort race.
    request.resolve({ chart: { personality: [25], design: [10] } });
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
  for (const exit of ['cancel-button', 'native-cancel', 'new-form']) {
    h.form.open(true, 'natal-1');
    const submitting = h.submit(), request = h.requests.at(-1);
    if (exit === 'cancel-button') await h.element('cancelDialog').emit('click');
    else if (exit === 'native-cancel') await h.element('chartDialog').emit('cancel');
    else h.form.open();
    request.reject(Object.assign(new Error('Устаревшая ошибка'), {
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
  for (const exit of ['cancel-button', 'native-cancel']) {
    for (const outcome of ['success', 'error']) {
      h.form.open();
      const request = await h.search('Берлин');
      if (exit === 'cancel-button') await h.element('cancelDialog').emit('click');
      else await h.element('chartDialog').emit('cancel');
      assert.equal(request.options.signal.aborted, true);
      if (outcome === 'success') request.resolve({ cities: [city(1, 'Берлин')] });
      else request.reject(new Error('Устаревшая ошибка поиска'));
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
  const ids = [];
  for (const name of ['Первая карта', 'Вторая карта']) {
    h.form.open(); await h.mode('manual');
    h.element('chartName').value = name;
    h.element('personalityGates').value = '20';
    h.element('designGates').value = '57';
    await h.submit();
    const id = h.calls.saved.at(-1);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    ids.push(id);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(h.store.charts.length, 2);
  const original = h.store.charts.find(chart => chart.id === ids[0]);
  assert.ok(Number.isFinite(Date.parse(original.createdAt)));
  h.form.open(true, original.id);
  h.element('chartName').value = 'Переименованная карта';
  await h.submit();
  const updated = h.store.charts.find(chart => chart.id === ids[0]);
  assert.equal(updated.name, 'Переименованная карта');
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(h.store.charts.length, 2);
  assert.equal(h.calls.saved.at(-1), original.id);
  assert.equal(h.requests.length, 0);
});

test('manual editing retains identity and creation time while normalizing fields and gates without a request', async t => {
  const original = Object.freeze(manualChart());
  const h = formHarness(t, { charts: Object.freeze([original]) });
  h.form.open(true, original.id);
  assert.equal(h.element('birthDate').value, '02.01.2000');
  assert.equal(h.element('manualFields').hidden, false);
  h.element('chartName').value = '  Новое имя  ';
  h.element('birthDate').value = '29022000'; h.element('birthTime').value = '7:05';
  h.element('birthPlace').value = '  Казань  '; h.element('chartNote').value = '  Новая заметка  ';
  h.element('personalityGates').value = '34, 20; 34'; h.element('designGates').value = '57 10';
  await h.submit();
  assert.equal(h.requests.length, 0);
  const saved = h.store.charts[0];
  assert.equal(saved.id, original.id); assert.equal(saved.createdAt, original.createdAt);
  assert.equal(saved.name, 'Новое имя'); assert.equal(saved.source, 'manual');
  assert.equal(saved.birthDate, '2000-02-29'); assert.equal(saved.birthTime, '07:05');
  assert.equal(saved.birthPlace, 'Казань'); assert.equal(saved.note, 'Новая заметка');
  assert.deepEqual(saved.personality, [20, 34]); assert.deepEqual(saved.design, [10, 57]);
  assert.equal(original.name, 'Исходная карта');
  assert.deepEqual(h.calls.saved, [original.id]);
  assert.equal(h.form.opened, false);
  assert.match(h.calls.toasts[0], /сохранена на этом устройстве/);
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

test('ambiguous local time exposes only valid DST choices and retries with the explicit fold', async t => {
  const original = natalChart(), h = formHarness(t, { charts: [original] });
  h.form.open(true, original.id);
  const firstSubmit = h.submit(), first = h.requests.at(-1);
  assert.deepEqual(JSON.parse(first.options.body), { name: original.name, date: '2025-10-26', time: '02:30', cityId: '1', cityName: 'Берлин', mode: 'natal' });
  first.reject(Object.assign(new Error('Выберите местное время'), { code: 'ambiguous_time', choices: [
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
  assert.match(h.element('formError').textContent, /Выберите один/);
  h.element('foldChoice').value = '1';
  const retrying = h.submit(), retry = h.requests.at(-1);
  assert.equal(JSON.parse(retry.options.body).fold, 1);
  retry.resolve({ chart: { personality: [25], design: [10], birthDate: '2025-10-26', birthTime: '02:30', timezone: 'Europe/Berlin' } });
  await retrying;
  assert.equal(h.store.charts[0].id, original.id); assert.equal(h.store.charts[0].createdAt, original.createdAt);
  assert.deepEqual(h.store.charts[0].city, original.city); assert.equal(h.store.charts[0].source, 'calculated');
  assert.deepEqual(h.calls.saved, [original.id]);
  assert.equal(h.form.opened, false);
  assert.deepEqual(h.calls.toasts, ['Карта рассчитана и сохранена']);
});
