import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartSession } from '../src/state/chart-session.js';
import { createChartStore } from '../src/data/chart-store.js';
import { createChartDayExplorer } from '../src/state/natal-day.js';
import { createLiveTransit } from '../src/state/live-transit.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { chartDayFixture, personalChartFixture } from './fixtures/chart-day.mjs';

function harness(charts) {
  const writes = [], changes = [];
  charts = charts.map(chart => chartAtMinute(chartDayFixture(), 754, chart));
  const store = createChartStore({ getStorage: () => ({ getItem: () => JSON.stringify(charts), setItem: (...value) => writes.push(value) }) });
  let natal, transit;
  const session = createChartSession({ store, getNatalDay: () => natal, getTransit: () => transit,
    onChange: () => changes.push({ id: session.selectedId, chart: session.current }) });
  natal = createChartDayExplorer({ dayClient: { getDay: async () => chartDayFixture() }, onRender: session.refresh });
  return { store, session, natal, changes, writes, set transit(value) { transit = value; } };
}

test('session is the only selected-ID owner and navigation emits only the final chart', async () => {
  const h = harness([personalChartFixture(), personalChartFixture({ id: 'second' })]);
  assert.equal('selectedId' in h.store, false); assert.equal('current' in h.store, false);
  const saved = h.store.charts, before = JSON.stringify(saved);
  h.session.select(saved[0].id); await h.natal.open(); h.natal.scrub(1);
  h.changes.length = 0;
  h.session.select('second');
  assert.equal(h.changes.length, 1);
  assert.equal(h.changes[0].chart, saved[1]);
  assert.equal(h.natal.state.opened, false);
  assert.equal(h.session.original, saved[1]); assert.equal(h.session.current, saved[1]);
  assert.equal(h.store.charts, saved); assert.equal(JSON.stringify(saved), before); assert.deepEqual(h.writes, []);
});

test('reselecting a saved chart closes its day preview in one update', async () => {
  const h = harness([personalChartFixture()]);
  h.session.select(h.store.charts[0].id); await h.natal.open(); h.natal.scrub(100);
  h.changes.length = 0; h.session.select(h.session.selectedId);
  assert.equal(h.changes.length, 1); assert.equal(h.changes[0].chart, h.session.original);
});

test('every intermediate natal minute is published synchronously without waiting for release or a frame', async () => {
  const h = harness([personalChartFixture()]);
  h.session.select(h.store.charts[0].id); await h.natal.open(); h.changes.length = 0;
  const minutes = Array.from({ length: 100 }, (_, index) => index + 200);
  for (const minute of minutes) {
    const before = h.changes.length; h.natal.scrub(minute);
    assert.equal(h.changes.length, before + 1);
    assert.equal(Date.parse(h.changes.at(-1).chart.utc), Date.parse('2026-09-24T00:00:00Z') + minute * 60000);
  }
  assert.equal(h.changes.length, minutes.length); assert.deepEqual(h.writes, []);
});

test('every transit input publishes exact positions while late source updates never change navigation', async () => {
  const h = harness([personalChartFixture()]);
  const columns = Array.from({ length: 11 }, (_, column) => Float64Array.from({ length: 1440 }, (_, minute) => column * 20 + minute / 10000));
  const transit = createLiveTransit({ now: () => Date.parse('2026-09-24T12:00:00Z'), timeZone: () => 'UTC',
    dayClient: { getDay: async date => ({ date, startUtc: `${date}T00:00:00Z`, samples: 1440, stepSeconds: 60, columns }) },
    onRender: h.session.refresh });
  h.transit = transit; await transit.refresh(true); h.changes.length = 0;
  for (const minute of [0, 1, 2, 3, 4, 5, 1438, 1439]) {
    const before = h.changes.length; transit.scrub(minute); assert.equal(h.changes.length, before + 1);
    assert.equal(h.changes.at(-1).chart.activations.personality[0].longitude, columns[0][minute]);
  }
  h.session.select(h.store.charts[0].id); const count = h.changes.length;
  await transit.refresh(true); assert.equal(h.changes.length, count);
  assert.equal(h.session.current, h.store.charts[0]); assert.deepEqual(h.writes, []);
});
