import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChartData } from '../src/domain/chart-data.js';
import { createChartSession } from '../src/state/chart-session.js';
import { createNatalDayExplorer } from '../src/state/natal-day.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

const recordFields = ['id', 'name', 'note', 'birthDate', 'birthTime', 'birthPlace', 'cityId', 'city', 'createdAt', 'updatedAt', 'calculation'];
const assertOnlyChart = chart => recordFields.forEach(field => assert.equal(Object.hasOwn(chart, field), false, field));

test('chart data preserves exact calculation fields without borrowing library identity or opaque saved metadata', () => {
  const record = { ...personalChartFixture(), utc: '2026-10-25T01:30:17.123456Z', birthTime: '02:30:17',
    utcOffset: 'UTC+01:00', fold: 1, note: 'Личная заметка', calculation: { legacy: true } };
  const before = JSON.stringify(record), data = extractChartData(record);
  assertOnlyChart(data);
  assert.equal(data.utc, record.utc); assert.equal(data.localTime, '02:30:17');
  assert.equal(data.localDate, record.birthDate); assert.equal(data.utcOffset, record.utcOffset); assert.equal(data.fold, 1);
  assert.equal(data.personality, record.personality, 'read-only extraction does not reproject saved gates');
  assert.equal(JSON.stringify(record), before);
  const manual = extractChartData({ id: 'manual', source: 'manual', name: 'Вручную', personality: [1], design: [] });
  assertOnlyChart(manual); assert.equal(manual.utc, undefined); assert.equal(manual.activations, undefined);
});

test('library metadata and a natal-day preview have independent identities while captions can follow a renamed record', async () => {
  let record = { ...personalChartFixture(), note: 'Сохранено' };
  const day = natalDayFixture();
  let explorer;
  const session = createChartSession({ store: { get: id => id === record.id ? record : null, has: id => id === record.id },
    getNatalDay: () => explorer });
  explorer = createNatalDayExplorer({ dayClient: { getDay: async () => day }, onRender: () => session.publish('natal-day', explorer.current) });
  session.select(record.id); const base = session.baseChart;
  assert.equal(session.record, record); assert.equal(session.current.primary, base); assertOnlyChart(base);
  await explorer.open(); explorer.scrub(3);
  const preview = session.current.primary;
  assertOnlyChart(preview); assert.equal(preview.utc, chartAtMinute(day, 3).utc);
  record = { ...record, name: 'Новое имя', note: 'Новая заметка' };
  session.refreshRecord();
  assert.equal(session.current.primary, preview, 'renaming does not recreate the selected moment');
  assert.equal(session.baseChart, base, 'renaming does not recreate the birth calculation');
  assert.equal(session.current.primaryLabel, record.name); assert.equal(session.record, record);
  explorer.reset(); assert.equal(session.current.primary, base);
});
