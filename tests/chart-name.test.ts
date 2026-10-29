import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChartName } from '../src/domain/chart-record.ts';

const chart = (name: string) => Object.freeze({ id: 'saved-name', name, personality: [1], design: [8] });
const cases = [
  ['  марат  ', 'Марат'], ['мАРат', 'МАРат'], ['anna van Gogh', 'Anna van Gogh'],
  ['«ёлка» & "друг"', '«Ёлка» & "друг"'], ['🌿 марат', '🌿 Марат'], ['𐐨name', '𐐀name'],
];
test('saved chart names capitalize only the first Unicode letter while preserving the rest', () => {
  for (const [input, expected] of cases) {
    const original = chart(input), normalized = normalizeChartName(original.name);
    assert.equal(normalized, expected);
    assert.equal(original.name, input, 'normalization must not mutate the provided chart');
    assert.equal(normalizeChartName(normalized), expected, 'normalization is idempotent');
  }
});
test('normalizing a chart name leaves the provided value unchanged', () => {
  const original = chart('  «ёлка» & "друг"  ');
  assert.equal(normalizeChartName(original.name), '«Ёлка» & "друг"');
  assert.equal(original.name, '  «ёлка» & "друг"  ');
});
