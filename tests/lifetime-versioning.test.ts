import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { lifetimeFileFingerprint, createLifetimeFile, createLifetimeMoments } from '../server/services/lifetime.ts';
import { calculationVersion } from '../server/runtime/calculation-version.ts';
import { LIFETIME_PLANETS, LIFETIME_FIELDS, LIFETIME_FILE_VERSION, LIFETIME_FILE_FORMAT } from '../shared/lifetime-format.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const utc = '2000-01-01T00:01:00Z';
const point = { utc, longitudes: Array(11).fill(10), design: { utc, designUtc: '1999-10-05T00:00:00Z',
  longitudes: Array(11).fill(20), designArcResidualDegrees: 0 } };
const metadata = { calculationVersion: 'a'.repeat(64), cacheVersion: 'b'.repeat(64),
  startUtc: '2000-01-01T00:00:00Z', endExclusiveUtc: '2000-01-02T00:00:00Z',
  samples: 144, stepSeconds: 600, planets: LIFETIME_PLANETS, engine: 'Swiss Ephemeris 2.10.03' };

async function copyProject(t: test.TestContext) {
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-lifetime-contract-'));
  t.after(() => fs.rm(copy, { recursive: true, force: true }));
  for (const name of ['server', 'src', 'shared', 'data/ephe', 'requirements.txt', 'package.json'] as const) {
    await fs.mkdir(path.dirname(path.join(copy, name)), { recursive: true });
    await fs.cp(path.join(root, name), path.join(copy, name), { recursive: true });
  }
  return copy;
}
async function changeExactContract(copy: string) {
  // Exercise the actual owner in both the old and corrected arrangements.
  const modern = path.join(copy, 'shared/lifetime-exact-format.ts');
  const file = await fs.access(modern).then(() => modern, () => path.join(copy, 'shared/lifetime-format.ts'));
  const source = await fs.readFile(file, 'utf8');
  assert.match(source, /export const LIFETIME_EXACT_VERSION = '1';/);
  await fs.writeFile(file, source.replace("export const LIFETIME_EXACT_VERSION = '1';", "export const LIFETIME_EXACT_VERSION = '2';"));
}

test('a ready-minute projection contract update preserves prepared-file provenance and numeric revision', async t => {
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

test('the ready-minute projection adopts its version without changing the source numbers', async t => {
  const copy = await copyProject(t); await changeExactContract(copy);
  const { lifetimeExactChartAt } = await import(pathToFileURL(path.join(copy, 'src/domain/lifetime.ts')));
  const chart = lifetimeExactChartAt({...point, version: '2'}, metadata, Date.parse(utc));
  assert.equal(chart.utc, utc);
  assert.throws(() => lifetimeExactChartAt({...point, version: '1'}, metadata, Date.parse(utc)));
  assert.deepEqual(point.longitudes, Array(11).fill(10));
});

test('a new projection contract preserves full-day numbers and versions prepared point URLs', async t => {
  const copy = await copyProject(t); await changeExactContract(copy);
  const { createLifetimeMoments: updatedMoments } = await import(pathToFileURL(path.join(copy, 'server/services/lifetime.ts')));
  const options = { lifetimeFile: { metadata, cacheIdentity: 'c'.repeat(64) }, calculationFingerprint: metadata.calculationVersion };
  const previous = createLifetimeMoments(options)!.metadata, updated = updatedMoments(options).metadata;
  assert.notEqual(updated.cacheVersion, previous.cacheVersion, 'old exact response contracts must not occupy the new versioned URL');
  assert.equal(updated.calculationVersion, previous.calculationVersion, 'stored numbers remain compatible across response updates');
});
