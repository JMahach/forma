import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';
import { GATE_ORDER as MANDALA_GATE_ORDER, GATE_LONGITUDE_START as MANDALA_LONGITUDE_START, GATE_WIDTH as MANDALA_GATE_WIDTH } from '../src/domain/gate-wheel.js';

const normalize = value => ((value % 360) + 360) % 360;
const lineWidth = MANDALA_GATE_WIDTH / 6;
const expectedProfiles = [
  ['1/3', 'right-angle'], ['1/4', 'right-angle'],
  ['2/4', 'right-angle'], ['2/5', 'right-angle'],
  ['3/5', 'right-angle'], ['3/6', 'right-angle'],
  ['4/6', 'right-angle'], ['4/1', 'juxtaposition'],
  ['5/1', 'left-angle'], ['5/2', 'left-angle'],
  ['6/2', 'left-angle'], ['6/3', 'left-angle'],
];

test('cross uses the calculator solar arc and Sun/Earth opposition, not calendar days', () => {
  const calculator = readFileSync(new URL('../server/python/astronomy.py', import.meta.url), 'utf8');
  assert.match(calculator, /arc > 88/);
  assert.match(calculator, /values\['earth'\] = \(values\['sun'\] \+ 180\) % 360/);
  const cross = crossAtLongitude(180);
  assert.deepEqual(cross.positions.map(({ source, planet, longitude }) => [source, planet, longitude]), [
    ['personality', 'sun', 180], ['personality', 'earth', 0],
    ['design', 'sun', 92], ['design', 'earth', 272],
  ]);
  assert.deepEqual(cross.gates, [46, 25, 15, 10]);
  assert.equal(cross.profile, '2/5');
  assert.equal(cross.type, 'right-angle');
});

test('every gate traverses all twelve verified profiles in the correct order', () => {
  for (let gateIndex = 0; gateIndex < 64; gateIndex++) {
    const start = MANDALA_LONGITUDE_START + gateIndex * MANDALA_GATE_WIDTH;
    const found = [];
    for (let line = 0; line < 6; line++) {
      for (const withinLine of [.4, .875]) {
        const cross = crossAtLongitude(start + line * lineWidth + withinLine);
        found.push([cross.profile, cross.type]);
        assert.equal(cross.gates[0], MANDALA_GATE_ORDER[gateIndex]);
        assert.equal(cross.gates[1], MANDALA_GATE_ORDER[(gateIndex + 32) % 64]);
        assert.equal(cross.positions[0].line, cross.positions[1].line);
        assert.equal(cross.positions[2].line, cross.positions[3].line);
        assert.equal(new Set(cross.gates).size, 4);
        assert.equal(typeof cross.label, 'string');
      }
    }
    assert.deepEqual(found, expectedProfiles, `gate ${MANDALA_GATE_ORDER[gateIndex]}`);
  }
});

test('right-angle, narrow juxtaposition and left-angle change inside each gate, not at gate centers', () => {
  for (let gateIndex = 0; gateIndex < 64; gateIndex++) {
    const start = normalize(MANDALA_LONGITUDE_START + gateIndex * MANDALA_GATE_WIDTH);
    const juxtapositionStart = start + 3 * lineWidth + .8125;
    const leftStart = start + 4 * lineWidth;
    assert.equal(crossAtLongitude(juxtapositionStart - 1e-8).profile, '4/6');
    assert.equal(crossAtLongitude(juxtapositionStart).profile, '4/1');
    assert.equal(crossAtLongitude(leftStart - 1e-8).profile, '4/1');
    assert.equal(crossAtLongitude(leftStart).profile, '5/1');
    assert.equal(crossAtLongitude(leftStart).type, 'left-angle');
    assert.notDeepEqual(crossAtLongitude(juxtapositionStart - 1e-8).gates, crossAtLongitude(juxtapositionStart).gates);
    assert.equal(leftStart - juxtapositionStart, .125, 'the transition is only 7.5 arcminutes wide');
  }
});

test('every exact gate and line boundary belongs to the following interval without epsilon snapping', () => {
  for (let gateIndex = 0; gateIndex < 64; gateIndex++) {
    const start = normalize(MANDALA_LONGITUDE_START + gateIndex * MANDALA_GATE_WIDTH);
    for (let line = 0; line < 6; line++) {
      const boundary = start + line * lineWidth;
      const current = crossAtLongitude(boundary).positions[0];
      const previous = crossAtLongitude(boundary - 1e-8).positions[0];
      assert.equal(current.gate, MANDALA_GATE_ORDER[gateIndex]);
      assert.equal(current.line, line + 1);
      assert.equal(previous.line, line === 0 ? 6 : line);
      assert.equal(previous.gate, MANDALA_GATE_ORDER[(gateIndex + (line === 0 ? 63 : 0)) % 64]);
    }
  }
});

test('design and personality hover references produce the same four exact positions', () => {
  for (let tick = 0; tick < 360 * 32; tick++) {
    const longitude = tick / 32;
    const personality = crossAtLongitude(longitude);
    const design = crossAtLongitude(longitude - 88, { source: 'design' });
    assert.deepEqual(design.positions, personality.positions);
    assert.deepEqual(design.gates, personality.gates);
    assert.equal(design.type, personality.type);
    assert.equal(design.profile, personality.profile);
    assert.equal(design.source, 'design');
    assert.equal(personality.source, 'personality');
    assert.equal(design.longitude, normalize(longitude - 88));
  }
});

test('longitude wraps continuously, does not round cursor position, and accepts multiple turns', () => {
  for (const longitude of [0, .125, 88, 180, 301.99998474121094, 302, 359.99998474121094]) {
    const cross = crossAtLongitude(longitude);
    assert.deepEqual(crossAtLongitude(longitude - 720), cross);
    assert.deepEqual(crossAtLongitude(longitude + 720), cross);
    assert.equal(cross.positions[0].longitude, longitude);
    assert.equal(cross.longitude, longitude);
  }
  assert.deepEqual(crossAtLongitude(0), crossAtLongitude(360));
  assert.equal(Object.is(crossAtLongitude(-0).longitude, -0), false);
});

test('cross positions move continuously even when profile and gates remain unchanged', () => {
  const before = crossAtLongitude(302.2), after = crossAtLongitude(302.3);
  assert.equal(before.profile, after.profile);
  assert.deepEqual(before.gates, after.gates);
  before.positions.forEach((item, index) => {
    assert.ok(Math.abs(normalize(after.positions[index].longitude - item.longitude) - .1) < 1e-10);
  });
});

test('invalid positions and unsupported source cannot invent a cross', () => {
  for (const longitude of [undefined, null, NaN, Infinity, -Infinity, '180', {}, []]) {
    assert.throws(() => crossAtLongitude(longitude), TypeError);
  }
  for (const source of [null, 'both', 'transit', 'sun', '', 0, {}]) {
    assert.throws(() => crossAtLongitude(180, { source }), TypeError);
  }
});

test('results are independent snapshots, without chart mutations or persistent preview state', () => {
  const first = crossAtLongitude(180);
  first.positions[0].gate = 1;
  first.gates.push(64);
  const second = crossAtLongitude(180);
  assert.deepEqual(second.gates, [46, 25, 15, 10]);
  assert.equal(second.positions[0].gate, 46);
  assert.equal(second.positions.length, 4);
});
