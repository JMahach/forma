import test from 'node:test';
import assert from 'node:assert/strict';
import { CENTERS, GATES, CHANNELS, getGate } from '../src/scene/geometry/chart-geometry.ts';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import { svgDocument, SVG_NS } from './helpers/svg-dom.ts';
import { INTEGRATION_PATH, roundedCenter } from '../src/scene/geometry/drawing-geometry.ts';
import { INTEGRATION_IDS } from '../src/domain/topology.ts';

const attribute = (markup: string, name: string) => markup.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const gateGroups = (markup: string) => [...markup.matchAll(/<g\s+data-type="gate"\s+data-id="(\d+)"([^>]*)>([\s\S]*?)<\/g>/g)]
  .map(([, id, attributes, content]) => ({ id: Number(id), attributes, content }));
const circle = (group: { id: number; attributes: string; content: string; }|undefined, className: string) => group!.content.match(new RegExp(`<circle class="${className}"[^>]*\/>`))?.[0];
const outerRadius = (markup: string) => Number(attribute(markup, 'r')) + Number(attribute(markup, 'stroke-width') || 0) / 2;
const allActive = { personality: GATES.map(gate => gate.id), design: [] };
const groupContent = (markup: string, type: string, id: string) => markup.match(new RegExp(`<g\\s+data-type="${type}"\\s+data-id="${id}"[^>]*>([\\s\\S]*?)<\\/g>`))?.[1];
const highlightPath = (content: string, className: string) => content.match(new RegExp(`<path class="${className}"[^>]*\/>`))?.[0];
const sameVisiblePaint = (before: string|undefined, after: string|undefined, label: string) => {
  assert.ok(before && after, `${label} has a persistent hover/click element`);
  for (const name of ['r', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'] as const) {
    assert.equal(attribute(before!, name), attribute(after!, name), `${label} keeps ${name} after clicking`);
  }
  assert.equal(attribute(before!, 'stroke'), '#91bce9', `${label} is always light blue`);
};

test('center bloom is excluded from center and channel interiors without clipping its crisp border', () => {
  const root = svgDocument().createElementNS(SVG_NS, 'svg');
  root.innerHTML = renderBodygraph({}, { type: 'center', id: 'throat' }, { idPrefix: 'outside' });
  for (const highlight of root.querySelectorAll('.bg-center-highlight')) {
    const maskUrl = highlight.getAttribute('mask');
    assert.ok(maskUrl, 'center glow needs an exclusion after its blur, including hover and focus');
    const mask = root.querySelector(`mask[id="${maskUrl!.slice(5, -1)}"]`)!;
    assert.ok(mask, 'mask resolves within this chart');
    assert.equal(mask.getAttribute('maskUnits'), 'userSpaceOnUse');
    assert.equal(mask.querySelector('rect')?.getAttribute('fill'), '#ffffff', 'unoccupied exterior remains visible');
    const paths = mask.querySelectorAll('path');
    for (const center of CENTERS) {
      const cutout = paths.find(path => path.getAttribute('d') === roundedCenter(center.points));
      assert.ok(cutout, `${center.id} interior is protected`);
      assert.equal(cutout!.getAttribute('fill'), '#000000');
      assert.equal(cutout!.getAttribute('stroke'), '#ffffff', 'the original thin center border remains visible');
      assert.equal(cutout!.getAttribute('stroke-width'), '1.25');
    }
    for (const d of [...CHANNELS.filter(channel => !INTEGRATION_IDS.has(channel.id)).map(channel => channel.path), INTEGRATION_PATH]) {
      const cutout = paths.find(path => path.getAttribute('d') === d);
      assert.ok(cutout, 'connected and crossing channel interiors are protected');
      assert.equal(cutout!.getAttribute('stroke'), '#000000');
      assert.equal(cutout!.getAttribute('stroke-width'), '6.072');
    }
  }
});

test('ordinary full and half highlights replace the physical outline beneath unchanged activation interiors', () => {
  for (const chart of [{}, { personality: [1, 8] }, { design: [1, 8] }, { personality: [1, 8], design: [1, 8] }]) {
    for (const selection of [{ type: 'channel' as const, id: '1-8' }, { type: 'gate' as const, id: 1 }, { type: 'center' as const, id: 'g' }]) {
      const root = svgDocument().createElementNS(SVG_NS, 'svg');
      root.innerHTML = renderBodygraph(chart, selection);
      const channel = root.querySelector('[data-type="channel"][data-id="1-8"]')!;
      const children = channel.children, outline = channel.querySelector('.bg-channel-outline')!;
      const paper = children.find(node => node.localName === 'path' && node.getAttribute('stroke') === '#ffffff')!;
      const highlights = children.filter(node => node.hasAttribute('data-highlight-gate') || node.classList.contains('bg-channel-highlight'));
      for (const highlight of highlights) {
        const paint = highlight.localName === 'path' ? highlight : highlight.querySelector('path')!;
        assert.equal(paint.getAttribute('stroke-width'), '8.448', 'blue occupies the existing physical outline, not an extra exterior stripe');
        assert.ok(children.indexOf(outline) < children.indexOf(highlight), 'blue covers the gray outline');
        assert.ok(children.indexOf(highlight) < children.indexOf(paper), 'paper and source lanes cover blue in the semantic interior');
      }
      assert.equal(paper.getAttribute('stroke-width'), '6.072');
      for (const source of channel.querySelectorAll('path').filter(node => ['#202020', '#c32d35'].includes(node.getAttribute('stroke')!))) {
        assert.ok(children.indexOf(source) > children.indexOf(paper));
      }
    }
  }
});

test('stationary glow stays behind semantic gate discs and leaves the inset core and numbers sharp', () => {
  for (const [chart, fill] of [
    [{}, 'transparent'], [{ personality: [31] }, '#202020'], [{ design: [31] }, '#c32d35'],
    [{ personality: [31], design: [31] }, 'url(#glow-test-dual)'],
  ] as const) {
    const markup = renderBodygraph(chart, { type: 'gate', id: 31 }, { idPrefix: 'glow-test' });
    const group = gateGroups(markup).find(gate => gate.id === 31)!;
    const glow = circle(group, 'bg-gate-glow'), disc = circle(group, 'bg-gate-disc')!, core = circle(group, 'bg-gate-highlight')!;
    assert.ok(glow, 'a separate lower highlight owns bloom outside the semantic disc');
    assert.equal(attribute(glow!, 'filter'), 'url(#glow-test-gate-glow)');
    assert.equal(attribute(glow!, 'opacity'), '1');
    assert.equal(attribute(glow!, 'pointer-events'), 'none');
    assert.ok(group.content.indexOf(glow!) < group.content.indexOf(disc), 'disc covers any inward bloom');
    assert.ok(group.content.indexOf(disc) < group.content.indexOf(core), 'existing crisp inset core keeps its paint order');
    assert.equal(attribute(disc, 'fill'), fill);
    for (const tag of [disc, core, group.content.match(/<text\b[^>]*>/)![0]]) {
      assert.equal(attribute(tag, 'filter'), undefined, 'source fills, existing core and digits are not blurred');
    }
    for (const circle of [core, glow!]) {
      assert.equal(attribute(circle, 'r'), '9');
      assert.equal(attribute(circle, 'stroke-width'), '1');
      assert.equal(outerRadius(circle), 9.5, 'thinner decorative line retains the semantic disc boundary');
    }
  }
});

test('each static highlight resolves a bounded namespaced glow without relying on path bounding-box area', () => {
  const markup = renderBodygraph({}, null, { idPrefix: 'glow-bounds', selections: [
    { type: 'gate', id: 1 }, { type: 'gate', id: 20 }, { type: 'center', id: 'root' }, { type: 'channel', id: '31-7' },
  ] });
  const filters = [...markup.matchAll(/<filter\b[^>]*>[\s\S]*?<\/filter>/g)].map(match => match[0]);
  assert.equal(filters.length, 2, 'tiny translated gate circles and chart paths have their own bounded surfaces');
  for (const [id, box] of [['glow-bounds-gate-glow', [-15, -15, 15, 15]], ['glow-bounds-highlight-glow', [0, 0, 640, 820]]] as const) {
    const filter = filters.find(tag => attribute(tag, 'id') === id);
    assert.ok(filter, `filter ${id} belongs to this chart`);
    assert.equal(attribute(filter!, 'filterUnits'), 'userSpaceOnUse', 'horizontal/vertical paths must render even with a zero bbox dimension');
    const x = Number(attribute(filter!, 'x')), y = Number(attribute(filter!, 'y'));
    assert.ok(x <= box[0] && y <= box[1]);
    assert.ok(x + Number(attribute(filter!, 'width')) >= box[2] && y + Number(attribute(filter!, 'height')) >= box[3]);
    if (id.endsWith('gate-glow')) assert.ok(Number(attribute(filter!, 'width')) <= 40 && Number(attribute(filter!, 'height')) <= 40, 'each gate avoids a chart-sized offscreen surface');
    const gate = id.endsWith('gate-glow');
    assert.equal(attribute(filter!.match(/<feMorphology\b[^>]*>/)![0], 'radius'), gate ? '0.8' : '1.6');
    assert.equal(attribute(filter!.match(/<feGaussianBlur\b[^>]*>/)![0], 'stdDeviation'), gate ? '1.6' : '2.4');
    assert.equal((filter!.match(/<feGaussianBlur\b/g) || []).length, 1, 'only the wider halo blurs; the narrow core stays crisp');
    assert.equal(attribute(filter!.match(/<feFuncA\b[^>]*>/)![0], 'slope'), gate ? '0.65' : '1');
    assert.match(filter!, /<feMergeNode in="SourceGraphic"/);
  }
  for (const className of ['bg-channel-highlight', 'bg-center-highlight']) {
    const paths = [...markup.matchAll(new RegExp(`<path class="${className}"[^>]*\\/>`, 'g'))];
    assert.ok(paths.length, `${className} has paint`);
    for (const [path] of paths) assert.equal(attribute(path, 'filter'), 'url(#glow-bounds-highlight-glow)');
  }
  const integrationLayer = markup.match(/<g class="bodygraph-integration-highlights"[^>]*>/)![0];
  assert.equal(attribute(integrationLayer, 'filter'), 'url(#glow-bounds-highlight-glow)', 'bloom is applied after child masks so a partial arm keeps its exterior glow');
  assert.equal(attribute(integrationLayer, 'mask'), 'url(#glow-bounds-integration-outline)', 'the final bloom is cut out of every physical interior, including dimmed inactive arms');
  for (const className of ['bg-integration-hover', 'bg-integration-selection', 'bg-integration-focus']) {
    const paths = [...markup.matchAll(new RegExp(`<path class="${className}"[^>]*\\/>`, 'g'))];
    assert.ok(paths.length, `${className} has paint`);
    for (const [path] of paths) {
      assert.equal(attribute(path, 'filter'), undefined, 'child ownership masks shape the glow source before the shared filter');
      assert.match(attribute(path, 'mask')!, /^url\(#glow-bounds-integration-/);
    }
  }
  assert.match(markup, /<g data-highlight-gate="1" filter="url\(#glow-bounds-highlight-glow\)"/);
  assert.doesNotMatch(markup, /<(?:animate|animateMotion)\b|stroke-dashoffset=/, 'glow has no travelling beam');
});

test('direct and related gate highlights use the same compact light-blue ring', () => {
  for (const gate of GATES) {
    const selected = gateGroups(renderBodygraph(allActive, { type: 'gate' as const, id: gate.id })).find(item => item.id === gate.id);
    const related = gateGroups(renderBodygraph(allActive, { type: 'center' as const, id: gate.center })).find(item => item.id === gate.id);
    const selectedRing = circle(selected, 'bg-gate-highlight'), relatedRing = circle(related, 'bg-gate-highlight');
    assert.equal(attribute(selectedRing!, 'data-state'), 'selected');
    assert.equal(attribute(relatedRing!, 'data-state'), 'related');
    assert.equal(attribute(selectedRing!, 'stroke'), '#91bce9', `gate ${gate.id} has a light-blue selection ring`);
    assert.equal(attribute(relatedRing!, 'stroke'), '#91bce9', `gate ${gate.id} has a light-blue related ring`);
    for (const name of ['r', 'stroke-width'] as const) assert.equal(attribute(selectedRing!, name), attribute(relatedRing!, name), `gate ${gate.id} ring size is independent of selection type`);
    for (const ring of [selectedRing, relatedRing] as const) {
      assert.equal(attribute(ring!, 'r'), '9');
      assert.equal(attribute(ring!, 'stroke-width'), '1');
      assert.equal(outerRadius(ring!), 9.5, 'highlight stays within the gate disc radius');
      assert.equal(attribute(ring!, 'opacity'), '1');
      assert.equal(attribute(ring!, 'pointer-events'), 'none');
    }
  }
});

test('gate hover and keyboard focus reuse the inset ring without enlarging activation discs', () => {
  const markup = renderBodygraph();
  const style = markup.match(/<style>([\s\S]*?)<\/style>/)![1];
  assert.match(style, /\.bg-interactive:hover \.bg-gate-highlight\s*\{\s*opacity:\s*1;\s*\}/);
  assert.match(style, /\.bg-interactive:focus-visible \.bg-gate-highlight\s*\{\s*opacity:\s*1;\s*\}/);
  assert.doesNotMatch(style, /(?:hover|focus-visible)[^{]*\.bg-gate-disc/, 'hover and focus cannot expand the activation disc outline');
  for (const group of gateGroups(markup)) {
    const ring = circle(group, 'bg-gate-highlight');
    assert.equal(attribute(ring!, 'data-state'), 'idle');
    assert.equal(attribute(ring!, 'opacity'), '0', `unselected gate ${group.id} has no visible ring`);
    assert.equal(attribute(ring!, 'fill'), '#91bce9', 'hidden hover ring has the same fill as direct selection');
    assert.equal(outerRadius(ring!), 9.5, 'the same ring is ready for compact hover/focus');
  }
});

test('compact rings keep the existing touch target, activation disc and readable labels', () => {
  for (const selection of [null, { type: 'gate' as const, id: 31 }, { type: 'gate' as const, id: 8 }, { type: 'center' as const, id: 'throat' }] as const) {
    for (const group of gateGroups(renderBodygraph(allActive, selection))) {
      assert.match(group.content, /<circle r="12\.5" fill="transparent" pointer-events="all"\/>/, `gate ${group.id} keeps its touch target`);
      const disc = circle(group, 'bg-gate-disc'), ring = circle(group, 'bg-gate-highlight');
      assert.equal(attribute(disc!, 'r'), '9.5');
      assert.equal(attribute(disc!, 'stroke'), 'none');
      assert.ok(group.content.indexOf(disc!) < group.content.indexOf(ring!), 'the compact ring is visible over the activation disc');
      assert.ok(group.content.indexOf(ring!) < group.content.indexOf('<text'), 'gate number stays above the ring');
      assert.match(group.content, new RegExp(`<text[^>]*font-size="9\\.9"[^>]*>${group.id}<\\/text>`));
    }
  }
});

test('internal gate labels are ten percent smaller in both modes without shrinking hit targets or mandala numbers', () => {
  for (const showMandala of [false, true] as const) {
    const markup = renderBodygraph(allActive, null, { showMandala });
    const groups = gateGroups(markup);
    assert.equal(groups.length, 64);
    for (const group of groups) {
      const text = group.content.match(/<text\b[^>]*>/)![0];
      assert.equal(Number(attribute(text, 'font-size')), 11 * .9);
      assert.match(group.content, /<circle r="12\.5" fill="transparent" pointer-events="all"\/>/);
    }
    const ringLabels = [...markup.matchAll(/<text class="mandala-number"[^>]*>/g)];
    assert.equal(ringLabels.length, showMandala ? 64 : 0);
    for (const [tag] of ringLabels) assert.equal(attribute(tag, 'font-size'), '12');
  }
});

test('selected rings preserve black, red and dual activations without a solid overlay', () => {
  for (const chart of [
    { personality: [31], design: [] },
    { personality: [], design: [31] },
    { personality: [31], design: [31] },
  ] as const) {
    for (const selection of [{ type: 'gate' as const, id: 31 }, { type: 'center' as const, id: 'throat' }] as const) {
      const markup = renderBodygraph(chart, selection, { idPrefix: 'ring-test' });
      const group = gateGroups(markup).find(gate => gate.id === 31);
      const disc = circle(group, 'bg-gate-disc'), ring = circle(group, 'bg-gate-highlight');
      const expected = chart.personality.length && chart.design.length ? 'url(#ring-test-dual)'
        : chart.personality.length ? '#202020' : '#c32d35';
      assert.equal(attribute(disc!, 'fill'), expected);
      assert.equal(attribute(ring!, 'fill'), 'none', 'ring must not cover the activation source colors');
      if (expected.startsWith('url')) {
        assert.match(markup, /<stop offset="50%" stop-color="#202020"\/><stop offset="50%" stop-color="#c32d35"\/>/);
      }
    }
  }
});

test('unactivated selected and related gates retain a compact light-blue interior', () => {
  for (const selection of [{ type: 'gate' as const, id: 8 }, { type: 'center' as const, id: 'throat' }] as const) {
    const group = gateGroups(renderBodygraph({}, selection)).find(gate => gate.id === 8);
    assert.equal(attribute(circle(group, 'bg-gate-disc')!, 'fill'), 'transparent');
    const ring = circle(group, 'bg-gate-highlight');
    assert.equal(attribute(ring!, 'fill'), '#91bce9');
    assert.equal(outerRadius(ring!), 9.5);
  }
});

test('every gate highlight fits inside its center and cannot overlap a neighboring gate highlight', () => {
  const distance = (p: number[], a: number[], b: number[]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const rings = [];
  for (const center of CENTERS) {
    const points = center.points.split(/\s+/).map(point => point.split(',').map(Number));
    for (const group of gateGroups(renderBodygraph(allActive, { type: 'center' as const, id: center.id }))) {
      if (getGate(group.id)!.center !== center.id) continue;
      const gate = getGate(group.id), radius = outerRadius(circle(group, 'bg-gate-highlight')!);
      const clearance = Math.min(...points.map((a, i) => distance([gate!.x, gate!.y], a, points[(i + 1) % points.length])));
      assert.ok(radius <= clearance, `gate ${gate!.id} highlight stays inside ${center.id}`);
      rings.push({ ...gate, radius });
    }
  }
  assert.equal(rings.length, 64);
  for (let i = 0; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++) {
    const a = rings[i], b = rings[j];
    assert.ok(Math.hypot(a.x! - b.x!, a.y! - b.y!) >= a.radius + b.radius, `gate highlights ${a.id}/${b.id} never overlap`);
  }
});

test('every ordinary channel has a complete CSS hover outline without highlighting its gate numbers', () => {
  const markup = renderBodygraph();
  const style = markup.match(/<style>([\s\S]*?)<\/style>/)![1];
  assert.match(style, /\.bg-interactive\[data-type="channel"\]:hover > \.bg-channel-highlight\s*\{\s*opacity:\s*1;\s*\}/);
  const channels = [...markup.matchAll(/<g\s+data-type="channel"\s+data-id="([^"]+)"([^>]*)>([\s\S]*?)<\/g>/g)];
  let count = 0;
  for (const [, id, attributes, content] of channels) {
    if (attributes.includes('data-integration="true"')) continue;
    const channel = CHANNELS.find(channel => channel.id === id);
    assert.ok(content.includes(`class="bg-channel-highlight" d="${channel!.path}"`), `${id} has one whole-channel hover target`);
    assert.doesNotMatch(content, /bg-gate-highlight|data-type="gate"/, `${id} hover does not contain gate-number elements`);
    count++;
  }
  assert.equal(count, 30);
  for (const gate of gateGroups(markup)) assert.equal(attribute(circle(gate, 'bg-gate-highlight')!, 'opacity'), '0');
});

test('integration hover uses a masked lower outline while keeping its source colors and selection unchanged', () => {
  const markup = renderBodygraph({ personality: [10, 20], design: [34, 57] });
  const integration = markup.slice(markup.indexOf('<g class="bodygraph-channels">'));
  const hover = integration.match(/<path class="bg-integration-hover"[^>]*\/>/)![0];
  assert.equal(attribute(hover, 'opacity'), '0');
  assert.equal(attribute(hover, 'pointer-events'), 'none');
  assert.equal(attribute(hover, 'stroke-linecap'), 'butt');
  assert.equal((attribute(hover, 'd')!.match(/M/g) || []).length, 5, 'four arms and the shared stem hover together');
  assert.ok(integration.indexOf(hover) > integration.indexOf('data-type="channel" data-id="26-44"'), 'hover stays above ordinary crossings');
  assert.ok(integration.indexOf(hover) < integration.indexOf('data-junction="integration"'), 'hover stays below its own physical branches');
  assert.equal(attribute(hover, 'mask'), 'url(#bodygraph-integration-outline)');
  assert.equal(attribute(hover, 'stroke'), '#91bce9');
  assert.equal(attribute(hover, 'stroke-width'), '8.448');
  assert.match(markup, /\.bodygraph-channels:has\(> \.bg-interactive\[data-type="integration"\]\[data-visual-selected="false"\]:hover\) > \.bodygraph-integration-highlights > \.bg-integration-hover\s*\{\s*opacity:\s*1;/);
  for (const gate of gateGroups(markup)) assert.equal(attribute(circle(gate, 'bg-gate-highlight')!, 'opacity'), '0', 'hover alone does not select gate numbers');
});

test('selected integration arms keep lower outlines outside every branch interior', () => {
  for (const id of [10, 20, 34, 57] as const) {
    const markup = renderBodygraph({ personality: [10, 20, 34, 57], design: [10, 20, 34, 57] },
      { type: 'gate' as const, id }, { idPrefix: `arm-${id}` });
    const integration = markup.slice(markup.indexOf('<g class="bodygraph-channels">'), markup.indexOf('<g class="bodygraph-centers">'));
    const overlay = integration.match(/<path class="bg-integration-selection"[^>]*\/>/)![0];
    assert.equal(attribute(overlay, 'stroke-width'), '8.448');
    assert.equal(attribute(overlay, 'stroke-linecap'), 'round', `arm ${id} covers its masked terminal plane`);
    assert.equal(attribute(overlay, 'pointer-events'), 'none');
    assert.equal(attribute(overlay, 'mask'), `url(#arm-${id}-integration-selection-outline)`);
    const bundleStart = integration.indexOf('data-junction="integration"');
    assert.ok(integration.indexOf(overlay) > integration.indexOf('data-type="channel" data-id="26-44"'), `arm ${id} outline is above ordinary crossings`);
    for (const color of ['#ffffff', '#202020', '#c32d35'] as const) {
      assert.ok(integration.indexOf(overlay) < integration.indexOf(`stroke="${color}"`, bundleStart), `arm ${id} outline is below every own ${color} lane`);
    }
    const mask = markup.match(new RegExp(`<mask id="arm-${id}-integration-selection-outline"[^>]*>([\\s\\S]*?)<\\/mask>`))![1];
    const cutout = mask.match(/<path class="bg-integration-interior"[^>]*\/>/)![0];
    assert.equal((attribute(cutout, 'd')!.match(/M/g) || []).length, 5, 'all four branches and the stem cut out their interiors');
    assert.ok(attribute(cutout, 'd')!.includes(attribute(overlay, 'd')!), 'the selected branch is part of the complete physical-node cutout');
    assert.equal(attribute(cutout, 'stroke'), '#000000');
    assert.equal(attribute(cutout, 'stroke-width'), '6.072', 'both activation lanes remain untouched while blue replaces their outline');
    assert.equal(attribute(cutout, 'stroke-linecap'), 'round', 'cutout caps match the underlying physical node');
    assert.equal((attribute(overlay, 'd')!.match(/M/g) || []).length, 1, 'individual gate selection does not outline other branches');
  }
});

test('clicking a gate keeps exactly its hover paint for inactive, black, red and dual activations', () => {
  for (const id of [8, 31, 10, 34] as const) for (const chart of [
    {}, { personality: [id] }, { design: [id] }, { personality: [id], design: [id] },
  ] as const) {
    const before = gateGroups(renderBodygraph(chart)).find(gate => gate.id === id);
    const after = gateGroups(renderBodygraph(chart, { type: 'gate' as const, id })).find(gate => gate.id === id);
    const hover = circle(before, 'bg-gate-highlight'), selected = circle(after, 'bg-gate-highlight');
    sameVisiblePaint(hover, selected, `gate ${id}`);
    assert.equal(attribute(hover!, 'opacity'), '0');
    assert.equal(attribute(selected!, 'opacity'), '1');
  }
});

test('center hover and direct selection share one restrained outline without changing the base paint', () => {
  for (const chart of [{}, allActive] as const) for (const center of CENTERS) {
    const before = groupContent(renderBodygraph(chart), 'center', center.id);
    const after = groupContent(renderBodygraph(chart, { type: 'center' as const, id: center.id }), 'center', center.id);
    const hover = highlightPath(before!, 'bg-center-highlight'), selected = highlightPath(after!, 'bg-center-highlight');
    sameVisiblePaint(hover, selected, center.id);
    assert.equal(attribute(hover!, 'stroke-width'), '1.25', 'center keeps a thin sharp core within its soft bloom');
    assert.equal(attribute(hover!, 'opacity'), '0');
    assert.equal(attribute(selected!, 'opacity'), '1');
    assert.equal(highlightPath(before!, 'bg-center-shape'), highlightPath(after!, 'bg-center-shape'), 'click does not recolor or resize the actual center');
  }
});

test('ordinary channel clicks freeze the existing hover contour instead of changing color or thickness', () => {
  const beforeMarkup = renderBodygraph(allActive);
  for (const channel of CHANNELS.filter(channel => !channel.gates.every(id => [10, 20, 34, 57].includes(id)))) {
    const before = groupContent(beforeMarkup, 'channel', channel.id);
    const after = groupContent(renderBodygraph(allActive, { type: 'channel' as const, id: channel.id }), 'channel', channel.id);
    const hover = highlightPath(before!, 'bg-channel-highlight'), selected = highlightPath(after!, 'bg-channel-highlight');
    sameVisiblePaint(hover, selected, channel.id);
    assert.equal(attribute(hover!, 'stroke-width'), '8.448');
    assert.equal(attribute(hover!, 'opacity'), '0');
    assert.equal(attribute(selected!, 'opacity'), '1');
    assert.equal(highlightPath(before!, 'bg-channel-outline'), highlightPath(after!, 'bg-channel-outline'));
    assert.ok(after!.indexOf(selected!) > after!.indexOf('class="bg-channel-outline"'), 'hover and click replace the same underlying outline');
  }
});

test('full integration hover and click share the same lower masked contour without doubled hover paint', () => {
  const before = renderBodygraph(allActive), after = renderBodygraph(allActive, { type: 'integration' as const, id: 'integration' });
  const hover = highlightPath(before, 'bg-integration-hover'), selected = highlightPath(after, 'bg-integration-selection');
  sameVisiblePaint(hover, selected, 'integration');
  const hoverMask = before.match(/<mask id="bodygraph-integration-outline"[^>]*>([\s\S]*?)<\/mask>/)![1];
  const selectedMask = after.match(/<mask id="bodygraph-integration-outline"[^>]*>([\s\S]*?)<\/mask>/)![1];
  assert.equal(hoverMask, selectedMask, 'hover and selected outlines preserve the same black/red interior');
  assert.match(after, /data-type="integration"[^>]*aria-pressed="true"/);
  assert.match(after, /\[data-type="integration"\]\[data-visual-selected="false"\]:hover\) > \.bodygraph-integration-highlights > \.bg-integration-hover/,
    'the full selected node cannot also paint an identical hover layer on top');
});

test('bodygraph interaction styles contain no saturated blue override', () => {
  const markup = renderBodygraph(allActive, { type: 'center' as const, id: 'throat' });
  assert.doesNotMatch(markup, /#3b72b8/i);
  const style = markup.match(/<style>([\s\S]*?)<\/style>/)![1];
  assert.match(style, /\.bg-interactive:hover \.bg-center-highlight\s*\{\s*opacity:\s*1;\s*\}/);
  assert.doesNotMatch(style, /\.bg-interactive[^{}]*(?:hover|focus-visible)[^{}]*\{[^}]*stroke-width:/,
    'hover/focus must not give a contour a different thickness from its selected version');
});
