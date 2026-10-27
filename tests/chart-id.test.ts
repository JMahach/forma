import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createChartId, readCharts, writeChartChanges, validateLibraryChart } from '../src/data/storage.ts';

// Each crypto double supplies only the capability exercised at this browser boundary.
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('chart IDs prefer native randomUUID with its original receiver', () => {
  const expected = '00112233-4455-4677-8899-aabbccddeeff';
  const cryptoApi = {
    randomUUID() { assert.equal(this, cryptoApi); return expected; },
    getRandomValues() { assert.fail('native UUID generation should be used'); }
  };
  assert.equal(createChartId(cryptoApi as unknown as Crypto), expected);
});

test('HTTP fallback uses random bytes and sets UUID v4 version and variant', () => {
  for (const value of [0, 255] as const) {
    const cryptoApi = {
      getRandomValues(bytes: Uint8Array) {
        assert.equal(this, cryptoApi);
        assert.ok(bytes instanceof Uint8Array);
        assert.equal(bytes.length, 16);
        bytes.fill(value);
        return bytes;
      }
    };
    const id = createChartId(cryptoApi as unknown as Crypto);
    assert.match(id, uuidV4);
    assert.equal(id, value === 0 ? '00000000-0000-4000-8000-000000000000' : 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  }
});

test('HTTP fallback creates distinct IDs that survive storage validation', () => {
  const cryptoApi = { getRandomValues: (bytes:Uint8Array) => webcrypto.getRandomValues(bytes) };
  const charts = Array.from({ length: 1000 }, (_, index) => ({
    id: createChartId(cryptoApi as unknown as Crypto), name: `Test ${index}`, personality: [46], design: [10]
  }));
  assert.equal(new Set(charts.map(chart => chart.id)).size, charts.length);
  for (const chart of charts) {
    assert.match(chart.id, uuidV4);
    assert.equal(validateLibraryChart(chart).id, chart.id);
  }
  const values = new Map<string,string>();
  const storage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key:string) => values.delete(key) };
  // The legacy minimal records intentionally exercise normalization at storage ingress.
  assert.equal(writeChartChanges(storage, charts.slice(0, 500) as unknown as Parameters<typeof writeChartChanges>[1], []), 500);
  assert.deepEqual(readCharts(storage).map(chart => chart.id), charts.slice(0, 500).map(chart => chart.id));
});

test('missing random-byte support reports a readable error instead of using weak randomness', () => {
  for (const cryptoApi of [null, {}] as const) {
    assert.throws(() => createChartId(cryptoApi as unknown as Crypto), /Браузер не поддерживает создание идентификатора карты/);
  }
});
