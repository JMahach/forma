import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartStore } from '../src/data/chart-store.js';
import { createChartSession } from '../src/state/chart-session.js';
import { STORAGE_KEY, TRASH_KEY, CHART_RECORD_PREFIX, CHART_DELETED_PREFIX, readCharts } from '../src/data/storage.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

const personal = { id: 'personal', name: 'Test chart', source: 'manual', personality: [1], design: [8] };

function storageHarness(initial = []) {
  const values = new Map([[STORAGE_KEY, JSON.stringify(initial)]]), writes = [];
  let fail = false;
  return {
    values, writes,
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => values.delete(key),
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (fail) throw new Error('Quota exceeded'); values.set(key, value); writes.push([key, value]); },
    set fail(value) { fail = value; },
  };
}

test('chart store loads without writing and keeps selection independent of saved records', () => {
  const storage = storageHarness([personal]);
  const store = createChartStore({ getStorage: () => storage });
  const session = createChartSession({ store });
  assert.equal(store.storageAvailable, true);
  assert.equal(session.selectedId, 'current-transit');
  assert.equal(session.original.source, 'transit');
  assert.deepEqual(session.original.personality, []);
  assert.equal(store.has('personal'), true);
  session.select('personal');
  assert.equal(session.original, store.charts[0]);
  assert.equal(session.original.name, personal.name);
  assert.equal(storage.writes.length, 0);
});

test('failed persistence retains existing state until the caller explicitly keeps an unsaved chart in memory', () => {
  const storage = storageHarness([personal]), errors = [];
  const store = createChartStore({ getStorage: () => storage, onStorageError: message => errors.push(message) });
  const session = createChartSession({ store });
  const previous = store.charts, next = [...previous, { ...personal, id: 'unsaved' }];
  storage.fail = true;
  assert.equal(store.persist(next), false);
  assert.deepEqual(store.saveError, { code: 'storage', message: 'Не удалось сохранить карту в браузере.', canKeepInMemory: true });
  assert.equal(store.charts, previous);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Не удалось сохранить/);
  store.replace(next);
  session.select('unsaved');
  assert.equal(session.original.id, 'unsaved');
  assert.equal(JSON.parse(storage.values.get(STORAGE_KEY)).length, 1);
  storage.fail = false;
  assert.equal(store.persist(), true);
  assert.equal(store.saveError, null);
  assert.equal(readCharts(storage).length, 2);
});

test('denied storage access leaves a usable in-memory store without erasing saved data', () => {
  const errors = [];
  const store = createChartStore({ getStorage() { throw new Error('Access denied'); }, onStorageError: message => errors.push(message) });
  const session = createChartSession({ store });
  assert.equal(store.storageAvailable, false);
  assert.deepEqual(store.charts, []);
  assert.equal(store.persist([personal]), false);
  store.replace([personal]);
  session.select(personal.id);
  assert.equal(session.original, personal);
  assert.equal(errors.length, 1);
});

test('deletion changes memory only after storage succeeds and removes only the confirmed historical copy', () => {
  const other = { ...personal, id: 'other', name: 'Other' };
  const storage = storageHarness([personal, other]);
  storage.values.set(TRASH_KEY, JSON.stringify([personal, other]));
  const store = createChartStore({ getStorage: () => storage });
  const original = store.charts;
  storage.fail = true;
  assert.throws(() => store.remove(personal.id), /Quota/);
  assert.equal(store.charts, original);
  storage.fail = false;
  store.remove(personal.id);
  assert.deepEqual(store.charts.map(chart => chart.id), ['other']);
  assert.deepEqual(JSON.parse(storage.values.get(TRASH_KEY)).map(chart => chart.id), ['other']);
  assert.throws(() => store.remove('current-transit'), /Эта карта не удаляется/);
});

test('one corrupt legacy entry leaves healthy charts usable and preserves its exact stored data', () => {
  const damaged = { id: 'damaged', name: 'Broken', personality: [65], design: [] };
  const storage = storageHarness([personal, damaged]), errors = [];
  const original = storage.values.get(STORAGE_KEY);
  const store = createChartStore({ getStorage: () => storage, onStorageError: message => errors.push(message) });
  assert.equal(store.storageAvailable, true);
  assert.deepEqual(store.charts.map(chart => chart.id), ['personal']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /поврежд|прочитать/i);
  assert.equal(storage.writes.length, 0);
  assert.equal(store.persist([...store.charts, { ...personal, id: 'new', name: 'New' }]), true);
  assert.equal(storage.values.get(STORAGE_KEY), original, 'an unrelated save cannot rewrite away a damaged record');
  assert.deepEqual(readCharts(storage).map(chart => chart.id).sort(), ['new', 'personal']);
});

test('stale tabs preserve independent additions and edits instead of replacing their common snapshot', () => {
  const storage = storageHarness([personal, { ...personal, id: 'second', name: 'Second' }]);
  const first = createChartStore({ getStorage: () => storage }), second = createChartStore({ getStorage: () => storage });
  assert.equal(first.persist([...first.charts.map(chart => chart.id === 'personal' ? { ...chart, name: 'First edit' } : chart),
    { ...personal, id: 'added-first', name: 'First addition' }]), true);
  assert.equal(second.persist([...second.charts.map(chart => chart.id === 'second' ? { ...chart, name: 'Second edit' } : chart),
    { ...personal, id: 'added-second', name: 'Second addition' }]), true);
  assert.deepEqual(Object.fromEntries(readCharts(storage).map(chart => [chart.id, chart.name])), {
    personal: 'First edit', second: 'Second edit', 'added-first': 'First addition', 'added-second': 'Second addition',
  });
  assert.equal(second.charts.find(chart => chart.id === 'personal').name, 'First edit', 'save publishes a merged synchronous readback');
  storage.writes.length = 0;
  first.persist(); second.persist();
  assert.deepEqual(storage.writes, [], 'unchanged stores do not write their old collection');
  assert.equal(readCharts(storage).find(chart => chart.id === 'second').name, 'Second edit');
});

test('interleaved independent record writes cannot overwrite another tab save', () => {
  const storage = storageHarness([personal, { ...personal, id: 'second', name: 'Second' }]);
  const first = createChartStore({ getStorage: () => storage }), second = createChartStore({ getStorage: () => storage });
  const write = storage.setItem;
  let nested = false;
  storage.setItem = (key, value) => {
    if (!nested) {
      nested = true;
      assert.equal(second.persist(second.charts.map(chart => chart.id === 'second' ? { ...chart, name: 'Second edit' } : chart)), true);
    }
    write(key, value);
  };
  assert.equal(first.persist(first.charts.map(chart => chart.id === 'personal' ? { ...chart, name: 'First edit' } : chart)), true);
  assert.deepEqual(readCharts(storage).map(chart => chart.name), ['First edit', 'Second edit']);
  assert.equal(new Set(storage.writes.map(([key]) => key)).size, 2, 'the two independent cards do not share a mutable storage key');
});

test('stale editing or explicit persistence cannot resurrect a chart deleted in another tab', () => {
  const storage = storageHarness([personal, { ...personal, id: 'second', name: 'Second' }]), errors = [];
  const deleting = createChartStore({ getStorage: () => storage });
  const stale = createChartStore({ getStorage: () => storage, onStorageError: message => errors.push(message) });
  const pending = stale.charts.map(chart => chart.id === 'personal' ? { ...chart, name: 'Stale edit' } : chart);
  deleting.remove('personal');
  stale.persist();
  assert.deepEqual(readCharts(storage).map(chart => chart.id), ['second']);
  assert.equal(stale.persist(pending), false);
  assert.equal(stale.saveError.code, 'deleted');
  assert.equal(stale.saveError.canKeepInMemory, false);
  assert.match(errors.at(-1), /удален|удалён|другой вкладке/i);
  assert.deepEqual(readCharts(storage).map(chart => chart.id), ['second']);
  assert.equal(stale.persist(stale.charts.map(chart => chart.id === 'second' ? { ...chart, name: 'Allowed edit' } : chart)), true);
  assert.deepEqual(readCharts(storage).map(chart => [chart.id, chart.name]), [['second', 'Allowed edit']]);
});

test('a concurrent delete wins even when it occurs between a stale save preflight and its record write', () => {
  const storage = storageHarness([personal]), errors = [];
  const stale = createChartStore({ getStorage: () => storage, onStorageError: value => errors.push(value) });
  const deleting = createChartStore({ getStorage: () => storage }), write = storage.setItem;
  let deleted = false;
  storage.setItem = (key, value) => {
    if (!deleted && key === `${CHART_RECORD_PREFIX}personal`) {
      deleted = true; deleting.remove('personal');
    }
    write(key, value);
  };
  assert.equal(stale.persist([{ ...stale.charts[0], name: 'Too late' }]), false);
  assert.deepEqual(readCharts(storage), []);
  assert.equal(storage.getItem(`${CHART_RECORD_PREFIX}personal`), null);
  assert.equal(storage.getItem(`${CHART_DELETED_PREFIX}personal`), '1');
  assert.match(errors.at(-1), /удалена/);
});

test('saving an unchanged tab refreshes its collection without persisting stale records', () => {
  const storage = storageHarness([personal]);
  const stale = createChartStore({ getStorage: () => storage }), other = createChartStore({ getStorage: () => storage });
  other.persist([{ ...other.charts[0], name: 'Other edit' }, { ...personal, id: 'other' }]);
  storage.writes.length = 0;
  assert.equal(stale.persist(), true);
  assert.deepEqual(stale.charts.map(chart => [chart.id, chart.name]), [['personal', 'Other edit'], ['other', 'Test chart']]);
  assert.equal(storage.writes.length, 0);
});

test('corrupt v2 records preserve raw bytes and do not hide unrelated healthy cards', () => {
  const storage = storageHarness([personal, { ...personal, id: 'other' }]), warnings = [];
  const stale = createChartStore({ getStorage: () => storage });
  const key = `${CHART_RECORD_PREFIX}personal`, raw = '{broken record';
  storage.values.set(key, raw);
  const store = createChartStore({ getStorage: () => storage, onStorageError: value => warnings.push(value) });
  assert.deepEqual(store.charts.map(chart => chart.id), ['other'], 'a damaged override cannot expose its old legacy version as current');
  assert.equal(store.storageAvailable, true);
  assert.equal(warnings.length, 1);
  assert.equal(store.persist([...store.charts, { ...personal, id: 'new' }]), true);
  assert.equal(storage.getItem(key), raw);
  assert.equal(warnings.length, 1, 're-reading the same damaged key does not repeat the warning');
  assert.equal(stale.persist(stale.charts.map(chart => chart.id === 'personal' ? { ...chart, name: 'Overwrite' } : chart)), false);
  assert.equal(stale.saveError.code, 'corrupt');
  assert.equal(stale.saveError.canKeepInMemory, false);
  assert.equal(storage.getItem(key), raw, 'a stale edit cannot overwrite evidence of corruption');
});

test('invalid charts are rejected with a local error before any storage write', () => {
  const storage = storageHarness([personal]);
  const store = createChartStore({ getStorage: () => storage });
  assert.equal(store.saveError, null);
  assert.equal(store.persist([{ ...personal, personality: [65] }]), false);
  assert.equal(store.saveError.code, 'invalid');
  assert.equal(store.saveError.canKeepInMemory, false);
  assert.match(store.saveError.message, /Некорректный список активаций/);
  assert.equal(store.persist([{ ...personal, id: 'bad/id' }]), false);
  assert.equal(store.saveError.code, 'invalid');
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(readCharts(storage).map(chart => chart.personality), [[1]]);
});

test('normalizing a newly saved name does not turn unchanged later saves into writes', () => {
  const storage = storageHarness([]), store = createChartStore({ getStorage: () => storage });
  assert.equal(store.persist([{ ...personal, name: '  renamed  ' }]), true);
  assert.equal(store.get(personal.id).name, 'Renamed');
  storage.writes.length = 0;
  store.persist(); store.persist();
  assert.equal(storage.writes.length, 0);
});

test('deletion cleans only its target from fresh raw legacy arrays and reports incomplete cleanup honestly', () => {
  const broken = { id: 'broken', name: 'Do not discard', personality: [65] };
  const storage = storageHarness([personal, broken, { ...personal, id: 'other' }]), warnings = [];
  storage.values.set(TRASH_KEY, JSON.stringify([personal, broken]));
  const store = createChartStore({ getStorage: () => storage, onStorageError: value => warnings.push(value) });
  store.remove('personal');
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).map(chart => chart.id), ['broken', 'other']);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY))[0], broken);
  assert.deepEqual(JSON.parse(storage.getItem(TRASH_KEY)), [broken]);
  assert.deepEqual(store.charts.map(chart => chart.id), ['other']);

  const original = storage.getItem(STORAGE_KEY), write = storage.setItem;
  storage.setItem = (key, value) => { if (key === STORAGE_KEY) throw new Error('Cleanup denied'); write(key, value); };
  warnings.length = 0;
  assert.doesNotThrow(() => store.remove('other'));
  assert.deepEqual(store.charts, []);
  assert.deepEqual(readCharts(storage), []);
  assert.equal(storage.getItem(STORAGE_KEY), original, 'failed cleanup keeps raw data rather than claiming it was erased');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /удалена.*не удалось очистить/);
});

test('same-ID edits use the last completed record write while unchanged cards keep their identity', () => {
  const storage = storageHarness([personal, { ...personal, id: 'other' }]);
  const first = createChartStore({ getStorage: () => storage }), second = createChartStore({ getStorage: () => storage });
  const unchanged = second.get('other');
  first.persist(first.charts.map(chart => chart.id === 'personal' ? { ...chart, name: 'Earlier' } : chart));
  second.persist(second.charts.map(chart => chart.id === 'personal' ? { ...chart, name: 'Later' } : chart));
  assert.equal(readCharts(storage).find(chart => chart.id === 'personal').name, 'Later');
  assert.equal(second.get('other'), unchanged);
});

test('deleting another card preserves an explicitly retained unsaved chart and its pending persistence', () => {
  const storage = storageHarness([personal, { ...personal, id: 'other' }]);
  const store = createChartStore({ getStorage: () => storage });
  const pending = { ...personal, id: 'unsaved', name: 'Unsaved' };
  const next = [...store.charts.map(chart => chart.id === 'other' ? { ...chart, name: 'Unsaved edit' } : chart), pending];
  storage.fail = true;
  assert.equal(store.persist(next), false);
  store.replace(next);
  storage.fail = false;
  store.remove('personal');
  assert.deepEqual(store.charts.map(chart => [chart.id, chart.name]), [['other', 'Unsaved edit'], ['unsaved', 'Unsaved']]);
  assert.deepEqual(readCharts(storage).map(chart => [chart.id, chart.name]), [['other', 'Test chart']], 'delete does not silently save another draft');
  store.persist();
  assert.deepEqual(readCharts(storage).map(chart => [chart.id, chart.name]), [['other', 'Unsaved edit'], ['unsaved', 'Unsaved']]);
});

test('real-store saves, reloads, and edits retain exact time and opaque calculation metadata', () => {
  const exact = { ...chartAtMinute(natalDayFixture(), 754, personalChartFixture()),
    utc: '2026-09-24T12:34:45.321Z', birthTime: '12:34:45', calculation: { unknown: true, precision: [1e-14, 0.123456789012345] } };
  const storage = storageHarness([]), store = createChartStore({ getStorage: () => storage });
  assert.equal(store.persist([exact]), true);
  const key = `${CHART_RECORD_PREFIX}${exact.id}`;
  assert.deepEqual(JSON.parse(storage.getItem(key)).chart, exact, 'validated persistence does not replace the raw payload with its projection');
  const reloaded = createChartStore({ getStorage: () => storage });
  assert.equal(reloaded.get(exact.id).birthTime, exact.birthTime);
  assert.deepEqual(reloaded.get(exact.id).calculation, exact.calculation);
  assert.equal(reloaded.persist(reloaded.charts.map(chart => ({ ...chart, name: 'Renamed' }))), true);
  assert.deepEqual(JSON.parse(storage.getItem(key)).chart.calculation, exact.calculation);
  assert.equal(reloaded.get(exact.id).utc, exact.utc);
  assert.deepEqual(reloaded.get(exact.id).activations, exact.activations);
  storage.writes.length = 0;
  reloaded.persist();
  assert.equal(storage.writes.length, 0, 'raw snapshots do not make unchanged preserved extensions dirty');
  assert.equal(reloaded.persist(reloaded.charts.map(chart => ({ ...chart, calculation: { ...chart.calculation, unknown: false } }))), true);
  assert.equal(storage.writes.length, 1, 'a change outside the old projection still participates in the save');
  assert.equal(JSON.parse(storage.getItem(key)).chart.birthTime, exact.birthTime);
  assert.equal(JSON.parse(storage.getItem(key)).chart.calculation.unknown, false);
  assert.equal(createChartStore({ getStorage: () => storage }).get(exact.id).calculation.unknown, false);
  assert.equal(reloaded.persist(reloaded.charts.map(chart => ({ ...chart, birthTime: '12:34:46' }))), true);
  assert.equal(storage.writes.length, 2, 'seconds-only changes also persist');
  assert.equal(JSON.parse(storage.getItem(key)).chart.birthTime, '12:34:46');
  reloaded.get(exact.id).calculation.precision[0] = 2e-14;
  reloaded.persist();
  assert.equal(storage.writes.length, 3, 'nested mutations are compared against an owned baseline');
  assert.equal(JSON.parse(storage.getItem(key)).chart.calculation.precision[0], 2e-14);
});

test('interleaved legacy cleanup cannot resurrect either independently deleted chart', () => {
  const damaged = { id: 'damaged', personality: [65] };
  const storage = storageHarness([personal, { ...personal, id: 'other' }, damaged]);
  const first = createChartStore({ getStorage: () => storage }), second = createChartStore({ getStorage: () => storage });
  const write = storage.setItem;
  let nested = false;
  storage.setItem = (key, value) => {
    if (!nested && key === STORAGE_KEY) { nested = true; second.remove('other'); }
    write(key, value);
  };
  first.remove(personal.id);
  assert.deepEqual(readCharts(storage), [], 'both tombstones dominate all legacy cleanup snapshots');
  assert.equal(storage.getItem(`${CHART_DELETED_PREFIX}personal`), '1');
  assert.equal(storage.getItem(`${CHART_DELETED_PREFIX}other`), '1');
  assert.ok(JSON.parse(storage.getItem(STORAGE_KEY)).some(chart => chart.id === 'other'), 'physical cleanup is best effort, not a transaction or secure erase');
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)).find(chart => chart.id === damaged.id), damaged);
});

test('unrelated saves and no-op saves preserve every legacy record with a repeated ID', () => {
  const first = { ...personal, id: 'same', name: 'First', personality: [1] };
  const second = { ...personal, id: 'same', name: 'Second', personality: [2] };
  const storage = storageHarness([first, second]), original = storage.getItem(STORAGE_KEY);
  const store = createChartStore({ getStorage: () => storage });
  const before = store.charts.map(chart => ({ name: chart.name, personality: chart.personality }));
  assert.equal(store.persist([...store.charts, { ...personal, id: 'new' }]), true);
  assert.deepEqual(store.charts.slice(0, 2).map(chart => ({ name: chart.name, personality: chart.personality })), before);
  assert.deepEqual(storage.writes.map(([key]) => key), [`${CHART_RECORD_PREFIX}new`]);
  assert.equal(storage.getItem(STORAGE_KEY), original);
  assert.equal(storage.getItem(`${CHART_RECORD_PREFIX}same`), null);
  storage.writes.length = 0;
  assert.equal(store.persist(), true);
  assert.equal(storage.writes.length, 0);
  assert.deepEqual(readCharts(storage).map(chart => chart.name), ['First', 'Second', personal.name]);
});

test('ambiguous edits reject the complete batch without accepting memory changes or overwriting repeated IDs', () => {
  for (const edit of ['rename', 'copy-second', 'drop-second', 'add-third']) {
    const storage = storageHarness([{ ...personal, id: 'same', name: 'First', personality: [1] },
      { ...personal, id: 'same', name: 'Second', personality: [2] }]);
    const store = createChartStore({ getStorage: () => storage }), previous = store.charts;
    const next = edit === 'rename' ? [{ ...previous[0], name: 'Changed' }, previous[1]]
      : edit === 'copy-second' ? [previous[1], { ...previous[1] }]
        : edit === 'drop-second' ? [previous[0]] : [...previous, { ...previous[1] }];
    assert.equal(store.persist([{ ...personal, id: 'new' }, ...next]), false, edit);
    assert.equal(store.saveError.code, 'ambiguous', edit);
    assert.equal(store.saveError.canKeepInMemory, false, edit);
    assert.match(store.saveError.message, /одинаковым идентификатором/);
    assert.equal(store.charts, previous, edit);
    assert.deepEqual(storage.writes, [], edit);
    assert.deepEqual(readCharts(storage).map(chart => chart.name), ['First', 'Second'], edit);
  }
});

test('a newly observed duplicate blocks a formerly unambiguous stale edit', () => {
  const first = { ...personal, id: 'same', name: 'First' };
  const storage = storageHarness([first]), store = createChartStore({ getStorage: () => storage });
  storage.values.set(STORAGE_KEY, JSON.stringify([first, { ...first, name: 'Second', personality: [2] }]));
  assert.equal(store.persist([{ ...store.charts[0], name: 'Stale edit' }]), false);
  assert.equal(store.saveError.code, 'ambiguous');
  assert.equal(store.saveError.canKeepInMemory, false);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(readCharts(storage).map(chart => chart.name), ['First', 'Second']);
});

test('deleting an independent ID preserves repeated records while deleting their shared ID removes all its occurrences', () => {
  const storage = storageHarness([{ ...personal, id: 'same', name: 'First', personality: [1] },
    { ...personal, id: 'same', name: 'Second', personality: [2] }, { ...personal, id: 'other' }]);
  const store = createChartStore({ getStorage: () => storage });
  store.remove('other');
  assert.deepEqual(store.charts.map(chart => [chart.name, chart.personality]), [['First', [1]], ['Second', [2]]]);
  assert.deepEqual(readCharts(storage).map(chart => chart.name), ['First', 'Second']);
  storage.writes.length = 0;
  assert.equal(store.persist(), true);
  assert.deepEqual(storage.writes, []);
  store.remove('same');
  assert.deepEqual(store.charts, []);
  assert.deepEqual(readCharts(storage), []);
});

test('fresh duplicate IDs block unrelated deletion before writing when a conflicting edit was retained in memory', () => {
  const first = { ...personal, id: 'same', name: 'First' }, other = { ...personal, id: 'other' };
  const storage = storageHarness([first, other]), store = createChartStore({ getStorage: () => storage });
  store.replace(store.charts.map(chart => chart.id === 'same' ? { ...chart, name: 'Unsaved edit' } : chart));
  const before = store.charts;
  storage.values.set(STORAGE_KEY, JSON.stringify([first, { ...first, name: 'Second', personality: [2] }, other]));
  assert.throws(() => store.remove('other'), error => error.code === 'ambiguous' && /одинаковым идентификатором/.test(error.message));
  assert.equal(store.charts, before);
  assert.deepEqual(storage.writes, []);
  assert.deepEqual(readCharts(storage).map(chart => chart.name), ['First', 'Second', other.name]);
});

test('a legacy writer introducing duplicates during deletion cannot replace both fresh records with one pending edit', () => {
  const first = { ...personal, id: 'same', name: 'First' }, other = { ...personal, id: 'other' };
  const storage = storageHarness([first, other]), warnings = [];
  const store = createChartStore({ getStorage: () => storage, onStorageError: message => warnings.push(message) });
  store.replace(store.charts.map(chart => chart.id === 'same' ? { ...chart, name: 'Unsaved edit' } : chart));
  const write = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === `${CHART_DELETED_PREFIX}other`) storage.values.set(STORAGE_KEY,
      JSON.stringify([first, { ...first, name: 'Second', personality: [2] }, other]));
    write(key, value);
  };
  store.remove('other');
  assert.deepEqual(store.charts.map(chart => chart.name), ['First', 'Second']);
  assert.deepEqual(readCharts(storage).map(chart => chart.name), ['First', 'Second']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Несохранённые изменения.*не применены/);
});

test('legacy chart metadata survives the first per-record edit without rewriting the legacy source', () => {
  const original = { ...personal, birthTime: '01:02:03', calculation: { retained: 'legacy' } };
  const storage = storageHarness([original]), raw = storage.getItem(STORAGE_KEY);
  const store = createChartStore({ getStorage: () => storage });
  assert.equal(store.persist([{ ...store.get(personal.id), name: 'Renamed legacy' }]), true);
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  const persisted = JSON.parse(storage.getItem(`${CHART_RECORD_PREFIX}${personal.id}`)).chart;
  assert.equal(persisted.birthTime, original.birthTime);
  assert.deepEqual(persisted.calculation, original.calculation);
});
