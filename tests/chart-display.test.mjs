import test from 'node:test';
import assert from 'node:assert/strict';
import { chartSubtitle } from '../src/charts/chart-display.js';

function localZone(t, zone) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
}

test('transit caption follows the selected calculation minute and its local date', t => {
  localZone(t, 'Europe/Moscow');
  const chart = Object.freeze({ id: 'current-transit', source: 'transit',
    utc: '2026-09-26T21:28:00Z', birthDate: '2026-09-26', birthTime: '21:28', timezone: 'UTC' });
  assert.equal(chartSubtitle(chart), '27 сентября 2026 г. · 00:28');
  assert.equal(chartSubtitle({ ...chart, utc: '2026-09-26T20:15:00Z' }), '26 сентября 2026 г. · 23:15');
});

test('transit caption uses minute precision in the browser timezone', t => {
  localZone(t, 'Asia/Kathmandu');
  assert.equal(chartSubtitle({ source: 'transit', utc: '2026-09-26T18:20:59Z' }), '27 сентября 2026 г. · 00:05');
});

test('legacy transit placeholders never fabricate a time when UTC is missing or invalid', () => {
  for (const chart of [
    { id: 'current-transit', name: 'Legacy moment' },
    { id: 'current-transit', source: 'manual', birthDate: '2000-01-02', birthTime: '03:04' },
    { id: 'legacy-transit', source: 'transit', birthDate: '2000-01-02', birthTime: '03:04' },
    { source: 'transit', utc: '' },
    { source: 'transit', utc: null },
    { source: 'transit', utc: 'not a date' },
  ]) assert.equal(chartSubtitle(Object.freeze(chart)), '');
});

test('saved transit moments work regardless of their id; natal captions keep their recorded birthplace time', t => {
  localZone(t, 'Europe/Moscow');
  assert.equal(chartSubtitle({ id: 'old-transit', source: 'transit', utc: '2020-02-29T12:34:56Z' }), '29 февраля 2020 г. · 15:34');
  assert.equal(chartSubtitle({ id: 'current-transit', utc: '2020-02-29T12:34:56Z' }), '29 февраля 2020 г. · 15:34');
  for (const source of ['manual', 'calculated']) {
    assert.equal(chartSubtitle({ id: 'personal', source, utc: '2000-01-01T12:00:00Z',
      birthDate: '2000-01-02', birthTime: '03:04', birthPlace: 'Берлин' }), '02.01.2000 · 03:04 · Берлин');
  }
});
