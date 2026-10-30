import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createNatalDayStorage, type NatalDayStorage } from '../src/data/natal-day-storage.ts';
import { createCalculationCache } from '../src/data/calculation-cache.ts';
import { createMemoryCache } from '../src/data/memory-cache.ts';
import { createNatalDayClient } from '../src/data/natal-day-client.ts';
import { NATAL_DAY_VERSION } from '../shared/day-packets/natal-format.ts';
import { encodeNatalDay } from '../server/packets/encode.ts';
import { natalDayFixture, personalChartFixture } from './fixtures/natal-day.ts';
import { deferred } from './helpers/deferred.ts';

const chart = personalChartFixture();
const key = `natal-day:${NATAL_DAY_VERSION}:${chart.birthDate}:${chart.cityId}`;
const day = natalDayFixture();
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function readyClient(touch: NatalDayStorage['touch'], memory = createMemoryCache()) {
  memory.put(key, day);
  const persistentCache: NatalDayStorage = {
    get: async () => { throw new Error('ready day must not read storage'); },
    put: async () => { throw new Error('ready day must not rewrite its payload'); },
    remove: async () => { throw new Error('ready day must not remove its payload'); },
    close() {}, touch,
  };
  return createNatalDayClient({ memory, persistentCache,
    fetch() { throw new Error('ready day must not fetch'); } });
}

test('ready natal reads share pending LRU work per key and later use touches again', async t => {
  const owner = createCalculationCache({ indexedDB: new IDBFactory(), legacySources: [] });
  const persistent = createNatalDayStorage({ cache: owner });
  t.after(() => { persistent.close(); owner.close(); });
  const bytes = encodeNatalDay(day).buffer;
  const otherChart = { ...chart, cityId: 'other-city' };
  const otherKey = `natal-day:${NATAL_DAY_VERSION}:${chart.birthDate}:other-city`;
  await persistent.put(key, bytes); await persistent.put(otherKey, bytes);
  const memory = createMemoryCache(); memory.put(key, day); memory.put(otherKey, day);
  const held = deferred<void>(), calls: string[] = [], pending: Promise<boolean | null>[] = [];
  t.after(() => held.resolve());
  const original = persistent.touch.bind(persistent);
  const client = createNatalDayClient({ memory,
    persistentCache: { ...persistent, touch(value) {
      calls.push(value);
      const work = original(value).then(async result => { await held.promise; return result; });
      pending.push(work); return work;
    } }, fetch() { throw new Error('ready day must not fetch'); } });
  for (let i = 0; i < 100; i++) assert.equal(client.peekDay(chart), day);
  assert.equal(await client.readDay(chart), day);
  assert.equal(await client.getDay(chart), day);
  await tick();
  assert.deepEqual(calls, [key], 'one unfinished storage touch serves all ready-day reads');
  assert.equal(client.peekDay(otherChart), day); await tick();
  assert.deepEqual(calls, [key, otherKey], 'another day has independent storage work');
  held.resolve(); await Promise.all(pending); await tick();
  assert.equal(client.peekDay(chart), day); await tick();
  assert.deepEqual(calls, [key, otherKey, key], 'completion permits the next access-time update');
  await Promise.all(pending);
  assert.deepEqual(await persistent.get(key), bytes, 'touches preserve the full day packet');
});

for (const failure of ['reject', 'throw'] as const) test(`a ${failure}ing natal touch leaves ready data usable and permits the next touch`, async () => {
  const failed = deferred<boolean | null>(); let calls = 0;
  const client = readyClient(() => {
    if (++calls === 1) {
      if (failure === 'throw') throw new Error('storage unavailable');
      return failed.promise;
    }
    return Promise.resolve(true);
  });
  assert.equal(client.peekDay(chart), day); await tick();
  failed.reject(new Error('storage unavailable'));
  // In the synchronous case no code consumes this deferred promise.
  if (failure === 'throw') await failed.promise.catch(() => {});
  await tick();
  assert.equal(await client.getDay(chart), day); await tick();
  assert.equal(calls, 2, 'a failed optional touch must not permanently suppress later accesses');
});

test('a late touch from a replaced natal client cannot block or release the new client work', async () => {
  const memory = createMemoryCache(), oldWork = deferred<boolean | null>(), freshWork = deferred<boolean | null>();
  let oldCalls = 0, freshCalls = 0;
  const old = readyClient(() => { oldCalls++; return oldWork.promise; }, memory);
  assert.equal(old.peekDay(chart), day); await tick();
  memory.clearExcept('transit-day:');
  const fresh = readyClient(() => { freshCalls++; return freshCalls === 1 ? freshWork.promise : Promise.resolve(true); }, memory);
  assert.equal(fresh.peekDay(chart), day); await tick();
  assert.equal(oldCalls, 1); assert.equal(freshCalls, 1, 'old unfinished work cannot suppress the replacement');
  oldWork.resolve(true); await tick();
  assert.equal(fresh.peekDay(chart), day); await tick();
  assert.equal(freshCalls, 1, 'old completion cannot release the replacement touch');
  freshWork.resolve(true); await tick();
  assert.equal(fresh.peekDay(chart), day); await tick();
  assert.equal(freshCalls, 2);
});
