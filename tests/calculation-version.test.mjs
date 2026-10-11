import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calculationVersion, CALCULATION_INPUTS } from '../server/runtime/calculation-version.mjs';
import { lifetimeFileFingerprint } from '../server/services/lifetime.mjs';
import { cyclesCalculationFingerprint } from '../server/services/cycles.mjs';

test('public numeric revision follows every calculation input, independent of delivery and file location', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-numeric-version-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = CALCULATION_INPUTS.flatMap(name => name === 'data/ephe' ? ['data/ephe/planet.se1', 'data/ephe/moon.se1'] : [name]);
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), `input ${name}`);
  }
  const original = await calculationVersion(root);
  assert.match(original, /^[a-f0-9]{64}$/);
  for (const name of names) {
    const file = path.join(root, name), bytes = await fs.readFile(file), stat = await fs.stat(file);
    const changed = Buffer.from(bytes); changed[0] ^= 1;
    await fs.writeFile(file, changed); await fs.utimes(file, stat.atime, stat.mtime);
    assert.notEqual(await calculationVersion(root), original, name);
    await fs.writeFile(file, bytes);
  }
  for (const name of ['src/app.js', 'server/services/lifetime.mjs', 'server/services/transit-days.mjs']) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), 'delivery changed');
  }
  assert.equal(await calculationVersion(root), original);
  await fs.writeFile(path.join(root, 'data/ephe/new.se1'), 'new ephemeris');
  assert.notEqual(await calculationVersion(root), original);
});


test('a lifetime generator correction invalidates previously stored public numbers', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-generator-version-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = new Set([...CALCULATION_INPUTS.filter(name => name !== 'data/ephe'), 'server/python/lifetime_file.py', 'data/ephe/planet.se1']);
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), `input ${name}`);
  }
  const original = await calculationVersion(root);
  await fs.writeFile(path.join(root, 'server/python/lifetime_file.py'), 'corrected lifetime sample generation');
  assert.notEqual(await calculationVersion(root), original, 'old stored moments must not hide corrected prepared values');
});

test('a natal-day generator correction changes public numbers without invalidating prepared lifetime or cycles', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forma-natal-version-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Copy the real calculation owners independently of the list being tested:
  // a forgotten worker must still exist here and exercise its version boundary.
  for (const name of ['server/python', 'shared', 'requirements.txt', 'data/ephe']) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.cp(new URL(`../${name}`, import.meta.url), path.join(root, name), { recursive: true });
  }
  const original = await calculationVersion(root);
  const prepared = await lifetimeFileFingerprint(root), cycles = await cyclesCalculationFingerprint(root);
  const file = path.join(root, 'server/python/natal_day.py');
  await fs.appendFile(file, '\n# Changed natal-day calculation source.\n');
  assert.notEqual(await calculationVersion(root), original, 'a stored natal day cannot keep the revision of an older generator');
  assert.equal(await lifetimeFileFingerprint(root), prepared, 'natal-day changes do not reject the prepared ten-minute file');
  assert.equal(await cyclesCalculationFingerprint(root), cycles, 'the independent return calculation has not changed');
});
