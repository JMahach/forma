import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifetimeClient } from '../src/data/lifetime-client.js';
import { LIFETIME_PLANETS } from '../shared/lifetime-format.js';

const meta = { calculationVersion: 'a'.repeat(64), startUtc: '2000-01-01T00:00:00Z', endExclusiveUtc: '2000-01-02T00:00:00Z',
  samples: 144, stepSeconds: 600, planets: LIFETIME_PLANETS };
const value = index => {
  const utc = new Date(Date.parse(meta.startUtc) + index * 600000).toISOString().replace('.000Z', 'Z');
  return { index, utc, longitudes: LIFETIME_PLANETS.map((_, i) => i * 30),
    design: { utc, designUtc: '1999-10-05T00:00:00Z', designArcResidualDegrees: 0,
      longitudes: LIFETIME_PLANETS.map((_, i) => i * 30 + 1) } };
};

test('versioned moments share the browser cache across clients; metadata is always fresh', async () => {
  let cacheVersion = 'a'.repeat(64), transfers = 0, metas = 0;
  const disk = new Map(), requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, cache: options.cache });
    if (url.endsWith('/meta')) { metas++; return { ok: true, json: async () => ({ ...meta, cacheVersion }) }; }
    let result = options.cache === 'no-store' ? null : disk.get(url);
    if (!result) { transfers++; result = value(Number(new URL(url, 'http://local').searchParams.get('index'))); disk.set(url, result); }
    return { ok: true, json: async () => result };
  };
  const first = await createLifetimeClient({ fetch }).getPoint(3);
  const second = await createLifetimeClient({ fetch }).getPoint(3);
  assert.deepEqual(second, first);
  assert.equal(transfers, 1, 'reload reuses the versioned response instead of transferring it');
  assert.equal(metas, 2);
  assert.deepEqual(requests.slice(0, 2), [{ url: '/api/lifetime/meta', cache: 'no-store' },
    { url: `/api/lifetime?index=3&v=${'a'.repeat(64)}`, cache: 'default' }]);
  cacheVersion = 'b'.repeat(64);
  await createLifetimeClient({ fetch }).getPoint(3);
  assert.equal(transfers, 2, 'changed calculation revision selects a different immutable URL');
});

test('unversioned metadata keeps safe no-store transport', async () => {
  const requests = [];
  const fetch = async (url, options) => { requests.push({ url, cache: options.cache });
    return { ok: true, json: async () => url.endsWith('/meta') ? meta : value(3) }; };
  await createLifetimeClient({ fetch }).getPoint(3);
  assert.deepEqual(requests, [{ url: '/api/lifetime/meta', cache: 'no-store' }, { url: '/api/lifetime?index=3', cache: 'no-store' }]);
});


test('preparation status reaches the caller and is not cached when the completed file later appears', async () => {
  let ready = false, requests = 0;
  const client = createLifetimeClient({ fetch: async () => {
    requests++;
    return ready ? { ok: true, json: async () => meta }
      : { ok: false, json: async () => ({ error: 'lifetime_preparing', message: 'Создаём летопись' }) };
  } });
  await assert.rejects(client.getMeta(), error => error.code === 'lifetime_preparing');
  ready = true;
  assert.equal((await client.getMeta()).samples, 144);
  assert.equal(requests, 2);
});
