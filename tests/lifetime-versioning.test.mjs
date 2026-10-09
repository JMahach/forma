import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { lifetimeFileFingerprint, createLifetimeFile, createLifetimeMoments } from '../server/services/lifetime.mjs';
import { calculationVersion } from '../server/runtime/calculation-version.mjs';
import { LIFETIME_PLANETS, LIFETIME_FIELDS, LIFETIME_FILE_VERSION, LIFETIME_FILE_FORMAT } from '../shared/lifetime-format.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const utc = '2000-01-01T00:01:00Z';
const point = { utc, longitudes: Array(11).fill(10), design: { utc, designUtc: '1999-10-05T00:00:00Z',
  longitudes: Array(11).fill(20), designArcResidualDegrees: 0 } };
const metadata = { calculationVersion: 'a'.repeat(64), cacheVersion: 'b'.repeat(64),
  startUtc: '2000-01-01T00:00:00Z', endExclusiveUtc: '2000-01-02T00:00:00Z',
  samples: 144, stepSeconds: 600, planets: LIFETIME_PLANETS, engine: 'Swiss Ephemeris 2.10.03' };

async function copyProject(t) {
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-lifetime-contract-'));
  t.after(() => fs.rm(copy, { recursive: true, force: true }));
  for (const name of ['server', 'src', 'shared', 'data/ephe', 'requirements.txt', 'package.json']) {
    await fs.mkdir(path.dirname(path.join(copy, name)), { recursive: true });
    await fs.cp(path.join(root, name), path.join(copy, name), { recursive: true });
  }
  return copy;
}
async function changeExactContract(copy) {
  // Exercise the actual owner in both the old and corrected arrangements.
  const modern = path.join(copy, 'shared/lifetime-exact-format.js');
  const file = await fs.access(modern).then(() => modern, () => path.join(copy, 'shared/lifetime-format.js'));
  const source = await fs.readFile(file, 'utf8');
  assert.match(source, /export const LIFETIME_EXACT_VERSION = '1';/);
  await fs.writeFile(file, source.replace("export const LIFETIME_EXACT_VERSION = '1';", "export const LIFETIME_EXACT_VERSION = '2';"));
}

test('an exact HTTP contract update preserves prepared-file provenance and numeric revision', async t => {
  const copy = await copyProject(t), provenance = await lifetimeFileFingerprint(copy), numeric = await calculationVersion(copy);
  const file = path.join(copy, 'prepared.f64le'), metadataFile = path.join(copy, 'prepared.metadata.json');
  const values = [...point.longitudes, ...point.design.longitudes, Date.parse(point.design.designUtc) / 1000, 0];
  const bytes = Buffer.alloc(192); values.forEach((value, column) => bytes.writeDoubleLE(value, column * 8));
  await fs.writeFile(file, bytes);
  await fs.writeFile(metadataFile, JSON.stringify({ version: LIFETIME_FILE_VERSION, format: LIFETIME_FILE_FORMAT,
    columns: LIFETIME_FIELDS, startUtc: metadata.startUtc, endExclusiveUtc: '2000-01-01T00:10:00Z',
    sampleCount: 1, stepSeconds: 600, bytes: bytes.length, flags: 258, engine: metadata.engine,
    sha256: createHash('sha256').update(bytes).digest('hex'), provenance: { version: '1', calculationFingerprint: provenance } }));
  await changeExactContract(copy);
  assert.equal(await lifetimeFileFingerprint(copy), provenance, 'a wire-only update must not reject an existing prepared file');
  assert.equal(await calculationVersion(copy), numeric, 'wire changes preserve stored public numbers');
  const prepared = await createLifetimeFile({ root: copy, file, metadataFile });
  try { assert.deepEqual((await prepared.getPoint(0)).longitudes, point.longitudes); }
  finally { await prepared.close(); }
});

test('HTTP delivery and exact projection adopt the same updated response contract without retaining points', async t => {
  const copy = await copyProject(t); await changeExactContract(copy);
  const { createLifetimeHandler } = await import(pathToFileURL(path.join(copy, 'server/http/lifetime.mjs')));
  const { createLifetimeClient } = await import(pathToFileURL(path.join(copy, 'src/data/lifetime-client.js')));
  const { createTransitDayCache } = await import(pathToFileURL(path.join(copy, 'src/data/transit-day-cache.js')));
  const days = createTransitDayCache({ indexedDB: null });
  t.after(() => days.close());
  const handler = createLifetimeHandler({ getMetadata: async () => metadata, getUtcMoment: async () => point });
  const responses = [], urls = [];
  const client = createLifetimeClient({ days, fetch: async url => {
    urls.push(url);
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await handler({ method: 'GET' }, res, new URL(url, 'http://localhost'));
    responses.push(res.body);
    return { ok: res.status === 200, json: async () => res.body };
  } });
  const chart = await client.getMinute(Date.parse(utc));
  assert.equal(responses.at(-1).version, '2');
  assert.equal(chart.utc, utc);
  const cached = client.peekMinute(Date.parse(utc));
  assert.equal(cached, null);
  assert.equal((await client.getMinute(Date.parse(utc))).utc, utc);
  assert.equal(urls.length, 3, 'metadata is reused, but each independent point visit returns to the exact API');
});


test('a new exact response contract selects fresh versioned URLs without discarding full-day numbers', async t => {
  const copy = await copyProject(t); await changeExactContract(copy);
  const { createLifetimeMoments: updatedMoments } = await import(pathToFileURL(path.join(copy, 'server/services/lifetime.mjs')));
  const options = { lifetimeFile: { metadata, cacheIdentity: 'c'.repeat(64) }, calculationFingerprint: metadata.calculationVersion };
  const previous = createLifetimeMoments(options).metadata, updated = updatedMoments(options).metadata;
  assert.notEqual(updated.cacheVersion, previous.cacheVersion, 'old exact response contracts must not occupy the new versioned URL');
  assert.equal(updated.calculationVersion, previous.calculationVersion, 'stored numbers remain compatible across response updates');
});
