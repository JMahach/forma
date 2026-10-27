import type test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {lifetimeFileFingerprint} from '../../server/services/lifetime.ts';
import {LIFETIME_PLANETS, LIFETIME_STEP_SECONDS, LIFETIME_FILE_VERSION, LIFETIME_FILE_FORMAT, LIFETIME_FIELDS, LIFETIME_POINT_BYTES} from '../../shared/lifetime-format.ts';

export async function lifetimeFileFixture(t: test.TestContext, samples = 17) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-lifetime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sample.f64le'), metadataFile = path.join(directory, 'sample.metadata.json');
  const bytes = Buffer.alloc(samples * LIFETIME_POINT_BYTES), start = Date.parse('1900-01-01T00:00:00Z');
  const columns = LIFETIME_PLANETS.map((_, column) => Array.from({ length: samples }, (_, index) => (column * 30 + index / 1024) % 360 + 0.000012345));
  columns[0][0] = 0; columns.at(-1)![samples - 1] = 359.99999999999994;
  columns.push(...LIFETIME_PLANETS.map((_, column) => Array.from({ length: samples }, (_, index) => (column * 30 + index / 2048 + 1) % 360)),
    Array.from({ length: samples }, (_, index) => (start + index * 600000 - 88 * 86400000) / 1000), Array(samples).fill(1e-11));
  columns.forEach((values, column) => values.forEach((value, index) => bytes.writeDoubleLE(value, index * LIFETIME_POINT_BYTES + column * 8)));
  const metadata = { version: LIFETIME_FILE_VERSION, format: LIFETIME_FILE_FORMAT, columns: [...LIFETIME_FIELDS], startUtc: '1900-01-01T00:00:00Z',
    endExclusiveUtc: new Date(start + samples * LIFETIME_STEP_SECONDS * 1000).toISOString().replace('.000Z', 'Z'), stepSeconds: LIFETIME_STEP_SECONDS,
    sampleCount: samples, bytes: bytes.length, flags: 258, engine: 'Swiss Ephemeris 2.10.03', sha256: createHash('sha256').update(bytes).digest('hex'),
    provenance: { version: '1', calculationFingerprint: await lifetimeFileFingerprint(fileURLToPath(new URL('../../', import.meta.url))) } };
  await fs.writeFile(file, bytes); await fs.writeFile(metadataFile, JSON.stringify(metadata));
  return { file, metadataFile, metadata, columns, bytes };
}
