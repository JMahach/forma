import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { renderChartThumbnail } from '../src/views/thumbnail.js';
import { svgDocument, significantDOM, SVG_NS } from './helpers/svg-dom.mjs';

const priorOptions = { interactive: false, showActivations: false, showLabels: false, showBackdrop: true, idPrefix: 'thumbnail' };
const profile = { profile: 'thumbnail', idPrefix: 'thumbnail' };
// The published library generated all gates and hid them with this exact CSS.
const legacyThumbnail = chart => renderBodygraph(chart, null, priorOptions) + '<style>.bodygraph-gates { display: none; }</style>';
function parse(markup) {
  const document = svgDocument(), root = document.createElementNS(SVG_NS, 'svg');
  root.innerHTML = markup; return root;
}
const all = root => root.querySelectorAll('*');

// Compare actual painted SVG, pruning only zero-opacity artwork, transparent
// hit paths and definitions no surviving paint references. Keep group transforms,
// colors, stroke geometry, order and all resources used by visible artwork.
function visibleArtwork(markup) {
  const root = parse(markup);
  if (root.querySelectorAll('style').some(node => /\.bodygraph-gates\s*\{\s*display:\s*none;\s*\}/.test(node.textContent))) root.querySelector('.bodygraph-gates')?.remove();
  for (const node of all(root)) {
    if (node.localName === 'style' || node.getAttribute('opacity') === '0'
      || node.localName === 'path' && node.getAttribute('fill') === 'none' && node.getAttribute('stroke') === 'transparent') node.remove();
  }
  const resources = new Map(root.querySelectorAll('defs').flatMap(defs => defs.children.map(node => [node.getAttribute('id'), node])));
  const used = new Set();
  function references(node) {
    for (const name of node.getAttributeNames()) for (const [, id] of node.getAttribute(name).matchAll(/url\(#([^\)]+)\)/g)) {
      if (used.has(id)) continue;
      used.add(id);
      const resource = resources.get(id);
      if (resource) { references(resource); for (const child of all(resource)) references(child); }
    }
  }
  for (const node of all(root)) {
    let parent = node.parentNode, definition = false;
    while (parent) { if (parent.localName === 'defs') definition = true; parent = parent.parentNode; }
    if (!definition) references(node);
  }
  for (const [id, resource] of resources) if (!used.has(id)) resource.remove();
  for (const node of all(root).reverse()) {
    if (node.localName === 'defs' && !node.children.length || node.localName === 'g' && !node.children.length && !node.textContent.trim()) node.remove();
  }
  return significantDOM(root);
}

function integrationChart(code) {
  const personality = [], design = [];
  for (const gate of [20, 10, 34, 57]) {
    const side = code & 3; code >>= 2;
    if (side & 1) personality.push(gate);
    if (side & 2) design.push(gate);
  }
  return { personality, design };
}

test('thumbnail profile preserves every visible shape for empty, single, dual, full and all 256 integration states', () => {
  const charts = [{}, { personality: [7, 31], design: [] }, { personality: [7, 31, 37, 40], design: [7, 31, 37, 40] },
    { personality: Array.from({ length: 64 }, (_, index) => index + 1), design: Array.from({ length: 64 }, (_, index) => index + 1) },
    ...Array.from({ length: 256 }, (_, index) => integrationChart(index))];
  charts.forEach((chart, index) => assert.deepEqual(visibleArtwork(renderBodygraph(chart, null, profile)), visibleArtwork(legacyThumbnail(chart)), `chart ${index}`));
});

test('thumbnail profile excludes interaction-only geometry and is unaffected by accidentally supplied selections or display flags', () => {
  const chart = integrationChart(255), expected = renderBodygraph(chart, null, profile);
  assert.equal(renderBodygraph(chart, { type: 'integration', id: 'integration' }, {
    ...profile, interactive: true, showActivations: true, showGates: true, showLabels: true, showMandala: true,
    showMandalaLayer: true, dimInactive: true, showBackdrop: false,
    selections: [{ type: 'channel', id: '20-34' }], previewSelection: { type: 'center', id: 'root' },
  }), expected);
  assert.doesNotMatch(expected, /<style\b|<mask\b|<clipPath\b|tabindex=|role="button"|bg-interactive|bg-focus-shape|bg-center-highlight|bg-channel-highlight|data-highlight-gate|bg-integration-(?:hover|focus|selection)|stroke="transparent"/);
  assert.match(expected, /<linearGradient id="thumbnail-dual"/);
  assert.equal(decodeURIComponent(renderChartThumbnail(chart).split(',').slice(1).join(',')).includes(expected), true);
});

test('noninteractive stories still retain their explicitly selected paint and supporting masks', () => {
  const chart = integrationChart(255);
  const markup = renderBodygraph(chart, { type: 'integration', id: 'integration' }, { interactive: false, showBackdrop: true });
  assert.match(markup, /class="bg-integration-selection"/);
  assert.match(markup, /<mask id="bodygraph-integration-outline"/);
  assert.match(markup, /class="bg-gate-highlight"/);
});

test('thumbnail profile reduces markup and parsed nodes instead of merely hiding them', t => {
  const fixtures = { empty: {}, single: { personality: [7, 31], design: [] }, dual: { personality: [7, 31, 37, 40], design: [7, 31, 37, 40] }, integration: integrationChart(255) };
  for (const [name, chart] of Object.entries(fixtures)) {
    const before = legacyThumbnail(chart), after = renderBodygraph(chart, null, profile);
    const beforeNodes = all(parse(before)).length, afterNodes = all(parse(after)).length;
    assert.ok(after.length < before.length * 0.45, name);
    assert.ok(afterNodes < beforeNodes * 0.65, name);
    t.diagnostic(`${name}: ${Buffer.byteLength(before)} → ${Buffer.byteLength(after)} bytes; ${beforeNodes} → ${afterNodes} SVG nodes`);
  }
});
