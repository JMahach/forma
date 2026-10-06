import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayFixture } from './helpers/chart-composition.mjs';
import { OVERLAY_SOURCES } from '../src/domain/chart-overlay.js';
import { PALETTE, gatePaint } from '../src/scene/bodygraph-paint.js';
import { MANDALA_PALETTE, mandalaGateSets, mandalaSectorPaint, mandalaPlanetPaint } from '../src/scene/mandala-paint-rules.js';
import { createRenderState } from '../src/scene/render-state.js';
import { MANDALA_SECTORS } from '../src/scene/geometry/mandala-geometry.js';
const colors = { natal: '#c32d35', cycle: '#202020' };
const luminance = color => {
  const channels = color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
};
const contrast = (first, second) => {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};
function paintFor(source) {
  const natal = { personality: [], design: [] }, cycle = { personality: [], design: [] };
  (source.origin === 'natal' ? natal : cycle)[source.source] = [63];
  const chart = overlayFixture(natal, cycle, { kind: 'transit' });
  return {
    gate: gatePaint({ id: 63, name: 'test' }, createRenderState(chart, null, {})),
    sector: mandalaSectorPaint(MANDALA_SECTORS.find(value => value.gate === 63), mandalaGateSets(chart), new Set(), new Set()),
    planet: mandalaPlanetPaint(source.id, 'sun'),
  };
}
test('overlay uses two distinct origins consistently while retaining four source identities', () => {
  assert.deepEqual(OVERLAY_SOURCES.map(source => [source.id, source.bit]), [
    ['natal-personality', 1], ['natal-design', 2], ['cycle-personality', 4], ['cycle-design', 8] ]);
  for (const source of OVERLAY_SOURCES) {
    assert.equal(source.color, colors[source.origin]);
    const paint = paintFor(source);
    assert.equal(paint.gate.fill, source.color);
    assert.equal(paint.sector.sources[0].color, source.color);
    assert.equal(paint.planet.color, source.color);
  }
});
test('both overlay origins keep white gate numbers and planet symbols readable on the light canvas', () => {
  for (const source of OVERLAY_SOURCES) {
    const paint = paintFor(source);
    assert.ok(contrast(paint.gate.fill, paint.gate.textFill) >= 4.5, `${source.id}: gate numbers`);
    assert.ok(contrast(paint.planet.color, '#fffefd') >= 4.5, `${source.id}: planet symbols`);
  }
});
test('overlay palette leaves ordinary natal and transit paint and traditional center fills unchanged', () => {
  assert.deepEqual([PALETTE.ink, PALETTE.design, PALETTE.head, PALETTE.ajna, PALETTE.throat, PALETTE.heart],
    ['#202020', '#c32d35', '#edcd4c', '#79a367', '#b58a60', '#da514b']);
  assert.deepEqual([MANDALA_PALETTE.personality, MANDALA_PALETTE.design], ['#4b514e', '#ae6259']);
});
