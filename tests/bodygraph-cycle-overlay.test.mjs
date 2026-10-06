import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayFixture } from './helpers/chart-composition.mjs';
import { createRenderState } from '../src/scene/render-state.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { createBodygraphPainter } from '../src/scene/bodygraph-painter.js';
import { createSceneRenderer } from '../src/scene/renderer.js';
import { CHANNEL_WIDTH, PALETTE } from '../src/scene/bodygraph-paint.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';
import { SVG_NS, SvgElement, svgDocument, significantDOM } from './helpers/svg-dom.mjs';
const RETURN_OVERLAY = { kind: 'return', event: { id: 'fixture-return', body: 'saturn', cycle: 1 } };

SvgElement.prototype.getCTM = () => null;
const NATAL = '#c32d35', CYCLE = '#202020';
const chart = (personality = [], design = []) => ({ source: 'manual', personality, design });
function svg(chart, selection = null, options = {}) {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = renderBodygraph(chart, selection, options);
  return { root, document };
}
function assertBody(actual, chart, selection = null, options = {}) {
  const expected = svg(chart, selection, options).root;
  for (const selector of ['.bodygraph-drawing', 'defs'])
    assert.deepEqual(significantDOM(actual.querySelector(selector)), significantDOM(expected.querySelector(selector)), selector);
}
const gate = (root, id) => root.querySelector(`.bodygraph-gates [data-id="${id}"]`);
const center = (root, id) => root.querySelector(`.bodygraph-centers [data-id="${id}"] .bg-center-shape`);
const coloredPaths = node => node.querySelectorAll('path').filter(path => [NATAL, CYCLE].includes(path.getAttribute('stroke')));

test('shared overlay lanes and gate halves retain the baseline geometry independently of their colors', () => {
  const { root } = svg(overlayFixture(chart([63, 4]), chart([63, 4]), RETURN_OVERLAY));
  const channel = root.querySelector('.bodygraph-channels [data-id="4-63"]');
  const paths = channel.querySelectorAll('path').filter(path => path.getAttribute('stroke-width') === '3.036');
  assert.deepEqual(paths.map(path => path.getAttribute('d').split(' ')[0]),
    ['M342.58,106.00', 'M339.42,106.00', 'M342.58,131.00', 'M339.42,131.00']);
});

test('shared gate discs have exactly two adjoining fifty-percent halves', () => {
  const { root } = svg(overlayFixture(chart([63]), chart([63]), RETURN_OVERLAY));
  const gradientId = gate(root, 63).querySelector('.bg-gate-disc').getAttribute('fill').match(/^url\(#(.+)\)$/)[1];
  const stops = root.querySelector(`linearGradient[id="${gradientId}"]`).querySelectorAll('stop');
  assert.deepEqual(stops.map(stop => stop.getAttribute('offset')), ['50%', '50%']);
});

test('four source facts use the original black-red lane positions and fifty-fifty gate disc', () => {
  const gates = [63, 4, 20, 34], overlay = overlayFixture(chart(gates, gates), chart(gates, gates), RETURN_OVERLAY);
  const state = createRenderState(overlay, null, {}), { root } = svg(overlay);
  assert.equal(state.overlaySources.masks.get(63), 15, 'four independent source facts remain available to detail');
  const channel = root.querySelector('.bodygraph-channels [data-id="4-63"]');
  const paths = coloredPaths(channel);
  assert.equal(paths.length, 4, 'each channel half contains two origins, never four thin lanes');
  assert.deepEqual(paths.map(path => path.getAttribute('stroke')), [CYCLE, NATAL, CYCLE, NATAL]);
  for (const path of paths) assert.equal(path.getAttribute('stroke-width'), '3.036');
  assert.deepEqual(paths.map(path => path.getAttribute('d').split(' ')[0]),
    ['M342.58,106.00', 'M339.42,106.00', 'M342.58,131.00', 'M339.42,131.00']);
  const arm = coloredPaths(root.querySelector('.bg-integration-arm[data-arm="20"]'));
  assert.deepEqual(arm.map(path => [path.getAttribute('stroke'), path.getAttribute('stroke-width'), path.getAttribute('d').split(' ')[0]]),
    [[CYCLE, '3.036', 'M284.26,303.56'], [NATAL, '3.036', 'M283.74,300.44']]);
  assert.equal(Number(channel.querySelector('.bg-channel-outline').getAttribute('stroke-width')), CHANNEL_WIDTH.outline);
  const shared = gate(root, 63), disc = shared.querySelector('.bg-gate-disc');
  assert.equal(disc.getAttribute('r'), '9.5'); assert.equal(disc.getAttribute('stroke'), 'none');
  assert.equal(shared.querySelectorAll('circle').length, 3, 'the existing hit area, disc and selection halo remain the only gate marks');
  assert.equal(shared.querySelectorAll('path').length, 0, 'source ownership adds no arcs or extra outlines');
  const gradientId = disc.getAttribute('fill').match(/^url\(#(.+)\)$/)?.[1];
  const stops = root.querySelector(`linearGradient[id="${gradientId}"]`).querySelectorAll('stop');
  assert.deepEqual(stops.map(stop => stop.getAttribute('offset')), ['50%', '50%']);
  assert.deepEqual(stops.map(stop => stop.getAttribute('stop-color')), [CYCLE, NATAL]);
  assert.equal(root.querySelectorAll('linearGradient').length, 1);
  assert.equal(root.querySelectorAll('.cycle-origin-separator').length, 0);
  assert.equal(shared.querySelector('text').getAttribute('stroke'), null);
  for (const label of ['Личная карта · Личность', 'Личная карта · Дизайн', 'Возврат · Личность', 'Возврат · Дизайн'])
    assert.ok(shared.getAttribute('aria-label').includes(label), label);
});

test('mixed channel halves and integration branches keep their own origin without changing the native rail width', () => {
  const overlay = overlayFixture(chart([63, 20]), chart([], [4, 34]), RETURN_OVERLAY);
  const { root } = svg(overlay), channel = root.querySelector('.bodygraph-channels [data-id="4-63"]');
  assert.deepEqual(coloredPaths(channel).map(path => [path.getAttribute('stroke'), Number(path.getAttribute('stroke-width'))]), [[NATAL, CHANNEL_WIDTH.paint], [CYCLE, CHANNEL_WIDTH.paint]]);
  for (const [id, color] of [[63, NATAL], [4, CYCLE], [20, NATAL], [34, CYCLE]]) {
    assert.equal(gate(root, id).querySelector('.bg-gate-disc').getAttribute('fill'), color);
  }
  for (const [id, color] of [[20, NATAL], [34, CYCLE]]) {
    const arm = root.querySelector(`.bg-integration-arm[data-arm="${id}"]`);
    assert.deepEqual(coloredPaths(arm).map(path => path.getAttribute('stroke')), [color]);
  }
  const integration = root.querySelector('[data-type="integration"]');
  assert.deepEqual(integration.children.filter(node => node.tagName === 'path' && [NATAL, CYCLE].includes(node.getAttribute('stroke'))).map(node => node.getAttribute('stroke')), [NATAL, CYCLE], 'opposite stem halves retain their contributing origins');
});

test('all defined centers keep the original solid boundary while ownership stays in their description', () => {
  for (const [natal, cycle, label] of [
    [chart([63]), chart([4]), /только в соединении/],
    [chart(), chart([63, 4]), /в карте возврата/],
    [chart([63, 4]), chart([63]), /в натале/],
  ]) {
    const { root } = svg(overlayFixture(natal, cycle, RETURN_OVERLAY)), shape = center(root, 'head');
    assert.equal(shape.getAttribute('fill'), PALETTE.head);
    assert.equal(shape.getAttribute('stroke'), '#84715b');
    assert.equal(shape.getAttribute('stroke-width'), '1.25');
    assert.equal(shape.getAttribute('stroke-dasharray'), null);
    assert.match(root.querySelector('.bodygraph-centers [data-id="head"]').getAttribute('aria-label'), label);
  }
});

test('persistent paint invalidates exact ownership with unchanged unions and restores ordinary paint without replacing targets', () => {
  const natal = chart([63, 20, 41], [34]), cycle = chart([4, 34, 41], [20]);
  const first = overlayFixture(natal, cycle, RETURN_OVERLAY), swapped = overlayFixture(cycle, natal, RETURN_OVERLAY);
  assert.deepEqual(first.personality, swapped.personality); assert.deepEqual(first.design, swapped.design);
  const detailFirst = overlayFixture(chart([63]), chart([], [63]), RETURN_OVERLAY);
  const detailChanged = overlayFixture(chart([], [63]), chart([63]), RETURN_OVERLAY);
  for (const adopted of [false, true]) {
    const options = { idPrefix: 'origins', dimInactive: true }, { root, document } = svg(first, null, options);
    const painter = createBodygraphPainter(root, adopted ? createRenderState(first, null, options) : null, options);
    if (!adopted) painter.update(createRenderState(first, null, options), options);
    const targets = root.querySelectorAll('[data-type]'), originalGate = gate(root, 63);
    const scenarios = [swapped, first, detailFirst, detailChanged,
      overlayFixture(chart([63, 4]), chart([41]), RETURN_OVERLAY), overlayFixture(chart([41]), chart([63, 4]), RETURN_OVERLAY), natal];
    for (const current of scenarios) {
      const selection = { type: 'gate', id: 20 };
      assert.equal(painter.update(createRenderState(current, selection, options), options), true);
      assertBody(root, current, selection, options);
      root.querySelectorAll('[data-type]').forEach((node, index) => assert.equal(node, targets[index]));
      assert.equal(gate(root, 63), originalGate);
      document.parses.length = 0;
      assert.equal(painter.update(createRenderState(current, selection, options), options), false);
      assert.deepEqual(document.parses, [], 'identical ownership reuses every fragment and mask');
    }
    assert.equal(gate(root, 63).querySelector('.bg-gate-disc').getAttribute('fill'), PALETTE.ink);
    assert.equal(center(root, 'head').getAttribute('stroke-dasharray'), null);
    assert.equal(root.querySelector('.bodygraph-channels [data-cycle-origin]'), null);
  }
});

function variableChart() {
  const activations = Object.fromEntries(['personality', 'design'].map(source => [source,
    Object.entries({ sun: 302.0130208333333, earth: 122.0130208333333, north_node: 307.6380208333333, south_node: 127.6380208333333 })
      .map(([planet, longitude]) => ({ planet, ...gatePositionAtLongitude(longitude) }))]));
  return { source: 'calculated', activations, ...Object.fromEntries(['personality', 'design'].map(source => [source,
    [...new Set(activations[source].map(entry => entry.gate))]])) };
}

test('full and persistent overlay renders suppress variable arrows and restore them on exit across decorative modes', () => {
  const natal = variableChart(), overlay = overlayFixture(natal, chart([63, 4, 20, 34]), RETURN_OVERLAY);
  const options = { showActivations: true, showBackdrop: true };
  assert.ok(svg(natal, null, options).root.querySelector('.bodygraph-variables'));
  assert.equal(Boolean(svg(overlay, null, options).root.querySelector('.bodygraph-variables')), false);
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg'), renderer = createSceneRenderer(root);
  renderer.update(overlay, null, options);
  assert.equal(Boolean(root.querySelector('.bodygraph-variables')), false, 'the first scene mount must also suppress arrows');
  const target = gate(root, 41);
  for (const [current, mode, arrows] of [[natal, {}, true], [overlay, {}, false], [overlay, { showMandala: true }, false],
    [natal, { showMandala: true }, false], [natal, {}, true], [overlay, { showActivations: false }, false], [natal, {}, true]]) {
    const next = { ...options, ...mode }; renderer.update(current, null, next);
    assert.equal(Boolean(root.querySelector('.bodygraph-variables')), arrows);
    assertBody(root, current, null, next); assert.equal(gate(root, 41), target);
  }
});


test('identical return and transit masks still update source ownership labels without replacing geometry', () => {
  const natal = chart([41]), cycle = chart([63, 4]);
  const returning = overlayFixture(natal, cycle, RETURN_OVERLAY), transit = overlayFixture(natal, cycle, { kind: 'transit' });
  const options = { idPrefix: 'moment-ownership' }, { root } = svg(returning, null, options);
  const painter = createBodygraphPainter(root, createRenderState(returning, null, options), options);
  const target = gate(root, 63), head = root.querySelector('.bodygraph-centers [data-id="head"]');
  for (const [current, expected] of [[transit, 'Транзит'], [returning, 'Возврат']]) {
    assert.equal(painter.update(createRenderState(current, null, options), options), true);
    assert.equal(gate(root, 63), target); assert.match(target.getAttribute('aria-label'), new RegExp(expected));
    assert.match(head.getAttribute('aria-label'), current === transit ? /в карте транзита/ : /в карте возврата/);
    assertBody(root, current, null, options);
    assert.equal(painter.update(createRenderState(current, null, options), options), false);
  }
});

test('renaming the natal owner updates all accessible gate sources without changing gate node identity or paint', () => {
  const original = { ...chart([63, 4], [63]), name: 'Марат <g> & "друг"' };
  const moment = chart([63, 4], [63]), document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  const renderer = createSceneRenderer(root);
  const options = { showActivations: true };
  let savedGate;
  for (const name of [original.name, 'Анна & <svg>', 'Ш'.repeat(80)]) {
    const overlay = overlayFixture({ ...original, name }, moment, RETURN_OVERLAY);
    renderer.update(overlay, null, options);
    const target = gate(root, 63);
    if (savedGate) assert.equal(target, savedGate);
    savedGate = target;
    assert.ok(target.getAttribute('aria-label').includes(`${name} · Личность`));
    assert.ok(target.getAttribute('aria-label').includes(`${name} · Дизайн`));
    assertBody(root, overlay, null, options);
  }
});
