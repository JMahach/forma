import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANET_IDS } from '../src/domain/planets.js';
import { MANDALA_GEOMETRY, mandalaPoint } from '../src/scene/geometry/mandala-geometry.js';
import { MANDALA_PLANET_LAYOUT, layoutMandalaPlanets } from '../src/scene/geometry/mandala-planets.js';

const normalize = angle => ((angle % 360) + 360) % 360;
const angularDistance = (left, right) => Math.abs(normalize(left - right + 180) - 180);
const key = entry => `${entry.source}:${entry.planet}`;
const byKey = entries => new Map(entries.map(entry => [key(entry), entry]));
const fixture = (longitudes, source = 'personality') => longitudes.map((longitude, index) => ({
  source, planet: PLANET_IDS[index], longitude,
}));
const { outerRadius, centerX, centerY } = MANDALA_GEOMETRY;
const { glyphRadius, labelGap, visualRadius } = MANDALA_PLANET_LAYOUT;

function assertProtected(labels) {
  for (const label of labels) {
    assert.ok(Number.isFinite(label.x) && Number.isFinite(label.y));
    assert.ok(label.labelLongitude >= 0 && label.labelLongitude < 360);
    const radius = Math.hypot(label.x - centerX, label.y - centerY);
    assert.ok(radius - glyphRadius > outerRadius, `${key(label)} stays outside the rim`);
    assert.ok(radius + glyphRadius <= visualRadius + .001, `${key(label)} stays in the fixed visual frame`);
  }
  for (let left = 0; left < labels.length; left++) {
    for (let right = left + 1; right < labels.length; right++) {
      const first = labels[left], second = labels[right];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const clearance = 2 * glyphRadius + (first.source === second.source ? labelGap : 1);
      assert.ok(distance >= clearance - .002,
        `${key(first)} and ${key(second)} retain glyph clearance (${distance})`);
    }
  }
}

test('isolated planets stay exactly opposite their true longitude in distinct source lanes', () => {
  assert.ok(MANDALA_PLANET_LAYOUT.personalityRadius < MANDALA_PLANET_LAYOUT.designRadius,
    'dark personality symbols occupy the inner lane, red design symbols the outer lane');
  const longitudes = [0, 27, 51, 80, 106, 139, 169, 196, 225, 257, 288, 316, 341];
  const entries = [...fixture(longitudes, 'design'), ...fixture(longitudes)];
  const labels = layoutMandalaPlanets(entries);
  assert.deepEqual(labels.map(key), entries.map(key), 'caller order is retained');
  labels.forEach((label, index) => {
    assert.equal(label.longitude, entries[index].longitude);
    assert.equal(label.labelLongitude, label.longitude);
    assert.deepEqual([label.x, label.y], mandalaPoint(label.longitude,
      MANDALA_PLANET_LAYOUT[`${label.source}Radius`]));
    assert.doesNotMatch(label.leaderPath, / A /, 'an aligned glyph has a straight connection');
    const endRadius = label.source === 'design' ? MANDALA_PLANET_LAYOUT.designRadius - glyphRadius - 1 : outerRadius + 3;
    assert.equal(label.leaderPath,
      `M ${mandalaPoint(label.longitude, outerRadius + 1).join(' ')} L ${mandalaPoint(label.longitude, endRadius).join(' ')}`,
      'red connections reach their glyphs even in uncrowded sectors; dark ticks stay compact');
  });
  assertProtected(labels);
});

test('near-identical slow planets from the two calculations remain separate without moving their angles', () => {
  const entries = [
    { source: 'design', planet: 'neptune', longitude: 45.0001 },
    { source: 'personality', planet: 'neptune', longitude: 45.0002 },
    { source: 'design', planet: 'pluto', longitude: 314.98 },
    { source: 'personality', planet: 'pluto', longitude: 315.0002 },
  ];
  const labels = layoutMandalaPlanets(entries);
  labels.forEach(label => assert.equal(label.labelLongitude, label.longitude));
  assertProtected(labels);
});

test('a tight group opens locally and leaves distant labels untouched', () => {
  const entries = fixture([34, 34.15, 34.3, 130, 270]);
  const labels = layoutMandalaPlanets(entries);
  assert.ok(labels[0].labelLongitude < 34);
  assert.ok(labels[2].labelLongitude > 34.3);
  assert.ok(angularDistance(labels[1].labelLongitude, 34.15) < 1e-9, 'symmetric group remains centered');
  assert.equal(labels[3].labelLongitude, 130);
  assert.equal(labels[4].labelLongitude, 270);
  labels.forEach((label, index) => {
    assert.equal(label.longitude, entries[index].longitude, 'the activation itself never receives an offset');
    assert.ok(label.leaderPath.startsWith(`M ${mandalaPoint(label.longitude, outerRadius + 1).join(' ')}`),
      'each tick still points to its exact activation');
  });
  assertProtected(labels);
});

test('a group across 359° / 0° separates across the seam rather than travelling around the wheel', () => {
  const entries = fixture([359.9, .01, .2, 180]);
  const labels = layoutMandalaPlanets(entries);
  assertProtected(labels);
  for (let index = 0; index < 3; index++) {
    assert.ok(angularDistance(labels[index].labelLongitude, entries[index].longitude) < 4);
  }
  assert.equal(labels[3].labelLongitude, 180);
});

test('crowded and coincident 26-planet charts keep every glyph inside the fixed frame and out of its neighbours', () => {
  for (const longitude of [0, 44.9, 90, 179.99, 270, 359.999]) {
    for (const spread of [0, .001, .06, .3]) {
      const angles = PLANET_IDS.map((_, index) => normalize(longitude + index * spread));
      const entries = [...fixture(angles, 'design'), ...fixture(angles)];
      const labels = layoutMandalaPlanets(entries);
      assert.equal(labels.length, 26);
      assertProtected(labels);
      labels.forEach((label, index) => assert.ok(angularDistance(label.labelLongitude, entries[index].longitude) < 21,
        'even an artificial pile of thirteen planets stays near its activation group'));
    }
  }
});

test('input order cannot change the placement of coincident or close planets, and inputs are immutable', () => {
  const angles = [0, 0, .02, 150, 150.01, 150.03, 181, 212, 260, 310, 310, 359.97, 359.98];
  const entries = [...fixture(angles, 'design'), ...fixture(angles)].map(Object.freeze);
  const original = structuredClone(entries);
  Object.freeze(entries);
  const forward = byKey(layoutMandalaPlanets(entries));
  const reverse = byKey(layoutMandalaPlanets([...entries].reverse()));
  const shuffled = byKey(layoutMandalaPlanets(entries.filter((_, index) => index % 2)
    .concat(entries.filter((_, index) => index % 2 === 0))));
  for (const [id, label] of forward) {
    assert.deepEqual(reverse.get(id), label);
    assert.deepEqual(shuffled.get(id), label);
  }
  assert.deepEqual(entries, original);
});

test('uniform angular motion, including crossing 0°, moves crowded groups smoothly with their activations', () => {
  const entries = [...fixture([359.999, .05, .12, 90, 180], 'design'), ...fixture([15, 15.001, 250, 359.999])];
  const first = layoutMandalaPlanets(entries);
  for (const step of [.0001, .0009, .0011, .002, .01, .02]) {
    const moved = layoutMandalaPlanets(entries.map(entry => ({ ...entry, longitude: normalize(entry.longitude + step) })));
    assertProtected(moved);
    moved.forEach((label, index) => {
      assert.ok(angularDistance(label.labelLongitude, normalize(first[index].labelLongitude + step)) < 1e-9,
        'a uniform small motion cannot cause a new label jump');
    });
  }
});

test('relative overtaking preserves true activations and clearance on both sides of the discrete label reorder', () => {
  const frames = [];
  for (const longitude of [49.9999, 50, 50.0001]) {
    const entries = [
      { source: 'personality', planet: 'venus', longitude: 50 },
      { source: 'personality', planet: 'mercury', longitude },
    ];
    const labels = layoutMandalaPlanets(entries);
    assertProtected(labels);
    assert.deepEqual(labels.map(({ source, planet, longitude }) => ({ source, planet, longitude })), entries);
    for (const label of labels) {
      assert.ok(label.leaderPath.startsWith(`M ${mandalaPoint(label.longitude, outerRadius + 1).join(' ')}`));
      assert.ok(angularDistance(label.labelLongitude, label.longitude) < 2);
    }
    frames.push(labels);
  }
  // Glyphs exchange order at conjunction; they are not the astronomical rays.
  // Do not imply that a one-dimensional collision layout can keep both glyph
  // identities continuous while they pass each other without an overlap.
  assert.ok(frames[0][1].labelLongitude < frames[0][0].labelLongitude);
  assert.ok(frames[2][1].labelLongitude > frames[2][0].labelLongitude);
  for (const [index, longitude] of [50.0001, 50, 49.9999].entries()) {
    const reverseIndex = frames.length - 1 - index;
    const labels = layoutMandalaPlanets([
      { source: 'personality', planet: 'venus', longitude: 50 },
      { source: 'personality', planet: 'mercury', longitude },
    ]);
    assert.deepEqual(labels, frames[reverseIndex], 'scrubbing direction cannot change the result');
  }
});

test('deterministic scattered and clustered fixtures preserve bounds and spacing', () => {
  let state = 88271;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let sample = 0; sample < 240; sample++) {
    const cluster = random() * 360;
    const angles = PLANET_IDS.map(() => normalize(cluster + (random() < .7 ? random() * 9 : random() * 360)));
    const entries = [...fixture(angles, 'design'), ...fixture(angles.map(angle => normalize(angle + random() * .1)))];
    assertProtected(layoutMandalaPlanets(entries));
  }
});

test('empty charts need no planetary decoration', () => {
  assert.deepEqual(layoutMandalaPlanets([]), []);
});
