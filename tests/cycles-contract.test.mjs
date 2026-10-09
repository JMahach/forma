import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createComputeQueue } from '../server/runtime/compute-queue.mjs';
import { createCycles } from '../server/services/cycles.mjs';
import { createCyclesClient } from '../src/data/cycles-client.js';
import { chartAtMinute } from '../src/domain/natal-day.js';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const utc = '2028-07-21T12:36:05.920740Z';
const input = { birthUtc: '2000-01-01T00:00:00Z', body: 'saturn', eventUtc: utc, timezone: 'UTC' };
function result() {
  return { chart: { ...chartAtMinute(natalDayFixture({ date: '2028-07-21' }), 0, personalChartFixture()), utc } };
}

test('worker refinement within one second reaches the client and keeps the exact resolved chart UTC', async () => {
  const service = createCycles({ root });
  try {
    const client = createCyclesClient({ request: (_, options) => service.chart(JSON.parse(options.body)) });
    for (const eventUtc of [utc, '2028-07-21T12:36:05.420Z', '2028-07-21T12:36:05Z']) {
      const data = await client.chart({ ...input, eventUtc });
      assert.equal(data.event, undefined); assert.ok(Math.abs(Date.parse(data.chart.utc) - Date.parse(utc)) < 2);
    }
    await assert.rejects(client.chart({ ...input, eventUtc: '2028-07-21T12:36:04Z' }), error => error.code === 'invalid_event');
  } finally { await service.close(); }
});

test('server and client reject the same corrupt successful chart before it enters either cache', async () => {
  const changes = [
    ['invalid UTC', data => { data.chart.utc = '2028-02-30T12:00:00Z'; }],
    ['wrong timezone', data => { data.chart.timezone = 'Europe/Moscow'; }],
    ['different event', data => { data.chart.utc = '2028-07-21T12:36:09Z'; }],
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

test('opened exact charts reuse shared memory then device storage after reload', async () => {
  let calls = 0, reads = 0, writes = 0; const records = new Map();
  const returnStorage = { getChart: async key => { reads++; return records.get(key); }, putChart: async (key, data) => { writes++; records.set(key, data); } };
  const options = { cacheVersion: 'a'.repeat(64), returnStorage, request: async () => { calls++; return result(); } };
  const requested = { ...input, eventUtc: '2028-07-21T12:36:05Z' }, client = createCyclesClient(options);
  const first = await client.chart(requested);
  assert.equal(await client.chart(requested), first); assert.equal(calls, 1);
  const reopened = await createCyclesClient(options).chart(requested);
  assert.equal(calls, 1); assert.deepEqual(reopened, first);
  assert.equal(reads, 2); assert.equal(writes, 1);
});

test('ready charts bypass saturated work and an uncached selected chart precedes waiting date searches', async () => {
  const queue = createComputeQueue({ concurrency: 1, maxQueued: 2 }), started = [];
  const service = createCycles({ computeQueue: queue, generate: async request => {
    started.push(request.action);
    return request.action === 'chart' ? { chart: { ...result().chart, timezone: request.timezone } }
      : { events: [], range: { fromAge: request.fromAge, toAge: request.toAge } };
  } });
  const cached = await service.chart(input);
  let release;
  const occupied = queue.run(() => new Promise(resolve => { release = resolve; }));
  const dates = service.events({ birthUtc: input.birthUtc, body: input.body });
  const selected = service.chart({ ...input, timezone: 'Europe/Moscow' });
  assert.equal(queue.active, 1); assert.equal(queue.queued, 2);
  assert.equal(await service.chart(input), cached, 'ready memory never enters the compute queue');
  assert.deepEqual(started, ['chart']);
  release(); await Promise.all([occupied, dates, selected]);
  assert.deepEqual(started, ['chart', 'chart', 'events']);
  await service.close();
  assert.equal(await queue.run(() => 'other service still works'), 'other service still works');
  queue.close();
});
