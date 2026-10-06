import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayFixture } from './helpers/chart-composition.mjs';
import { createChartComposition } from '../src/domain/chart-composition.js';
import { createOverlaySourceState, resolveOverlayActivation, overlayOriginLabel } from '../src/domain/chart-overlay.js';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const natal = freeze({ id: 'saved', name: 'Анна', source: 'calculated', utc: '1998-08-18T12:00:00Z',
  designUtc: '1998-05-20T05:00:00Z', engine: 'Natal engine', timezone: 'Europe/Moscow', birthDate: '1998-08-18',
  personality: [63, 41], design: [19], activations: {
    personality: [{ planet: 'sun', gate: 63, line: 1, longitude: 300 }],
    design: [{ planet: 'sun', gate: 19, line: 2, longitude: 310 }],
  } });
const moment = freeze({ id: 'moment', source: 'transit', utc: '2057-06-24T23:27:34.429422Z',
  designUtc: '2057-03-28T05:00:00.123456Z', engine: 'Moment engine', ephemeris: 'Moment ephemeris',
  timezone: 'UTC', nodeModel: 'true', zodiac: 'tropical', designArcResidualDegrees: 1e-12,
  personality: [63, 4], design: [49], activations: {
    personality: [{ planet: 'sun', gate: 63, line: 6, longitude: 301 }],
    design: [{ planet: 'sun', gate: 49, line: 3, longitude: 320 }],
  } });
const event = freeze({ id: 'saturn:2:1', body: 'saturn', cycle: 2, utc: moment.utc });

test('both overlay kinds retain real sources, exact UTC and separate immutable topology', () => {
  const before = JSON.stringify({ natal, moment });
  for (const kind of ['return', 'transit']) {
    const overlay = overlayFixture(natal, moment, { kind, ...(kind === 'return' ? { event } : {}) });
    assert.equal(overlay.primary, natal);
    assert.equal(overlay.secondary, moment);
    assert.equal(overlay.utc, moment.utc, 'the six fractional digits remain intact');
    assert.equal(overlay.id, kind === 'return' ? 'saved:cycle:saturn:2:1' : 'saved:transit-preview');
    assert.equal(overlay.kind, kind);
    assert.equal(overlay.event, kind === 'return' ? event : null);
    for (const field of ['source', 'name', 'activations', 'personality', 'design', 'overlay', 'designUtc', 'engine', 'birthDate']) {
      assert.equal(Object.hasOwn(overlay, field), false, `${field} belongs to a real source, not the composition`);
    }
    assert.equal(Object.isFrozen(overlay), true);
    assert.equal(Object.isFrozen(overlay.topology), true);
    assert.equal(Object.isFrozen(overlay.topology.personality), true);
    assert.equal(JSON.stringify({ natal, moment }), before);
  }
});

test('gate unions and all four exact activation owners survive the common overlay constructor', () => {
  const overlay = overlayFixture(natal, moment, { kind: 'return', event });
  assert.deepEqual(overlay.topology.personality, [4, 41, 63]); assert.deepEqual(overlay.topology.design, [19, 49]);
  assert.equal(createOverlaySourceState(overlay).masks.get(63), 5);
  for (const origin of ['natal', 'cycle']) for (const source of ['design', 'personality']) {
    const owner = origin === 'natal' ? natal : moment;
    const resolved = resolveOverlayActivation(overlay, `${origin}-${source}-sun`);
    assert.equal(resolved.chart, owner); assert.equal(resolved.entry, owner.activations[source][0]);
    assert.equal(resolved.origin, origin); assert.equal(resolved.source, source);
  }
});

test('overlay kind is explicit and a return cannot lose its event descriptor', () => {
  assert.throws(() => createChartComposition(natal, { secondary: moment }), /single/);
  assert.throws(() => createChartComposition(natal, { secondary: moment, kind: 'other' }), /kind/);
  assert.throws(() => createChartComposition(natal, { secondary: moment, kind: 'return' }), /event/);
  assert.throws(() => createChartComposition(natal, { kind: 'return', event }), /secondary/);
  assert.throws(() => createChartComposition(natal, { secondary: moment, kind: 'transit', event }), /event/);
});

test('overlay source names follow the saved chart and leave moment kind labels intact', () => {
  for (const [kind, label] of [['return', 'Возврат'], ['transit', 'Транзит']]) {
    const chart = overlayFixture(natal, moment, { kind, event: kind === 'return' ? event : null });
    assert.equal(overlayOriginLabel(chart, 'natal'), natal.name);
    assert.equal(overlayOriginLabel(chart, 'cycle'), label);
    assert.equal(resolveOverlayActivation(chart, 'natal-design-sun').label, `${natal.name} · Дизайн`);
    for (const name of [undefined, '', '   ']) {
      assert.equal(overlayOriginLabel(overlayFixture({ ...natal, name }, moment, { kind, event: kind === 'return' ? event : null }), 'natal'), 'Личная карта');
    }
  }
});


test('manual input remains gate-only even if stale activation rows are present', () => {
  const manual = { ...natal, source: 'manual' };
  const chart = overlayFixture(manual, moment, { kind: 'transit' });
  assert.deepEqual(chart.topology.design, [19, 49]);
  assert.equal(resolveOverlayActivation(chart, 'natal-design-sun'), null);
  assert.equal(resolveOverlayActivation(chart, 'cycle-design-sun').entry, moment.activations.design[0]);
});
