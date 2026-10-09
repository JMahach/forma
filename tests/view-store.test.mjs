import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartStore } from '../src/data/chart-store.js';
import { createViewStore, VIEW_STORAGE_KEY } from '../src/data/view-store.js';

function memory(value = null) {
  const records = new Map(value ? [[VIEW_STORAGE_KEY, JSON.stringify(value)]] : []), writes = [];
  return { records, writes, getItem: key => records.get(key) ?? null,
    setItem(key, value) { writes.push([key, value]); records.set(key, value); } };
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
  assert.equal(JSON.parse(storage.records.get(VIEW_STORAGE_KEY)).lifetime.mode, 'lifetime');
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
  for (const value of ['{', 'null', '[]', '{"version":8,"mandala":true}']) {
    storage.records.set(VIEW_STORAGE_KEY, value); assert.equal(store.read(), null);
  }
  storage.records.set(VIEW_STORAGE_KEY, JSON.stringify({ ...snapshot, camera: { x: 'bad', y: 0, k: 0 },
    selectedId: '../bad', lifetime: { opened: true, mode: 'lifetime', fromDate: '2020-02-31', toDate: '2027-10-04', index: -4 },
    arbitrary: { library: 'replace' } }));
  const read = store.read();
  assert.equal(read.mandala, true); assert.equal(read.selectedId, 'current-transit');
  assert.equal(read.camera, null); assert.equal(read.lifetime, null); assert.equal('arbitrary' in read, false);
});

test('denied storage remains usable in memory and warns only once', () => {
  const warnings = []; const store = createViewStore({ getStorage() { throw new Error('Denied'); }, onStorageError: text => warnings.push(text) });
  assert.equal(store.read(), null); assert.equal(store.write(snapshot), false);
  store.write({ ...snapshot, mandala: false }); assert.equal(warnings.length, 1);
  assert.equal(store.read().mandala, false);
});


test('the empty-end meaning survives storage without losing its effective final date', () => {
  const storage = memory(); const store = createViewStore({ getStorage: () => storage });
  store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, openEnded: true } });
  const restored = createViewStore({ getStorage: () => storage }).read();
  assert.equal(restored.lifetime.openEnded, true); assert.equal(restored.lifetime.toDate, '2027-10-04');
});


test('same-tab reload restores the view while a new tab starts fresh and shares only the chart library', t => {
  const persistent = memory(snapshot), firstTab = memory(), nextTab = memory();
  persistent.records.set('liniya.charts.v1', JSON.stringify([{ id: 'saved-chart', name: 'My chart', personality: [1], design: [2] }]));
  const previous = new Map(['localStorage', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: persistent });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: firstTab });
  const view = createViewStore();
  assert.equal(view.read(), null, 'a new tab must not revive the legacy persistent view');
  view.write(snapshot);
  assert.equal(createViewStore().read().mandala, true, 'reload uses the same tab storage');
  assert.equal(createChartStore().get('saved-chart').name, 'My chart');
  globalThis.sessionStorage = nextTab;
  assert.equal(createViewStore().read(), null, 'a new tab has no presentation snapshot');
  assert.equal(createChartStore().get('saved-chart').name, 'My chart');
  createViewStore().write({ ...snapshot, mandala: false });
  globalThis.sessionStorage = firstTab;
  assert.equal(createViewStore().read().mandala, true, 'another tab cannot overwrite this tab');
  assert.equal(persistent.writes.length, 0, 'view writes never alter persistent library or legacy view data');
});


test('return exploration saves only navigation metadata and cannot inject a computed overlay', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  const returns = { opened: true, year: 2050, bodies: ['saturn'], eventId: 'saturn:2050-01-01T12:00:00Z' };
  store.write({ ...snapshot, returns: { ...returns, chart: { injected: true } } });
  assert.deepEqual(createViewStore({ getStorage: () => storage }).read().returns, returns);
  store.write({ ...snapshot, returns: { ...returns, bodies: ['injected'], eventId: '<script>' } });
  assert.equal(createViewStore({ getStorage: () => storage }).read().returns, undefined);
});

test('closed empty return filters round-trip without inventing default planets or a year', () => {
  const returns = { opened: false, year: null, bodies: [], eventId: null };
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  store.write({ ...snapshot, returns });
  assert.deepEqual(createViewStore({ getStorage: () => storage }).read().returns, returns);
});

test('legacy return modes become one combined filter only at the storage boundary', () => {
  for (const [group, year, bodies] of [
    ['major', null, ['north_node', 'saturn', 'uranus_opposition', 'chiron', 'uranus']],
    ['year', 2050, ['sun', 'mercury', 'venus', 'mars']], ['planet', null, ['moon']],
  ]) {
    const storage = memory({ ...snapshot, returns: { opened: false, group, year: 2050, body: 'moon', eventId: null } });
    const store = createViewStore({ getStorage: () => storage }), result = store.read();
    assert.deepEqual(result.returns, { opened: false, year, bodies, eventId: null });
    assert.equal(storage.writes.length, 0);
    store.write({ ...result, mandala: false });
    assert.equal('group' in JSON.parse(storage.records.get(VIEW_STORAGE_KEY)).returns, false);
  }
});

test('modern filters do not fall back to legacy values and reject malformed bodies or years', () => {
  for (const bad of [{ bodies: ['unknown'], year: null }, { bodies: 'moon', year: null },
    { bodies: [], year: '2050' }, { bodies: [], year: 2400 }]) {
    const storage = memory({ ...snapshot, returns: { opened: false, group: 'major', body: 'saturn', eventId: null, ...bad } });
    assert.equal(createViewStore({ getStorage: () => storage }).read().returns, undefined);
  }
  const storage = memory({ ...snapshot, returns: { opened: false, bodies: ['moon', 'sun', 'moon'], year: null, eventId: null } });
  assert.deepEqual(createViewStore({ getStorage: () => storage }).read().returns.bodies, ['sun', 'moon']);
});


test('personal timeline distinguishes birth view from a scrubbed preview across refresh', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  for (const personalPreview of [false, true]) {
    store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, personalPreview } });
    assert.equal(createViewStore({ getStorage: () => storage }).read().lifetime.personalPreview, personalPreview);
  }
});

test('following the current minute remains distinct from a manually selected lifetime moment', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  for (const personalLive of [true, false]) {
    store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, personalPreview: true, personalLive } });
    const restored = createViewStore({ getStorage: () => storage }).read();
    assert.equal(restored.lifetime.personalLive, personalLive);
  }
  store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, personalLive: 'true' } });
  assert.equal(createViewStore({ getStorage: () => storage }).read().lifetime.personalLive, undefined);
});


test('lifetime UTC survives storage exactly and supersedes a legacy transport index', () => {
  const storage = memory(), store = createViewStore({ getStorage: () => storage });
  const requestedUtc = Date.parse('2026-10-04T12:37:29.432Z');
  store.write({ ...snapshot, lifetime: { ...snapshot.lifetime, requestedUtc, index: 5040 } });
  const saved = createViewStore({ getStorage: () => storage }).read().lifetime;
  assert.equal(saved.requestedUtc, requestedUtc); assert.equal('index' in saved, false);
  assert.equal('index' in JSON.parse(storage.records.get(VIEW_STORAGE_KEY)).lifetime, false);
});

test('legacy lifetime indices remain readable until metadata can convert them', () => {
  const legacy = { ...snapshot, lifetime: { ...snapshot.lifetime, requestedUtc: undefined, index: 5040 } };
  const storage = memory(legacy), saved = createViewStore({ getStorage: () => storage }).read();
  assert.equal(saved.lifetime.index, 5040); assert.equal('requestedUtc' in saved.lifetime, false);
});

test('lifetime UTC rejects invalid timestamps while accepting dates before the Unix epoch', () => {
  for (const requestedUtc of [Infinity, NaN, '2026-10-04', 8640000000000001]) {
    const storage = memory({ ...snapshot, lifetime: { ...snapshot.lifetime, requestedUtc } });
    assert.equal(createViewStore({ getStorage: () => storage }).read().lifetime, null);
  }
  const storage = memory({ ...snapshot, lifetime: { ...snapshot.lifetime, requestedUtc: -60000 } });
  assert.equal(createViewStore({ getStorage: () => storage }).read().lifetime.requestedUtc, -60000);
});
