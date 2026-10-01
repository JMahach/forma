import test from 'node:test';
import assert from 'node:assert/strict';
import { chartSubtitle } from '../src/views/chart-display.js';

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

test('century preview caption uses the same UTC grid as its slider, including historical offsets', t => {
  localZone(t, 'Europe/Moscow');
  assert.equal(chartSubtitle({ id: 'lifetime-preview', source: 'transit', utc: '1900-01-01T00:10:00Z' }),
    '1 января 1900 г. · 00:10 · UTC');
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

test('cached formatting follows live timezone changes, DST and historical second offsets exactly', t => {
  localZone(t, 'UTC');
  for (const zone of ['UTC', 'Europe/Moscow', 'Asia/Kathmandu', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Apia', 'Europe/Amsterdam']) {
    process.env.TZ = zone;
    for (const utc of ['1801-01-01T00:00:00Z', '1890-01-01T23:59:45Z', '1930-06-15T00:00:00Z',
      '2024-03-10T06:59:00Z', '2024-03-10T07:00:00Z', '2024-11-03T05:30:00Z', '2024-11-03T06:30:00Z',
      '2011-12-30T10:00:00Z', '2399-12-31T23:59:00Z']) {
      const date = new Date(utc);
      const expected = [
        new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date),
        new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date),
      ].join(' · ');
      assert.equal(chartSubtitle({ source: 'transit', utc }), expected, `${zone} ${utc}`);
    }
  }
});

test('120 selected minutes reuse two formatters, including after changing the device timezone', async t => {
  localZone(t, 'UTC');
  const original = Intl.DateTimeFormat;
  let constructors = 0;
  Intl.DateTimeFormat = function(...args) { constructors++; return new original(...args); };
  try {
    const { chartSubtitle: isolated } = await import('../src/views/chart-display.js?formatter-count');
    for (let index = 0; index < 120; index++) {
      if (index === 60) process.env.TZ = 'Asia/Kathmandu';
      const utc = new Date(Date.UTC(2026, 8, 29, 0, index)).toISOString();
      assert.equal(isolated({ source: 'transit', utc }), chartSubtitle({ source: 'transit', utc }));
    }
    assert.equal(constructors, 2);
  } finally { Intl.DateTimeFormat = original; }
});
