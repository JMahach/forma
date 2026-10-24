import { LIFETIME_DATE_LIMITS_MIGRATION } from '../server/services/lifetime-compatibility.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLifetimeFile, lifetimeFileFingerprint, LifetimeError } from '../server/services/lifetime.ts';
import { LIFETIME_FIELDS, LIFETIME_FILE_FORMAT, LIFETIME_PROVENANCE_INPUTS } from '../shared/lifetime-format.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const oldFingerprint = '03fe75bc83b639e306ee871ad8ca8fe309dc363baa61b5d15b1391a06f19fb8f';
const run = promisify(execFile);
const migrate = (file: string) => run(process.execPath, ['scripts/migrate-lifetime-date-limits.ts', '--file', file], { cwd: root });

async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-lifetime-migration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sample.f64le'), metadataFile = path.join(directory, 'sample.metadata.json');
  const values = [...Array.from({ length: 22 }, (_, i) => i + 0.125), Date.parse('1999-10-05T00:00:00Z') / 1000, 0];
  const bytes = Buffer.alloc(192); values.forEach((value, i) => bytes.writeDoubleLE(value, i * 8));
  const metadata = { version: '3', format: LIFETIME_FILE_FORMAT, columns: [...LIFETIME_FIELDS],
    startUtc: '2000-01-01T00:00:00Z', endExclusiveUtc: '2000-01-01T00:10:00Z',
    stepSeconds: 600, sampleCount: 1, bytes: bytes.length, flags: 258, engine: 'Swiss Ephemeris 2.10.03',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    provenance: { version: '1', calculationFingerprint: oldFingerprint }, generationSeconds: 123 };
  await fs.writeFile(file, bytes); await fs.writeFile(metadataFile, JSON.stringify(metadata));
  return { directory, file, metadataFile, bytes, metadata };
}

test('audited date-limit migration keeps numeric bytes and original provenance, and is repeatable', async t => {
  const input = await fixture(t), before = await fs.stat(input.file);
  await migrate(input.file);
  const text = await fs.readFile(input.metadataFile, 'utf8'), updated = JSON.parse(text);
  assert.deepEqual(updated.provenance, input.metadata.provenance);
  assert.equal(updated.compatibility.calculationFingerprint, LIFETIME_DATE_LIMITS_MIGRATION.to);
  assert.equal(updated.compatibility.change, 'shared-date-limits');
  assert.equal(updated.sha256, input.metadata.sha256);
  assert.deepEqual(await fs.readFile(input.file), input.bytes);
  assert.equal((await fs.stat(input.file)).mtimeMs, before.mtimeMs);
  const service = await createLifetimeFile(input);
  try { assert.equal((await service.getPoint(0)).longitudes[0], 0.125); }
  finally { await service.close(); }
  await migrate(input.file);
  assert.equal(await fs.readFile(input.metadataFile, 'utf8'), text);
  assert.deepEqual((await fs.readdir(input.directory)).sort(), ['sample.f64le', 'sample.metadata.json']);
});

for (const kind of ['unknown provenance', 'corrupted bytes', 'old format'] as const) {
  test(`migration refuses ${kind} without rewriting metadata`, async t => {
    const input = await fixture(t);
    if (kind === 'unknown provenance') input.metadata.provenance.calculationFingerprint = 'a'.repeat(64);
    if (kind === 'old format') input.metadata.version = '2';
    await fs.writeFile(input.metadataFile, JSON.stringify(input.metadata));
    if (kind === 'corrupted bytes') await fs.writeFile(input.file, Buffer.alloc(192));
    const before = await fs.readFile(input.metadataFile, 'utf8');
    await assert.rejects(migrate(input.file));
    assert.equal(await fs.readFile(input.metadataFile, 'utf8'), before);
    assert.deepEqual((await fs.readdir(input.directory)).sort(), ['sample.f64le', 'sample.metadata.json']);
  });
}

test('compatibility cannot attest an unknown generating version or substitute its checksum', async t => {
  const input = await fixture(t); await migrate(input.file);
  const updated = JSON.parse(await fs.readFile(input.metadataFile, 'utf8'));
  for (const override of [
    { provenance: { version: '1', calculationFingerprint: 'a'.repeat(64) } },
    { compatibility: { ...updated.compatibility, calculationFingerprint: 'b'.repeat(64) } },
    { compatibility: { ...updated.compatibility, sha256: 'c'.repeat(64) } },
  ] as const) {
    await fs.writeFile(input.metadataFile, JSON.stringify({ ...updated, ...override }));
    await assert.rejects(createLifetimeFile(input), error => error instanceof LifetimeError && error.code === 'lifetime_unavailable');
  }
});

test('the date-limit attestation cannot authorize a later source change', async t => {
  const input = await fixture(t); await migrate(input.file);
  const copy = path.join(input.directory, 'source');
  for (const name of LIFETIME_PROVENANCE_INPUTS) {
    await fs.mkdir(path.dirname(path.join(copy, name)), { recursive: true });
    await fs.cp(path.join(root, name), path.join(copy, name), { recursive: true });
  }
  await fs.appendFile(path.join(copy, 'shared/date-limits.ts'), '\n// A different source revision.\n');
  const metadata = JSON.parse(await fs.readFile(input.metadataFile, 'utf8'));
  metadata.compatibility.calculationFingerprint = await lifetimeFileFingerprint(copy);
  await fs.writeFile(input.metadataFile, JSON.stringify(metadata));
  await assert.rejects(createLifetimeFile({ ...input, root: copy }), error => error instanceof LifetimeError && error.code === 'lifetime_unavailable');
});

test('a second migration cannot remove an existing lock or modify metadata', async t => {
  const input = await fixture(t), lock = input.metadataFile + '.migration-lock';
  const before = await fs.readFile(input.metadataFile, 'utf8');
  await fs.writeFile(lock, 'existing owner');
  await assert.rejects(migrate(input.file));
  assert.equal(await fs.readFile(lock, 'utf8'), 'existing owner');
  assert.equal(await fs.readFile(input.metadataFile, 'utf8'), before);
});

test('metadata keeps its owner and permissions even under a restrictive process umask', {
  skip: process.platform === 'win32' && 'Windows does not implement POSIX umask, uid/gid and mode bits',
}, async t => {
  const input = await fixture(t);
  await fs.chmod(input.metadataFile, 0o644);
  const before = await fs.stat(input.metadataFile);
  await run(process.execPath, ['--input-type=module', '-e',
    "process.umask(0o077); await import('./scripts/migrate-lifetime-date-limits.ts');",
    'scripts/migrate-lifetime-date-limits.ts', '--file', input.file], { cwd: root });
  const after = await fs.stat(input.metadataFile);
  assert.equal(after.mode & 0o777, 0o644);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
});
