import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import revisions from '../shared/prepared-data-revisions.json' with { type: 'json' };
import type { LifetimeFileMetadata } from '../shared/lifetime-format.ts';
import { lifetimeFileFingerprint } from '../server/services/lifetime.ts';
import { lifetimeProvenanceMatches, LIFETIME_DATE_LIMITS_MIGRATION } from '../server/services/lifetime-compatibility.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const migration = revisions.lifetimeTypescript;
const metadata = (generated: string): LifetimeFileMetadata => ({
  version: '3', format: '', columns: [], sampleCount: 0, stepSeconds: 600, flags: 258,
  engine: 'Swiss Ephemeris 2.10.03', sha256: 'a'.repeat(64), bytes: 0, startUtc: '', endExclusiveUtc: '',
  provenance: { version: '1', calculationFingerprint: generated },
});

test('the TypeScript attestation is bound to the actual reviewed calculation inputs', async () => {
  assert.equal(await lifetimeFileFingerprint(root), migration.to);
});

test('unchanged TypeScript calculations read the previous prepared revision without rewriting it', () => {
  const input = metadata(migration.from), before = structuredClone(input);
  assert.equal(lifetimeProvenanceMatches(input, migration.to), true);
  assert.deepEqual(input, before);
  assert.equal(lifetimeProvenanceMatches(input, 'f'.repeat(64)), false);
  assert.equal(lifetimeProvenanceMatches(metadata('b'.repeat(64)), migration.to), false);
});

test('the prior date-limit attestation remains mandatory with its original checksum', () => {
  const input = metadata(LIFETIME_DATE_LIMITS_MIGRATION.from);
  assert.equal(lifetimeProvenanceMatches(input, migration.to), false);
  input.compatibility = { version: '1', change: LIFETIME_DATE_LIMITS_MIGRATION.change,
    calculationFingerprint: migration.from, sha256: input.sha256 };
  assert.equal(lifetimeProvenanceMatches(input, migration.to), true);
  input.compatibility.sha256 = 'b'.repeat(64);
  assert.equal(lifetimeProvenanceMatches(input, migration.to), false);
});
