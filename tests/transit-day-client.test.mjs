import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitDayClient } from '../src/data/transit-day-client.js';
import { encodeTransitDay } from '../server/packets/encode.mjs';
import { TRANSIT_DAY_VERSION } from '../shared/day-packets/transit-format.js';
import { createLiveTransit } from '../src/state/live-transit.js';
import { createLifetimeClient } from '../src/data/lifetime-client.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';

const day = date => ({ date, startUtc: `${date}T00:00:00Z`, stepSeconds: 60, samples: 1440,
  engine: 'Swiss Ephemeris', ephemeris: 'test', timezoneDatabase: 'test', nodeModel: 'true', zodiac: 'tropical-geocentric-apparent',
  columns: Array.from({ length: 24 }, (_, col) => Float64Array.from({ length: 1440 }, (_, index) => col < 22
    ? (col * 30 + index / 10000) % 360 : col === 22 ? Date.parse(`${date}T00:00:00Z`) / 1000 - 88 * 86400 + index * 61 : index % 100 * 1e-12)),
});
const response = date => ({ ok: true, arrayBuffer: async () => encodeTransitDay(day(date)).buffer });

test('day client coalesces concurrent requests and reuses the decoded immutable packet without more network', async () => {
  const requests = [];
  let resolve;
  const client = createTransitDayClient({ fetch: (url, options) => {
    requests.push({ url, options });
    return new Promise(done => { resolve = done; });
  } });
  const first = client.getDay('2026-09-24'), second = client.getDay('2026-09-24');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/api/transit/day?date=2026-09-24&v=${TRANSIT_DAY_VERSION}`);
  assert.equal(requests[0].options.method, undefined, 'packet loading is a GET');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  resolve(response('2026-09-24'));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(a.columns[0][100], 0.01);
  assert.equal(a.columns.length, 24);
  assert.deepEqual(a.columns.map(column => [...column]), day('2026-09-24').columns.map(column => [...column]), 'all red angles, exact Design seconds and residuals survive the network decoder');
  assert.equal(await client.getDay('2026-09-24'), a);
  assert.equal(requests.length, 1);
});

test('failed requests are retryable and JSON API errors reach the day controls', async () => {
  let requests = 0;
  const client = createTransitDayClient({ fetch: async () => {
    requests++;
    return requests === 1 ? { ok: false, json: async () => ({ message: 'Подготовка дня недоступна' }) } : response('2026-09-24');
  } });
  await assert.rejects(client.getDay('2026-09-24'), /Подготовка дня недоступна/);
  assert.equal((await client.getDay('2026-09-24')).date, '2026-09-24');
  assert.equal(requests, 2);
});

test('day client rejects mismatched packets and bounds its decoded-day memory', async () => {
  let requests = 0;
  const client = createTransitDayClient({ capacity: 2, fetch: async url => {
    requests++;
    return response(new URL(url, 'https://example.test').searchParams.get('date'));
  } });
  await client.getDay('2026-09-22');
  await client.getDay('2026-09-23');
  await client.getDay('2026-09-24');
  await client.getDay('2026-09-23');
  assert.equal(requests, 3);
  await client.getDay('2026-09-22');
  assert.equal(requests, 4, 'oldest unused packet is released');
  const mismatch = createTransitDayClient({ fetch: async () => response('2026-09-23') });
  await assert.rejects(mismatch.getDay('2026-09-24'), /другого дня/);
});

test('day requests have a deadline instead of accumulating indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const client = createTransitDayClient({ timeoutMs: 100, fetch: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  } });
  const pending = assert.rejects(client.getDay('2026-09-24'), /не успел загрузиться/);
  t.mock.timers.tick(100);
  await pending;
  assert.equal(signal.aborted, true);
});

test('the startup request shares the pending request and decoded cache with the live view', async () => {
  for (const completeBeforeAttach of [false, true]) {
    let finish, requests = 0;
    const client = createTransitDayClient({ initialDate: '2026-09-24', fetch: () => {
      requests++;
      return new Promise(resolve => { finish = () => resolve(response('2026-09-24')); });
    } });
    assert.equal(requests, 1, 'construction starts the UTC packet before UI attachment');
    if (completeBeforeAttach) { finish(); await new Promise(resolve => setImmediate(resolve)); }
    const first = client.getDay('2026-09-24'), concurrent = client.getDay('2026-09-24');
    if (!completeBeforeAttach) finish();
    const [a, b] = await Promise.all([first, concurrent]);
    assert.equal(a, b);
    assert.equal(await client.getDay('2026-09-24'), a);
    assert.equal(requests, 1, 'handoff uses one network request in both timing orders');
  }
});

test('an early failure reaches the existing live retry policy without an automatic duplicate request', async () => {
  const requests = [];
  const client = createTransitDayClient({ initialDate: '2026-09-24', fetch: async url => {
    const date = new URL(url, 'https://example.test').searchParams.get('date');
    requests.push(date);
    return requests.length === 1 ? { ok: false, json: async () => ({ message: 'День ещё не готов' }) } : response(date);
  } });
  // The rejection must remain handled even if loading the UI takes another task.
  await new Promise(resolve => setImmediate(resolve));
  const live = createLiveTransit({ dayClient: client,
    now: () => Date.parse('2026-09-24T12:00:20Z'), timeZone: () => 'Europe/Moscow' });
  await live.refresh(true);
  assert.equal(live.state.status, 'error');
  assert.equal(live.state.error, 'День ещё не готов');
  assert.deepEqual(requests, ['2026-09-24', '2026-09-23'], 'current UTC request precedes the local-day edge');
  await live.refresh();
  assert.equal(requests.length, 2, 'automatic retry observes the original backoff');
  await live.refresh(true);
  assert.equal(live.state.status, 'ready');
  assert.deepEqual(requests, ['2026-09-24', '2026-09-23', '2026-09-24'], 'explicit retry reuses the successful edge');
});

test('another UTC date cannot consume the one-shot startup failure', async () => {
  const requests = [];
  const client = createTransitDayClient({ initialDate: '2026-09-24', fetch: async url => {
    const date = new URL(url, 'https://example.test').searchParams.get('date');
    requests.push(date);
    if (requests.length === 1) throw new Error('Offline during startup');
    return response(date);
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await client.getDay('2026-09-25')).date, '2026-09-25');
  await assert.rejects(client.getDay('2026-09-24'), /Не удалось загрузить транзит дня/);
  assert.deepEqual(requests, ['2026-09-24', '2026-09-25'], 'the first matching consumer receives the initial failure');
  assert.equal((await client.getDay('2026-09-24')).date, '2026-09-24');
  assert.deepEqual(requests, ['2026-09-24', '2026-09-25', '2026-09-24']);
});

test('the active local day stays visible to shared lookup while unrelated days rotate through LRU', async () => {
  let requests = 0;
  const client = createTransitDayClient({ capacity: 2, fetch: async url => {
    requests++;
    return response(new URL(url, 'https://example.test').searchParams.get('date'));
  } });
  const live = createLiveTransit({ dayClient: client, now: () => Date.parse('2026-09-24T12:00:00Z'), timeZone: () => 'Europe/Moscow' });
  await live.refresh();
  const active = client.peekDay('2026-09-24'), edge = client.peekDay('2026-09-23');
  for (const date of ['2026-09-20', '2026-09-19', '2026-09-18']) await client.getDay(date);
  assert.equal(client.peekDay('2026-09-24'), active);
  assert.equal(client.peekDay('2026-09-23'), edge);
  assert.equal(await client.getDay('2026-09-24'), active);
  assert.equal(requests, 5, 'shared lookup reuses the same active object without a request');
  live.setWanted(false);
  for (const date of ['2026-09-17', '2026-09-16']) await client.getDay(date);
  assert.equal(client.peekDay('2026-09-24'), active, 'Lifetime can use the packets still owned by the last live day');
  const lifetime = createLifetimeClient({ dayClient: client, fetch: async url => {
    assert.equal(url, '/api/lifetime/meta', 'a minute or lifetime point already held by Day needs no transport');
    return { ok: true, json: async () => ({ startUtc: '2026-09-01T00:00:00Z', endExclusiveUtc: '2026-10-01T00:00:00Z',
      stepSeconds: 600, samples: 30 * 144, planets: LIFETIME_PLANETS, engine: 'Swiss Ephemeris' }) };
  } });
  await lifetime.getMeta();
  assert.ok(lifetime.peekMinute(Date.parse('2026-09-24T12:31:00Z')));
  assert.equal((await lifetime.getPoint(23 * 144 + 72)).utc, '2026-09-24T12:00:00Z');
  live.setWanted(true);
  assert.equal(client.peekDay('2026-09-24'), active, 'resuming exposes the already-held packet without fetching it again');
  live.stop();
  for (const date of ['2026-09-15', '2026-09-14']) await client.getDay(date);
  assert.equal(client.peekDay('2026-09-24'), null, 'stop releases retention');
  await live.refresh();
  const refreshed = client.peekDay('2026-09-24');
  for (const date of ['2026-09-13', '2026-09-12', '2026-09-11']) await client.getDay(date);
  assert.equal(client.peekDay('2026-09-24'), refreshed, 'a fresh refresh owns packets again even without start');
  live.stop();
});

test('day rollover releases every earlier pin, and late stopped loads cannot pin again', async () => {
  let timestamp = Date.parse('2026-09-01T12:00:00Z');
  const client = createTransitDayClient({ capacity: 2, fetch: async url => response(new URL(url, 'https://example.test').searchParams.get('date')) });
  const live = createLiveTransit({ dayClient: client, now: () => timestamp, timeZone: () => 'UTC' });
  for (let offset = 0; offset < 20; offset++) { await live.refresh(); timestamp += 86400000; }
  for (let date = 1; date < 18; date++) assert.equal(client.peekDay(`2026-09-${String(date).padStart(2, '0')}`), null);
  live.stop();
  let finish;
  const delayedClient = createTransitDayClient({ capacity: 1, fetch: url => {
    const date = new URL(url, 'https://example.test').searchParams.get('date');
    return date === '2026-09-24' ? new Promise(resolve => { finish = () => resolve(response(date)); }) : Promise.resolve(response(date));
  } });
  const delayed = createLiveTransit({ dayClient: delayedClient, now: () => Date.parse('2026-09-24T12:00:00Z'), timeZone: () => 'UTC' });
  const loading = delayed.refresh(); delayed.stop(); finish(); await loading;
  assert.equal(delayed.state.status, 'idle', 'completion after stop has no right to change loading or error state');
  assert.equal(delayed.state.loading, false);
  await delayedClient.getDay('2026-09-25');
  assert.equal(delayedClient.peekDay('2026-09-24'), null);
});

for (const [zone, index, selectedUtc] of [
  ['Europe/Moscow', 12, '2026-09-23T21:12:00Z'],
  ['America/New_York', 1439, '2026-09-25T03:59:00Z'],
]) test(`a restored pause in ${zone} consumes the early failure once and retains its retry backoff`, async t => {
  const requests = [], initialDate = '2026-09-24';
  let timestamp = Date.parse('2026-09-24T12:00:20Z'), fail = true;
  const client = createTransitDayClient({ initialDate, fetch: async url => {
    const date = new URL(url, 'https://example.test').searchParams.get('date');
    requests.push(date);
    return date === initialDate && fail ? { ok: false, json: async () => ({ message: 'Initial packet unavailable' }) } : response(date);
  } });
  await new Promise(resolve => setImmediate(resolve));
  let renders = 0;
  const live = createLiveTransit({ dayClient: client, now: () => timestamp, timeZone: () => zone, onRender: () => renders++ });
  t.after(() => live.stop());
  await live.start({ live: false, date: initialDate, timeZone: zone, index });
  assert.deepEqual(requests, [initialDate, selectedUtc.slice(0, 10)], 'loading the selected adjacent UTC packet must not retry the initial failure');
  assert.equal(live.state.status, 'error');
  assert.equal(live.state.error, 'Initial packet unavailable');
  assert.equal(live.current.utc, selectedUtc, 'an available selected minute remains usable while the full range has failed');
  const accepted = live.current;
  await live.refresh(); timestamp += 29_999; await live.refresh();
  assert.equal(requests.length, 2, 'the first 30 seconds perform no retry');
  timestamp++; await live.refresh();
  assert.deepEqual(requests, [initialDate, selectedUtc.slice(0, 10), initialDate]);
  timestamp += 59_999; await live.refresh();
  assert.equal(requests.length, 3, 'a second failure doubles the automatic backoff');
  fail = false;
  await live.retry();
  assert.equal(requests.length, 4, 'explicit retry bypasses backoff and fetches only the missing packet');
  assert.equal(live.state.status, 'ready');
  assert.equal(live.state.live, false); assert.equal(live.state.index, index);
  assert.equal(live.current, accepted); assert.equal(renders, 1, 'range recovery does not recreate or redraw the selected minute');
  assert.equal(client.peekDay(selectedUtc.slice(0, 10)).date, selectedUtc.slice(0, 10));
});

test('a different UTC packet does not disturb a pending startup handoff or its successful cache', async () => {
  const requests = []; let finish;
  const client = createTransitDayClient({ initialDate: '2026-09-24', fetch: url => {
    const date = new URL(url, 'https://example.test').searchParams.get('date'); requests.push(date);
    return date === '2026-09-24' ? new Promise(resolve => { finish = () => resolve(response(date)); }) : Promise.resolve(response(date));
  } });
  await client.getDay('2026-09-23');
  const first = client.getDay('2026-09-24'), shared = client.getDay('2026-09-24');
  finish(); const [a, b] = await Promise.all([first, shared]);
  assert.equal(a, b); assert.equal(await client.getDay('2026-09-24'), a);
  assert.deepEqual(requests, ['2026-09-24', '2026-09-23']);
});
