import test from 'node:test';
import assert from 'node:assert/strict';
import { returnsVisibleWindow } from '../src/domain/returns-window.js';

const span = { minUtc: Date.parse('1998-08-18T15:00:00Z'), maxUtc: Date.parse('2098-08-18T23:59:59Z') };
test('a returns year uses the natal local calendar on both sides of the date line', () => {
  assert.deepEqual(returnsVisibleWindow({ timezone: 'Pacific/Kiritimati' }, 2026, span),
    { minUtc: Date.parse('2025-12-31T10:00:00Z'), maxUtc: Date.parse('2026-12-31T09:59:59.999Z') });
  assert.deepEqual(returnsVisibleWindow({ timezone: 'Pacific/Honolulu' }, 2026, span),
    { minUtc: Date.parse('2026-01-01T10:00:00Z'), maxUtc: Date.parse('2027-01-01T09:59:59.999Z') });
});
test('visible years clip to the personal range and an absent year preserves the full span', () => {
  assert.deepEqual(returnsVisibleWindow({ timezone: 'UTC' }, null, span), span);
  assert.deepEqual(returnsVisibleWindow({ timezone: 'UTC' }, 1998, span),
    { minUtc: span.minUtc, maxUtc: Date.parse('1998-12-31T23:59:59.999Z') });
  assert.deepEqual(returnsVisibleWindow({ timezone: 'UTC' }, 2098, span),
    { minUtc: Date.parse('2098-01-01T00:00:00Z'), maxUtc: span.maxUtc });
});

test('an unknown saved timezone uses the same UTC calendar as the returns controller', () => {
  const expected = { minUtc: Date.parse('2026-01-01T00:00:00Z'), maxUtc: Date.parse('2026-12-31T23:59:59.999Z') };
  assert.deepEqual(returnsVisibleWindow({ timezone: 'Obsolete/Zone' }, 2026, span), expected);
  assert.deepEqual(returnsVisibleWindow({ timezone: 'UTC' }, 2026, span), expected);
});
test('a historical local year keeps second-based timezone offsets', () => {
  const bounds = { minUtc: Date.parse('1801-01-01T00:00:00Z'), maxUtc: Date.parse('2000-01-01T00:00:00Z') };
  assert.equal(returnsVisibleWindow({ timezone: 'Europe/Moscow' }, 1900, bounds).minUtc, Date.parse('1899-12-31T21:29:43Z'));
});
