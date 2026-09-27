import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { CHANNELS, GATES } from '../src/scene/geometry/chart-geometry.js';
import { INTEGRATION_IDS } from '../src/domain/topology.js';

// Independent output requirements, deliberately not imported from the renderer:
// Another 10% after the first 20% increase: 1.2 × 1.1 = 1.32 overall.
const WIDTH = { outline: 8.448, paint: 6.072, lane: 3.036, offset: 1.584, halo: 13.2 };
const allGates = Array.from({ length: 64 }, (_, index) => index + 1);
const charts = {
  empty: {}, black: { personality: allGates }, red: { design: allGates },
  dual: { personality: allGates, design: allGates },
};
const ordinary = CHANNELS.filter(channel => !INTEGRATION_IDS.has(channel.id));
const gate = id => ({ type: 'gate', id });
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const hasClass = (tag, name) => (attribute(tag, 'class') || '').split(/\s+/).includes(name);
const paths = markup => [...markup.matchAll(/<path\b[^>]*\/>/g)].map(match => match[0]);
const colored = (tags, color) => tags.filter(tag => attribute(tag, 'stroke') === color);
const width = tag => Number(attribute(tag, 'stroke-width'));
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance,
  `${label}: expected ${expected}, received ${actual}`);

function group(markup, matches) {
  const opening = [...markup.matchAll(/<g\b[^>]*>/g)].find(match => matches(match[0]));
  assert.ok(opening, 'expected SVG group exists');
  const tokens = /<g\b[^>]*>|<\/g>/g;
  tokens.lastIndex = opening.index;
  let depth = 0;
  for (let token; (token = tokens.exec(markup));) {
    depth += token[0] === '</g>' ? -1 : 1;
    if (depth === 0) return markup.slice(opening.index + opening[0].length, token.index);
  }
  assert.fail('expected SVG group closes');
}

const target = (markup, type, id) => group(markup,
  tag => attribute(tag, 'data-type') === type && attribute(tag, 'data-id') === String(id));
function directPaths(content) {
  let depth = 0;
  const result = [];
  for (const [token] of content.matchAll(/<g\b[^>]*>|<\/g>|<path\b[^>]*\/>/g)) {
    if (token.startsWith('<g')) depth++;
    else if (token === '</g>') depth--;
    else if (depth === 0) result.push(token);
  }
  return result;
}

function assertWidths(tags, count, expected, label) {
  assert.equal(tags.length, count, `${label}: number of paths`);
  tags.forEach(tag => assert.equal(width(tag), expected, `${label}: stroke width`));
}

test('all ordinary channel outlines, inactive interiors and source paint are 32% wider than the original', () => {
  assert.equal(ordinary.length, 30);
  for (const [mode, chart] of Object.entries(charts)) {
    const markup = renderBodygraph(chart);
    for (const { id, path } of ordinary) {
      const tags = paths(target(markup, 'channel', id));
      const outline = tags.filter(tag => hasClass(tag, 'bg-channel-outline'));
      assertWidths(outline, 1, WIDTH.outline, `${mode} ${id}: outline`);
      assert.equal(attribute(outline[0], 'd'), path, `${id}: centerline remains the authored curve`);
      assertWidths(colored(tags, '#ffffff'), 1, WIDTH.paint, `${mode} ${id}: white interior`);
      assertWidths(colored(tags, '#202020'), mode === 'black' || mode === 'dual' ? 2 : 0,
        mode === 'dual' ? WIDTH.lane : WIDTH.paint, `${mode} ${id}: black source`);
      assertWidths(colored(tags, '#c32d35'), mode === 'red' || mode === 'dual' ? 2 : 0,
        mode === 'dual' ? WIDTH.lane : WIDTH.paint, `${mode} ${id}: red source`);
    }
  }
});

test('all four integration arms and both stem halves use the same increased widths', () => {
  for (const [mode, chart] of Object.entries(charts)) {
    const markup = renderBodygraph(chart), content = target(markup, 'integration', 'integration');
    const backgroundAndStem = directPaths(content);
    assertWidths(colored(backgroundAndStem, '#c6c2b9'), 5, WIDTH.outline, `${mode}: four outlines and stem`);
    assertWidths(colored(backgroundAndStem, '#ffffff'), 5, WIDTH.paint, `${mode}: four white interiors and stem`);
    const checkSource = (tags, count, label) => {
      assertWidths(colored(tags, '#202020'), mode === 'black' || mode === 'dual' ? count : 0,
        mode === 'dual' ? WIDTH.lane : WIDTH.paint, `${mode}: ${label}, black`);
      assertWidths(colored(tags, '#c32d35'), mode === 'red' || mode === 'dual' ? count : 0,
        mode === 'dual' ? WIDTH.lane : WIDTH.paint, `${mode}: ${label}, red`);
    };
    checkSource(backgroundAndStem, 2, 'stem halves');
    for (const id of [20, 10, 34, 57]) {
      checkSource(paths(group(content, tag => attribute(tag, 'data-arm') === String(id))), 1, `arm ${id}`);
    }
  }
});

const polyline = tag => [...attribute(tag, 'd').matchAll(/[ML]\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/g)]
  .map(([, x, y]) => [Number(x), Number(y)]);

function assertLaneOffsets(single, dual, label) {
  const centered = colored(single, '#202020').map(polyline);
  const black = colored(dual, '#202020').map(polyline), red = colored(dual, '#c32d35').map(polyline);
  assert.ok(centered.length > 0, `${label}: source paint exists`);
  assert.equal(black.length, centered.length); assert.equal(red.length, centered.length);
  centered.forEach((points, index) => {
    assert.ok(points.length > 1);
    assert.equal(black[index].length, points.length); assert.equal(red[index].length, points.length);
    points.forEach((point, step) => {
      const a = black[index][step], b = red[index][step];
      // These measurements use rendered polylines, not the renderer's offset
      // helper. Two-decimal SVG coordinates allow at most 0.015px rounding.
      near(Math.hypot(a[0] - point[0], a[1] - point[1]), WIDTH.offset, 0.015, `${label}: black offset`);
      near(Math.hypot(b[0] - point[0], b[1] - point[1]), WIDTH.offset, 0.015, `${label}: red offset`);
      near(Math.hypot(a[0] - b[0], a[1] - b[1]), 3.168, 0.015, `${label}: lane separation`);
      near((a[0] + b[0]) / 2, point[0], 0.01, `${label}: common x centerline`);
      near((a[1] + b[1]) / 2, point[1], 0.01, `${label}: common y centerline`);
      const before = points[Math.max(0, step - 1)], after = points[Math.min(points.length - 1, step + 1)];
      const dx = after[0] - before[0], dy = after[1] - before[1], length = Math.hypot(dx, dy);
      assert.ok(length > 0, `${label}: nonzero local direction`);
      const signed = shifted => (-dy * (shifted[0] - point[0]) + dx * (shifted[1] - point[1])) / length;
      near(signed(a), -WIDTH.offset, 0.02, `${label}: black lane side`);
      near(signed(b), WIDTH.offset, 0.02, `${label}: red lane side`);
    });
  });
}

test('dual source lanes remain centered at minus/plus 1.584px throughout channels, arms and stem', () => {
  const single = renderBodygraph(charts.black), dual = renderBodygraph(charts.dual);
  for (const { id } of ordinary) {
    assertLaneOffsets(paths(target(single, 'channel', id)), paths(target(dual, 'channel', id)), id);
  }
  const singleIntegration = target(single, 'integration', 'integration');
  const dualIntegration = target(dual, 'integration', 'integration');
  assertLaneOffsets(directPaths(singleIntegration), directPaths(dualIntegration), 'stem');
  for (const id of [20, 10, 34, 57]) {
    const arm = content => paths(group(content, tag => attribute(tag, 'data-arm') === String(id)));
    assertLaneOffsets(arm(singleIntegration), arm(dualIntegration), `integration arm ${id}`);
  }
});

test('ordinary full-channel and gate-half highlights expand together to 13.2px', () => {
  const markup = renderBodygraph(charts.dual, null, { selections: allGates.map(gate) });
  const highlights = paths(markup).filter(tag => hasClass(tag, 'bg-channel-highlight'));
  assertWidths(highlights, 30, WIDTH.halo, 'whole-channel highlights');
  const halfPaths = [...markup.matchAll(/<g data-highlight-gate="\d+">(<path[^>]*\/>)/g)].map(match => match[1]);
  assertWidths(halfPaths, 60, WIDTH.halo, 'gate-half highlights');
});

test('integration footprints, halos and physical cutouts stay aligned at the larger width', () => {
  const footprintClasses = ['bg-integration-owned-arm', 'bg-integration-owned-stem', 'bg-integration-connected-footprint'];
  const interiorClasses = ['bg-integration-interior', 'bg-integration-connected-interior', 'bg-integration-connected-occlusion'];
  const seen = new Set();
  for (const selections of [
    [gate(20)], [gate(34)], [gate(20), gate(10)], [gate(34), gate(57)],
    [gate(20), gate(34)], [gate(10), gate(57)], [{ type: 'integration', id: 'integration' }],
  ]) {
    const markup = renderBodygraph(charts.dual, null, { selections });
    const tags = paths(markup);
    for (const name of [...footprintClasses, ...interiorClasses]) {
      for (const tag of tags.filter(tag => hasClass(tag, name))) {
        seen.add(name);
        assert.equal(width(tag), footprintClasses.includes(name) ? WIDTH.halo : WIDTH.outline, name);
        assert.equal(attribute(tag, 'stroke'), footprintClasses.includes(name) ? '#ffffff' : '#000000', name);
      }
    }
    for (const name of ['bg-integration-selection', 'bg-integration-hover', 'bg-integration-focus', 'bg-integration-focus-target']) {
      const selected = tags.filter(tag => hasClass(tag, name));
      assert.ok(selected.length > 0, name);
      selected.forEach(tag => assert.equal(width(tag), WIDTH.halo, name));
    }
    const physicalPath = attribute(directPaths(target(markup, 'integration', 'integration'))
      .find(tag => attribute(tag, 'stroke') === 'transparent'), 'd');
    for (const [mask] of markup.matchAll(/<mask\b[\s\S]*?<\/mask>/g)) {
      const maskPaths = paths(mask);
      assert.equal(attribute(maskPaths.find(tag => hasClass(tag, 'bg-integration-interior')), 'd'), physicalPath,
        'every mask cuts the exact four arms and shared stem');
      const connected = maskPaths.find(tag => hasClass(tag, 'bg-integration-connected-footprint'));
      if (connected) {
        const cutout = maskPaths.find(tag => hasClass(tag, 'bg-integration-connected-interior'));
        assert.equal(attribute(cutout, 'd'), attribute(connected, 'd'), 'connected ring has matching outer and inner paths');
        near((width(connected) - width(cutout)) / 2, 2.376, 1e-12, 'visible halo per side');
      }
    }
  }
  assert.deepEqual(seen, new Set([...footprintClasses, ...interiorClasses]));
});

test('larger channel paint leaves gate/center dimensions and pointer hit areas unchanged', () => {
  const markup = renderBodygraph(charts.dual);
  const hits = paths(markup).filter(tag => attribute(tag, 'stroke') === 'transparent'
    && attribute(tag, 'pointer-events') === 'stroke');
  assert.equal(hits.length, 31);
  assertWidths(hits.filter(tag => hasClass(tag, 'bg-focus-shape')), 30, 19, 'ordinary pointer targets');
  assertWidths(hits.filter(tag => !hasClass(tag, 'bg-focus-shape')), 1, 20, 'integration pointer target');
  assertWidths(paths(markup).filter(tag => hasClass(tag, 'bg-center-shape')), 9, 1.25, 'center outlines');
  assertWidths(paths(markup).filter(tag => hasClass(tag, 'bg-center-highlight')), 9, 2.5, 'center highlights');
  for (const { id, x, y } of GATES) {
    const body = target(markup, 'gate', id), circles = [...body.matchAll(/<circle\b[^>]*\/>/g)].map(match => match[0]);
    assert.deepEqual(circles.map(tag => Number(attribute(tag, 'r'))), [12.5, 9.5, 8.5], `gate ${id}: radii`);
    assert.equal(width(circles[1]), 0.8); assert.equal(width(circles[2]), 2);
    assert.match(markup, new RegExp(`data-type="gate" data-id="${id}"[^>]*transform="translate\\(${x} ${y}\\)"`));
  }
});

// Frozen from the renderer immediately before the width change. These hashes
// cover complete gate/center markup, clip geometry, CSS and pointer targets;
// they intentionally exclude channel paint and masks whose widths must change.
const unchangedHashes = {
  empty: '67a0d6055b8b12f41fd9a1694b328b0833ef85f20f210de70bf17e7b55681532',
  black: 'a3e47a2b4150a768407e5e64c68237d3c99bf667d134c6ec9d5c63d3787d5b0a',
  red: 'fa3fc055238d3fc7473281b19ce0d8d961bd8642c7882036cd914515e1fbe444',
  dual: '04d11eb99d1ab8900cd13b7739a22f54ea869009e525c23d63022655e3d1bd6b',
};
// The later, user-requested 10% gate-label reduction is independent of width.
// Normalize only that typography change when comparing this historical oracle;
// gate-highlight.test.mjs independently requires the new 9.9 label size.
const originalGateFont = markup => markup.replace(/font-size="9\.9"/g, 'font-size="11"');
test('non-channel SVG and terminal clipping remain byte-identical to the previous renderer', () => {
  const selections = [gate(54), { type: 'center', id: 'throat' },
    { type: 'channel', id: '37-40' }, { type: 'integration', id: 'integration' }];
  for (const [mode, chart] of Object.entries(charts)) {
    const markup = renderBodygraph(chart, null, { selections, showLabels: true, dimInactive: true, idPrefix: 'width-check' });
    const unchanged = {
      gatesAndCenters: originalGateFont(markup.slice(markup.indexOf('<g class="bodygraph-centers">'))),
      clips: markup.match(/<clipPath\b[\s\S]*?<\/clipPath>/g),
      style: markup.match(/<style>[\s\S]*?<\/style>/)[0],
      pointerTargets: paths(markup).filter(tag => attribute(tag, 'stroke') === 'transparent'
        && attribute(tag, 'pointer-events') === 'stroke'),
    };
    assert.equal(createHash('sha256').update(JSON.stringify(unchanged)).digest('hex'), unchangedHashes[mode], mode);
  }
});

// Full SVG hashes captured from the pre-width-change renderer. They are fixed
// baselines, independent of the current source and any temporary backup files.
const rollbackCases = [
  {
    name: 'empty', args: [{}, null, {}],
    hash: '4f919dbf63f3debf2f14916b1a5765ce7522bfaf76355a274b55112b7f0bfd91',
  },
  {
    name: 'dual', args: [charts.dual, null, {}],
    hash: 'cc6e13c76ad916f284bc2fd14837097720db72088d1ea67ff2a314c970feed1f',
  },
  {
    name: 'pair20-34',
    args: [charts.dual, null, { selections: [gate(20), gate(34)], showLabels: true, idPrefix: 'rollback-pair' }],
    hash: '0fba4885216262abb39fcfbd62e164da72db61eca5e7f0158e6e97e47a433889',
  },
  {
    name: 'center+hover',
    args: [
      { personality: [20, 34, 37, 54], design: [10, 57, 40] },
      { type: 'center', id: 'throat' },
      { previewSelection: { type: 'center', id: 'sacral' }, dimInactive: true, showActivations: true, idPrefix: 'rollback-hover' },
    ],
    hash: '404f5ac4fc5ccd5565faa4845bff88c18ce116b36e6076c9f008ab1d8f0c052e',
  },
];

async function rendererAtScale(scale) {
  const rendererURL = new URL('../src/scene/bodygraph-svg.js', import.meta.url);
  const paintURL = new URL('../src/scene/bodygraph-paint.js', import.meta.url);
  const paintSource = await readFile(paintURL, 'utf8');
  const setting = /^const CHANNEL_WIDTH_SCALE = 1\.32;$/gm;
  assert.equal([...paintSource.matchAll(setting)].length, 1, 'one explicit width setting provides the rollback');
  const link = (source, base) => source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
    (_, quote, name) => `from ${quote}${new URL(name, base).href}${quote}`);
  const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const paint = moduleURL(link(paintSource.replace(setting, `const CHANNEL_WIDTH_SCALE = ${scale};`), paintURL));
  const source = (await readFile(rendererURL, 'utf8')).replace("'./bodygraph-paint.js'", `'${paint}'`);
  return (await import(moduleURL(link(source, rendererURL)))).renderBodygraph;
}

test('changing only the width scale to 1 restores the complete pre-change SVG', async () => {
  const renderReverted = await rendererAtScale(1);
  for (const { name, args, hash } of rollbackCases) {
    assert.equal(createHash('sha256').update(originalGateFont(renderReverted(...args))).digest('hex'), hash, name);
  }
});

test('width scale 1.2 restores the preceding paint, lane, halo and mask widths', async () => {
  const renderPrevious = await rendererAtScale(1.2);
  const markup = renderPrevious(charts.dual, null, { selections: [gate(20), gate(34)] });
  const tags = paths(markup);
  assertWidths(colored(tags, '#c6c2b9'), 35, 7.68, 'previous ordinary and integration outlines');
  assertWidths(colored(tags, '#202020'), 66, 2.76, 'previous dual black lanes');
  assertWidths(colored(tags, '#c32d35'), 66, 2.76, 'previous dual red lanes');
  assertWidths(colored(paths(renderPrevious(charts.black)), '#202020'), 66, 5.52, 'previous single-source paint');
  for (const { id } of ordinary) {
    assertWidths(colored(paths(target(markup, 'channel', id)), '#ffffff'), 1, 5.52, `previous ${id} white interior`);
  }
  assertWidths(colored(paths(target(markup, 'integration', 'integration')), '#ffffff'), 5, 5.52,
    'previous integration white interiors');
  for (const name of ['bg-channel-highlight', 'bg-integration-owned-arm', 'bg-integration-owned-stem',
    'bg-integration-connected-footprint', 'bg-integration-selection', 'bg-integration-hover',
    'bg-integration-focus', 'bg-integration-focus-target']) {
    const matching = tags.filter(tag => hasClass(tag, name));
    assert.ok(matching.length > 0, name);
    matching.forEach(tag => assert.equal(width(tag), 12, `previous ${name}`));
  }
  const cutouts = colored(tags, '#000000');
  assert.ok(cutouts.length > 0);
  cutouts.forEach(tag => assert.equal(width(tag), 7.68, 'previous physical mask cutouts'));
});
