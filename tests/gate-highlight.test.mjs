import test from 'node:test';
import assert from 'node:assert/strict';
import { CENTERS, GATES, CHANNELS, getGate } from '../src/bodygraph/graph-data.js';
import { renderBodygraph } from '../src/bodygraph/bodygraph.js';

const attribute = (markup, name) => markup.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const gateGroups = markup => [...markup.matchAll(/<g\s+data-type="gate"\s+data-id="(\d+)"([^>]*)>([\s\S]*?)<\/g>/g)]
  .map(([, id, attributes, content]) => ({ id: Number(id), attributes, content }));
const circle = (group, className) => group.content.match(new RegExp(`<circle class="${className}"[^>]*\/>`))?.[0];
const outerRadius = markup => Number(attribute(markup, 'r')) + Number(attribute(markup, 'stroke-width') || 0) / 2;
const allActive = { personality: GATES.map(gate => gate.id), design: [] };
const groupContent = (markup, type, id) => markup.match(new RegExp(`<g\\s+data-type="${type}"\\s+data-id="${id}"[^>]*>([\\s\\S]*?)<\\/g>`))?.[1];
const highlightPath = (content, className) => content.match(new RegExp(`<path class="${className}"[^>]*\/>`))?.[0];
const sameVisiblePaint = (before, after, label) => {
  assert.ok(before && after, `${label} has a persistent hover/click element`);
  for (const name of ['r', 'd', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']) {
    assert.equal(attribute(before, name), attribute(after, name), `${label} keeps ${name} after clicking`);
  }
  assert.equal(attribute(before, 'stroke'), '#c4d9f1', `${label} is always light blue`);
};

test('direct and related gate highlights use the same compact light-blue ring', () => {
  for (const gate of GATES) {
    const selected = gateGroups(renderBodygraph(allActive, { type: 'gate', id: gate.id })).find(item => item.id === gate.id);
    const related = gateGroups(renderBodygraph(allActive, { type: 'center', id: gate.center })).find(item => item.id === gate.id);
    const selectedRing = circle(selected, 'bg-gate-highlight'), relatedRing = circle(related, 'bg-gate-highlight');
    assert.equal(attribute(selectedRing, 'data-state'), 'selected');
    assert.equal(attribute(relatedRing, 'data-state'), 'related');
    assert.equal(attribute(selectedRing, 'stroke'), '#c4d9f1', `gate ${gate.id} has a light-blue selection ring`);
    assert.equal(attribute(relatedRing, 'stroke'), '#c4d9f1', `gate ${gate.id} has a light-blue related ring`);
    for (const name of ['r', 'stroke-width']) assert.equal(attribute(selectedRing, name), attribute(relatedRing, name), `gate ${gate.id} ring size is independent of selection type`);
    for (const ring of [selectedRing, relatedRing]) {
      assert.equal(attribute(ring, 'r'), '8.5');
      assert.equal(attribute(ring, 'stroke-width'), '2');
      assert.equal(outerRadius(ring), 9.5, 'highlight stays within the gate disc radius');
      assert.equal(attribute(ring, 'opacity'), '1');
      assert.equal(attribute(ring, 'pointer-events'), 'none');
    }
  }
});

test('gate hover and keyboard focus reuse the inset ring without enlarging activation discs', () => {
  const markup = renderBodygraph();
  const style = markup.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(style, /\.bg-interactive:hover \.bg-gate-highlight\s*\{\s*opacity:\s*1;\s*\}/);
  assert.match(style, /\.bg-interactive:focus-visible \.bg-gate-highlight\s*\{\s*opacity:\s*1;\s*\}/);
  assert.doesNotMatch(style, /(?:hover|focus-visible)[^{]*\.bg-gate-disc/, 'hover and focus cannot expand the activation disc outline');
  for (const group of gateGroups(markup)) {
    const ring = circle(group, 'bg-gate-highlight');
    assert.equal(attribute(ring, 'data-state'), 'idle');
    assert.equal(attribute(ring, 'opacity'), '0', `unselected gate ${group.id} has no visible ring`);
    assert.equal(attribute(ring, 'fill'), '#c4d9f1', 'hidden hover ring has the same fill as direct selection');
    assert.equal(outerRadius(ring), 9.5, 'the same ring is ready for compact hover/focus');
  }
});

test('compact rings keep the existing touch target, activation disc and readable labels', () => {
  for (const selection of [null, { type: 'gate', id: 31 }, { type: 'gate', id: 8 }, { type: 'center', id: 'throat' }]) {
    for (const group of gateGroups(renderBodygraph(allActive, selection))) {
      assert.match(group.content, /<circle r="12\.5" fill="transparent" pointer-events="all"\/>/, `gate ${group.id} keeps its touch target`);
      const disc = circle(group, 'bg-gate-disc'), ring = circle(group, 'bg-gate-highlight');
      assert.equal(attribute(disc, 'r'), '9.5');
      assert.equal(attribute(disc, 'stroke-width'), '.8');
      assert.ok(group.content.indexOf(disc) < group.content.indexOf(ring), 'the compact ring is visible over the activation disc');
      assert.ok(group.content.indexOf(ring) < group.content.indexOf('<text'), 'gate number stays above the ring');
      assert.match(group.content, new RegExp(`<text[^>]*font-size="9\\.9"[^>]*>${group.id}<\\/text>`));
    }
  }
});

test('internal gate labels are ten percent smaller in both modes without shrinking hit targets or mandala numbers', () => {
  for (const showMandala of [false, true]) {
    const markup = renderBodygraph(allActive, null, { showMandala });
    const groups = gateGroups(markup);
    assert.equal(groups.length, 64);
    for (const group of groups) {
      const text = group.content.match(/<text\b[^>]*>/)[0];
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
  ]) {
    for (const selection of [{ type: 'gate', id: 31 }, { type: 'center', id: 'throat' }]) {
      const markup = renderBodygraph(chart, selection, { idPrefix: 'ring-test' });
      const group = gateGroups(markup).find(gate => gate.id === 31);
      const disc = circle(group, 'bg-gate-disc'), ring = circle(group, 'bg-gate-highlight');
      const expected = chart.personality.length && chart.design.length ? 'url(#ring-test-dual)'
        : chart.personality.length ? '#202020' : '#c32d35';
      assert.equal(attribute(disc, 'fill'), expected);
      assert.equal(attribute(ring, 'fill'), 'none', 'ring must not cover the activation source colors');
      if (expected.startsWith('url')) {
        assert.match(markup, /<stop offset="50%" stop-color="#202020"\/><stop offset="50%" stop-color="#c32d35"\/>/);
      }
    }
  }
});

test('unactivated selected and related gates retain a compact light-blue interior', () => {
  for (const selection of [{ type: 'gate', id: 8 }, { type: 'center', id: 'throat' }]) {
    const group = gateGroups(renderBodygraph({}, selection)).find(gate => gate.id === 8);
    assert.equal(attribute(circle(group, 'bg-gate-disc'), 'fill'), 'transparent');
    const ring = circle(group, 'bg-gate-highlight');
    assert.equal(attribute(ring, 'fill'), '#c4d9f1');
    assert.equal(outerRadius(ring), 9.5);
  }
});

test('every gate highlight fits inside its center and cannot overlap a neighboring gate highlight', () => {
  const distance = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const rings = [];
  for (const center of CENTERS) {
    const points = center.points.split(/\s+/).map(point => point.split(',').map(Number));
    for (const group of gateGroups(renderBodygraph(allActive, { type: 'center', id: center.id }))) {
      if (getGate(group.id).center !== center.id) continue;
      const gate = getGate(group.id), radius = outerRadius(circle(group, 'bg-gate-highlight'));
      const clearance = Math.min(...points.map((a, i) => distance([gate.x, gate.y], a, points[(i + 1) % points.length])));
      assert.ok(radius <= clearance, `gate ${gate.id} highlight stays inside ${center.id}`);
      rings.push({ ...gate, radius });
    }
  }
  assert.equal(rings.length, 64);
  for (let i = 0; i < rings.length; i++) for (let j = i + 1; j < rings.length; j++) {
    const a = rings[i], b = rings[j];
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius, `gate highlights ${a.id}/${b.id} never overlap`);
  }
});

test('every ordinary channel has a complete CSS hover outline without highlighting its gate numbers', () => {
  const markup = renderBodygraph();
  const style = markup.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(style, /\.bg-interactive\[data-type="channel"\]:hover > \.bg-channel-highlight\s*\{\s*opacity:\s*1;\s*\}/);
  const channels = [...markup.matchAll(/<g\s+data-type="channel"\s+data-id="([^"]+)"([^>]*)>([\s\S]*?)<\/g>/g)];
  let count = 0;
  for (const [, id, attributes, content] of channels) {
    if (attributes.includes('data-integration="true"')) continue;
    const channel = CHANNELS.find(channel => channel.id === id);
    assert.ok(content.includes(`class="bg-channel-highlight" d="${channel.path}"`), `${id} has one whole-channel hover target`);
    assert.doesNotMatch(content, /bg-gate-highlight|data-type="gate"/, `${id} hover does not contain gate-number elements`);
    count++;
  }
  assert.equal(count, 30);
  for (const gate of gateGroups(markup)) assert.equal(attribute(circle(gate, 'bg-gate-highlight'), 'opacity'), '0');
});

test('integration hover uses a masked lower outline while keeping its source colors and selection unchanged', () => {
  const markup = renderBodygraph({ personality: [10, 20], design: [34, 57] });
  const integration = markup.slice(markup.indexOf('<g class="bodygraph-channels">'));
  const hover = integration.match(/<path class="bg-integration-hover"[^>]*\/>/)[0];
  assert.equal(attribute(hover, 'opacity'), '0');
  assert.equal(attribute(hover, 'pointer-events'), 'none');
  assert.equal(attribute(hover, 'stroke-linecap'), 'butt');
  assert.equal((attribute(hover, 'd').match(/M/g) || []).length, 5, 'four arms and the shared stem hover together');
  assert.ok(integration.indexOf(hover) > integration.indexOf('data-type="channel" data-id="26-44"'), 'hover stays above ordinary crossings');
  assert.ok(integration.indexOf(hover) < integration.indexOf('data-junction="integration"'), 'hover stays below its own physical branches');
  assert.equal(attribute(hover, 'mask'), 'url(#bodygraph-integration-outline)');
  assert.equal(attribute(hover, 'stroke'), '#c4d9f1');
  assert.equal(attribute(hover, 'stroke-width'), '13.2');
  assert.match(markup, /\.bodygraph-channels:has\(> \.bg-interactive\[data-type="integration"\]\[data-visual-selected="false"\]:hover\) > \.bodygraph-integration-highlights > \.bg-integration-hover\s*\{\s*opacity:\s*1;/);
  for (const gate of gateGroups(markup)) assert.equal(attribute(circle(gate, 'bg-gate-highlight'), 'opacity'), '0', 'hover alone does not select gate numbers');
});

test('selected integration arms keep lower outlines outside every branch interior', () => {
  for (const id of [10, 20, 34, 57]) {
    const markup = renderBodygraph({ personality: [10, 20, 34, 57], design: [10, 20, 34, 57] },
      { type: 'gate', id }, { idPrefix: `arm-${id}` });
    const integration = markup.slice(markup.indexOf('<g class="bodygraph-channels">'), markup.indexOf('<g class="bodygraph-centers">'));
    const overlay = integration.match(/<path class="bg-integration-selection"[^>]*\/>/)[0];
    assert.equal(attribute(overlay, 'stroke-width'), '13.2');
    assert.equal(attribute(overlay, 'stroke-linecap'), 'round', `arm ${id} covers its masked terminal plane`);
    assert.equal(attribute(overlay, 'pointer-events'), 'none');
    assert.equal(attribute(overlay, 'mask'), `url(#arm-${id}-integration-selection-outline)`);
    const bundleStart = integration.indexOf('data-junction="integration"');
    assert.ok(integration.indexOf(overlay) > integration.indexOf('data-type="channel" data-id="26-44"'), `arm ${id} outline is above ordinary crossings`);
    for (const color of ['#ffffff', '#202020', '#c32d35']) {
      assert.ok(integration.indexOf(overlay) < integration.indexOf(`stroke="${color}"`, bundleStart), `arm ${id} outline is below every own ${color} lane`);
    }
    const mask = markup.match(new RegExp(`<mask id="arm-${id}-integration-selection-outline"[^>]*>([\\s\\S]*?)<\\/mask>`))[1];
    const cutout = mask.match(/<path class="bg-integration-interior"[^>]*\/>/)[0];
    assert.equal((attribute(cutout, 'd').match(/M/g) || []).length, 5, 'all four branches and the stem cut out their interiors');
    assert.ok(attribute(cutout, 'd').includes(attribute(overlay, 'd')), 'the selected branch is part of the complete physical-node cutout');
    assert.equal(attribute(cutout, 'stroke'), '#000000');
    assert.equal(attribute(cutout, 'stroke-width'), '8.448', 'both activation lanes and their base outline remain visible');
    assert.equal(attribute(cutout, 'stroke-linecap'), 'round', 'cutout caps match the underlying physical node');
    assert.equal((attribute(overlay, 'd').match(/M/g) || []).length, 1, 'individual gate selection does not outline other branches');
  }
});

test('clicking a gate keeps exactly its hover paint for inactive, black, red and dual activations', () => {
  for (const id of [8, 31, 10, 34]) for (const chart of [
    {}, { personality: [id] }, { design: [id] }, { personality: [id], design: [id] },
  ]) {
    const before = gateGroups(renderBodygraph(chart)).find(gate => gate.id === id);
    const after = gateGroups(renderBodygraph(chart, { type: 'gate', id })).find(gate => gate.id === id);
    const hover = circle(before, 'bg-gate-highlight'), selected = circle(after, 'bg-gate-highlight');
    sameVisiblePaint(hover, selected, `gate ${id}`);
    assert.equal(attribute(hover, 'opacity'), '0');
    assert.equal(attribute(selected, 'opacity'), '1');
  }
});

test('center hover and direct selection share one restrained outline without changing the base paint', () => {
  for (const chart of [{}, allActive]) for (const center of CENTERS) {
    const before = groupContent(renderBodygraph(chart), 'center', center.id);
    const after = groupContent(renderBodygraph(chart, { type: 'center', id: center.id }), 'center', center.id);
    const hover = highlightPath(before, 'bg-center-highlight'), selected = highlightPath(after, 'bg-center-highlight');
    sameVisiblePaint(hover, selected, center.id);
    assert.equal(attribute(hover, 'stroke-width'), '2.5', 'center has no oversized glow');
    assert.equal(attribute(hover, 'opacity'), '0');
    assert.equal(attribute(selected, 'opacity'), '1');
    assert.equal(highlightPath(before, 'bg-center-shape'), highlightPath(after, 'bg-center-shape'), 'click does not recolor or resize the actual center');
  }
});

test('ordinary channel clicks freeze the existing hover contour instead of changing color or thickness', () => {
  const beforeMarkup = renderBodygraph(allActive);
  for (const channel of CHANNELS.filter(channel => !channel.gates.every(id => [10, 20, 34, 57].includes(id)))) {
    const before = groupContent(beforeMarkup, 'channel', channel.id);
    const after = groupContent(renderBodygraph(allActive, { type: 'channel', id: channel.id }), 'channel', channel.id);
    const hover = highlightPath(before, 'bg-channel-highlight'), selected = highlightPath(after, 'bg-channel-highlight');
    sameVisiblePaint(hover, selected, channel.id);
    assert.equal(attribute(hover, 'stroke-width'), '13.2');
    assert.equal(attribute(hover, 'opacity'), '0');
    assert.equal(attribute(selected, 'opacity'), '1');
    assert.equal(highlightPath(before, 'bg-channel-outline'), highlightPath(after, 'bg-channel-outline'));
    assert.ok(after.indexOf(selected) < after.indexOf('class="bg-channel-outline"'), 'hover and click stay in the same background layer');
  }
});

test('full integration hover and click share the same lower masked contour without doubled hover paint', () => {
  const before = renderBodygraph(allActive), after = renderBodygraph(allActive, { type: 'integration', id: 'integration' });
  const hover = highlightPath(before, 'bg-integration-hover'), selected = highlightPath(after, 'bg-integration-selection');
  sameVisiblePaint(hover, selected, 'integration');
  const hoverMask = before.match(/<mask id="bodygraph-integration-outline"[^>]*>([\s\S]*?)<\/mask>/)[1];
  const selectedMask = after.match(/<mask id="bodygraph-integration-outline"[^>]*>([\s\S]*?)<\/mask>/)[1];
  assert.equal(hoverMask, selectedMask, 'hover and selected outlines preserve the same black/red interior');
  assert.match(after, /data-type="integration"[^>]*aria-pressed="true"/);
  assert.match(after, /\[data-type="integration"\]\[data-visual-selected="false"\]:hover\) > \.bodygraph-integration-highlights > \.bg-integration-hover/,
    'the full selected node cannot also paint an identical hover layer on top');
});

test('bodygraph interaction styles contain no saturated blue override', () => {
  const markup = renderBodygraph(allActive, { type: 'center', id: 'throat' });
  assert.doesNotMatch(markup, /#3b72b8/i);
  const style = markup.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(style, /\.bg-interactive:hover \.bg-center-highlight\s*\{\s*opacity:\s*1;\s*\}/);
  assert.doesNotMatch(style, /\.bg-interactive[^{}]*(?:hover|focus-visible)[^{}]*\{[^}]*stroke-width:/,
    'hover/focus must not give a contour a different thickness from its selected version');
});
