import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { createSceneRenderer } from '../src/scene/renderer.ts';
import { renderLoadingPlaceholder } from '../src/scene/loading-placeholder.ts';
import { PLANETS } from '../src/domain/planets.ts';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.ts';
import { MANDALA_SCENE_TRANSFORM } from '../src/scene/geometry/mandala-geometry.ts';
import { SVG_NS, SvgElement, svgDocument } from './helpers/svg-dom.ts';

SvgElement.prototype.getCTM = () => null;
const parse = (markup: string) => {
  const root = svgDocument().createElementNS(SVG_NS, 'svg');
  root.innerHTML = markup; return root;
};
const near = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) < 1e-8, `${label}: ${actual} != ${expected}`);
// Evaluate the authored SVG ancestor chain, including column pivot/row
// transforms. This detects missing ancestors and accidental double scaling.
function project(node: SvgElement | null, point: readonly number[]): readonly number[] {
  for (let current = node; current; current = current.parentNode) {
    const operations = [...(current.getAttribute?.('transform') || '').matchAll(/(matrix|translate|scale)\(([^)]+)\)/g)];
    for (const [, name, values] of operations.reverse()) {
      const [a, b, c, d, e, f] = values.trim().split(/[\s,]+/).map(Number), [x, y] = point;
      if (name === 'matrix') point = [a * x + c * y + e, b * x + d * y + f];
      else if (name === 'translate') point = [x + a, y + (b ?? 0)];
      else point = [x * a, y * (b ?? a)];
    }
  }
  return point;
}
function scale(node: (SvgElement&SVGElement)|null) {
  const origin = project(node, [0, 0]), unit = project(node, [1, 0]);
  return Math.hypot(unit[0] - origin[0], unit[1] - origin[1]);
}
function natalChart() {
  const longitude: Record<string, number> = { sun: 302.0130208333333, earth: 122.0130208333333,
    north_node: 307.6380208333333, south_node: 127.6380208333333 };
  const entries = PLANETS.map(([planet], index) => ({ planet, ...gatePositionAtLongitude(longitude[planet] ?? index * 23) }));
  return { source: 'calculated' as const, activations: { design: structuredClone(entries), personality: structuredClone(entries) },
    design: entries.map(entry => entry.gate), personality: entries.map(entry => entry.gate) };
}
const options = { profile: 'studio' as const, showBackdrop: true, showActivations: true };
const modes = [{}, { showMandala: true, showMandalaLayer: true }, { showMandalaLayer: true }, {}];
function measure(root: SvgElement, mandala: boolean) {
  const drawing = root.querySelector('.bodygraph-drawing');
  const backdrop = root.querySelector(mandala ? '.mandala-underlay' : '.chart-backdrop');
  assert.ok(backdrop);
  const shared = ['.bodygraph-channels', '.bodygraph-centers', '.bodygraph-gates', '.activation-columns'];
  for (const selector of shared) {
    const layer = root.querySelector(selector);
    assert.equal(layer!.parentNode, drawing, `${selector} remains inside the same permanent drawing`);
    near(scale(layer), 1 / .96, `${selector} has exactly the approved scale`);
  }
  assert.equal(backdrop!.parentNode, drawing, 'the silhouette shares the body and column parent');
  near(scale(backdrop), 1 / .96, 'silhouette scale');
  const bodyPoint = project(root.querySelector('.bodygraph-centers'), [320, 436]);
  near(bodyPoint[0], 320, 'G stays horizontally centered');
  near(bodyPoint[1], 398 + 26 / .96, 'G keeps the approved location in both modes');
  const result = { bodyPoint, silhouette: project(backdrop, [320, 80]), columns: [] as (readonly number[])[] };
  for (const columnSide of ['left', 'right'] as const) {
    const column = root.querySelector(`.activation-column[data-column-side="${columnSide}"]`);
    const text = column!.querySelector('.planet-symbol');
    near(scale(text), 1.09 / .96, `${columnSide} inherits both column and shared scales exactly once`);
    result.columns.push(project(text, [Number(text!.getAttribute('x')), Number(text!.getAttribute('y'))]));
  }
  const variables = root.querySelector('.bodygraph-variables');
  assert.equal(Boolean(variables), !mandala, 'variables retain their normal-only visibility');
  if (variables) {
    assert.equal(variables.parentNode, drawing);
    near(scale(variables.querySelector('.variable-block')), 1.09 / .96, 'variable headings keep the column scale');
  }
  const ring = root.querySelector('.mandala-scene');
  if (ring) {
    assert.equal(ring.parentNode, drawing!.parentNode, 'the wheel never inherits the body enlargement');
    assert.equal(ring.getAttribute('transform'), MANDALA_SCENE_TRANSFORM);
  }
  return result;
}

test('static studio body, silhouette and both columns keep the approved presentation in normal, open and outgoing modes', () => {
  const chart = natalChart();
  let expected;
  for (const mode of modes) {
    const root = parse(renderBodygraph(chart, null, { ...options, ...mode }));
    const actual = measure(root, Boolean(mode.showMandala));
    if (expected) assert.deepEqual(actual, expected, 'a decorative toggle must not change the body, silhouette or column geometry');
    else expected = actual;
  }
});

test('persistent toggles and reversals retain body targets, parents and presentation while the wheel appears and disappears', () => {
  const root = parse(''), renderer = createSceneRenderer(root), chart = natalChart();
  renderer.update(chart, null, options);
  const drawing = root.querySelector('.bodygraph-drawing');
  const targets = root.querySelectorAll('.bodygraph-drawing [data-type]');
  const parents = targets.map(node => node.parentNode);
  const layers = ['.bodygraph-channels', '.bodygraph-centers', '.bodygraph-gates', '.activation-columns'].map(selector => root.querySelector(selector));
  const expected = measure(root, false);
  for (const mode of [...modes, modes[1], modes[2], modes[1], modes[2], modes[0]] as const) {
    renderer.update(chart, { type: 'gate' as const, id: 20 }, { ...options, ...mode });
    assert.equal(root.querySelector('.bodygraph-drawing'), drawing);
    targets.forEach((node: { parentNode: unknown; }, index: number) => {
      assert.ok(drawing!.contains(node), `target ${index} remains attached`);
      assert.equal(node.parentNode, parents[index], `target ${index} retains its parent`);
    });
    layers.forEach(node => assert.equal(node!.parentNode, drawing, 'body layers are never moved into a mode-specific wrapper'));
    assert.deepEqual(measure(root, Boolean(mode.showMandala)), expected);
  }
  renderer.clear();
  renderer.update(chart, null, options);
  assert.notEqual(root.querySelector('.bodygraph-drawing'), drawing, 'a true remount creates a fresh drawing');
  assert.deepEqual(measure(root, false), expected, 'a remount uses the same approved geometry');
});

test('loading paths and both column row centers retain the same complete ancestors in every studio mode', () => {
  for (const mode of modes) {
  const loading = parse(renderLoadingPlaceholder()), live = parse(renderBodygraph(natalChart(), null, { ...options, ...mode }));
  for (const point of [[320, 40], [320, 436], [320, 756]] as const) {
    assert.deepEqual(project(loading.querySelector('.loading-centers'), point), project(live.querySelector('.bodygraph-centers'), point));
    assert.deepEqual(project(loading.querySelector('.loading-channels'), point), project(live.querySelector('.bodygraph-channels'), point));
  }
  for (const columnSide of ['left', 'right'] as const) {
    const empty = loading.querySelector(`.activation-column[data-column-side="${columnSide}"]`)!.querySelectorAll('.loading-activation-row');
    const actual = live.querySelector(`.activation-column[data-column-side="${columnSide}"]`)!.querySelectorAll('.activation-row');
    assert.equal(empty.length, actual.length);
    empty.forEach((row, index) => {
      const glyph = row.querySelector('circle'), rect = actual[index].querySelector('.bg-planet rect');
      const center = [Number(rect!.getAttribute('x')) + Number(rect!.getAttribute('width')) / 2,
        Number(rect!.getAttribute('y')) + Number(rect!.getAttribute('height')) / 2];
      assert.deepEqual(project(glyph, [Number(glyph!.getAttribute('cx')), Number(glyph!.getAttribute('cy'))]),
        project(rect, center), 'the loading dot shares the live target center; glyph text has an optical offset');
    });
  }
  }
});
