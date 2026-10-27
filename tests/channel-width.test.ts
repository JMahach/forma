import { integrationArmMarkup } from './helpers/integration-markup.ts';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { CHANNELS, GATES } from '../src/scene/geometry/chart-geometry.ts';
import { INTEGRATION_IDS } from '../src/domain/topology.ts';

// Independent output requirements, deliberately not imported from the renderer:
// Another 25% after the approved width: 1.32 × 1.25 = 1.65 overall.
const WIDTH = { outline: 10.56, paint: 7.59, lane: 3.795, offset: 1.98, firstLane: 4.125, firstOffset: 1.815, halo: 16.5 };
const allGates = Array.from({ length: 64 }, (_, index) => index + 1);
const charts = {
  empty: {}, black: { personality: allGates }, red: { design: allGates },
  dual: { personality: allGates, design: allGates },
};
const ordinary = CHANNELS.filter(channel => !INTEGRATION_IDS.has(channel.id));
const gate = (id: number) => ({ type: 'gate' as const, id });
const attribute = (tag: string|undefined, name: string) => tag!.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const hasClass = (tag: string, name: string) => (attribute(tag, 'class') || '').split(/\s+/).includes(name);
const paths = (markup: string) => [...markup.matchAll(/<path\b[^>]*\/>/g)].map(match => match[0]);
const colored = (tags, color) => tags.filter((tag: string|undefined) => attribute(tag, 'stroke') === color);
const width = (tag: string|undefined) => Number(attribute(tag, 'stroke-width'));
const near = (actual: number, expected: number, tolerance: number, label: string) => assert.ok(Math.abs(actual - expected) <= tolerance,
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

const target = (markup: string, type: string, id: string|number) => group(markup,
  (  tag: string|undefined) => attribute(tag, 'data-type') === type && attribute(tag, 'data-id') === String(id));
function directPaths(content: string) {
  let depth = 0;
  const result = [];
  for (const [token] of content.matchAll(/<g\b[^>]*>|<\/g>|<path\b[^>]*\/>/g)) {
    if (token.startsWith('<g')) depth++;
    else if (token === '</g>') depth--;
    else if (depth === 0) result.push(token);
  }
  return result;
}

function assertWidths(tags: (string|undefined)[], count: number, expected: number, label: string) {
  assert.equal(tags.length, count, `${label}: number of paths`);
  tags.forEach((tag: string|undefined) => assert.equal(width(tag), expected, `${label}: stroke width`));
}

test('all ordinary channel outlines, inactive interiors and source paint are 25% wider than the approved 1.32 baseline', () => {
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
        mode === 'dual' ? WIDTH.firstLane : WIDTH.paint, `${mode} ${id}: black source`);
      assertWidths(colored(tags, '#c32d35'), mode === 'red' || mode === 'dual' ? 2 : 0,
        mode === 'dual' ? WIDTH.lane : WIDTH.paint, `${mode} ${id}: red source`);
    }
  }
});

test('all four integration arms and both stem halves use the same increased widths', () => {
  for (const [mode, chart] of Object.entries(charts)) {
    const markup = renderBodygraph(chart), content = target(markup, 'integration', 'integration');
    const backgroundAndStem = directPaths(content);
    assertWidths(paths(group(markup, tag => hasClass(tag, 'bodygraph-integration-outlines'))), 5, WIDTH.outline, `${mode}: four outlines and stem`);
    assertWidths(colored(backgroundAndStem, '#ffffff'), 5, WIDTH.paint, `${mode}: four white interiors and stem`);
    const checkSource = (tags: string[], count: number, label: string) => {
      assertWidths(colored(tags, '#202020'), mode === 'black' || mode === 'dual' ? count : 0,
        mode === 'dual' ? WIDTH.firstLane : WIDTH.paint, `${mode}: ${label}, black`);
      assertWidths(colored(tags, '#c32d35'), mode === 'red' || mode === 'dual' ? count : 0,
        mode === 'dual' ? WIDTH.lane : WIDTH.paint, `${mode}: ${label}, red`);
    };
    assert.equal(colored(backgroundAndStem, '#202020').length + colored(backgroundAndStem, '#c32d35').length, 0, 'no separate stem cuts');
    for (const id of [20, 10, 34, 57] as const) {
      checkSource(paths(integrationArmMarkup(content, id)), 1, `arm ${id}`);
    }
  }
});

const polyline = (tag: string|undefined) => [...attribute(tag, 'd')!.matchAll(/[ML]\s*(-?[\d.]+)[,\s]+(-?[\d.]+)/g)]
  .map(([, x, y]) => [Number(x), Number(y)]);

function assertLaneOffsets(single: string[], dual: string[], label: string) {
  const centered = colored(single, '#202020').map(polyline);
  const black = colored(dual, '#202020').map(polyline), red = colored(dual, '#c32d35').map(polyline);
  assert.ok(centered.length > 0, `${label}: source paint exists`);
  assert.equal(black.length, centered.length); assert.equal(red.length, centered.length);
  centered.forEach((points, index) => {
    assert.ok(points.length > 1);
    assert.equal(black[index].length, points.length); assert.equal(red[index].length, points.length);
    points.forEach((point: number[], step: number) => {
      const a = black[index][step], b = red[index][step];
      // These measurements use rendered polylines, not the renderer's offset
      // helper. Two-decimal SVG coordinates allow at most 0.015px rounding.
      near(Math.hypot(a[0] - point[0], a[1] - point[1]), WIDTH.firstOffset, 0.015, `${label}: black offset`);
      near(Math.hypot(b[0] - point[0], b[1] - point[1]), WIDTH.offset, 0.015, `${label}: red offset`);
      const separation = Math.hypot(a[0] - b[0], a[1] - b[1]);
      near(separation, 3.795, 0.015, `${label}: lane separation`);
      assert.ok((WIDTH.firstLane + WIDTH.lane) / 2 - separation > .11, `${label}: overlap prevents an antialiased white seam`);
      near((a[0] * 1.98 + b[0] * 1.815) / 3.795, point[0], 0.01, `${label}: common x centerline`);
      near((a[1] * 1.98 + b[1] * 1.815) / 3.795, point[1], 0.01, `${label}: common y centerline`);
      const before = points[Math.max(0, step - 1)], after = points[Math.min(points.length - 1, step + 1)];
      const dx = after[0] - before[0], dy = after[1] - before[1], length = Math.hypot(dx, dy);
      assert.ok(length > 0, `${label}: nonzero local direction`);
      const signed = (shifted: number[]) => (-dy * (shifted[0] - point[0]) + dx * (shifted[1] - point[1])) / length;
      near(signed(a), -WIDTH.firstOffset, 0.02, `${label}: black lane side`);
      near(signed(b), WIDTH.offset, 0.02, `${label}: red lane side`);
      near(signed(a) - WIDTH.firstLane / 2, -3.8775, .02, `${label}: original black exterior edge`);
      near(signed(b) + WIDTH.lane / 2, 3.8775, .02, `${label}: original red exterior edge`);
    });
  });
}

test('dual source lanes close the seam toward black and retain both outside edges throughout channels, arms and stem', () => {
  const single = renderBodygraph(charts.black), dual = renderBodygraph(charts.dual);
  for (const { id } of ordinary) {
    assertLaneOffsets(paths(target(single, 'channel', id)), paths(target(dual, 'channel', id)), id);
  }
  const singleIntegration = target(single, 'integration', 'integration');
  const dualIntegration = target(dual, 'integration', 'integration');
  for (const id of [20, 10, 34, 57] as const) {
    const arm = content => paths(integrationArmMarkup(content, id));
    assertLaneOffsets(arm(singleIntegration), arm(dualIntegration), `integration arm ${id}`);
  }
});

test('ordinary full-channel and gate-half highlights share the same exterior ring', () => {
  const markup = renderBodygraph(charts.dual, null, { selections: allGates.map(gate) });
  const highlights = paths(markup).filter(tag => hasClass(tag, 'bg-channel-highlight'));
  assertWidths(highlights, 30, 16.06, 'whole-channel highlights');
  const halfPaths = [...markup.matchAll(/<g data-highlight-gate="\d+"[^>]*>(<path[^>]*\/>)/g)].map(match => match[1]);
  assertWidths(halfPaths, 60, 16.06, 'gate-half highlights');
  for (const path of [...highlights, ...halfPaths]) assert.equal(width(path), 16.06, 'mask removes the physical outline plus its gap');
});

test('integration footprints, halos and physical cutouts stay aligned at the larger width', () => {
  const footprintClasses = ['bg-integration-owned-arm', 'bg-integration-owned-stem', 'bg-integration-connected-footprint'];
  const interiorClasses = ['bg-integration-interior', 'bg-integration-connected-interior', 'bg-integration-connected-occlusion'];
  const seen = new Set();
  for (const selections of [
    [gate(20)], [gate(34)], [gate(20), gate(10)], [gate(34), gate(57)],
    [gate(20), gate(34)], [gate(10), gate(57)], [{ type: 'integration' as const, id: 'integration' }],
  ] as const) {
    const markup = renderBodygraph(charts.dual, null, { selections });
    const tags = paths(markup);
    for (const name of [...footprintClasses, ...interiorClasses] as const) {
      for (const tag of tags.filter(tag => hasClass(tag, name))) {
        seen.add(name);
        assert.equal(width(tag), footprintClasses.includes(name) ? 16.06 : 12.06, name);
        assert.equal(attribute(tag, 'stroke'), footprintClasses.includes(name) ? '#ffffff' : '#000000', name);
      }
    }
    for (const name of ['bg-integration-selection', 'bg-integration-hover', 'bg-integration-focus', 'bg-integration-focus-target'] as const) {
      const selected = tags.filter(tag => hasClass(tag, name));
      assert.ok(selected.length > 0, name);
      selected.forEach(tag => assert.equal(width(tag), name === 'bg-integration-focus-target' ? WIDTH.halo : 16.06, name));
    }
    const physicalPath = attribute(directPaths(target(markup, 'integration', 'integration'))
      .find(tag => attribute(tag, 'stroke') === 'transparent'), 'd');
    for (const [mask] of markup.matchAll(/<mask\b[^>]*id="[^"]+-integration-[^"]*"[\s\S]*?<\/mask>/g)) {
      const maskPaths = paths(mask);
      assert.equal(attribute(maskPaths.find(tag => hasClass(tag, 'bg-integration-interior')), 'd'), physicalPath,
        'every mask cuts the exact four arms and shared stem');
      const connected = maskPaths.find(tag => hasClass(tag, 'bg-integration-connected-footprint'));
      if (connected) {
        const cutout = maskPaths.find(tag => hasClass(tag, 'bg-integration-connected-interior'));
        assert.equal(attribute(cutout, 'd'), attribute(connected, 'd'), 'connected ring has matching outer and inner paths');
        near((width(connected) - width(cutout)) / 2, 2, 1e-12, 'ownership footprint extends beyond the protected semantic interior');
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
  assertWidths(paths(markup).filter(tag => hasClass(tag, 'bg-center-highlight')), 9, 7.75, 'masked exterior center highlights');
  for (const { id, x, y } of GATES) {
    const body = target(markup, 'gate', id), circles = [...body.matchAll(/<circle\b[^>]*\/>/g)].map(match => match[0])
      .filter(tag => !hasClass(tag, 'bg-gate-glow'));
    assert.deepEqual(circles.map(tag => Number(attribute(tag, 'r'))), [8.975, 8.4, 8.4], `gate ${id}: hit/disc radii and adjusted decorative core`);
    assert.equal(attribute(circles[1], 'stroke'), 'none');
    assert.equal(attribute(circles[1], 'stroke-width'), undefined);
    assert.equal(attribute(circles[2], 'stroke'), 'none');
    assert.equal(Number(attribute(circles[2], 'r')), 8.4, 'core fits the approved precise-circle disc');
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
// gate-highlight.test.ts independently requires the new 9.9 label size.
const originalGateFont = (markup: string) => markup.replace(/font-size="9\.9"/g, 'font-size="11"');
// The later approved precise-circle markers are independent of channel width.
// Normalize their exact typography/paint to the historical gate presentation;
// current marker and pointer invariants are verified above and in gate-highlight.
const originalGateMarkers = (markup: string) => markup.replace(
  /(<g data-type="gate"[^>]*>)([\s\S]*?)(<\/g>)/g,
  (_all, opening, body, ending) => opening + body
    // The later mouse/touch split is independent of the channel-width oracle.
    .replace('<circle class="bg-gate-hit" r="8.975" fill="transparent" pointer-events="fill"', '<circle r="12.5" fill="transparent" pointer-events="all"')
    .replace(/(<circle class="bg-gate-(?:disc|highlight)"[^>]* r=")8\.4(")/g, '$19.5$2')
    .replace(/<text[^>]*font-size="10\.4"[^>]*fill="([^"]+)"[^>]*>(\d+)<\/text>/g,
      (_text, fill, id) => `<text y=".5" text-anchor="middle" dominant-baseline="central" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="9.9" font-weight="${fill === '#ffffff' ? '650' : '500'}" fill="${fill}" pointer-events="none">${id}</text>`) + ending);

// Gate contours were later removed independently of channel width. Restore
// only the exact current disc tag; radius, fill, highlight and hit area remain
// covered by the frozen oracle and the current assertions above.
const originalGateContour = (markup: string) => markup.replace(
  /(<circle class="bg-gate-disc" r="9\.5" fill="([^"]+)") stroke="none"( pointer-events="none"\/>)/g,
  (_tag, opening, fill, ending) => {
    const stroke = fill === 'transparent' ? 'none' : fill.startsWith('url(') ? '#202020' : fill;
    return `${opening} stroke="${stroke}" stroke-width=".8"${ending}`;
  });
// The later activation interaction change removes sticky pointer hover/tap
// decoration. Restore only those exact CSS lines for this geometry oracle.
const originalActivationStyle = (markup: string) => markup.replace(
  '    .bg-activation { cursor: pointer; outline: none; -webkit-tap-highlight-color: transparent; }\n',
  '    .bg-activation { cursor: pointer; outline: none; }\n    .bg-activation:hover rect { fill: #f1f4f8; }\n')
  // Explicit Safari baseline inheritance does not change channel geometry.
  .replace('    /* Safari needs explicit inheritance to keep the line suffix on the gate baseline. */\n    .bg-activation tspan { dominant-baseline: inherit; }\n', '')
  // Center hover now belongs to the shared preview controller; this oracle
  // covers the earlier width change, so restore only that former CSS line.
  .replace('      .bg-interactive:hover .bg-gate-highlight { opacity: 1; }\n',
    '      .bg-interactive:hover .bg-gate-highlight { opacity: 1; }\n      .bg-interactive:hover .bg-center-highlight { opacity: 1; }\n')
  // Moving activation backgrounds are independent of this frozen shape oracle.
  .replace('    .bg-activation[data-fluid-active="true"] > rect { fill: transparent; }\n', '')
  // Committed cell outlines are unrelated to channel geometry.
  .replace('    .bg-activation[aria-pressed="true"] > rect { stroke: #c4d9f1; stroke-width: 2; }\n', '');
// A later layout split supplies the standalone mandala fallback explicitly.
// These historical cases render normal charts, where that property is inert.
// Normalize only this exact metadata attribute, retaining every transform,
// painted path, hit target and original hash. mandala.test.ts covers its value.
const originalDrawingStyle = (markup: string) => markup.replace(
  /(<g class="bodygraph-drawing"(?: transform="[^"]*")?) style="--activation-column-expanded-offset:244px"/,
  '$1');
// The later stationary bloom is independent of width. Remove only its paint
// additions and decorative core tuning for this historical geometry oracle;
// gate-highlight.test.ts covers the current thin cores and retained boundaries.
function originalOutlineRecolor(markup: string, outlineWidth: number) {
  const outlines = markup.match(/<g class="bodygraph-integration-outlines" pointer-events="none">([\s\S]*?)<\/g>/)!;
  return markup.replace(outlines[0], '')
    .replace(/(<g data-type="integration"[^>]*>\n    )/, opening => opening + outlines[1])
    .replace(/\n      (<path class="bg-channel-outline"[^>]*\/>)(\n      [\s\S]*?<path class="bg-channel-highlight"[^>]*\/>)/g, '$2\n      $1')
    .replace(/<path class="bg-integration-(?:interior|connected-interior)"[^>]*\/>/g,
      path => path.replace(/stroke-width="[^"]+"/, `stroke-width="${outlineWidth}"`));
}
const originalHighlightGlow = (markup: string, legacyHaloWidth = 16.5) => originalOutlineRecolor(
  // The current highlight color is independent of this frozen geometry oracle.
  markup.replaceAll('#83a9d2', '#c4d9f1').replaceAll('#91bce9', '#c4d9f1'), Number((legacyHaloWidth * .64).toFixed(3)))
  .replace(/    <filter id="[^"]+-(?:gate|highlight)-glow"[^>]*>[\s\S]*?<\/filter>\n/g, '')
  // Exterior-only bloom is decorative; keep the frozen physical oracle intact.
  .replace(/    <mask id="[^"]+-highlight-(?:center-|underpass-)?exterior"[^>]*>[\s\S]*?<\/mask>\n/g, '')
  .replace(/ mask="url\(#[^)]*-highlight-(?:center-|underpass-)?exterior\)"/g, '')
  .replace(/      <circle class="bg-gate-glow"[^>]*\/>\n/g, '')
  .replace(/ filter="url\(#[^)]*-(?:gate|highlight)-glow\)"/g, '')
  .replace(/(<g class="bodygraph-integration-highlights") mask="url\(#[^)]*-integration-outline\)"/, '$1')
  .replace(/(<circle class="bg-gate-highlight"[^>]* r=")9\.5("[^>]* stroke=")none(")/g, '$18.5$2#c4d9f1$3 stroke-width="2"')
  .replace(/<path\b[^>]*stroke="#c4d9f1"[^>]*\/>/g, path => path.replace(/stroke-width="[^"]+"/,
    `stroke-width="${hasClass(path, 'bg-center-highlight') ? 2.5 : legacyHaloWidth}"`))
  .replace(/^ +\.bg-interactive:(?:hover|focus-visible) \.bg-gate-glow \{ opacity: 1; \}\n/gm, '')
  .replaceAll('opacity: var(--integration-focus-opacity, 1); transition-duration: 92ms;', 'opacity: var(--integration-focus-opacity, 1);');
test('non-channel SVG and terminal clipping remain byte-identical to the previous renderer', () => {
  const selections = [gate(54), { type: 'center' as const, id: 'throat' },
    { type: 'channel' as const, id: '37-40' }, { type: 'integration' as const, id: 'integration' }];
  for (const [mode, chart] of Object.entries(charts)) {
    const markup = originalHighlightGlow(originalGateMarkers(renderBodygraph(chart, null, { selections, showLabels: true, dimInactive: true, idPrefix: 'width-check' })));
    const unchanged = {
      gatesAndCenters: originalGateFont(originalGateContour(markup.slice(markup.indexOf('<g class="bodygraph-centers">')))),
      clips: markup.match(/<clipPath\b[\s\S]*?<\/clipPath>/g),
      style: originalActivationStyle(markup.match(/<style>[\s\S]*?<\/style>/)![0]),
      pointerTargets: paths(markup).filter(tag => attribute(tag, 'stroke') === 'transparent'
        && attribute(tag, 'pointer-events') === 'stroke'),
    };
    assert.equal(createHash('sha256').update(JSON.stringify(unchanged)).digest('hex'), unchangedHashes[mode], mode);
  }
});

async function rendererAtScale(scale: number, legacyDualGap = false) {
  const rendererURL = new URL('../src/scene/bodygraph-svg.ts', import.meta.url);
  const paintURL = new URL('../src/scene/bodygraph-paint.ts', import.meta.url);
  const presentationURL = new URL('../src/scene/geometry/drawing-presentation.ts', import.meta.url);
  const presentationSource = await readFile(presentationURL, 'utf8');
  const setting = /^const CHANNEL_WIDTH_SCALE = 1\.65;$/gm;
  assert.equal([...presentationSource.matchAll(setting)].length, 1, 'one explicit width setting provides the rollback');
  const link = (source: string, base: string|URL|undefined, replacements = {}) => source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
    (_, quote, name) => {
      const url = new URL(name, base).href;
      return `from ${quote}${replacements[url] || url}${quote}`;
    });
  const moduleURL = (source: string) => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, { mode: 'strip' })).toString('base64');
  const presentation = moduleURL(link(presentationSource.replace(setting, `const CHANNEL_WIDTH_SCALE = ${scale};`), presentationURL));
  const replacements = { [presentationURL.href]: presentation };
  let paintSource = await readFile(paintURL, 'utf8');
  // This full historical oracle predates the separately tested black seam fix.
  if (legacyDualGap) paintSource = paintSource.replaceAll('CHANNEL_WIDTH.firstLaneOffset', 'CHANNEL_WIDTH.laneOffset')
    .replaceAll('CHANNEL_WIDTH.firstLane', 'CHANNEL_WIDTH.lane');
  const paint = moduleURL(link(paintSource, paintURL, replacements));
  replacements[paintURL.href] = paint;
  const integrationURL = new URL('../src/scene/integration-paint.ts', import.meta.url);
  let integrationSource = await readFile(integrationURL, 'utf8');
  if (legacyDualGap) integrationSource = integrationSource.replaceAll('CHANNEL_WIDTH.firstLaneOffset', 'CHANNEL_WIDTH.laneOffset').replaceAll('CHANNEL_WIDTH.firstLane', 'CHANNEL_WIDTH.lane');
  replacements[integrationURL.href] = moduleURL(link(integrationSource, integrationURL, replacements));
  return (await import(moduleURL(link(await readFile(rendererURL, 'utf8'), rendererURL, replacements)))).renderBodygraph;
}

test('width scale 1 preserves original widths with continuous integration paths', async () => {
  const renderReverted = await rendererAtScale(1, true);
  const dual = paths(renderReverted(charts.dual));
  assertWidths(colored(dual, '#202020'), 64, 2.3, 'original black width');
  assertWidths(colored(dual, '#c32d35'), 64, 2.3, 'original red width');
  assertWidths(colored(paths(renderReverted(charts.black)), '#202020'), 64, 4.6, 'original single width');
});

test('width scale 1.2 restores the preceding paint, lane, halo and mask widths', async () => {
  const renderPrevious = await rendererAtScale(1.2);
  const markup = renderPrevious(charts.dual, null, { selections: [gate(20), gate(34)] });
  const tags = paths(markup);
  assertWidths(colored(tags, '#c6c2b9'), 35, 7.68, 'previous ordinary and integration outlines');
  assertWidths(colored(tags, '#202020'), 64, 3, 'black lanes retain the seam fix at the previous scale');
  assertWidths(colored(tags, '#c32d35'), 64, 2.76, 'previous dual red lanes');
  assertWidths(colored(paths(renderPrevious(charts.black)), '#202020'), 64, 5.52, 'previous single-source paint');
  for (const { id } of ordinary) {
    assertWidths(colored(paths(target(markup, 'channel', id)), '#ffffff'), 1, 5.52, `previous ${id} white interior`);
  }
  assertWidths(colored(paths(target(markup, 'integration', 'integration')), '#ffffff'), 5, 5.52,
    'previous integration white interiors');
  for (const name of ['bg-channel-highlight', 'bg-integration-owned-arm', 'bg-integration-owned-stem',
    'bg-integration-connected-footprint', 'bg-integration-selection', 'bg-integration-hover',
    'bg-integration-focus', 'bg-integration-focus-target'] as const) {
    const matching = tags.filter(tag => hasClass(tag, name));
    assert.ok(matching.length > 0, name);
    const decorative = name !== 'bg-integration-focus-target';
    matching.forEach(tag => assert.equal(width(tag), decorative ? 13.18 : 12, `previous physical width with replacement-outline policy: ${name}`));
  }
  for (const [mask] of markup.matchAll(/<mask\b[^>]*>[\s\S]*?<\/mask>/g)) {
    const id = attribute(mask, 'id')!;
    const cuts = colored(paths(mask), '#000000');
    if (!cuts.length) continue;
    for (const cut of cuts) {
      const lowerCrossing = id.endsWith('-highlight-underpass-exterior')
        && attribute(cut, 'd') !== CHANNELS.find(channel => channel.id === '26-44')!.path;
      const expected = attribute(cut, 'fill') === '#000000' ? 3.75 : lowerCrossing ? 7.68 : 9.18;
      assert.equal(width(cut), expected, `${id}: scaled physical edge and fixed 0.75-unit gap`);
    }
  }
});
