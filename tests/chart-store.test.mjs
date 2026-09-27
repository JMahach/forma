import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartStore } from '../src/data/chart-store.js';
import { createChartSession } from '../src/state/chart-session.js';
import { STORAGE_KEY, TRASH_KEY } from '../src/data/storage.js';

const personal = { id: 'personal', name: 'Test chart', source: 'manual', personality: [1], design: [8] };

function storageHarness(initial = []) {
  const values = new Map([[STORAGE_KEY, JSON.stringify(initial)]]), writes = [];
  let fail = false;
  return {
    values, writes,
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
  assert.equal(store.charts, previous);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Не удалось сохранить/);
  store.replace(next);
  session.select('unsaved');
  assert.equal(session.original.id, 'unsaved');
  assert.equal(JSON.parse(storage.values.get(STORAGE_KEY)).length, 1);
  assert.doesNotThrow(() => store.flush());
  assert.equal(errors.length, 1, 'background persistence stays best effort');
  storage.fail = false;
  assert.equal(store.persist(), true);
  assert.equal(JSON.parse(storage.values.get(STORAGE_KEY)).length, 2);
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
  assert.doesNotThrow(() => store.flush());
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
