import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createChartId, readCharts, writeChartChanges, validateChart } from '../src/data/storage.js';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('chart IDs prefer native randomUUID with its original receiver', () => {
  const expected = '00112233-4455-4677-8899-aabbccddeeff';
  const cryptoApi = {
    randomUUID() { assert.equal(this, cryptoApi); return expected; },
    getRandomValues() { assert.fail('native UUID generation should be used'); }
  };
  assert.equal(createChartId(cryptoApi), expected);
});

test('HTTP fallback uses random bytes and sets UUID v4 version and variant', () => {
  for (const value of [0, 255]) {
    const cryptoApi = {
      getRandomValues(bytes) {
        assert.equal(this, cryptoApi);
        assert.ok(bytes instanceof Uint8Array);
        assert.equal(bytes.length, 16);
        bytes.fill(value);
        return bytes;
      }
    };
    const id = createChartId(cryptoApi);
    assert.match(id, uuidV4);
    assert.equal(id, value === 0 ? '00000000-0000-4000-8000-000000000000' : 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  }
});

test('HTTP fallback creates distinct IDs that survive storage validation', () => {
  const cryptoApi = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) };
  const charts = Array.from({ length: 1000 }, (_, index) => ({
    id: createChartId(cryptoApi), name: `Test ${index}`, personality: [46], design: [10]
  }));
  assert.equal(new Set(charts.map(chart => chart.id)).size, charts.length);
  for (const chart of charts) {
    assert.match(chart.id, uuidV4);
    assert.equal(validateChart(chart).id, chart.id);
  }
  const values = new Map();
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(writeChartChanges(storage, charts.slice(0, 500), []), 500);
  assert.deepEqual(readCharts(storage).map(chart => chart.id), charts.slice(0, 500).map(chart => chart.id));
});

test('missing random-byte support reports a readable error instead of using weak randomness', () => {
  for (const cryptoApi of [null, {}]) {
    assert.throws(() => createChartId(cryptoApi), /Браузер не поддерживает создание идентификатора карты/);
  }
});
