import test from 'node:test';
import assert from 'node:assert/strict';
import { mandalaPreviewFromPointer, mandalaPreviewFromFocus } from '../src/scene/mandala-preview.js';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';
import { renderMandala } from '../src/scene/mandala.js';
import { mandalaPoint, MANDALA_GEOMETRY } from '../src/scene/geometry/mandala-geometry.js';
import { GATE_ORDER as MANDALA_GATE_ORDER, GATE_LONGITUDE_START as MANDALA_LONGITUDE_START, GATE_WIDTH as MANDALA_GATE_WIDTH } from '../src/domain/gate-wheel.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { attachHoverPreview } from '../src/selection/hover-preview.js';
import { createSummarySelectionState } from '../src/selection/summary-selection-state.js';

const normalize = value => ((value % 360) + 360) % 360;
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} equals ${expected}`);
const preview = longitude => ({ type: 'mandala-cross', id: normalize(longitude), cross: crossAtLongitude(longitude) });

function patchGlobals(t, replacements) {
  for (const [key, value] of Object.entries(replacements)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original); else delete globalThis[key];
    });
  }
}

class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  matrixTransform(matrix) {
    return new Point(matrix.a * this.x + matrix.c * this.y + matrix.e, matrix.b * this.x + matrix.d * this.y + matrix.f);
  }
}

function matrix(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
  return {
    a, b, c, d, e, f,
    inverse() {
      const determinant = a * d - b * c;
      return matrix(d / determinant, -b / determinant, -c / determinant, a / determinant,
        (c * f - d * e) / determinant, (b * e - a * f) / determinant);
    },
  };
}

function target({ gate = 41, transform = matrix(), ring = true, insideSvg = true } = {}) {
  const wheel = transform === null ? null : { getScreenCTM: () => transform };
  return {
    dataset: { type: 'gate', id: String(gate) }, insideSvg,
    classList: { contains: name => ring && name === 'mandala-gate' },
    closest(selector) { return selector === '.bodygraph-mandala' ? wheel : selector === '[data-type]' ? this : null; },
  };
}

function screenPoint(longitude, transform = matrix()) {
  const angle = longitude * Math.PI / 180, radius = MANDALA_GEOMETRY.labelRadius;
  return new Point(MANDALA_GEOMETRY.centerX - radius * Math.cos(angle),
    MANDALA_GEOMETRY.centerY + radius * Math.sin(angle)).matrixTransform(transform);
}

test('pointer longitude uses inverse screen transform after translation, scaling, rotation and skew', t => {
  patchGlobals(t, { DOMPoint: Point });
  for (const transform of [matrix(), matrix(.38, 0, 0, .38, 125, -48), matrix(0, 1.2, -1.2, 0, 900, 70), matrix(.8, .1, .25, .7, -200, 300)]) {
    for (const longitude of [0, .125, 89.99, 180, 270, 305.625, 305.75, 359.999]) {
      const point = screenPoint(longitude, transform);
      const result = mandalaPreviewFromPointer({ clientX: point.x, clientY: point.y }, target({ transform }));
      assert.equal(result.type, 'mandala-cross');
      close(Math.min(normalize(result.id - longitude), normalize(longitude - result.id)), 0);
      assert.equal(result.cross.source, 'personality', 'pointer longitude always anchors the conscious Sun, independent of saved gate colors');
      assert.equal(result.cross.positions[0].longitude, result.id);
    }
  }
});

test('pointer preview is continuous within a single ring cell, including the narrow juxtaposition region', t => {
  patchGlobals(t, { DOMPoint: Point });
  const sameCell = target({ gate: 41 });
  const results = [305.6, 305.64, 305.78].map(longitude => {
    const point = screenPoint(longitude);
    return mandalaPreviewFromPointer({ clientX: point.x, clientY: point.y }, sameCell);
  });
  assert.deepEqual(results.map(result => result.cross.type), ['right-angle', 'juxtaposition', 'left-angle']);
  assert.deepEqual(results.map(result => result.cross.profile), ['4/6', '4/1', '5/1']);
  assert.equal(new Set(results.map(result => result.id)).size, 3, 'id tracks angular motion, not the gate id');
});

test('non-ring, unavailable matrix, invalid screen position and center cannot create a pointer preview', t => {
  patchGlobals(t, { DOMPoint: Point });
  const valid = { clientX: 100, clientY: 200 };
  assert.equal(mandalaPreviewFromPointer(valid, target({ ring: false })), null);
  assert.equal(mandalaPreviewFromPointer(valid, target({ transform: null })), null);
  assert.equal(mandalaPreviewFromPointer(valid, target({ transform: { inverse() { throw new Error('not invertible'); } } })), null);
  assert.equal(mandalaPreviewFromPointer({ clientX: NaN, clientY: 1 }, target()), null);
  assert.equal(mandalaPreviewFromPointer({ clientX: 1, clientY: Infinity }, target()), null);
  assert.equal(mandalaPreviewFromPointer({ clientX: MANDALA_GEOMETRY.centerX, clientY: MANDALA_GEOMETRY.centerY }, target()), null);
});

test('singular screen transforms fail closed instead of throwing or rendering invalid geometry', t => {
  patchGlobals(t, { DOMPoint: Point });
  assert.equal(mandalaPreviewFromPointer({ clientX: 1, clientY: 1 }, target({ transform: matrix(0, 0, 0, 0) })), null);
});

test('keyboard preview starts at each gate midpoint and can reach all angle categories without a pointer', () => {
  for (const [index, gate] of MANDALA_GATE_ORDER.entries()) {
    const element = target({ gate });
    let current = mandalaPreviewFromFocus(element);
    const initialLongitude = normalize(MANDALA_LONGITUDE_START + (index + .5) * MANDALA_GATE_WIDTH);
    assert.equal(current.id, initialLongitude);
    const seen = new Set([current.cross.type]);
    for (let step = 0; step < 48; step++) {
      current = mandalaPreviewFromFocus(element, current, 1);
      seen.add(current.cross.type);
    }
    assert.deepEqual([...seen].sort(), ['juxtaposition', 'left-angle', 'right-angle']);
    assert.equal(current.id, normalize(initialLongitude + MANDALA_GATE_WIDTH));
    for (let step = 0; step < 48; step++) current = mandalaPreviewFromFocus(element, current, -1);
    assert.equal(current.id, initialLongitude, 'reversing traversal restores exact position');
  }
  assert.equal(mandalaPreviewFromFocus(target({ ring: false })), null);
  assert.equal(mandalaPreviewFromFocus(target({ gate: 'invalid' })), null);
});

test('keyboard traversal wraps around the full circle without accumulating position drift', () => {
  const element = target({ gate: 41 });
  let current = mandalaPreviewFromFocus(element), initial = current.id;
  for (let step = 0; step < 64 * 48; step++) current = mandalaPreviewFromFocus(element, current, 1);
  assert.equal(current.id, initial);
  for (let step = 0; step < 64 * 48; step++) current = mandalaPreviewFromFocus(element, current, -1);
  assert.equal(current.id, initial);
});

test('keyboard traversal resets to the newly focused gate instead of continuing a previous gate or pointer', () => {
  const first = target({ gate: 41 }), second = target({ gate: 46 });
  let current = mandalaPreviewFromFocus(first);
  current = mandalaPreviewFromFocus(first, current, 1);
  assert.equal(current.focusGate, 41);
  const next = mandalaPreviewFromFocus(second, current, 1);
  assert.equal(next.focusGate, 46);
  assert.equal(next.id, mandalaPreviewFromFocus(second).id);
  const fromPointer = mandalaPreviewFromFocus(second, preview(123), 1);
  assert.equal(fromPointer.id, next.id);
  assert.equal(mandalaPreviewFromFocus(second, next, 1).id, normalize(next.id + MANDALA_GATE_WIDTH / 48));
});

function hoverHarness(t) {
  const listeners = new Map(), previews = [], clears = [];
  const listen = name => (type, callback) => listeners.set(`${name}:${type}`, callback);
  const document = { hidden: false, addEventListener: listen('document') }, window = { addEventListener: listen('window') };
  patchGlobals(t, { DOMPoint: Point, document, window });
  const svg = { addEventListener: listen('svg'), classList: { contains: () => false }, contains: element => element?.insideSvg === true };
  const controller = attachHoverPreview(svg, {
    resolvePreview: mandalaPreviewFromPointer, resolveKeyboard: mandalaPreviewFromFocus,
    onPreview(value) { previews.push(value); },
    onClear() { clears.push(true); },
  });
  function send(type, options = {}, surface = 'svg') {
    const event = { pointerType: 'mouse', buttons: 0, target: target(), defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    listeners.get(`${surface}:${type}`)?.(event);
    return event;
  }
  function move(longitude) {
    const point = screenPoint(longitude);
    return send('pointermove', { clientX: point.x, clientY: point.y });
  }
  return { controller, previews, clears, move, send, document };
}

test('hover controller distinguishes continuous cross movement while ordinary gates retain old preview semantics', t => {
  const harness = hoverHarness(t);
  harness.move(305.64);
  harness.move(305.66);
  assert.equal(harness.previews.length, 2);
  assert.notEqual(harness.previews[0].id, harness.previews[1].id);
  assert.equal(harness.previews[0].cross.type, 'juxtaposition');
  harness.move(305.66);
  assert.equal(harness.previews.length, 2, 'an unchanged pointer still deduplicates');
  harness.send('pointermove', { target: target({ gate: 20, ring: false }) });
  assert.deepEqual(harness.controller.currentSelection, { type: 'gate', id: 20 });
});

test('silent clear notifies once, does not trigger redraw, and resets the transient cross', t => {
  const harness = hoverHarness(t);
  harness.move(305.64);
  assert.equal(harness.controller.currentSelection.cross.type, 'juxtaposition');
  harness.controller.clear({ notify: false });
  assert.equal(harness.controller.currentSelection, null);
  assert.equal(harness.previews.length, 1);
  assert.equal(harness.clears.length, 1);
  harness.controller.clear();
  assert.equal(harness.clears.length, 1);
  assert.equal(harness.previews.length, 1);
});

test('keyboard controller handles arrows and Escape without consuming Enter, Shift selection or modified shortcuts', t => {
  const harness = hoverHarness(t), element = target();
  const first = harness.send('keydown', { target: element, key: 'ArrowRight' });
  assert.equal(first.defaultPrevented, true);
  const start = harness.controller.currentSelection.id;
  harness.send('keydown', { target: element, key: 'ArrowRight' });
  assert.equal(harness.controller.currentSelection.id, normalize(start + MANDALA_GATE_WIDTH / 48));
  for (const options of [{ key: 'Enter' }, { key: 'Enter', shiftKey: true }, { key: 'ArrowRight', ctrlKey: true }, { key: 'ArrowRight', metaKey: true }, { key: 'ArrowRight', altKey: true }]) {
    const before = harness.controller.currentSelection;
    assert.equal(harness.send('keydown', { target: element, ...options }).defaultPrevented, false);
    assert.deepEqual(harness.controller.currentSelection, before);
  }
  harness.send('keydown', { target: element, key: 'Escape' });
  assert.equal(harness.controller.currentSelection, null);
});

test('leaving, zooming, dragging, touch and window blur dismiss only the temporary cross', t => {
  const harness = hoverHarness(t);
  for (const dismiss of [
    () => harness.send('pointerleave'), () => harness.send('wheel'),
    () => harness.send('pointermove', { buttons: 1 }),
    () => harness.send('pointermove', { pointerType: 'touch' }),
    () => harness.send('blur', {}, 'window'),
    () => { harness.document.hidden = true; harness.send('visibilitychange', {}, 'document'); },
  ]) {
    harness.document.hidden = false;
    harness.move(180);
    dismiss();
    assert.equal(harness.controller.currentSelection, null);
    assert.equal(harness.previews.at(-1), null);
  }
});

test('cross overlay has exactly four exact-angle rays, source-colored ring gates, and a pointer indicator', () => {
  for (const source of ['personality', 'design']) {
    const cross = crossAtLongitude(305.64, { source });
    const markup = renderMandala({}, { previewCross: cross });
    assert.match(markup, new RegExp(`class="mandala-cross-preview" data-cross-type="${cross.type}" pointer-events="none" aria-hidden="true"`));
    const marks = [...markup.matchAll(/<g class="mandala-cross-position"([^>]*)>([\s\S]*?)<\/g>/g)];
    assert.equal(marks.length, 4);
    marks.forEach(([, raw, content], index) => {
      const attrs = attributes(raw), expected = cross.positions[index];
      assert.equal(Number(attrs['data-cross-gate']), expected.gate);
      assert.equal(attrs['data-source'], expected.source);
      assert.equal(attrs['data-cross-planet'], expected.planet);
      assert.equal(Number(attrs['data-longitude']), expected.longitude);
      const ray = attributes(content.match(/<path class="mandala-cross-preview-ray"[^>]*>/)[0]);
      const [x, y] = mandalaPoint(expected.longitude, MANDALA_GEOMETRY.innerRadius);
      assert.equal(ray.d, `M ${MANDALA_GEOMETRY.centerX} ${MANDALA_GEOMETRY.centerY} L ${x} ${y}`);
      assert.equal(ray.stroke, expected.source === 'design' ? '#ae6259' : '#4b514e');
      assert.match(content, /class="mandala-cross-sector"/);
      assert.doesNotMatch(content, /data-type=|tabindex=|aria-pressed=/);
    });
    const cursor = attributes(markup.match(/<path class="mandala-cross-cursor"[^>]*>/)[0]);
    assert.equal(cursor.d, `M ${mandalaPoint(cross.longitude, MANDALA_GEOMETRY.outerRadius - 3).join(' ')} L ${mandalaPoint(cross.longitude, MANDALA_GEOMETRY.outerRadius + 6).join(' ')}`);
    assert.doesNotMatch(markup, /NaN|Infinity|undefined/);
  }
});

test('invalid cross data cannot render a speculative overlay or crash the renderer', () => {
  const base = crossAtLongitude(180), baseline = renderMandala();
  for (const cross of [null, {}, { ...base, type: 'unknown' }, { ...base, positions: [] },
    { ...base, positions: [null, ...base.positions.slice(1)] },
    { ...base, positions: base.positions.map(p => ({ ...p, planet: 'earth' })) },
    { ...base, positions: base.positions.map(p => ({ ...p, source: 'personality' })) },
    { ...base, positions: base.positions.map(p => ({ ...p, longitude: NaN })) },
    { ...base, positions: base.positions.map(p => ({ ...p, gate: 65 })) },
  ]) assert.equal(renderMandala({}, { previewCross: cross }), baseline);
});

test('cross gate highlighting adds to pinned Shift selections without committing the preview', () => {
  const chart = { personality: [20, 34, 46, 25], design: [10, 15] }, state = createSummarySelectionState();
  state.choose({ type: 'gate', id: '20' });
  state.choose({ type: 'gate', id: '34', additive: true });
  const baselineState = JSON.stringify(state.items), crossPreview = preview(180);
  const render = temporary => renderBodygraph(chart, state.primary, { showMandala: true, selections: state.items, previewSelection: temporary });
  const wheelCell = (markup, id) => markup.match(new RegExp(`<g class="mandala-gate bg-interactive"[^>]*data-id="${id}"[^>]*>`))?.[0];
  const coreCell = (markup, id) => markup.match(new RegExp(`<g data-type="gate" data-id="${id}"[^>]*>`))?.[0];
  const baseline = render(null), hovered = render(crossPreview);
  for (const gate of [20, 34, ...crossPreview.cross.gates]) {
    const pinned = [20, 34].includes(gate);
    for (const cell of [wheelCell(hovered, gate), coreCell(hovered, gate)]) {
      assert.match(cell, /data-related="true"/);
      assert.match(cell, new RegExp(`aria-pressed="${pinned}"`));
    }
  }
  assert.equal(JSON.stringify(state.items), baselineState);
  assert.equal(render(null), baseline, 'leaving restores the original committed paint exactly');
  state.choose({ type: 'gate', id: '34', additive: true });
  const reduced = render(crossPreview);
  assert.match(wheelCell(reduced, 20), /aria-pressed="true"/);
  assert.match(wheelCell(reduced, 34), /aria-pressed="false"/);
  assert.deepEqual(state.items.map(item => item.id), [20]);
  state.choose({ type: 'gate', id: '46', additive: true });
  assert.match(wheelCell(render(crossPreview), 46), /aria-pressed="true"/);
  state.choose({ type: 'gate', id: '46', additive: true });
  assert.match(wheelCell(render(crossPreview), 46), /aria-pressed="false"/, 'a cross-highlighted gate remains independently removable');
});
