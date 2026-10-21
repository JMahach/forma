import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartComposition } from '../src/domain/chart-composition.ts';
import { extractChartData } from '../src/domain/chart-data.ts';
import { chartSubtitle, chartCaption, savedBirthTime } from '../src/views/chart-display.ts';
import type { ChartRecord } from '../shared/chart-types.ts';

// Pass distinct library/transport payloads through the real runtime boundary.
const single = (payload: Partial<ChartRecord>) => createChartComposition(extractChartData(payload), { id: payload.id, primaryLabel: payload.name || '' });
const overlayFixture = (record: Partial<ChartRecord>, payload: Partial<ChartRecord>, options: Parameters<typeof createChartComposition>[1]) => createChartComposition(extractChartData(record), { ...options,
  secondary: extractChartData(payload), id: `${record.id}:preview`, primaryLabel: record.name });

test('personal previews keep the name but show the accepted moment, its birth-zone offset and age', () => {
  const owner = Object.freeze({ id: 'anna', source: 'calculated' as const, name: 'Анна', utc: '1998-08-18T14:00:00Z',
    birthDate: '1998-08-18', birthTime: '18:00', timezone: 'Europe/Moscow' });
  const preview = { id: 'lifetime-preview', source: 'transit' as const, utc: '2026-10-08T09:25:00Z' };
  assert.deepEqual(chartCaption(overlayFixture(owner, preview, { kind: 'transit' as const }), owner), { title: 'Анна · Транзит', subtitle: '8 октября 2026 г. · 12:25 · UTC+3 · 28\u00a0лет' });
  const overlay = overlayFixture(owner, preview, { kind: 'return' as const, event: { id: 'saturn:1:1', body: 'saturn', cycle: 1, utc: preview.utc } });
  assert.equal(chartCaption(overlay, owner).subtitle, '8 октября 2026 г. · 12:25 · UTC+3 · 28\u00a0лет');
  assert.equal(owner.birthTime, '18:00');
});

test('header distinguishes repeated local minutes and never carries the previous persons age into transit', t => {
  localZone(t, 'America/New_York');
  const owner = { id: 'anna', name: 'Анна', source: 'calculated' as const, utc: '1998-08-18T14:00:00Z', timezone: 'America/New_York' };
  const first = { id: 'current-transit', source: 'transit' as const, utc: '2026-11-01T05:30:00Z' };
  assert.equal(chartCaption(overlayFixture(owner, first, { kind: 'transit' as const }), owner).subtitle, '1 ноября 2026 г. · 01:30 · UTC-4 · 28\u00a0лет');
  const second = { ...first, utc: '2026-11-01T06:30:00Z' };
  assert.equal(chartCaption(overlayFixture(owner, second, { kind: 'transit' as const }), owner).subtitle, '1 ноября 2026 г. · 01:30 · UTC-5 · 28\u00a0лет');
  assert.equal(chartCaption(single(second), null).subtitle, '1 ноября 2026 г. · 01:30 · UTC-5');
});

test('closing a preview restores saved birth facts with the same date formatting', () => {
  const owner = { id: 'anna', source: 'calculated' as const, name: 'Анна', utc: '1998-08-18T14:00:00Z',
    birthDate: '1998-08-18', birthTime: '18:00', utcOffset: 'UTC+04:00', timezone: 'Europe/Moscow', birthPlace: 'Мурманск' };
  assert.equal(chartCaption(single(owner), owner).subtitle, '18 августа 1998 г. · 18:00 · UTC+4 · Мурманск');
  assert.equal(chartCaption(single(owner), owner, { showAge: true }).subtitle, '18 августа 1998 г. · 18:00 · UTC+4 · Мурманск · 0\u00a0лет');
  const minute = { ...owner, utc: '1998-08-18T14:01:00Z', birthTime: '18:01' };
  assert.equal(chartCaption(single(minute), owner).subtitle, '18 августа 1998 г. · 18:01 · UTC+4 · Мурманск');
});

test('birth-day captions use todays age of the original person across their local birthday', () => {
  const owner = Object.freeze({ id: 'anna', source: 'calculated' as const, name: 'Анна', utc: '1998-08-18T14:00:00Z',
    birthDate: '1998-08-18', birthTime: '18:00', utcOffset: 'UTC+04:00', timezone: 'Europe/Moscow' });
  for (const [ageUtc, age] of [['2026-08-17T20:59:59Z', 27], ['2026-08-17T21:00:00Z', 28]] as const) {
    for (const minute of [owner, { ...owner, utc: '1998-08-18T14:01:00Z', birthTime: '18:01' }] as const) {
      const caption = chartCaption(single(minute), owner, { showAge: true, ageUtc });
      assert.equal(caption.subtitle, `18 августа 1998 г. · ${minute.birthTime} · UTC+4 · ${age}\u00a0лет`);
    }
  }
  assert.equal(chartCaption(single(owner), owner).subtitle, '18 августа 1998 г. · 18:00 · UTC+4');
});

test('today override cannot replace a return or life-event age or add an age to global transit', () => {
  const owner = { id: 'anna', source: 'calculated' as const, name: 'Анна', utc: '1998-08-18T14:00:00Z', timezone: 'Europe/Moscow' };
  const minute = { id: 'lifetime-preview', source: 'transit' as const, utc: '2050-01-01T00:00:00Z' };
  const options = { ageUtc: '2026-10-08T12:00:00Z' };
  const event = { id: 'saturn:2', body: 'saturn', cycle: 2, utc: minute.utc };
  const overlay = overlayFixture(owner, minute, { kind: 'return' as const, event });
  for (const caption of [chartCaption(overlay, owner, options), chartCaption(overlayFixture(owner, minute, { kind: 'transit' as const }), owner, options)] as const) {
    assert.equal(caption.subtitle, '1 января 2050 г. · 03:00 · UTC+3 · 51\u00a0год');
  }
  assert.equal(chartCaption(single(minute), null, { ...options, useUtc: true }).subtitle, '1 января 2050 г. · 00:00 · UTC');
});

test('stored historical offsets retain their minutes and seconds in the unified header', () => {
  const chart = { id: 'old', name: 'Карта', birthDate: '1890-01-01', birthTime: '02:30:17',
    utc: '1890-01-01T00:00:00Z', utcOffset: 'UTC+02:30:17' };
  assert.equal(chartCaption(single(chart), chart).subtitle, '1 января 1890 г. · 02:30:17 · UTC+2:30:17');
});

test('a return keeps its exact seconds and does not invent an age or timezone from malformed birth data', () => {
  const owner = { id: 'manual', name: 'Карта', utc: '', timezone: 'Not/AZone' };
  const event = { id: 'sun:1:1', body: 'sun', cycle: 1, utc: '2026-10-08T09:25:37Z' };
  const chart = overlayFixture(owner, { source: 'transit' as const, utc: event.utc }, { kind: 'return' as const, event });
  assert.equal(chartCaption(chart, owner).subtitle, '8 октября 2026 г. · 09:25:37 · UTC');
});

function localZone(t: test.TestContext, zone: string|undefined) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
}

test('transit caption follows the selected calculation minute and its local date', t => {
  localZone(t, 'Europe/Moscow');
  const chart = Object.freeze({ id: 'current-transit', source: 'transit' as const,
    utc: '2026-09-26T21:28:00Z', birthDate: '2026-09-26', birthTime: '21:28', timezone: 'UTC' });
  assert.equal(chartSubtitle(single(chart)), '27 сентября 2026 г. · 00:28 · UTC+3');
  assert.equal(chartSubtitle(single({ ...chart, utc: '2026-09-26T20:15:00Z' })), '26 сентября 2026 г. · 23:15 · UTC+3');
});

test('transit caption uses minute precision in the browser timezone', t => {
  localZone(t, 'Asia/Kathmandu');
  assert.equal(chartSubtitle(single({ source: 'transit' as const, utc: '2026-09-26T18:20:59Z' })), '27 сентября 2026 г. · 00:05 · UTC+5:45');
});

test('century preview caption uses the same UTC grid as its slider, including historical offsets', t => {
  localZone(t, 'Europe/Moscow');
  assert.equal(chartSubtitle(single({ source: 'transit' as const, utc: '1900-01-01T00:10:00Z' }), null, { useUtc: true }),
    '1 января 1900 г. · 00:10 · UTC');
});

test('a lifetime can display a shared day minute in UTC without cloning or renaming that chart', t => {
  localZone(t, 'Europe/Moscow');
  const minute = Object.freeze({ id: 'current-transit', source: 'transit' as const, utc: '2026-10-05T12:01:00Z' });
  assert.equal(chartCaption(single(minute), null, { useUtc: true }).subtitle, '5 октября 2026 г. · 12:01 · UTC');
  assert.equal(chartCaption(single(minute), null).subtitle, '5 октября 2026 г. · 15:01 · UTC+3');
});

test('legacy transit placeholders never fabricate a time when UTC is missing or invalid', () => {
  for (const chart of [
    { id: 'current-transit', name: 'Legacy moment' },
    { id: 'current-transit', source: 'manual' as const, birthDate: '2000-01-02', birthTime: '03:04' },
    { id: 'legacy-transit', source: 'transit' as const, birthDate: '2000-01-02', birthTime: '03:04' },
    { source: 'transit' as const, utc: '' },
    { source: 'transit' as const, utc: null },
    { source: 'transit' as const, utc: 'not a date' },
  ] as const) assert.equal(chartSubtitle(single(Object.freeze(chart) as Partial<ChartRecord>)), '');
});

test('saved transit moments work regardless of their id; natal captions keep their recorded birthplace time', t => {
  localZone(t, 'Europe/Moscow');
  assert.equal(chartSubtitle(single({ id: 'old-transit', source: 'transit' as const, utc: '2020-02-29T12:34:56Z' })), '29 февраля 2020 г. · 15:34 · UTC+3');
  assert.equal(chartSubtitle(single({ id: 'current-transit', utc: '2020-02-29T12:34:56Z' })), '29 февраля 2020 г. · 15:34 · UTC+3');
  for (const source of ['manual', 'calculated'] as const) {
    assert.equal(chartSubtitle(single({ id: 'personal', source, utc: '2000-01-01T12:00:00Z',
      birthDate: '2000-01-02', birthTime: '03:04' }), { birthPlace: 'Берлин' }), '2 января 2000 г. · 03:04 · Берлин');
  }
});

test('cached formatting follows live timezone changes, DST and historical second offsets exactly', t => {
  localZone(t, 'UTC');
  for (const zone of ['UTC', 'Europe/Moscow', 'Asia/Kathmandu', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Apia', 'Europe/Amsterdam'] as const) {
    process.env.TZ = zone;
    for (const utc of ['1801-01-01T00:00:00Z', '1890-01-01T23:59:45Z', '1930-06-15T00:00:00Z',
      '2024-03-10T06:59:00Z', '2024-03-10T07:00:00Z', '2024-11-03T05:30:00Z', '2024-11-03T06:30:00Z',
      '2011-12-30T10:00:00Z', '2399-12-31T23:59:00Z'] as const) {
      const date = new Date(utc);
      const expected = [
        new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).format(date),
        new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date),
      ].join(' · ');
      assert.equal(chartSubtitle(single({ source: 'transit' as const, utc })).split(' · ').slice(0, 2).join(' · '), expected, `${zone} ${utc}`);
    }
  }
});

test('120 selected minutes reuse two formatters, including after changing the device timezone', async t => {
  localZone(t, 'UTC');
  const original = Intl.DateTimeFormat;
  let constructors = 0;
  Intl.DateTimeFormat = function(...args: ConstructorParameters<typeof original>) { constructors++; return new original(...args); } as typeof original;
  try {
    const { chartSubtitle: isolated } = await import(new URL('../src/views/chart-display.ts?formatter-count', import.meta.url).href) as typeof import('../src/views/chart-display.ts');
    for (let index = 0; index < 120; index++) {
      if (index === 60) process.env.TZ = 'Asia/Kathmandu';
      const utc = new Date(Date.UTC(2026, 8, 29, 0, index)).toISOString();
      assert.equal(isolated(single({ source: 'transit' as const, utc })), chartSubtitle(single({ source: 'transit' as const, utc })));
    }
    assert.equal(constructors, 2);
  } finally { Intl.DateTimeFormat = original; }
});


test('personal life preview retains its selected chart caption while transit keeps its own identity', () => {
  const owner = { id: 'marat', source: 'calculated' as const, name: 'Марат', birthDate: '1998-08-18', birthTime: '12:00' };
  const preview = { id: 'lifetime-preview', source: 'transit' as const, name: 'Транзит', utc: '2050-01-01T00:00:00Z' };
  assert.deepEqual(chartCaption(overlayFixture(owner, preview, { kind: 'transit' as const }), owner), { title: 'Марат · Транзит', subtitle: '1 января 2050 г. · 00:00 · UTC' });
  assert.equal(chartCaption(single(preview), null).title, 'Транзит');
  const event = overlayFixture(owner, preview, { kind: 'return' as const, event: { id: 'saturn:2:1', body: 'saturn', cycle: 2, utc: preview.utc } });
  assert.equal(chartCaption(event, owner).title, 'Марат · Возврат Сатурна 2');
  assert.match(chartCaption(event, owner).subtitle, /2050/);
});


test('a personal transit overlay names both context and moment while preserving the natal birth facts', () => {
  const natal = { id: 'marat', source: 'calculated' as const, name: 'Марат', birthDate: '1998-08-18', birthTime: '18:00' };
  const moment = { source: 'transit' as const, utc: '2050-01-01T00:10:00Z', personality: [20], design: [] };
  const chart = overlayFixture(natal, moment, { kind: 'transit' as const });
  assert.deepEqual(chartCaption(chart, natal), { title: 'Марат · Транзит', subtitle: '1 января 2050 г. · 00:10 · UTC' });
});


test('accepted local fields belong to calculation data while name and place stay with the record', () => {
  const record = Object.freeze({ id: 'anna', name: 'Анна', source: 'calculated' as const, birthDate: '1998-08-18', birthTime: '18:00', birthPlace: 'Мурманск' });
  const data = Object.freeze({ source: 'calculated' as const, personality: [], design: [], localDate: '1998-08-19', localTime: '00:01', utc: '1998-08-18T20:01:00Z', utcOffset: 'UTC+04:00' });
  const shown = createChartComposition(data, { id: record.id, primaryLabel: record.name });
  assert.deepEqual(chartCaption(shown, record), { title: 'Анна', subtitle: '19 августа 1998 г. · 00:01 · UTC+4 · Мурманск' });
});

test('saved seconds and the second fold survive a minute-only input display', () => {
  const record = Object.freeze({ id: 'fold', name: 'Карта', source: 'calculated' as const, birthDate: '2024-11-03', birthTime: '01:30',
    utc: '2024-11-03T06:30:29Z', utcOffset: 'UTC-05:00', timezone: 'America/New_York', fold: 1 });
  assert.equal(savedBirthTime(record), '01:30:29');
  assert.equal(chartCaption(single(record), record).subtitle, '3 ноября 2024 г. · 01:30:29 · UTC-5');
});
