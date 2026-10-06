import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChart, readCharts, writeChartChanges, STORAGE_KEY, CHART_RECORD_PREFIX } from '../src/data/storage.js';

const chart = name => Object.freeze({ id: 'saved-name', name, personality: [1], design: [8] });
const cases = [
  ['  марат  ', 'Марат'], ['мАРат', 'МАРат'], ['anna van Gogh', 'Anna van Gogh'],
  ['«ёлка» & "друг"', '«Ёлка» & "друг"'], ['🌿 марат', '🌿 Марат'], ['𐐨name', '𐐀name'],
];
test('saved chart names capitalize only the first Unicode letter while preserving the rest', () => {
  for (const [input, expected] of cases) {
    const original = chart(input), normalized = validateChart(original);
    assert.equal(normalized.name, expected);
    assert.equal(original.name, input, 'normalization must not mutate the provided chart');
    assert.equal(validateChart(normalized).name, expected, 'normalization is idempotent');
  }
});
test('legacy reads and newly written names share the same normalization without altering their original records', () => {
  const legacy = JSON.stringify([chart('марат')]), values = new Map([[STORAGE_KEY, legacy]]);
  let writes = 0;
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, next) => { values.set(key, next); writes++; } };
  const previous = readCharts(storage);
  assert.equal(previous[0].name, 'Марат');
  assert.equal(writes, 0, 'reading an old library does not rewrite storage');
  const original = chart('  «ёлка» & "друг"  ');
  assert.equal(writeChartChanges(storage, Object.freeze([original]), previous), 1);
  assert.equal(JSON.parse(values.get(`${CHART_RECORD_PREFIX}${original.id}`)).chart.name, '«Ёлка» & "друг"');
  assert.equal(values.get(STORAGE_KEY), legacy, 'ordinary saves leave legacy data untouched');
  assert.equal(writes, 1);
  assert.equal(readCharts(storage)[0].name, '«Ёлка» & "друг"');
  assert.equal(original.name, '  «ёлка» & "друг"  ');
});
