import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createComputeQueue } from '../server/runtime/compute-queue.ts';
import { realCycleWorker } from './helpers/real-cycle-worker.ts';
import { deferred } from './helpers/deferred.ts';
import { createCycles } from '../server/services/cycles.ts';
import { createCyclesClient } from '../src/data/cycles-client.ts';
import { chartAtMinute } from '../src/domain/natal-day.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';
import { createChartComposition } from '../src/domain/chart-composition.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const utc = '2028-07-21T12:36:05.920740Z';
const input = { birthUtc: '2000-01-01T00:00:00Z', body: 'saturn', eventUtc: utc, timezone: 'UTC' };
function result() {
  return { chart: { ...chartAtMinute(natalDayFixture({ date: '2028-07-21' }), 0, personalChartFixture()), utc } };
}

test('worker refinement within one second reaches the client and keeps the exact resolved chart UTC', async t => {
  const real = await realCycleWorker(t);
  const service = createCycles({ root, generate: real.generate });
  try {
    const client = createCyclesClient({ request: (_, options) => service.chart(JSON.parse(options.body)) });
    for (const eventUtc of [utc, '2028-07-21T12:36:05.420Z', '2028-07-21T12:36:05Z'] as const) {
      const data = await client.chart({ ...input, eventUtc });
      assert.equal(data.event, undefined); assert.ok(Math.abs(Date.parse(data.chart.utc) - Date.parse(utc)) < 2);
    }
    await assert.rejects(client.chart({ ...input, eventUtc: '2028-07-21T12:36:04Z' }), error => error.code === 'invalid_event');
  } finally { await service.close(); }
});

test('server and client reject the same corrupt successful chart before publication', async () => {
  const changes = [
    ['invalid UTC', (data: { chart: { utc: string; }; }) => { data.chart.utc = '2028-02-30T12:00:00Z'; }],
    ['wrong timezone', (data: { chart: { timezone: string; }; }) => { data.chart.timezone = 'Europe/Moscow'; }],
    ['different event', (data: { chart: { utc: string; }; }) => { data.chart.utc = '2028-07-21T12:36:09Z'; }],
    ['duplicate planet', data => { data.chart.activations.personality = data.chart.activations.personality.map(() => data.chart.activations.personality[0]); }],
    ['unknown planet', data => { data.chart.activations.personality = data.chart.activations.personality.map((entry, i) => i ? entry : { ...entry, planet: 'unknown' }); }],
    ['missing residual', data => { delete data.chart.designArcResidualDegrees; }],
    ['invalid residual', (data: { chart: { designArcResidualDegrees: number; }; }) => { data.chart.designArcResidualDegrees = -0.01; }],
    ...['personality', 'design'].flatMap(side => [
      [`missing ${side} gates`, data => { delete data.chart[side]; }],
      [`empty ${side} gates`, data => { data.chart[side] = []; }],
      [`sparse ${side} gates`, data => { data.chart[side] = Array(data.chart[side].length); }],
      [`missing ${side} activation slot`, data => {
        const entries = [...data.chart.activations[side]];
        delete entries[0];
        data.chart.activations[side] = entries;
        data.chart[side] = [...new Set(Array.from(data.chart.activations[side], entry => entry?.gate))];
      }],
      [`foreign ${side} gate`, data => {
        const foreign = Array.from({ length: 64 }, (_, index) => index + 1).find(gate => !data.chart[side].includes(gate));
        data.chart[side] = [foreign, ...data.chart[side].slice(1)];
      }],
      [`duplicate ${side} gate`, data => { data.chart[side] = [...data.chart[side], data.chart[side][0]]; }],
    ]),
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

test('a stored return with contradictory gate sets is replaced before building the displayed composition', async () => {
  const corrupt = result(); corrupt.chart.personality = []; corrupt.chart.design = [];
  const fresh = result(); let calls = 0;
  const client = createCyclesClient({ cacheVersion: 'a'.repeat(64),
    returnStorage: { getChart: async () => corrupt, removeChart: async () => {}, putChart: async () => {} },
    request: async () => { calls++; return fresh; } });
  const received = await client.chart(input);
  const shown = createChartComposition(received.chart);
  for (const side of ['personality', 'design'] as const) {
    assert.deepEqual(shown.topology[side], [...new Set(received.chart.activations[side].map(entry => entry.gate))].sort((a, b) => a - b));
  }
  assert.equal(calls, 1, 'a contradictory stored result cannot substitute for a complete calculation');
});

test('both chart boundaries enforce the same symmetric one-second window down to the microsecond', async () => {
  const service = createCycles({ root, generate: async () => result() });
  try {
    for (const [eventUtc, accepted] of [
      ['2028-07-21T12:36:04.920740Z', true], ['2028-07-21T12:36:06.920740Z', true],
      ['2028-07-21T12:36:04.920741Z', true], ['2028-07-21T12:36:06.920739Z', true],
      ['2028-07-21T12:36:04.920739Z', false], ['2028-07-21T12:36:06.920741Z', false],
      ['2028-07-21T12:36:04.919Z', false], ['2028-07-21T12:36:04.920Z', false],
    ] as const) {
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

test('completed charts are computed again while simultaneous consumers share pending work', async t => {
  const release = deferred(); let calls = 0;
  const service = createCycles({ generate: async () => {
    calls++; await release.promise; return result();
  } });
  t.after(async () => { release.resolve!(); await service.close(); });
  const first = service.chart(input), shared = service.chart(input);
  release.resolve!();
  const [one, two] = await Promise.all([first, shared]);
  assert.equal(calls, 1); assert.equal(two, one);
  const repeated = await service.chart(input);
  assert.equal(calls, 2, 'a completed chart must not bypass a later calculation');
  assert.notEqual(repeated, one); assert.deepEqual(repeated, one);
  assert.equal(service.active, 0); assert.equal(service.queued, 0);
});

test('completed charts use admission while pending duplicates share a slot and selected charts keep priority', async () => {
  const queue = createComputeQueue({ concurrency: 1, maxQueued: 2 }), started: unknown[] = [];
  const service = createCycles({ computeQueue: queue, generate: async request => {
    started.push(request.action);
    return request.action === 'chart' ? { chart: { ...result().chart, timezone: request.timezone } }
      : { events: [], range: { fromAge: request.fromAge, toAge: request.toAge } };
  } });
  await service.chart(input);
  const release = deferred();
  const occupied = queue.run(() => release.promise);
  const dates = service.events({ birthUtc: input.birthUtc, body: input.body });
  const selectedInput = { ...input, timezone: 'Europe/Moscow' };
  const selected = service.chart(selectedInput), shared = service.chart(selectedInput);
  try {
    assert.equal(queue.active, 1); assert.equal(queue.queued, 2);
    assert.equal(shared, selected, 'duplicate pending work joins even when admission is full');
    await assert.rejects(service.chart(input), { code: 'cycles_busy' }, 'an earlier answer cannot bypass full admission');
    assert.deepEqual(started, ['chart']);
  } finally {
    release.resolve!(); await Promise.all([occupied, dates, selected, shared]);
    await service.close();
  }
  assert.deepEqual(started, ['chart', 'chart', 'events']);
  assert.equal(await queue.run(() => 'other service still works'), 'other service still works');
  queue.close();
});
