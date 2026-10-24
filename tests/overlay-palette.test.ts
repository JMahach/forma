import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayFixture } from './helpers/chart-composition.ts';
import { OVERLAY_SOURCES, type OverlaySource } from '../src/domain/chart-overlay.ts';
import { PALETTE, gatePaint } from '../src/scene/bodygraph-paint.ts';
import { MANDALA_PALETTE, mandalaGateSets, mandalaSectorPaint, mandalaPlanetPaint } from '../src/scene/mandala-paint-rules.ts';
import { createRenderState } from '../src/scene/render-state.ts';
import { MANDALA_SECTORS } from '../src/scene/geometry/mandala-geometry.ts';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { createBodygraphPainter } from '../src/scene/bodygraph-painter.ts';
import { SVG_NS, svgDocument } from './helpers/svg-dom.ts';
const colors = { natal: '#c32d35', cycle: '#202020' };
const luminance = (color: string) => {
  const channels = color.slice(1).match(/../g)!.map((value: string) => parseInt(value, 16) / 255)
    .map((value: number) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
};
const contrast = (first: string, second: string) => {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};
function paintFor(source: OverlaySource) {
  const natal = { personality: [] as number[], design: [] as number[] }, cycle = { personality: [] as number[], design: [] as number[] };
  (source.origin === 'natal' ? natal : cycle)[source.source] = [63];
  const chart = overlayFixture(natal, cycle, { kind: 'transit' as const });
  return {
    gate: gatePaint({ id: 63, name: 'test' } as Parameters<typeof gatePaint>[0], createRenderState(chart, null, {})),
    sector: mandalaSectorPaint(MANDALA_SECTORS.find(value => value.gate === 63)!, mandalaGateSets(chart), new Set(), new Set()),
    planet: mandalaPlanetPaint(source.id, 'sun'),
  };
}
test('overlay uses two distinct origins consistently while retaining four source identities', () => {
  assert.deepEqual(OVERLAY_SOURCES.map(source => [source.id, source.bit]), [
    ['natal-personality', 1], ['natal-design', 2], ['cycle-personality', 4], ['cycle-design', 8] ]);
  // A change to ordinary chart styling must not recolor overlay provenance.
  const original = { ink: PALETTE.ink, design: PALETTE.design };
  try {
    Object.assign(PALETTE, { ink: '#123456', design: '#654321' });
    for (const source of OVERLAY_SOURCES) {
      const paint = paintFor(source), color = colors[source.origin];
      assert.equal(paint.gate.fill, color);
      assert.equal(paint.sector.sources[0].color, color);
      assert.equal(paint.planet.color, color);
    }
    const ordinary = { personality: [63], design: [63] };
    const overlay = overlayFixture(ordinary, ordinary, { kind: 'transit' as const });
    const root = svgDocument().createElementNS(SVG_NS, 'svg');
    root.innerHTML = renderBodygraph(ordinary);
    const painter = createBodygraphPainter(root);
    const gradient = root.querySelector('linearGradient');
    for (const [chart, expected] of [[overlay, ['#202020', '#c32d35']], [ordinary, ['#123456', '#654321']], [overlay, ['#202020', '#c32d35']]] as const) {
      painter.update(createRenderState(chart, null, {}));
      assert.equal(root.querySelector('linearGradient'), gradient, 'the mounted gradient survives chart changes');
      assert.deepEqual(gradient!.querySelectorAll('stop').map(stop => stop.getAttribute('stop-color')), expected);
      const channel = root.querySelector('.bodygraph-channels [data-id="4-63"]');
      const lanes = channel!.querySelectorAll('path').filter((path) => ['3.3', '3.036'].includes(path.getAttribute('stroke-width')!));
      assert.deepEqual(lanes.map(path => path.getAttribute('stroke')), expected);
      const fresh = svgDocument().createElementNS(SVG_NS, 'svg');
      fresh.innerHTML = renderBodygraph(chart);
      assert.deepEqual(fresh.querySelector('linearGradient')!.querySelectorAll('stop').map(stop => stop.getAttribute('stop-color')), expected);
    }
  } finally { Object.assign(PALETTE, original); }
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
