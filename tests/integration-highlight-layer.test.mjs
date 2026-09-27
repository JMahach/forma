import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { CHANNELS } from '../src/scene/geometry/chart-geometry.js';
import { INTEGRATION_ARMS, STEM_POINTS } from '../src/scene/geometry/integration-geometry.js';
import { INTEGRATION_IDS } from '../src/domain/topology.js';

const gate = id => ({ type: 'gate', id });
const ids = [10, 20, 34, 57, 26, 44];
const charts = {
  inactive: { personality: [], design: [] },
  black: { personality: ids, design: [] },
  red: { personality: [], design: ids },
  dual: { personality: ids, design: ids },
  mixed: { personality: [10, 20, 26], design: [34, 57, 44] },
};
const modes = [
  { name: 'idle', selections: [] },
  { name: 'single', selections: [gate(20)] },
  { name: 'center', selections: [{ type: 'center', id: 'throat' }] },
  { name: 'channel', selections: [{ type: 'channel', id: '20-57' }] },
  { name: 'crossing pair', selections: [gate(20), gate(57)] },
  { name: 'same-junction pair', selections: [gate(10), gate(20)] },
  { name: 'three gates', selections: [gate(10), gate(20), gate(57)] },
  { name: 'four gates', selections: [10, 20, 34, 57].map(gate) },
  { name: 'whole integration', selections: [{ type: 'integration', id: 'integration' }] },
  { name: 'gate hover', selections: [gate(20)], previewSelection: gate(57) },
  { name: 'whole hover', selections: [], previewSelection: { type: 'integration', id: 'integration' } },
];
const render = (chart, mode, extra = {}) => renderBodygraph(chart, null, {
  selections: mode.selections, previewSelection: mode.previewSelection, ...extra,
});
const classes = node => new Set((node.attrs.class || '').split(/\s+/));
const hasClass = (node, name) => classes(node).has(name);
const isHalo = node => node.name === 'path' && ['bg-integration-hover', 'bg-integration-selection', 'bg-integration-focus'].some(name => hasClass(node, name));
const parts = path => new Set(path.split(/(?=M)/).map(item => item.trim()).filter(Boolean));
const stemPath = STEM_POINTS.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

function parseSvg(markup) {
  const root = { name: 'root', children: [] }, stack = [root], nodes = [];
  for (const match of markup.matchAll(/<!--[\s\S]*?-->|<\/?([A-Za-z][\w:-]*)\b[^>]*>/g)) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      const node = stack.pop();
      assert.equal(node.name, match[1], 'rendered SVG element nesting is valid');
      node.end = match.index + token.length;
      continue;
    }
    const attrs = Object.fromEntries([...token.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
    const node = { name: match[1], attrs, children: [], parent: stack.at(-1), start: match.index, end: match.index + token.length, token };
    node.parent.children.push(node);
    nodes.push(node);
    if (!token.endsWith('/>')) stack.push(node);
  }
  assert.equal(stack.length, 1, 'every rendered SVG element is closed');
  return { root, nodes };
}

function inside(node, ancestor) {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent === ancestor) return true;
  return false;
}

function inspect(markup) {
  const { nodes } = parseSvg(markup);
  const channels = nodes.find(node => hasClass(node, 'bodygraph-channels'));
  const layers = nodes.filter(node => hasClass(node, 'bodygraph-integration-highlights'));
  assert.ok(channels);
  assert.equal(layers.length, 1, 'one shared layer owns all integration halos');
  const layer = layers[0], halos = nodes.filter(isHalo);
  const physical = nodes.filter(node => node.name === 'path' && inside(node, channels)
    && ['#202020', '#c32d35', '#c6c2b9', '#ffffff'].includes(node.attrs.stroke));
  return { nodes, channels, layer, halos, physical };
}

// Derived from the prior physical baseline by multiplying only stroke widths
// and dual-lane offsets by 1.32. Every path and paint-order token is still covered.
const physicalBaselines = {
  inactive: 'e15a45c4e5ed90cded75ee1dbde0b5850759338a6aa14815f3568763f8eb4575',
  black: '49463a2bac593396162bad40b7e9d13eabbc6511748c4b4e510b8bdc0f36d1d5',
  red: '445b1978857ddd33252ccd656442999f25dceebd7b4dd98965e5fe0bc81fdcc0',
  dual: '418947bd62abb7f8425f42d5df054eb313eb70c662a0bebd46034684a3468a11',
  mixed: '5841b8767a0a3b6c4be97285808dde78e70cf96a10d12a5e4e9c8da602417e7a',
};

for (const mode of modes) {
  test(`${mode.name}: integration halos paint above ordinary channels and below physical integration`, () => {
    for (const [state, chart] of Object.entries(charts)) {
      const { nodes, channels, layer, halos, physical } = inspect(render(chart, mode));
      const ordinaryTargets = channels.children.filter(node => node.attrs['data-type'] === 'channel' && node.attrs['data-integration'] !== 'true');
      const physicalIntegration = nodes.find(node => node.attrs['data-junction'] === 'integration');
      const ordinaryPhysical = physical.filter(node => !inside(node, physicalIntegration));
      const integrationPhysical = physical.filter(node => inside(node, physicalIntegration));
      assert.equal(ordinaryTargets.length, 30);
      assert.equal(channels.children[ordinaryTargets.length], layer, 'the halo layer follows every ordinary channel target');
      assert.equal(channels.children[ordinaryTargets.length + 1], physicalIntegration, 'physical integration immediately follows its highlight layer');
      assert.ok(ordinaryTargets.every(target => target.end <= layer.start), 'adjacent SVG groups may share an exclusive end/start offset');
      assert.equal(layer.parent, channels);
      assert.equal(layer.attrs['pointer-events'], 'none');
      assert.equal(halos.length, mode.name === 'idle' ? 7 : 8, 'hover, six keyboard halos and any current selection share this layer');
      assert.ok(ordinaryPhysical.length >= 60, 'every ordinary physical channel path is checked');
      assert.ok(integrationPhysical.length >= 10, 'every physical integration path is checked');
      for (const halo of halos) {
        assert.ok(inside(halo, layer));
        assert.equal(halo.attrs['pointer-events'], 'none');
        for (const path of ordinaryPhysical) assert.ok(path.end < halo.start, `${state}: every integration halo paints above every ordinary physical path`);
        for (const path of integrationPhysical) assert.ok(halo.end < path.start, `${state}: every physical integration stroke paints above every integration halo`);
      }
      const crossing = nodes.find(node => node.attrs['data-type'] === 'channel' && node.attrs['data-id'] === '26-44');
      const whiteCrossing = physical.find(node => inside(node, crossing) && node.attrs.stroke === '#ffffff');
      assert.ok(whiteCrossing, '26–44 retains its white physical channel interior');
      assert.ok(whiteCrossing.end < layer.start, 'the complete halo layer paints above the white 26–44 crossing');
      assert.ok(layer.end <= physicalIntegration.start, 'the complete halo layer stays below the physical integration bundle');
      assert.ok(crossing.end < physicalIntegration.start, 'ordinary channels retain their order before the physical integration bundle');
      const hash = createHash('sha256').update(JSON.stringify(physical.map(node => node.token))).digest('hex');
      assert.equal(hash, physicalBaselines[state], `${state}: physical geometry, colors and paint order retain their baseline with exactly 32% wider strokes and offsets`);
    }
  });
}

test('every integration halo is outside all interactive targets and cannot intercept input', () => {
  for (const interactive of [true, false]) {
    const { nodes, layer, halos } = inspect(render(charts.dual, modes.find(mode => mode.name === 'crossing pair'), { interactive }));
    const targets = nodes.filter(node => node.attrs['data-type']);
    for (const halo of halos) {
      assert.ok(targets.every(target => !inside(halo, target)), 'interactive groups contain no integration halo paths');
      assert.equal(halo.attrs.tabindex, undefined);
      assert.equal(halo.attrs.role, undefined);
      assert.equal(halo.attrs['data-type'], undefined);
      assert.equal(halo.attrs['pointer-events'], 'none');
    }
    for (const node of nodes.filter(node => node === layer || inside(node, layer))) {
      assert.equal(node.attrs['pointer-events'], 'none');
      assert.equal(node.attrs.tabindex, undefined);
    }
    const bundle = nodes.find(node => node.attrs['data-junction'] === 'integration');
    const pointerTarget = nodes.find(node => inside(node, bundle) && node.name === 'path' && node.attrs.stroke === 'transparent');
    assert.ok(pointerTarget);
    assert.equal(pointerTarget.attrs['pointer-events'], interactive ? 'stroke' : 'none');
    assert.equal(pointerTarget.attrs['stroke-width'], '20', 'the existing complete integration pointer target is retained');
  }
});

test('all six keyboard-only channel targets retain transparent bounds matching their lower halo routes', () => {
  const { nodes, halos, layer } = inspect(render(charts.mixed, modes[0]));
  const keyboardTargets = nodes.filter(node => node.attrs['data-integration'] === 'true');
  assert.equal(keyboardTargets.length, 6);
  assert.deepEqual(new Set(keyboardTargets.map(node => node.attrs['data-id'])), INTEGRATION_IDS);
  for (const target of keyboardTargets) {
    const id = target.attrs['data-id'], channel = CHANNELS.find(item => item.id === id);
    assert.equal(target.attrs.tabindex, '0');
    assert.equal(target.attrs.role, 'button');
    assert.equal(target.attrs['aria-pressed'], 'false');
    const bounds = target.children.filter(node => hasClass(node, 'bg-integration-focus-target'));
    assert.equal(bounds.length, 1);
    assert.equal(target.children.length, 1, 'keyboard targets contain only their transparent route bounds');
    const halo = halos.find(node => hasClass(node, 'bg-integration-focus') && node.attrs['data-highlight-channel'] === id);
    assert.ok(halo);
    assert.ok(inside(halo, layer));
    assert.equal(bounds[0].attrs.d, halo.attrs.d);
    const expected = channel.gates.map(gate => INTEGRATION_ARMS.find(arm => arm.gate === gate).path);
    if ([10, 20].includes(channel.gates[0]) !== [10, 20].includes(channel.gates[1])) expected.push(stemPath);
    assert.deepEqual(parts(bounds[0].attrs.d), new Set(expected));
    assert.equal(bounds[0].attrs.fill, 'none');
    assert.equal(bounds[0].attrs.stroke, 'transparent');
    assert.equal(bounds[0].attrs['stroke-width'], '13.2');
    assert.equal(bounds[0].attrs['stroke-linecap'], 'round');
    assert.equal(bounds[0].attrs['stroke-linejoin'], 'round');
    assert.equal(bounds[0].attrs['pointer-events'], 'none');
    assert.equal(halo.attrs.opacity, '0');
  }
});

test('focus and hover CSS route interactive state to the matching lower highlight', () => {
  const markup = render(charts.inactive, modes[0]);
  const css = markup.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  assert.ok(css);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const focusRules = rules.filter(rule => rule.selector.includes(':has(') && rule.selector.includes('.bg-integration-focus['));
  assert.equal(focusRules.length, 6);
  for (const id of INTEGRATION_IDS) {
    const rule = focusRules.find(rule => rule.selector.includes(`[data-highlight-channel="${id}"]`));
    assert.ok(rule, `${id} has a relationship to its lower keyboard halo`);
    assert.match(rule.selector, /^\.bodygraph-channels:has\(>\s*\.bg-interactive/);
    assert.ok(rule.selector.includes(`[data-integration="true"][data-id="${id}"]:focus-visible)`));
    assert.ok(rule.selector.includes(`> .bodygraph-integration-highlights > .bg-integration-focus[data-highlight-channel="${id}"]`));
    assert.match(rule.body, /opacity\s*:\s*var\(--integration-focus-opacity,\s*1\)\s*;/);
  }
  for (const state of ['hover', 'focus-visible']) {
    const rule = rules.find(rule => rule.selector.includes(`:has(> .bg-interactive[data-type="integration"][data-visual-selected="false"]:${state})`));
    assert.ok(rule, `whole-integration ${state} reaches its lower halo`);
    assert.ok(rule.selector.endsWith('> .bodygraph-integration-highlights > .bg-integration-hover'));
    assert.match(rule.body, /opacity\s*:\s*1\s*;/);
  }
  assert.doesNotMatch(css, /\.bg-interactive:focus-visible\s*>\s*\.bg-integration-focus\s*\{/);
});

test('all lower-layer halos resolve their own prefixed masks in every selection mode', () => {
  for (const mode of modes) {
    const prefix = 'integrationPreview-v2';
    const { nodes, halos } = inspect(render(charts.mixed, mode, { idPrefix: prefix }));
    const definitions = new Map(nodes.filter(node => node.attrs.id).map(node => [node.attrs.id, node]));
    for (const halo of halos) {
      const maskId = halo.attrs.mask?.match(/^url\(#([^)]*)\)$/)?.[1];
      assert.ok(maskId?.startsWith(`${prefix}-integration-`));
      assert.equal(definitions.get(maskId)?.name, 'mask');
      const mask = definitions.get(maskId);
      for (const node of nodes.filter(node => inside(node, mask) && node.attrs['clip-path'])) {
        const clipId = node.attrs['clip-path'].match(/^url\(#([^)]*)\)$/)?.[1];
        assert.ok(clipId?.startsWith(`${prefix}-integration-`));
        assert.equal(definitions.get(clipId)?.name, 'clipPath');
      }
    }
    for (const id of INTEGRATION_IDS) {
      const focus = halos.find(node => node.attrs['data-highlight-channel'] === id);
      assert.equal(focus.attrs.mask, `url(#${prefix}-integration-focus-${id})`);
    }
  }
});

test('lower keyboard halos retain per-channel inactive dimming and brighten only active or related routes', () => {
  const centerForGate = { 10: 'g', 20: 'throat', 34: 'sacral', 57: 'spleen' };
  const cases = [{ chart: charts.inactive, mode: modes[0], activeGate: null, relatedGate: null }];
  for (const id of [10, 20, 34, 57]) {
    for (const source of ['black', 'red', 'dual']) {
      cases.push({
        chart: { personality: source === 'red' ? [] : [id], design: source === 'black' ? [] : [id] },
        mode: modes[0], activeGate: id, relatedGate: null,
      });
    }
    for (const mode of [
      { selections: [gate(id)] },
      { selections: [{ type: 'center', id: centerForGate[id] }] },
      { selections: [], previewSelection: gate(id) },
    ]) cases.push({ chart: charts.inactive, mode, activeGate: null, relatedGate: id });
  }
  for (const id of INTEGRATION_IDS) cases.push({
    chart: charts.inactive, mode: { selections: [{ type: 'channel', id }] }, activeGate: null, relatedGate: null, selectedChannel: id,
  });
  for (const scenario of cases) {
    const { nodes, halos, layer } = inspect(render(scenario.chart, scenario.mode, { dimInactive: true }));
    assert.equal(layer.attrs.opacity, undefined, 'a shared layer does not dim all keyboard routes together');
    for (const id of INTEGRATION_IDS) {
      const channel = CHANNELS.find(item => item.id === id);
      const related = channel.gates.includes(scenario.activeGate) || channel.gates.includes(scenario.relatedGate) || scenario.selectedChannel === id;
      const expected = related ? '1' : '0.2';
      const halo = halos.find(node => node.attrs['data-highlight-channel'] === id);
      const target = nodes.find(node => node.attrs['data-integration'] === 'true' && node.attrs['data-id'] === id);
      assert.equal(halo.attrs.style.match(/--integration-focus-opacity:\s*([^;]+)/)?.[1], expected, `${id} retains its own focus brightness`);
      assert.equal(target.attrs.opacity, expected, `${id} keyboard target and lower halo use the same dimming`);
      assert.equal(halo.attrs.opacity, '0', 'focus still controls whether the halo is visible');
    }
  }
  const { halos } = inspect(render(charts.inactive, modes[0], { dimInactive: false }));
  for (const halo of halos.filter(node => hasClass(node, 'bg-integration-focus'))) {
    assert.equal(halo.attrs.style.match(/--integration-focus-opacity:\s*([^;]+)/)?.[1], '1', 'disabling inactive dimming restores ordinary focus brightness');
  }
});
