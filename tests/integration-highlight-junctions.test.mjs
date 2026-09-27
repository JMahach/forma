import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { INTEGRATION_ARMS, STEM_POINTS } from '../src/scene/geometry/integration-geometry.js';
import { INTEGRATION_IDS } from '../src/domain/topology.js';
import { CENTERS, GATES, CHANNELS } from '../src/scene/geometry/chart-geometry.js';

const IDS = [10, 20, 34, 57];
const CENTER_GATE = { throat: 20, g: 10, sacral: 34, spleen: 57 };
const attribute = (markup, name) => markup.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const maskContent = (markup, prefix = 'bodygraph') => markup.match(new RegExp(`<mask id="${prefix}-integration-outline"[^>]*>([\\s\\S]*?)<\\/mask>`))?.[1];
const pathWithClass = (markup, name) => markup.match(new RegExp(`<path class="${name}"[^>]*\\/>`))?.[0];
const highlightLayer = markup => {
  const layer = markup.match(/<g class="bodygraph-integration-highlights"[^>]*>([\s\S]*?)<\/g>/)?.[1];
  assert.ok(layer, 'integration highlights live in their separate layer below physical integration');
  return layer;
};
const maskFor = (markup, overlay) => {
  const id = attribute(overlay, 'mask')?.match(/^url\(#([^)]+)\)$/)?.[1];
  assert.ok(id, 'every highlight has an explicit mask reference');
  const mask = markup.match(new RegExp(`<mask id="${id}"[^>]*>([\\s\\S]*?)<\\/mask>`))?.[1];
  assert.ok(mask, `mask ${id} exists in this rendered SVG`);
  return mask;
};
const clipFor = (markup, path) => {
  const id = attribute(path, 'clip-path')?.match(/^url\(#([^)]+)\)$/)?.[1];
  assert.ok(id, 'each owned arm has a geometric clipping reference');
  const clip = markup.match(new RegExp(`<clipPath id="${id}"[^>]*>([\\s\\S]*?)<\\/clipPath>`))?.[1];
  assert.ok(clip, `clip ${id} exists in this SVG`);
  return clip;
};
const ownedPaths = mask => [...mask.matchAll(/<path class="bg-integration-owned-(?:arm|stem)"[^>]*\/>/g)].map(match => match[0]);
const sampleCubic = (curve, steps = 512) => Array.from({ length: steps + 1 }, (_, index) => {
  const t = index / steps, u = 1 - t;
  return [0, 1].map(axis => u ** 3 * curve[0][axis] + 3 * u * u * t * curve[1][axis]
    + 3 * u * t * t * curve[2][axis] + t ** 3 * curve[3][axis]);
});
function polygonFromPath(path) {
  const tokens = path.match(/[MLCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi), points = [];
  let index = 0;
  const pair = () => [Number(tokens[index++]), Number(tokens[index++])];
  while (index < tokens.length) {
    const command = tokens[index++];
    if (command === 'M' || command === 'L') points.push(pair());
    else if (command === 'C') points.push(...sampleCubic([points.at(-1), pair(), pair(), pair()]).slice(1));
    else assert.equal(command, 'Z', 'ownership clips use only existing cubic contours and closing edges');
  }
  return points;
}
function pointInPolygon([x, y], polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
function distanceToPolyline(point, points) {
  return Math.min(...points.slice(1).map((b, index) => {
    const a = points[index], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
  }));
}
const subpaths = path => path.match(/M[^M]+/g).map(part => part.trim());
const stemPath = STEM_POINTS.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
const nodeParts = [...INTEGRATION_ARMS.map(arm => arm.path), stemPath];
const nodePath = nodeParts.join(' ');
const geometry = () => JSON.stringify({ CENTERS, GATES, CHANNELS, INTEGRATION_ARMS, STEM_POINTS });
const selections = [
  ...IDS.map(id => ({ type: 'gate', id })),
  ...Object.keys(CENTER_GATE).map(id => ({ type: 'center', id })),
  ...[...INTEGRATION_IDS].map(id => ({ type: 'channel', id })),
  { type: 'integration', id: 'integration' },
];
const crossesStem = gates => gates.some(id => [10, 20].includes(id)) && gates.some(id => [34, 57].includes(id));
const expectedParts = selection => {
  if (selection.type === 'integration') return nodeParts;
  const gates = selection.type === 'gate' ? [selection.id]
    : selection.type === 'center' ? [CENTER_GATE[selection.id]]
      : CHANNELS.find(channel => channel.id === selection.id).gates;
  const arms = gates.map(gate => INTEGRATION_ARMS.find(arm => arm.gate === gate).path);
  return [...arms, ...(selection.type === 'channel' && crossesStem(gates) ? [stemPath] : [])];
};
const fixtures = Array.from({ length: 256 }, (_, state) => {
  const personality = [], design = [];
  IDS.forEach((gate, index) => {
    const source = (state >> (index * 2)) & 3;
    if (source & 1) personality.push(gate);
    if (source & 2) design.push(gate);
  });
  return { personality, design };
});

// Captured before connected-route masks were introduced. These approved masks
// must remain byte-for-byte unchanged after normalizing only the approved width increase.
const legacyMaskHashes = {
  'gate:10': 'eed4d27de19ff4f2e4f23fe3e408e09f7e4108ae0063fab9c3128887d49b4328',
  'gate:20': '461b326f4b95f9fcfc5dace64c5edd9f15a4b636a1e651647a3f645c6b372ec8',
  'gate:34': '72c6c67093104b3372352807074dcf4d46df633f63c607dc62e5761b116717f5',
  'gate:57': 'b8b324a07baafcddd67599d698fb8fac46de1891f0dd388fa7e2aa76929ee499',
  'center:throat': '461b326f4b95f9fcfc5dace64c5edd9f15a4b636a1e651647a3f645c6b372ec8',
  'center:g': 'eed4d27de19ff4f2e4f23fe3e408e09f7e4108ae0063fab9c3128887d49b4328',
  'center:sacral': '72c6c67093104b3372352807074dcf4d46df633f63c607dc62e5761b116717f5',
  'center:spleen': 'b8b324a07baafcddd67599d698fb8fac46de1891f0dd388fa7e2aa76929ee499',
  'integration:integration': '7e4b164bee36e8e5e769894c21feb6d99558473d92b5bca6b02488245287c3ce',
};
const stripConnectedLayers = mask => mask.replace(/<path class="bg-integration-connected-[^"]+"[^>]*\/>/g, '');
const originalMaskWidths = mask => mask.replaceAll('stroke-width="13.2"', 'stroke-width="10"')
  .replaceAll('stroke-width="8.448"', 'stroke-width="6.4"');
const activeParts = chart => {
  const active = new Set([...(chart.personality || []), ...(chart.design || [])]);
  return [...INTEGRATION_ARMS.filter(arm => active.has(arm.gate)).map(arm => arm.path), ...(crossesStem([...active]) ? [stemPath] : [])];
};

function assertConnectedMask(markup, overlay, chart, context = '') {
  const mask = maskFor(markup, overlay), parts = subpaths(attribute(overlay, 'd'));
  const footprint = pathWithClass(mask, 'bg-integration-connected-footprint');
  const interior = pathWithClass(mask, 'bg-integration-connected-interior');
  const occlusion = pathWithClass(mask, 'bg-integration-connected-occlusion');
  const wholeInterior = pathWithClass(mask, 'bg-integration-interior');
  if (!parts.includes(stemPath)) {
    assert.equal(footprint, undefined, `${context}: same-fork routes preserve the physical terminal cuts`);
    assert.equal(interior, undefined);
    assert.equal(occlusion, undefined);
    assert.deepEqual(new Set(ownedPaths(mask).map(path => attribute(path, 'd'))), new Set(parts));
    assert.equal(ownedPaths(mask).length, 2);
    assert.ok(mask.endsWith(wholeInterior), 'all physical branches remain subtracted at same-fork junctions');
    return mask;
  }
  assert.ok(footprint && interior, `${context}: a connected route has its own continuous ring`);
  for (const [path, color, width] of [[footprint, '#ffffff', '13.2'], [interior, '#000000', '8.448']]) {
    assert.deepEqual(subpaths(attribute(path, 'd')), parts, `${context}: connected layers reuse the exact authored route`);
    assert.equal(attribute(path, 'fill'), 'none');
    assert.equal(attribute(path, 'stroke'), color);
    assert.equal(attribute(path, 'stroke-width'), width);
    assert.equal(attribute(path, 'stroke-linecap'), 'round');
    assert.equal(attribute(path, 'stroke-linejoin'), 'round');
    assert.equal(attribute(path, 'clip-path'), undefined, 'connected rings are not cut by single-arm terminal or ownership clips');
  }
  const expectedOcclusion = activeParts(chart).filter(path => !parts.includes(path));
  assert.equal(Boolean(occlusion), expectedOcclusion.length > 0, `${context}: only active unselected physical parts require protection`);
  if (occlusion) {
    assert.deepEqual(subpaths(attribute(occlusion, 'd')), expectedOcclusion, `${context}: inactive white neighbors never cut the connected ring`);
    for (const [name, value] of Object.entries({ fill: 'none', stroke: '#000000', 'stroke-width': '8.448', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
      assert.equal(attribute(occlusion, name), value, `${context}: active-neighbor ${name}`);
    }
    assert.equal(attribute(occlusion, 'clip-path'), undefined);
  }
  assert.equal(mask.slice(mask.indexOf(wholeInterior) + wholeInterior.length), footprint + interior + (occlusion || ''), 'the connected ring supersedes the full-node subtraction, then active occlusion is last');
  assert.ok(Math.abs((Number(attribute(footprint, 'stroke-width')) - Number(attribute(interior, 'stroke-width'))) / 2 - 2.376) < 1e-12, 'the halo band is exactly 32% wider at 2.376px');
  return mask;
}

test('the integration mask subtracts the complete physical node, including every inactive branch', () => {
  const baseline = maskContent(renderBodygraph());
  for (const selection of selections) {
    const markup = renderBodygraph({}, selection), mask = maskContent(markup);
    assert.equal(mask, baseline, `${selection.type}:${selection.id} uses the same full-node silhouette`);
    const cutout = pathWithClass(mask, 'bg-integration-interior');
    assert.equal(attribute(cutout, 'd'), nodePath);
    assert.equal(attribute(cutout, 'fill'), 'none');
    assert.equal(attribute(cutout, 'stroke'), '#000000');
    assert.equal(attribute(cutout, 'stroke-width'), '8.448');
    assert.equal(attribute(cutout, 'stroke-linecap'), 'round');
    assert.equal(attribute(cutout, 'stroke-linejoin'), 'round');
    assert.equal((mask.match(/<path\b/g) || []).length, 1, 'no active-only exclusions or artificial taper polygons');
    assert.equal((mask.match(/<rect\b/g) || []).length, 1);
    assert.match(mask, /^<rect x="0" y="0" width="640" height="820" fill="#ffffff"\/>/);
    assert.doesNotMatch(mask, /opacity|gradient|filter|taper|neighbor/);
  }
});

test('all 256 activation combinations preserve single masks and protect exactly the active neighbors of all connected channels', () => {
  const baseline = maskContent(renderBodygraph());
  const selectionMasks = new Map(selections.map(selection => {
    const markup = renderBodygraph({}, selection);
    return [selection, maskFor(markup, pathWithClass(markup, 'bg-integration-selection'))];
  }));
  assert.equal(selections.length, 15);
  const beforeGeometry = geometry();
  for (const [state, chart] of fixtures.entries()) for (const selection of selections) {
    const markup = renderBodygraph(chart, selection);
    const context = `${selection.type}:${selection.id}, activation state ${state}`;
    assert.equal(maskContent(markup), baseline, context);
    const halo = pathWithClass(markup, 'bg-integration-selection');
    const actualMask = maskFor(markup, halo);
    if (selection.type === 'channel') {
      assertConnectedMask(markup, halo, chart, context);
      assert.equal(stripConnectedLayers(actualMask), stripConnectedLayers(selectionMasks.get(selection)), `${context}: the underlying single-arm ownership remains activation-independent`);
    } else {
      assert.equal(actualMask, selectionMasks.get(selection), `${context}: single/center/whole ownership is activation-independent`);
      assert.equal(createHash('sha256').update(originalMaskWidths(actualMask)).digest('hex'), legacyMaskHashes[`${selection.type}:${selection.id}`], `${context}: approved mask bytes remain unchanged apart from stroke widths`);
      assert.doesNotMatch(actualMask, /bg-integration-connected-/);
    }
    const owned = ownedPaths(actualMask);
    assert.deepEqual(new Set(owned.map(path => attribute(path, 'd'))), new Set(selection.type === 'integration' ? [] : expectedParts(selection)), context);
    assert.deepEqual(subpaths(attribute(halo, 'd')), expectedParts(selection), context);
    assert.equal(attribute(halo, 'stroke'), '#c4d9f1', context);
    assert.equal(attribute(halo, 'stroke-width'), '13.2', context);
    assert.equal(attribute(halo, 'stroke-linecap'), selection.type === 'integration' ? 'butt' : 'round', context);
    assert.equal(attribute(halo, 'stroke-linejoin'), 'round', context);
  }
  assert.equal(geometry(), beforeGeometry, 'activation and highlight changes never mutate the bodygraph geometry');
});

test('individual and paired highlights reuse original independent subpaths without extending or joining their geometry', () => {
  for (const selection of selections) {
    const markup = renderBodygraph({}, selection);
    const halo = pathWithClass(markup, 'bg-integration-selection');
    const actual = subpaths(attribute(halo, 'd'));
    assert.deepEqual(actual, expectedParts(selection));
    assert.ok(actual.every(part => nodeParts.includes(part)), 'no newly sampled, joined or extended path is introduced');
    assert.equal(attribute(halo, 'stroke-linecap'), selection.type === 'integration' ? 'butt' : 'round', 'partial candidates cover the exact masked terminal plane');
    assert.doesNotMatch(markup, /data-integration-taper|bg-active-neighbor-cutout/);
    if (selection.type === 'channel') {
      const pair = CHANNELS.find(channel => channel.id === selection.id).gates;
      assert.equal(actual.length, crossesStem(pair) ? 3 : 2, 'only cross-junction channels highlight the shared stem');
    }
  }
});

test('all six keyboard-focus routes use equivalent ownership masks and exact selected-channel paint', () => {
  const prefix = 'keyboard-node';
  const markup = renderBodygraph({}, null, { idPrefix: prefix });
  const groups = [...markup.matchAll(/<g\s+data-type="channel"\s+data-id="([^"]+)"[^>]*data-integration="true"[^>]*>([\s\S]*?)<\/g>/g)];
  assert.equal(groups.length, 6);
  for (const [, id, content] of groups) {
    const focus = [...highlightLayer(markup).matchAll(/<path class="bg-integration-focus"[^>]*\/>/g)]
      .map(match => match[0]).find(path => attribute(path, 'data-highlight-channel') === id);
    assert.ok(focus, `${id} has a corresponding halo below physical integration`);
    const target = pathWithClass(content, 'bg-integration-focus-target');
    assert.ok(target, `${id} retains a transparent keyboard focus target`);
    assert.equal(attribute(target, 'd'), attribute(focus, 'd'), 'the transparent target retains the original channel bounds');
    assert.equal(attribute(target, 'stroke'), 'transparent');
    assert.equal(attribute(target, 'pointer-events'), 'none');
    assert.equal(pathWithClass(content, 'bg-integration-focus'), undefined, 'the keyboard target contains no colored focus path');
    const selectedMarkup = renderBodygraph({}, { type: 'channel', id }, { idPrefix: prefix });
    const selected = pathWithClass(selectedMarkup, 'bg-integration-selection');
    for (const name of ['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'pointer-events']) {
      assert.equal(attribute(focus, name), attribute(selected, name), `${id} focus and selection share ${name}`);
    }
    assert.equal(maskFor(markup, focus), maskFor(selectedMarkup, selected), `${id} focus and selection use the same physical-edge ownership`);
    assert.equal(attribute(focus, 'mask'), `url(#${prefix}-integration-focus-${id})`);
    assert.equal(attribute(focus, 'stroke-width'), '13.2', 'focus no longer draws an unmasked line inside the channel');
    assert.equal(attribute(focus, 'opacity'), '0');
  }
});

test('whole-integration hover and click share a single exterior mask without doubled hover paint', () => {
  const before = renderBodygraph({ personality: IDS, design: IDS });
  const after = renderBodygraph({ personality: IDS, design: IDS }, { type: 'integration', id: 'integration' });
  assert.equal(maskContent(before), maskContent(after));
  const hover = pathWithClass(before, 'bg-integration-hover');
  const selected = pathWithClass(after, 'bg-integration-selection');
  for (const name of ['d', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'mask']) {
    assert.equal(attribute(hover, name), attribute(selected, name));
  }
  assert.equal(attribute(hover, 'd'), nodePath);
  assert.equal(attribute(hover, 'mask'), 'url(#bodygraph-integration-outline)');
  assert.equal((after.match(/<mask\b/g) || []).length, 7, 'whole-node selection reuses hover mask while six channels retain their ownership masks');
  assert.match(after, /\.bodygraph-channels:has\(> \.bg-interactive\[data-type="integration"\]\[data-visual-selected="false"\]:hover\) > \.bodygraph-integration-highlights > \.bg-integration-hover \{ opacity: 1; \}/);
});

test('single halos exclude the whole physical node while connected rings exclude their own interior and active neighbors', () => {
  // Let U be the union of the five round-capped 8.448px background strokes.
  // Singles subtract U last. Connected routes S instead repaint their exact
  // 13.2px footprint, then subtract the 8.448px interior of S and active neighbors.
  // Therefore connected rings can cross inactive white branches, but never
  // their own physical route or an active neighboring physical stroke. Exact
  // path/cap/width identity proves those interior exclusions for every point.
  for (const selection of selections) {
    const markup = renderBodygraph({}, selection);
    const integration = markup.slice(markup.indexOf('data-junction="integration"'), markup.indexOf('<g class="bodygraph-centers">'));
    const physical = [...integration.matchAll(/<path\b[^>]*stroke="#c6c2b9"[^>]*\/>/g)].map(match => match[0]);
    const mask = maskContent(markup), cutout = pathWithClass(mask, 'bg-integration-interior');
    assert.equal(physical.length, 5);
    assert.deepEqual(subpaths(attribute(cutout, 'd')), physical.map(path => attribute(path, 'd')));
    for (const background of physical) {
      assert.equal(attribute(background, 'stroke-width'), attribute(cutout, 'stroke-width'));
      assert.equal(attribute(background, 'stroke-linecap'), attribute(cutout, 'stroke-linecap'));
      assert.equal(attribute(background, 'stroke-linejoin'), attribute(cutout, 'stroke-linejoin'));
    }
    const overlays = [...highlightLayer(markup).matchAll(/<path class="bg-integration-(?:selection|hover|focus)"[^>]*\/>/g)].map(match => match[0]);
    assert.equal(overlays.length, 8, 'selection, hover and all six focus paths participate in the invariant');
    for (const overlay of overlays) {
      const ownMask = maskFor(markup, overlay);
      assert.equal(pathWithClass(ownMask, 'bg-integration-interior'), cutout, 'every ownership mask retains the original full-node subtraction');
      const connected = pathWithClass(ownMask, 'bg-integration-connected-footprint');
      if (connected) assertConnectedMask(markup, overlay, {});
      else assert.ok(ownMask.endsWith(cutout), 'single and whole masks still subtract the complete physical interior last');
      assert.equal(attribute(overlay, 'fill'), 'none');
      assert.equal(attribute(overlay, 'stroke-width'), '13.2');
      assert.equal(attribute(overlay, 'stroke-linecap'), attribute(overlay, 'class') === 'bg-integration-hover' || selection.type === 'integration' && attribute(overlay, 'class') === 'bg-integration-selection' ? 'butt' : 'round');
      assert.ok(subpaths(attribute(overlay, 'd')).every(part => nodeParts.includes(part)));
      const selectedParts = subpaths(attribute(overlay, 'd'));
      const whole = selectedParts.length === nodeParts.length;
      const owned = ownedPaths(ownMask);
      assert.deepEqual(new Set(owned.map(path => attribute(path, 'd'))), new Set(whole ? [] : selectedParts));
      assert.doesNotMatch(ownMask, /bg-integration-neighbors/, 'neighbor halos never shorten a selected outline');
      for (const path of owned) {
        assert.equal(attribute(path, 'stroke'), '#ffffff');
        assert.equal(attribute(path, 'stroke-width'), '13.2');
        const gate = Number(attribute(path, 'data-owner-gate'));
        if (gate) {
          const outer = gate === 20 || gate === 57;
          assert.equal(attribute(path, 'stroke-linecap'), outer ? 'round' : 'butt');
          assert.equal(attribute(path, 'clip-path'), `url(#bodygraph-integration-${outer ? `end-${gate}` : 'inner-side'})`);
          clipFor(markup, path);
        } else {
          assert.equal(attribute(path, 'd'), stemPath);
          assert.equal(attribute(path, 'stroke-linecap'), 'butt');
          assert.equal(attribute(path, 'clip-path'), undefined);
        }
      }
      const connectedLayerCount = connected ? 2 + Number(Boolean(pathWithClass(ownMask, 'bg-integration-connected-occlusion'))) : 0;
      assert.equal((ownMask.match(/<path\b/g) || []).length, owned.length + 1 + connectedLayerCount, 'only the original ownership and specified connected-ring layers are present');
      assert.equal((ownMask.match(/<rect\b/g) || []).length, 1);
      assert.equal(attribute(ownMask.match(/^<rect[^>]*\/>/)[0], 'fill'), whole ? '#ffffff' : '#000000');
      // Each candidate is a 6.6px-radius stroke of existing paths only. Removing
      // its 4.224px physical interior leaves the existing 2.376px outer band.
      const bandWidth = (Number(attribute(overlay, 'stroke-width')) - Number(attribute(cutout, 'stroke-width'))) / 2;
      assert.ok(Math.abs(bandWidth - 2.376) < 1e-12);
    }
  }
});

test('connected masks retain both gap witnesses at the wider stroke boundary and reject active interiors', () => {
  const samples = new Map([...INTEGRATION_ARMS.map(arm => [arm.path, sampleCubic(arm.curve)]), [stemPath, STEM_POINTS]]);
  const distance = (point, paths) => Math.min(...paths.map(path => distanceToPolyline(point, samples.get(path))));
  const selection = { type: 'channel', id: '20-57' }, selectedParts = expectedParts(selection);
  // The original [170.112, 415.608] and [150.239, 492.171] witnesses move
  // 32% farther from the same selected centerline along their local normals.
  const witnesses = [{ gate: 10, point: [171.244204, 416.047246] }, { gate: 34, point: [151.465011, 492.360543] }];
  const opacityAfterPhysicalCutout = (mask, point) => {
    // Both witnesses lie inside U, so the unchanged base mask first makes them
    // black. Evaluate the actual subsequent round-stroke layers in paint order.
    let white = false;
    for (const [path] of mask.matchAll(/<path class="bg-integration-connected-[^"]+"[^>]*\/>/g)) {
      if (distance(point, subpaths(attribute(path, 'd'))) <= Number(attribute(path, 'stroke-width')) / 2) white = attribute(path, 'stroke') === '#ffffff';
    }
    return white;
  };
  for (const { gate, point } of witnesses) {
    const neighbor = INTEGRATION_ARMS.find(arm => arm.gate === gate);
    assert.ok(distance(point, selectedParts) > 4.224 && distance(point, selectedParts) < 6.6, 'the witness is inside the wider halo band but outside its selected route');
    assert.ok(distance(point, [neighbor.path]) < 4.224, 'the full-node cutout would remove this point inside an inactive neighbor');
    for (const chart of [{}, { personality: [20, 57] }, { design: [20, 57] }]) {
      const markup = renderBodygraph(chart, selection), halo = pathWithClass(markup, 'bg-integration-selection');
      const mask = assertConnectedMask(markup, halo, chart);
      assert.equal(opacityAfterPhysicalCutout(mask, point), true, `${gate}: mask eligibility is retained; physical integration is painted above its halo layer`);
    }
    for (const chart of [{ personality: [gate] }, { design: [gate] }, { personality: [gate], design: [gate] }]) {
      const markup = renderBodygraph(chart, selection), halo = pathWithClass(markup, 'bg-integration-selection');
      const mask = assertConnectedMask(markup, halo, chart);
      assert.equal(opacityAfterPhysicalCutout(mask, point), false, `${gate}: black, red and dual active neighbors remain protected`);
    }
  }
  for (const chart of [{}, { personality: IDS }, { design: IDS }]) {
    const markup = renderBodygraph(chart, selection), mask = maskFor(markup, pathWithClass(markup, 'bg-integration-selection'));
    for (const path of selectedParts) {
      const points = samples.get(path), point = points[Math.floor(points.length / 2)];
      assert.equal(opacityAfterPhysicalCutout(mask, point), false, 'the selected route interior stays black even where its white footprint repaints the base mask');
    }
  }
});

test('inner fork ownership follows the original outer curve and stops at the physical channel edge', () => {
  const outer = CHANNELS.find(channel => channel.id === '20-57');
  for (const gate of [10, 34]) {
    const markup = renderBodygraph({}, { type: 'gate', id: gate }, { idPrefix: `fork-${gate}` });
    const mask = maskFor(markup, pathWithClass(markup, 'bg-integration-selection'));
    const owned = ownedPaths(mask);
    assert.equal(owned.length, 1);
    assert.equal(attribute(owned[0], 'data-owner-gate'), String(gate));
    const clip = clipFor(markup, owned[0]);
    const boundary = attribute(clip.match(/<path[^>]*\/>/)[0], 'd');
    assert.ok(boundary.startsWith(`${outer.path} L `), 'side boundary reuses the complete authored outer curve');
    assert.equal((boundary.match(/C/g) || []).length, (outer.path.match(/C/g) || []).length, 'ownership introduces no altered fork curve');
    assert.match(boundary, / L 640 820 L 640 0 L [\d.]+ 0 Z$/, 'the region closes on the right side of the bodygraph');
    const cuts = [...mask.matchAll(/<path\b[^>]*stroke="#000000"[^>]*\/>/g)].map(match => match[0]);
    assert.equal(cuts.length, 1, 'no wider neighbor-halo subtraction can leave a gap');
    assert.equal(attribute(cuts[0], 'd'), nodePath);
    assert.equal(attribute(cuts[0], 'stroke-width'), '8.448', 'the selected fork reaches the existing physical channel boundary');
  }
});

test('outer 20 and 57 terminal clipping matches the exact rendered source endpoint and butt-cut normal', () => {
  const inside = (point, polygon) => {
    const crosses = polygon.map((a, index) => {
      const b = polygon[(index + 1) % polygon.length];
      return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    });
    return crosses.every(value => value >= -1e-6) || crosses.every(value => value <= 1e-6);
  };
  for (const gate of [20, 57]) for (const source of ['personality', 'design']) {
    const markup = renderBodygraph({ [source]: [gate] }, { type: 'gate', id: gate }, { idPrefix: `terminal-${gate}` });
    const arm = markup.match(new RegExp(`<g class="bg-integration-arm" data-arm="${gate}"[^>]*>([\\s\\S]*?)<\\/g>`))[1];
    const sourcePath = arm.match(/<path\b[^>]*stroke="(?:#202020|#c32d35)"[^>]*\/>/)[0];
    const points = [...attribute(sourcePath, 'd').matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
    const [end, before] = gate === 20 ? [points.at(-1), points.at(-2)] : [points[0], points[1]];
    const dx = end[0] - before[0], dy = end[1] - before[1], length = Math.hypot(dx, dy);
    const along = [dx / length, dy / length], across = [-along[1], along[0]];
    const mask = maskFor(markup, pathWithClass(markup, 'bg-integration-selection'));
    const owned = ownedPaths(mask)[0];
    const clip = clipFor(markup, owned);
    assert.match(clip, new RegExp(`data-terminal-gate="${gate}"`));
    const polygon = attribute(clip.match(/<polygon[^>]*\/>/)[0], 'points').split(/\s+/).map(pair => pair.split(',').map(Number));
    assert.equal(polygon.length, 4);
    const signedDistance = point => (point[0] - end[0]) * along[0] + (point[1] - end[1]) * along[1];
    assert.ok(polygon.slice(0, 2).every(point => Math.abs(signedDistance(point)) < 1e-6), `${gate}/${source} cut uses the actual source normal`);
    assert.ok(Math.hypot((polygon[0][0] + polygon[1][0]) / 2 - end[0], (polygon[0][1] + polygon[1][1]) / 2 - end[1]) < 1e-6, 'cut passes through the source endpoint');
    assert.ok(polygon.slice(2).every(point => signedDistance(point) < 0), 'clip retains the gate side of the endpoint');
    for (const side of [-5.94, 5.94]) {
      const justBefore = end.map((value, axis) => value + side * across[axis] - .01 * along[axis]);
      const justAfter = end.map((value, axis) => value + side * across[axis] + .01 * along[axis]);
      assert.ok(inside(justBefore, polygon), 'the terminal plane preserves each halo edge up to its endpoint');
      assert.ok(!inside(justAfter, polygon), 'no halo edge continues beyond the source butt cut');
    }
    assert.equal(attribute(sourcePath, 'stroke-linecap'), 'butt');
    assert.equal(attribute(owned, 'stroke-linecap'), 'round', 'candidate coverage reaches both sides of the sampled terminal plane');
  }
});

test('outer branch ownership removes far-side islands while preserving the left halo up to its terminal cut', () => {
  const outer = CHANNELS.find(channel => channel.id === '20-57');
  const physical = [...INTEGRATION_ARMS.map(arm => sampleCubic(arm.curve)), STEM_POINTS];
  for (const gate of [20, 57]) {
    const arm = INTEGRATION_ARMS.find(arm => arm.gate === gate);
    const neighbor = INTEGRATION_ARMS.find(item => item.gate === (gate === 20 ? 10 : 34));
    const markup = renderBodygraph({}, { type: 'gate', id: gate }, { idPrefix: `outer-${gate}` });
    const mask = maskFor(markup, pathWithClass(markup, 'bg-integration-selection'));
    const wrapper = mask.match(new RegExp(`<g clip-path="url\\(#outer-${gate}-integration-outer-owner-${gate}\\)">([\\s\\S]*?)<\\/g>`));
    assert.ok(wrapper, `${gate} applies outer ownership as well as its terminal clip`);
    const owned = ownedPaths(wrapper[1]);
    assert.equal(owned.length, 1);
    assert.equal(attribute(owned[0], 'data-owner-gate'), String(gate));
    const ownership = clipFor(markup, wrapper[0]);
    const paths = [...ownership.matchAll(/<path[^>]*\/>/g)].map(match => attribute(match[0], 'd'));
    assert.equal(paths.length, 2, 'ownership is the union of the outer side and the near side of the adjacent branch');
    assert.ok(paths.some(path => path.startsWith(`${outer.path} L `)), 'the outer side retains the original uninterrupted sweep');
    assert.ok(paths.some(path => path.startsWith(`${neighbor.path} L `)), 'the inner boundary follows the original neighboring cubic');
    const polygons = paths.map(polygonFromPath);
    const allowed = point => polygons.some(polygon => pointInPolygon(point, polygon));
    const [before, end] = sampleCubic(arm.curve, 48).slice(-2).map(point => point.map(value => Number(value.toFixed(2))));
    const dx = end[0] - before[0], dy = end[1] - before[1], length = Math.hypot(dx, dy);
    const along = [dx / length, dy / length];
    const right = [Math.abs(along[1]), -Math.sign(along[1]) * along[0]];
    const terminal = clipFor(markup, owned[0]);
    const terminalPolygon = attribute(terminal.match(/<polygon[^>]*\/>/)[0], 'points').split(/\s+/).map(pair => pair.split(',').map(Number));
    for (const back of [.01, .3]) {
      const ghost = end.map((value, axis) => value - back * along[axis] + 5.676 * right[axis]);
      const left = end.map((value, axis) => value - back * along[axis] - 5.676 * right[axis]);
      assert.ok(pointInPolygon(ghost, terminalPolygon), 'the old endpoint-only clip would allow this regression point');
      assert.ok(distanceToPolyline(ghost, sampleCubic(arm.curve)) < 6.6, 'the regression point lies inside the wider candidate halo');
      assert.ok(physical.every(points => distanceToPolyline(ghost, points) > 4.224), 'the wider physical cutout alone cannot remove this far-side island');
      assert.ok(!allowed(ghost), `${gate} does not repaint beyond the adjacent branch near its junction`);
      assert.ok(allowed(left), `${gate} preserves the free left halo until the exact terminal plane`);
      assert.ok(pointInPolygon(left, terminalPolygon), 'the preserved left edge reaches the same terminal cut');
    }
  }
});

test('highlight policy leaves original center, gate and channel geometry and source lanes unchanged', () => {
  const originalGeometry = geometry();
  const physicalRoutes = markup => [...markup.matchAll(/<path class="bg-channel-outline" d="([^"]+)"/g)].map(match => match[1]);
  const lanes = markup => [...markup.matchAll(/<path\b[^>]*stroke="(?:#202020|#c32d35)"[^>]*\/>/g)].map(match => match[0]);
  for (const chart of [fixtures[0], fixtures[1], fixtures[85], fixtures[170], fixtures[255], { personality: [10, 57], design: [20, 34] }]) {
    const baseline = renderBodygraph(chart);
    for (const selection of selections) {
      const selected = renderBodygraph(chart, selection);
      assert.deepEqual(physicalRoutes(selected), physicalRoutes(baseline));
      assert.deepEqual(lanes(selected), lanes(baseline), 'source-colored paths remain byte-for-byte identical');
    }
  }
  assert.equal(geometry(), originalGeometry);
});
