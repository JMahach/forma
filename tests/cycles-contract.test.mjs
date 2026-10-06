import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createCycles } from '../server/services/cycles.mjs';
import { createCyclesClient } from '../src/data/cycles-client.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { chartDayFixture, personalChartFixture } from './fixtures/chart-day.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const utc = '2028-07-21T12:36:05.920740Z';
const input = { birthUtc: '2000-01-01T00:00:00Z', body: 'saturn', eventUtc: utc, timezone: 'UTC' };
function result() {
  const event = { id: `saturn:${utc}`, cycleId: 'saturn:1', body: 'saturn', utc,
    age: (Date.parse(utc) - Date.parse(input.birthUtc)) / (365.2425 * 86400000), cycle: 1, pass: 1, direction: 'direct' };
  return { event, chart: { ...chartAtMinute(chartDayFixture({ date: '2028-07-21' }), 0, personalChartFixture()), utc } };
}

test('worker refinement within one second reaches the client and keeps the exact resolved chart UTC', async () => {
  const service = createCycles({ root });
  try {
    const client = createCyclesClient({ request: (_, options) => service.chart(JSON.parse(options.body)) });
    for (const eventUtc of [utc, '2028-07-21T12:36:05.420Z', '2028-07-21T12:36:05Z']) {
      const data = await client.chart({ ...input, eventUtc });
      assert.equal(data.event.utc, utc); assert.equal(data.chart.utc, utc);
    }
    await assert.rejects(client.chart({ ...input, eventUtc: '2028-07-21T12:36:04Z' }), error => error.code === 'invalid_event');
  } finally { await service.close(); }
});

test('server and client reject the same corrupt successful chart before it enters either cache', async () => {
  const changes = [
    ['event id', data => { data.event.id = 'wrong'; }],
    ['cycle id', data => { data.event.cycleId = 'saturn:99'; }],
    ['age inconsistent with UTC', data => { data.event.age += 1; }],
    ['duplicate planet', data => { data.chart.activations.personality = data.chart.activations.personality.map(() => data.chart.activations.personality[0]); }],
    ['unknown planet', data => { data.chart.activations.personality = data.chart.activations.personality.map((entry, i) => i ? entry : { ...entry, planet: 'unknown' }); }],
    ['missing residual', data => { delete data.chart.designArcResidualDegrees; }],
    ['invalid residual', data => { data.chart.designArcResidualDegrees = -0.01; }],
  ];
  for (const [name, change] of changes) {
    const data = result(); change(data);
    const service = createCycles({ root, generate: async () => data });
    try {
      await assert.rejects(service.chart(input), { code: 'cycles_unavailable' }, name);
      const client = createCyclesClient({ request: async () => data });
      await assert.rejects(client.chart(input), /неполные данные/, name);
    } finally { await service.close(); }
  }
});

test('both chart boundaries enforce the same symmetric one-second window down to the microsecond', async () => {
  const service = createCycles({ root, generate: async () => result() });
  try {
    for (const [eventUtc, accepted] of [
      ['2028-07-21T12:36:04.920740Z', true], ['2028-07-21T12:36:06.920740Z', true],
      ['2028-07-21T12:36:04.920741Z', true], ['2028-07-21T12:36:06.920739Z', true],
      ['2028-07-21T12:36:04.920739Z', false], ['2028-07-21T12:36:06.920741Z', false],
      ['2028-07-21T12:36:04.919Z', false], ['2028-07-21T12:36:04.920Z', false],
    ]) {
      const requested = { ...input, eventUtc };
      const client = createCyclesClient({ request: async () => result() });
      if (accepted) {
        assert.equal((await service.chart(requested)).chart.utc, utc);
        assert.equal((await client.chart(requested)).chart.utc, utc);
      } else {
        await assert.rejects(service.chart(requested), { code: 'cycles_unavailable' }, eventUtc);
        await assert.rejects(client.chart(requested), /неполные данные/, eventUtc);
      }
    }
  } finally { await service.close(); }
});

test('a refined exact chart survives device-cache reload under the original request identity', async () => {
  const records = new Map(); let calls = 0;
  const persistentCache = { get: async key => records.get(key), put: async (key, bytes) => records.set(key, bytes) };
  const options = { cacheVersion: 'a'.repeat(64), persistentCache, request: async () => { calls++; return result(); } };
  const requested = { ...input, eventUtc: '2028-07-21T12:36:05Z' };
  const first = await createCyclesClient(options).chart(requested);
  await Promise.resolve();
  const restored = await createCyclesClient(options).chart(requested);
  assert.equal(calls, 1); assert.equal(restored.event.utc, utc); assert.equal(restored.chart.utc, utc);
  assert.deepEqual(restored, first);
});
