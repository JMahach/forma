import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { LINE_FIXING_DATA, LINE_FIXING_PROVENANCE } from '../src/domain/line-fixing-data.js';

const PLANETS = ['sun', 'earth', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];
const PINNED_COMMIT = '8b78031ce9a4244b8eb0a4ce37e612b8d6782570';
const REPOSITORY = 'https://github.com/CReizner/SharpAstrology.HumanDesign';

test('the fixing table covers every gate and line exactly once using only the eleven fixing planets', () => {
  const expectedKeys = Array.from({ length: 64 }, (_, gate) =>
    Array.from({ length: 6 }, (_, line) => `${gate + 1}.${line + 1}`)).flat();
  assert.deepEqual(Object.keys(LINE_FIXING_DATA), expectedKeys);
  assert.equal(Object.keys(LINE_FIXING_DATA).length, 384);
  const seenPlanets = new Set();
  const entries = [];
  for (const [key, row] of Object.entries(LINE_FIXING_DATA)) {
    assert.deepEqual(Object.keys(row).sort(), ['detriment', 'exalted'], `${key} has both explicit state lists`);
    for (const state of ['exalted', 'detriment']) {
      assert.ok(Array.isArray(row[state]), `${key}/${state} supports multiple planets`);
      assert.equal(new Set(row[state]).size, row[state].length, `${key}/${state} has no duplicate planets`);
      for (const planet of row[state]) {
        assert.ok(PLANETS.includes(planet), `${key}/${state}: valid lowercase planet identifier`);
        seenPlanets.add(planet);
        entries.push(`${key}:${state}:${planet}`);
      }
    }
    assert.ok(row.exalted.every(planet => !row.detriment.includes(planet)), `${key} preserves the source's distinct polarity entries`);
  }
  assert.deepEqual([...seenPlanets].sort(), [...PLANETS].sort());
  assert.equal(new Set(entries).size, entries.length, 'all converted source entries remain unique');
});

test('the converted table retains all 759 source entries and exactly 375 dual-polarity lines', () => {
  const rows = Object.values(LINE_FIXING_DATA);
  const exalted = rows.reduce((count, row) => count + row.exalted.length, 0);
  const detriment = rows.reduce((count, row) => count + row.detriment.length, 0);
  assert.equal(exalted, 382);
  assert.equal(detriment, 377);
  assert.equal(exalted + detriment, 759);
  assert.equal(rows.filter(row => row.exalted.length && row.detriment.length).length, 375);
  assert.deepEqual(Object.entries(LINE_FIXING_DATA).filter(([, row]) => !row.exalted.length && !row.detriment.length).map(([key]) => key), ['54.4']);
});

test('all nine source exceptions and the requested known examples survive the conversion', () => {
  const exceptions = Object.fromEntries(Object.entries(LINE_FIXING_DATA)
    .filter(([, row]) => row.exalted.length !== 1 || row.detriment.length !== 1));
  assert.deepEqual(exceptions, {
    '5.6': { exalted: ['neptune'], detriment: [] },
    '25.4': { exalted: ['jupiter', 'venus'], detriment: [] },
    '37.1': { exalted: ['venus'], detriment: [] },
    '47.5': { exalted: ['venus'], detriment: [] },
    '47.6': { exalted: [], detriment: ['sun'] },
    '54.4': { exalted: [], detriment: [] },
    '54.5': { exalted: ['sun'], detriment: [] },
    '57.3': { exalted: ['mercury'], detriment: [] },
    '58.2': { exalted: [], detriment: ['uranus'] },
  });
  for (const [key, expected] of Object.entries({
    '43.2': { exalted: ['pluto'], detriment: ['moon'] },
    '55.2': { exalted: ['venus'], detriment: ['earth'] },
    '16.3': { exalted: ['moon'], detriment: ['mars'] },
    '16.4': { exalted: ['jupiter'], detriment: ['mars'] },
  })) assert.deepEqual(LINE_FIXING_DATA[key], expected, key);
});

test('data provenance pins the verified source and preserves the complete upstream MIT notice', () => {
  assert.equal(LINE_FIXING_PROVENANCE.repository, REPOSITORY);
  assert.equal(LINE_FIXING_PROVENANCE.commit, PINNED_COMMIT);
  assert.equal(LINE_FIXING_PROVENANCE.sourceURL, `${REPOSITORY}/blob/${PINNED_COMMIT}/Utility/HumanDesignUtility.cs`);
  assert.equal(LINE_FIXING_PROVENANCE.licenseURL, `${REPOSITORY}/blob/${PINNED_COMMIT}/LICENSE.md`);
  assert.equal(LINE_FIXING_PROVENANCE.sourceFunction, '_getStateFromStatesTable');
  assert.equal(LINE_FIXING_PROVENANCE.sourceSha256, 'bc22a96b00f79735fc791362bca24a9adadf67d9c219496c20ef5233ed924720');
  assert.equal(LINE_FIXING_PROVENANCE.license, 'MIT');
  assert.equal(LINE_FIXING_PROVENANCE.copyright, 'Copyright 2023 Christian Reizner');
  const license = readFileSync(new URL('../licenses/SharpAstrology.HumanDesign-MIT.txt', import.meta.url), 'utf8').trimEnd();
  assert.equal(createHash('sha256').update(license).digest('hex'), '9c5d3400ccfbd746e5fc48d6696bb0998c14935801aa669448cf5a564594b9c3', 'the full pinned license is retained without alteration');
  const moduleSource = readFileSync(new URL('../src/domain/line-fixing-data.js', import.meta.url), 'utf8');
  assert.ok(moduleSource.replace(/^ \* ?/gm, '').includes(license), 'the module header carries the same complete upstream notice');
});
