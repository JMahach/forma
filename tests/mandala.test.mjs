import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderMandala, mandalaPoint, MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from '../src/bodygraph/mandala.js';
import { GATE_ORDER as MANDALA_GATE_ORDER, GATE_LONGITUDE_START as MANDALA_LONGITUDE_START, GATE_WIDTH as MANDALA_GATE_WIDTH } from '../src/domain/gate-wheel.js';
import { MANDALA_FRAME } from '../src/bodygraph/mandala-mode.js';
import { renderVariableArrows } from '../src/activations/variable-arrows.js';
import { renderBodygraph } from '../src/bodygraph/bodygraph.js';

const calculator = readFileSync(new URL('../server/calculator.py', import.meta.url), 'utf8');
const normalize = longitude => ((longitude % 360) + 360) % 360;
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
function parseSvg(markup) {
  const document = { children: [] }, stack = [document];
  for (const [token] of markup.matchAll(/<[^>]+>|[^<]+/g)) {
    if (!token.startsWith('<')) { if (stack.at(-1).text !== undefined) stack.at(-1).text += token; continue; }
    if (token.startsWith('</')) {
      assert.equal(stack.pop()?.name, token.match(/^<\/([\w:-]+)/)?.[1]);
      continue;
    }
    const node = { name: token.match(/^<([\w:-]+)/)?.[1], attrs: attributes(token), children: [], text: '' };
    assert.ok(node.name);
    stack.at(-1).children.push(node);
    if (!token.endsWith('/>')) stack.push(node);
  }
  assert.equal(stack.length, 1, 'all SVG nodes close');
  assert.equal(document.children.length, 1, 'one standalone group');
  return document.children[0];
}
const gates = root => root.children.filter(node => (node.attrs.class || '').split(' ').includes('mandala-gate'));
const collect = (node, predicate) => [node, ...node.children.flatMap(child => collect(child, predicate))].filter(predicate);
const hasClass = (node, className) => (node.attrs.class || '').split(' ').includes(className);

test('mandala uses exactly the calculator gate order and longitude subdivision', () => {
  const order = JSON.parse(calculator.match(/^GATE_WHEEL = (\[[^\n]+\])/m)[1]);
  const start = Number(calculator.match(/position = \(lon - ([\d.]+)\) % 360/)[1]);
  const width = Number(calculator.match(/index = int\(position \/ ([\d.]+)\)/)[1]);
  assert.deepEqual(MANDALA_GATE_ORDER, order);
  assert.equal(MANDALA_LONGITUDE_START, start);
  assert.equal(MANDALA_GATE_WIDTH, width);
  assert.deepEqual([...MANDALA_GATE_ORDER].sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i + 1));
  assert.ok(Object.isFrozen(MANDALA_GATE_ORDER));
  const wheel = gates(parseSvg(renderMandala()));
  assert.equal(wheel.length, 64);
  wheel.forEach((node, index) => {
    assert.equal(Number(node.attrs['data-mandala-gate']), order[index]);
    assert.equal(Number(node.attrs['data-longitude-start']), normalize(start + index * width));
    assert.equal(Number(node.attrs['data-longitude-center']), normalize(start + (index + .5) * width));
    const label = node.children.find(child => child.name === 'text');
    assert.equal(label.text, String(order[index]));
    assert.deepEqual([Number(label.attrs.x), Number(label.attrs.y)], mandalaPoint(start + (index + .5) * width, MANDALA_GEOMETRY.labelRadius));
  });
});

test('wheel orientation follows seasonal longitude, not numerical gate order', () => {
  const { centerX: x, centerY: y, outerRadius: radius } = MANDALA_GEOMETRY;
  const rounded = values => values.map(value => Number(value.toFixed(3)));
  assert.deepEqual(mandalaPoint(0), rounded([x - radius, y]));
  assert.deepEqual(mandalaPoint(90), rounded([x, y + radius]));
  assert.deepEqual(mandalaPoint(180), rounded([x + radius, y]));
  assert.deepEqual(mandalaPoint(270), rounded([x, y - radius]));
  assert.deepEqual(mandalaPoint(360), mandalaPoint(0));
  const wheel = gates(parseSvg(renderMandala()));
  for (const [gate, longitude] of [[25, 0], [15, 90], [46, 180], [10, 270]]) {
    const entry = wheel.find(node => Number(node.attrs['data-mandala-gate']) === gate);
    assert.ok(normalize(longitude - Number(entry.attrs['data-longitude-start'])) < MANDALA_GATE_WIDTH, `gate ${gate} contains the seasonal longitude`);
  }
});

test('one gate can be empty, design-only, personality-only, or activated by both', () => {
  const root = parseSvg(renderMandala({ personality: [20, 34], design: [10, 34] }));
  const wheel = gates(root);
  for (const [gate, state, sources] of [[1, 'empty', []], [10, 'design', ['design']], [20, 'personality', ['personality']], [34, 'both', ['design', 'personality']]]) {
    const node = wheel.find(item => Number(item.attrs['data-mandala-gate']) === gate);
    assert.equal(node.attrs['data-mandala-state'], state);
    const sourceGroups = node.children.filter(child => child.attrs.class === 'mandala-source');
    assert.deepEqual(sourceGroups.map(child => child.attrs['data-mandala-source']), sources);
    assert.equal(collect(node, child => child.attrs.class === 'mandala-sector-fill').length, sources.length);
    assert.equal(collect(root, child => child.attrs.class === 'mandala-fan' && Number(child.attrs['data-mandala-gate']) === gate).length, sources.length);
    if (state === 'both') assert.notEqual(sourceGroups[0].children[0].attrs.d, sourceGroups[1].children[0].attrs.d, 'both sources occupy separate halves, neither hides the other');
  }
  assert.equal(wheel.filter(node => node.attrs['data-mandala-state'] !== 'empty').length, 3);
});

test('noninteractive mandala has no selectable, focusable or external content', () => {
  const markup = renderMandala({ personality: [1, 20], design: [34] }, { interactive: false });
  const root = parseSvg(markup);
  assert.equal(root.name, 'g');
  assert.equal(root.attrs.class, 'bodygraph-mandala');
  assert.equal(root.attrs['aria-hidden'], 'true');
  assert.equal(root.attrs['pointer-events'], 'none');
  assert.equal(root.attrs.focusable, 'false');
  assert.doesNotMatch(markup, /data-type=|tabindex=|role=|aria-pressed=|\sid=|\son\w+=|<script\b|<image\b|<foreignObject\b|href=|url\(/i);
  assert.doesNotMatch(markup, /NaN|undefined|Infinity/);
});

test('only the outer ring cells are interactive and reuse ordinary gate targets', () => {
  const root = parseSvg(renderMandala({ personality: [20] }));
  assert.equal(root.attrs['aria-hidden'], undefined, 'ring controls remain accessible');
  assert.notEqual(root.attrs['pointer-events'], 'none', 'the interactive ring is not inside a decorative-only ancestor');
  const targets = collect(root, node => node.attrs['data-type']);
  assert.equal(targets.length, 64);
  targets.forEach(node => {
    assert.equal(node.attrs['data-type'], 'gate');
    assert.equal(node.attrs['data-id'], node.attrs['data-mandala-gate']);
    assert.equal(node.attrs.role, 'button');
    assert.equal(node.attrs.tabindex, '0');
    assert.equal(node.attrs['aria-pressed'], 'false');
    assert.match(node.attrs.class, /\bbg-interactive\b/);
    const hit = node.children.find(child => child.attrs.class === 'mandala-gate-hit');
    assert.equal(hit?.attrs['pointer-events'], 'all');
    assert.match(hit.attrs.d, /A 373\.8 373\.8 0 0 0/);
    assert.match(hit.attrs.d, /A 340\.2 340\.2 0 0 1/);
    assert.equal(node.children.some(child => ['mandala-fan', 'mandala-ray'].includes(child.attrs.class)), false);
  });
  const field = root.children.find(node => node.attrs.class === 'mandala-field');
  assert.equal(field.attrs['pointer-events'], 'none');
  assert.equal(field.attrs['aria-hidden'], 'true');
  assert.equal(collect(field, node => node.attrs['data-type'] || node.attrs.tabindex || node.attrs['pointer-events'] === 'all').length, 0);
});

test('pinned gate selection and temporary preview share highlighting but not pressed state', () => {
  const selectedGates = new Set([10, 34]), relatedGates = new Set([10, 20, 34]);
  const root = parseSvg(renderMandala({}, { selectedGates, relatedGates }));
  for (const node of gates(root)) {
    const gate = Number(node.attrs['data-id']);
    assert.equal(node.attrs['aria-pressed'], String(selectedGates.has(gate)));
    assert.equal(node.attrs['data-related'], String(relatedGates.has(gate)));
    assert.equal(node.children.find(child => child.attrs.class === 'mandala-gate-highlight').attrs.opacity, relatedGates.has(gate) ? '1' : '0');
  }
  const noPreview = gates(parseSvg(renderMandala({}, { selectedGates })));
  assert.equal(noPreview.find(node => node.attrs['data-id'] === '20').attrs['data-related'], 'false');
  assert.equal(noPreview.find(node => node.attrs['data-id'] === '10').attrs['data-related'], 'true');
  assert.deepEqual([...selectedGates], [10, 34]);
  assert.deepEqual([...relatedGates], [10, 20, 34]);
});

test('five-percent wider ring, light edge, and labels fit the optional frame without changing its center', () => {
  const { centerX: cx, centerY: cy, outerRadius: outer, innerRadius: inner, labelRadius, rayRadius } = MANDALA_GEOMETRY;
  const bounds = MANDALA_FRAME.bounds;
  assert.ok(Object.isFrozen(MANDALA_GEOMETRY));
  assert.equal(cx, 320);
  assert.equal(cy, 398);
  for (const [radius, before] of [[outer, 356], [inner, 324], [labelRadius, 340], [rayRadius, 316]]) {
    assert.ok(Math.abs(radius - before * 1.05) < 1e-10, 'every mandala radius grows by exactly five percent');
  }
  assert.ok(rayRadius < inner && inner < labelRadius && labelRadius < outer);
  const radius = (outer + 6.5) * MANDALA_SCENE_SCALE;
  assert.ok(cx - radius >= bounds.x);
  assert.ok(cx + radius <= bounds.x + bounds.width);
  assert.ok(cy - radius >= bounds.y);
  assert.ok(cy + radius <= bounds.y + bounds.height, 'the enlarged wheel and cursor fit Home without shrinking the body');
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - cx) < 1e-8);
  assert.equal(bounds.y + bounds.height / 2, cy);
});

test('gate-only rendering is deterministic and does not modify saved data', () => {
  const chart = { name: 'Private', source: 'calculated', birthDate: '1990-01-01', personality: [20, 20, 34], design: [10], activations: { personality: [] } };
  const before = structuredClone(chart);
  const markup = renderMandala(chart);
  assert.equal(markup, renderMandala({ personality: [34, 20], design: [10] }));
  assert.equal(markup, renderMandala({ ...chart, name: 'Different', birthDate: '2000-01-01', source: 'manual' }));
  assert.deepEqual(chart, before);
  assert.notEqual(markup, renderMandala({ personality: [], design: [] }));
  assert.doesNotMatch(markup, /Private|1990-01-01/);
});

test('missing, transit and malformed chart data do not invent activations or inject markup', () => {
  const empty = renderMandala();
  assert.equal(empty, renderMandala(null));
  assert.equal(empty, renderMandala({ personality: false, design: {} }));
  assert.equal(empty, renderMandala({ personality: [0, 65, NaN, Infinity, 1.5, '<script>'], design: [] }));
  assert.equal(renderMandala({ personality: ['20'], design: [] }), renderMandala({ personality: [20], design: [] }));
  const wheel = gates(parseSvg(renderMandala({ source: 'transit', personality: [20], design: [] })));
  assert.equal(wheel.filter(node => node.attrs['data-mandala-state'] === 'personality').length, 1);
  assert.equal(wheel.filter(node => ['design', 'both'].includes(node.attrs['data-mandala-state'])).length, 0);
});

const entryAt = (planet, longitude) => {
  const position = normalize(longitude - MANDALA_LONGITUDE_START), index = Math.floor(position / MANDALA_GATE_WIDTH);
  return { planet, longitude, gate: MANDALA_GATE_ORDER[index], line: Math.min(6, Math.floor((position - index * MANDALA_GATE_WIDTH) / (MANDALA_GATE_WIDTH / 6)) + 1) };
};
const crossFixture = () => ({
  source: 'calculated', personality: [25, 46], design: [10, 15],
  activations: {
    personality: [entryAt('sun', .123), entryAt('earth', 180.123)],
    design: [entryAt('sun', 272.123), entryAt('earth', 92.123)],
  },
});
const markers = root => collect(root, node => node.attrs.class === 'mandala-planet-marker');
const knownPlanets = ['sun', 'earth', 'moon', 'north_node', 'south_node', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];

test('subdued mandala contrast rises fifteen percent while gate stripes gain extra clarity', () => {
  const chart = crossFixture();
  chart.activations.personality.push(entryAt('moon', 45.123));
  const root = parseSvg(renderMandala(chart, { relatedGates: new Set([25]) }));
  for (const [className, attribute, previous] of [
    ['mandala-well', 'fill-opacity', .132],
    ['mandala-engraving-edge', 'stroke-opacity', .33], ['mandala-fan', 'fill-opacity', .0715],
    ['mandala-cross-axis', 'stroke-opacity', .462], ['mandala-number', 'fill-opacity', .88],
  ]) {
    const nodes = collect(root, node => hasClass(node, className));
    assert.ok(nodes.length, className);
    for (const node of nodes) assert.ok(Math.abs(Number(node.attrs[attribute]) - Math.min(1, previous * 1.15)) < 1e-10, className);
  }
  const edge = collect(root, node => hasClass(node, 'mandala-engraving-edge'))[0];
  assert.equal(Number(edge.children.at(-1).attrs['stroke-opacity']), .1771);
  const separators = collect(root, node => hasClass(node, 'mandala-separator'));
  assert.equal(separators.length, 64);
  assert.ok(separators.every(node => Number(node.attrs['stroke-opacity']) === .4 && Number(node.attrs['stroke-width']) === .75));
  assert.ok(collect(root, node => hasClass(node, 'mandala-sector-fill')).every(node => Number(node.attrs['fill-opacity']) === .25));
  for (const marker of markers(root)) {
    const cross = ['sun', 'earth'].includes(marker.attrs['data-mandala-planet']);
    const ray = collect(marker, node => hasClass(node, 'mandala-planet-ray'))[0];
    const endpoint = collect(marker, node => hasClass(node, 'mandala-planet-endpoint'))[0];
    assert.equal(Number(ray.attrs['stroke-opacity']), cross ? .5313 : .2783);
    assert.equal(ray.attrs['stroke-width'], cross ? '.8' : '.55');
    assert.equal(Number(endpoint.attrs['fill-opacity']), cross ? 1 : .759);
  }
  for (const [source, color] of [['design', '#b6756a'], ['personality', '#727975']]) {
    const sourceMarkers = markers(root).filter(node => node.attrs['data-source'] === source);
    assert.ok(sourceMarkers.every(node => collect(node, child => hasClass(child, 'mandala-planet-ray'))[0].attrs.stroke === color));
  }
});

test('the contrast adjustment preserves white engraving and selection preview opacities', () => {
  const chart = crossFixture();
  const previewCross = {
    type: 'right-angle',
    positions: Object.entries(chart.activations).flatMap(([source, entries]) => entries.map(entry => ({ ...entry, source }))),
  };
  const root = parseSvg(renderMandala(chart, { relatedGates: new Set([25]), previewCross }));
  for (const [className, attribute, expected] of [
    ['mandala-engraving-light', 'stroke-opacity', .902],
    ['mandala-focus-sector', 'fill-opacity', .242], ['mandala-gate-highlight', 'fill-opacity', .77],
    ['mandala-cross-sector', 'fill-opacity', .15], ['mandala-cross-sector', 'stroke-opacity', .7],
    ['mandala-cross-preview-ray', 'stroke-opacity', .85],
  ]) {
    const nodes = collect(root, node => hasClass(node, className));
    assert.ok(nodes.length, className);
    for (const node of nodes) assert.equal(Number(node.attrs[attribute]), expected, className);
  }
});

test('mandala omits Color and Tone entirely and switching back restores the unchanged variable block', () => {
  const chart = crossFixture();
  for (const source of ['design', 'personality']) {
    chart.activations[source].push(entryAt('north_node', 31.123), entryAt('south_node', 211.123));
  }
  const before = structuredClone(chart);
  const variableBlock = renderVariableArrows(chart);
  assert.ok(variableBlock.includes('bodygraph-variables'), 'the fixture has valid variables');
  assert.equal((variableBlock.match(/class="variable-(?:color|tone)"/g) || []).length, 8);
  const normal = renderBodygraph(chart, null, { showActivations: true });
  const wheel = renderBodygraph(chart, null, { showActivations: true, showMandala: true });
  assert.ok(normal.includes(variableBlock), 'normal variables preserve their exact markup');
  assert.doesNotMatch(wheel, /bodygraph-variable|variable-color|variable-tone|variable-header-rule|>Цвет<|>Тон</);
  assert.equal((wheel.match(/class="activation-column"/g) || []).length, 2);
  assert.equal((wheel.match(/class="mandala-gate bg-interactive"/g) || []).length, 64);
  const physical = svg => svg.slice(svg.indexOf('<g class="bodygraph-channels">')).match(/<(?:path|circle|text)\b[^>]*>/g);
  assert.deepEqual(physical(wheel), physical(normal), 'gate numbers and physical drawing stay unchanged');
  assert.equal(renderBodygraph(chart, null, { showActivations: true, showMandala: false }), normal);
  assert.deepEqual(chart, before, 'toggling does not mutate saved data');
});

function assertExactMarker(marker, entry) {
  assert.equal(Number(marker.attrs['data-longitude']), entry.longitude);
  const endpoint = mandalaPoint(entry.longitude, MANDALA_GEOMETRY.innerRadius);
  const rays = collect(marker, node => hasClass(node, 'mandala-planet-ray'));
  assert.equal(rays.length, 1, 'one ray per saved activation');
  assert.equal(rays[0].name, 'path');
  assert.equal(rays[0].attrs.d, `M 320 398 L ${endpoint.join(' ')}`, 'ray reaches the exact longitude on the common inner circumference');
  assert.equal(hasClass(rays[0], 'mandala-cross-axis'), ['sun', 'earth'].includes(entry.planet));
  const endpoints = collect(marker, node => hasClass(node, 'mandala-planet-endpoint'));
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].name, 'circle');
  assert.deepEqual([Number(endpoints[0].attrs.cx), Number(endpoints[0].attrs.cy)], endpoint);
  assert.equal(collect(marker, node => node.attrs.tabindex || node.attrs['data-type'] || node.attrs['pointer-events'] === 'all').length, 0, 'exact rays remain decorative');
}

test('four Sun/Earth rays end at exact saved longitudes on the same circumference for both sources', () => {
  const chart = crossFixture(), before = structuredClone(chart);
  const rendered = renderMandala(chart), marks = markers(parseSvg(rendered));
  assert.equal(marks.length, 4);
  marks.forEach(marker => {
    const source = marker.attrs['data-source'], planet = marker.attrs['data-mandala-planet'];
    const entry = chart.activations[source].find(item => item.planet === planet);
    assertExactMarker(marker, entry);
  });
  assert.deepEqual(chart, before);
  assert.doesNotMatch(rendered, /incarnation|quarter|архетип|крест|четверть/i);
});

test('all known planet and node activations receive exact rays, not artificial gate-midpoint spokes', () => {
  const chart = {
    source: 'calculated', personality: [41], design: [41],
    activations: Object.fromEntries(['design', 'personality'].map(source => [source,
      knownPlanets.map((planet, index) => entryAt(planet, 302.1 + index * .1)),
    ])),
  };
  const before = structuredClone(chart), root = parseSvg(renderMandala(chart));
  const marks = markers(root);
  assert.equal(marks.length, knownPlanets.length * 2);
  assert.equal(collect(root, node => hasClass(node, 'mandala-ray')).length, 0, 'no fixed mid-sector rays remain');
  assert.equal(collect(root, node => hasClass(node, 'mandala-cross-axis')).length, 4, 'only Sun/Earth retain stronger cross styling');
  for (const source of ['design', 'personality']) {
    const sourceMarks = marks.filter(marker => marker.attrs['data-source'] === source);
    assert.deepEqual(sourceMarks.map(marker => marker.attrs['data-mandala-planet']).sort(), [...knownPlanets].sort());
    sourceMarks.forEach(marker => assertExactMarker(marker, chart.activations[source].find(entry => entry.planet === marker.attrs['data-mandala-planet'])));
    const paths = sourceMarks.map(marker => collect(marker, node => hasClass(node, 'mandala-planet-ray'))[0].attrs.d);
    assert.equal(new Set(paths).size, knownPlanets.length, 'several planets in the same gate retain their distinct exact angles');
  }
  assert.deepEqual(chart, before);
  assert.equal(renderMandala(chart), renderMandala(chart), 'exact rendering remains deterministic');
});

test('exact rays preserve longitude wraparound, gate boundaries and line boundaries', () => {
  const epsilon = 1e-7;
  const longitudes = [0, epsilon, 360 - epsilon, 302 - epsilon, 302, 302 + epsilon,
    302 + MANDALA_GATE_WIDTH - epsilon, 302 + MANDALA_GATE_WIDTH,
    302 + MANDALA_GATE_WIDTH / 6 - epsilon, 302 + MANDALA_GATE_WIDTH / 6,
    302 + MANDALA_GATE_WIDTH / 6 + epsilon];
  for (const longitude of longitudes) {
    const entry = entryAt('moon', longitude);
    const chart = { source: 'calculated', personality: [entry.gate], design: [], activations: { personality: [entry] } };
    const marks = markers(parseSvg(renderMandala(chart)));
    assert.equal(marks.length, 1, `valid boundary longitude ${longitude} is retained`);
    assertExactMarker(marks[0], entry);
  }
});

test('manual or gate-only charts never fabricate midpoint rays when exact positions are unavailable', () => {
  for (const chart of [{ personality: [25, 46], design: [10, 15] }, { ...crossFixture(), source: 'manual' }, null]) {
    const root = parseSvg(renderMandala(chart));
    assert.equal(markers(root).length, 0);
    assert.equal(collect(root, node => hasClass(node, 'mandala-ray') || hasClass(node, 'mandala-planet-ray')).length, 0);
  }
});

test('incomplete or invalid saved planet data never produces guessed marker positions', () => {
  assert.equal(markers(parseSvg(renderMandala({ ...crossFixture(), source: 'manual' }))).length, 0);
  assert.equal(markers(parseSvg(renderMandala({ source: 'calculated', personality: [25, 46], design: [10, 15] }))).length, 0);
  for (const patch of [{ longitude: null }, { longitude: '0.123' }, { longitude: NaN }, { longitude: Infinity }, { longitude: -1 }, { longitude: 360 }, { gate: 41 }, { gate: '25' }, { line: 6 }, { line: '1' }, { line: null }]) {
    const chart = crossFixture();
    Object.assign(chart.activations.personality[0], patch);
    const marks = markers(parseSvg(renderMandala(chart)));
    assert.equal(marks.length, 3);
    assert.equal(marks.some(marker => marker.attrs['data-source'] === 'personality' && marker.attrs['data-mandala-planet'] === 'sun'), false);
  }
  const duplicates = crossFixture();
  duplicates.activations.design.push(duplicates.activations.design[0]);
  assert.equal(markers(parseSvg(renderMandala(duplicates))).length, 3);
  const unknown = crossFixture();
  unknown.activations.personality.push(entryAt('unknown', .5), entryAt('<script>', .7), null);
  assert.equal(markers(parseSvg(renderMandala(unknown))).length, 4, 'unknown planet names are never rendered');
  assert.doesNotMatch(renderMandala(unknown), /<script>|unknown/);
  const malformed = { ...crossFixture(), activations: { personality: {}, design: false } };
  assert.equal(markers(parseSvg(renderMandala(malformed))).length, 0);
  const transit = { ...crossFixture(), source: 'transit' };
  const transitMarkers = markers(parseSvg(renderMandala(transit)));
  assert.equal(transitMarkers.length, 2);
  assert.ok(transitMarkers.every(marker => marker.attrs['data-source'] === 'personality'));
});
