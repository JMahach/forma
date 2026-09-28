import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachGestures } from '../src/scene/gestures.js';
import { DRAWING_BOUNDS } from '../src/scene/geometry/frames.js';
import { attachCameraControls, createCameraChangeHandler } from '../src/views/camera-controls.js';
import { createStudioLayout } from '../src/scene/studio-controller.js';
import { attachMandalaMode } from '../src/scene/modes/mandala.js';
import { MANDALA_FRAME, STUDIO_FRAME } from '../src/scene/geometry/frames.js';
import { createSelectionModel } from '../src/selection/selection-model.js';

const closeTo = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} ≈ ${expected}`);
const insets = Object.freeze({ side: 20, top: 12, bottom: 12 });

// Model the SVG's real centered viewBox transform. Pixel insets must remain
// correct when the canvas has a different aspect ratio from its viewBox.
function harness(t, width, height, mandala = false, initialInsets = insets, sharedHome = false) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform(matrix) { return { x: matrix.a * this.x + matrix.e, y: matrix.d * this.y + matrix.f }; }
  };
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'DOMPoint', previous); else delete globalThis.DOMPoint; });
  let rect = { left: 37, top: 84, width, height }, mode = mandala, safeInsets = { ...initialInsets };
  const listeners = new Map(), captures = new Set();
  const selection = createSelectionModel();
  const heading = { hidden: true };
  const fitButton = { hidden: true };
  const calls = { select: 0, clear: 0, preview: 0, popover: 0, summary: 0 };
  const matrix = () => {
    const scale = Math.min(rect.width / 640, rect.height / 820);
    return { scale, x: rect.left + (rect.width - 640 * scale) / 2, y: rect.top + (rect.height - 820 * scale) / 2 };
  };
  const svg = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    getScreenCTM() { return { inverse() { const { scale, x, y } = matrix(); return { a: 1 / scale, d: 1 / scale, e: -x / scale, f: -y / scale }; } }; },
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id),
    classList: { toggle() {} }, closest: () => null,
  };
  const controls = attachGestures(svg, { setAttribute() {} }, {
    fitInsets: () => safeInsets,
    getFrame: () => sharedHome || mode ? MANDALA_FRAME : null,
    getHomeFrame: sharedHome ? () => STUDIO_FRAME : null,
    onSelect(value) { calls.select++; selection.choose(value); },
    onBackgroundTap() { calls.clear++; selection.clear(); },
    onChange: createCameraChangeHandler({
      heading, fitButton,
      getHoverPreview: () => ({ clear() { calls.preview++; } }),
      activationPopover: { reposition() { calls.popover++; } },
      getSummary: () => ({ layout() { calls.summary++; } }),
    }),
  });
  const project = (view = controls.getView()) => {
    const { scale, x, y } = matrix(), bounds = mode ? MANDALA_FRAME.bounds : DRAWING_BOUNDS;
    return {
      left: x + (view.x + bounds.x * view.k) * scale,
      right: x + (view.x + (bounds.x + bounds.width) * view.k) * scale,
      top: y + (view.y + bounds.y * view.k) * scale,
      bottom: y + (view.y + (bounds.y + bounds.height) * view.k) * scale,
    };
  };
  const send = (type, extra = {}) => listeners.get(type)({
    type, pointerId: 1, pointerType: 'touch', button: 0,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    target: svg, preventDefault() {}, ...extra,
  });
  controls.reset();
  return { controls, project, send, selection, calls, heading, fitButton,
    get rect() { return { ...rect }; },
    get insets() { return { ...safeInsets }; },
    resize(width, height) { rect = { ...rect, width, height }; controls.resize(); },
    setInsets(value) { safeInsets = { ...value }; },
    setMandala(value) { mode = value; controls.reset(); },
    attachMandalaToggle() {
      let toggle, click;
      toggle = attachMandalaMode({
        button: { setAttribute() {}, addEventListener(type, handler) { assert.equal(type, 'click'); click = handler; } },
        canvas: { classList: { toggle() {}, add() {}, remove() {} } },
        gestures: controls,
        layout: sharedHome ? { frame: () => STUDIO_FRAME } : null,
        render() { mode = toggle.enabled; },
      });
      return () => click();
    },
  };
}

function assertCenteredAndContained(h) {
  const projected = h.project(), rect = h.rect, insets = h.insets;
  closeTo((projected.left + projected.right) / 2, rect.left + rect.width / 2, 'the whole drawing is horizontally centered');
  closeTo((projected.top + projected.bottom) / 2, rect.top + rect.height / 2, 'the whole drawing is vertically centered');
  assert.ok(projected.left >= rect.left + insets.side - 1e-8, 'left activations fit inside the canvas');
  assert.ok(projected.right <= rect.left + rect.width - insets.side + 1e-8, 'right activations fit inside the canvas');
  assert.ok(projected.top >= rect.top + insets.top - 1e-8, 'the top stays below the canvas edge');
  assert.ok(projected.bottom <= rect.top + rect.height - insets.bottom + 1e-8, 'the bottom stays above the separate day timeline');
  assert.deepEqual(h.controls.getView(), h.controls.getFittedView(), 'the initial frame is Home');
}

for (const [width, height, edge] of [[1440, 900, 100], [900, 800, 120], [390, 844, 120], [844, 390, 80], [390, 400, 120]]) {
  test(`standalone frame fitting remains centered in a ${width}×${height} canvas`, t => {
    const h = harness(t, width, height, false, { side: 20, top: edge, bottom: edge });
    assertCenteredAndContained(h);
    h.setMandala(true);
    assertCenteredAndContained(h);
    h.setMandala(false);
    assertCenteredAndContained(h);
  });
}


test('the layout owns measured insets and refreshes them once when canvas spacing changes', () => {
  let styleReads = 0, rectReads = 0;
  let style = { scrollPaddingLeft: '20px', scrollPaddingTop: '100px', scrollPaddingBottom: '60px' };
  const canvas = { dataset: {}, getBoundingClientRect() { rectReads++; return { width: 1200, height: 800 }; } };
  const layout = createStudioLayout({ canvas, panels: [], media: { matches: false },
    readStyle(element) { assert.equal(element, canvas); styleReads++; return style; } });
  const initial = layout.insets();
  assert.equal(initial.side, 20);
  assert.equal(initial.top, 100);
  assert.equal(initial.bottom, 60);
  assert.equal(layout.insets(), initial, 'camera measurements reuse the current measured layout');
  assert.deepEqual([rectReads, styleReads], [1, 1], 'reading resolved insets does not force another DOM measurement');
  style = { scrollPaddingLeft: '18.5px', scrollPaddingTop: '120px', scrollPaddingBottom: '80px' };
  layout.refresh();
  assert.equal(layout.insets().side, 18.5);
  assert.equal(layout.insets().top, 120);
  assert.equal(layout.insets().bottom, 80);
  assert.deepEqual([rectReads, styleReads], [2, 2]);
});

test('Home and resize reread responsive chrome space while preserving the screen center', t => {
  const h = harness(t, 1440, 900, false, { side: 20, top: 100, bottom: 100 });
  const desktopHome = h.controls.getFittedView();
  h.setInsets({ side: 20, top: 120, bottom: 120 });
  h.controls.reset();
  assertCenteredAndContained(h);
  assert.ok(h.controls.getFittedView().k < desktopHome.k, 'a larger chrome area leaves a smaller fitted drawing');
  h.setInsets({ side: 20, top: 80, bottom: 80 });
  h.resize(844, 390);
  assertCenteredAndContained(h);
});

test('explicit fit insets allow short canvases to fit below the historical normal-scale floor', t => {
  const h = harness(t, 320, 56);
  assert.ok(h.controls.getFittedView().k < 0.65, 'the full drawing can shrink when the reserved canvas is short');
  h.controls.zoom(1.01);
  const saved = h.controls.getView();
  assert.ok(saved.k < 0.65);
  h.controls.reset();
  h.controls.setView(saved);
  assert.deepEqual(h.controls.getView(), saved, 'a valid saved camera below the old floor can be restored');
  h.controls.zoom(0.001);
  assertCenteredAndContained(h);
});

test('resize and Home keep committed gates and mandala crosses while repositioning auxiliary views', t => {
  const h = harness(t, 1200, 800, true, { side: 20, top: 100, bottom: 100 });
  h.selection.choose({ type: 'mandala-cross', cross: { longitude: 40, source: 'personality' } });
  h.selection.choose({ type: 'gate', id: '37', additive: true });
  const items = h.selection.items, crosses = h.selection.crosses;
  const homeHandlers = new Map();
  attachCameraControls({ fitButton: { addEventListener(type, handler) { homeHandlers.set(type, handler); } } }, h.controls);
  h.send('wheel', { deltaY: -140 });
  const relativeZoom = h.controls.getView().k / h.controls.getFittedView().k;
  h.setInsets({ side: 20, top: 120, bottom: 120 });
  h.resize(390, 844);
  closeTo(h.controls.getView().k / h.controls.getFittedView().k, relativeZoom, 'resizing preserves relative zoom');
  assert.equal(h.selection.items, items, 'resize retains the committed gate snapshot');
  assert.equal(h.selection.crosses, crosses, 'resize retains the exact committed cross snapshot');
  homeHandlers.get('click')();
  assertCenteredAndContained(h);
  assert.equal(h.selection.items, items, 'Home retains gates');
  assert.equal(h.selection.crosses, crosses, 'Home retains crosses');
  assert.equal(h.calls.select, 0, 'camera movement does not select again');
  assert.equal(h.calls.clear, 0, 'camera movement does not clear selection');
  assert.ok(h.calls.popover > 2, 'open activation details follow the camera');
  assert.equal(h.calls.preview, h.calls.popover, 'transient hover is cleared on each camera change');
  assert.equal(h.calls.summary, h.calls.popover, 'the summary layout follows camera changes');
});

for (const mandala of [false, true]) {
  test(`the fixed title and Home button exchange visibility on zoom in ${mandala ? 'mandala' : 'normal'} mode`, t => {
    const h = harness(t, 1200, 800, mandala, { side: 20, top: 100, bottom: 100 });
    assert.equal(h.heading.hidden, false, 'initial Home shows the name and date');
    assert.equal(h.fitButton.hidden, true, 'initial fitted view needs no Home button');
    h.send('wheel', { deltaY: -140 });
    assert.equal(h.heading.hidden, true, 'any actual zoom hides the complete heading');
    assert.equal(h.fitButton.hidden, false, 'zoom reveals Home');
    const view = h.controls.getView();
    h.controls.setView({ ...view, x: view.x + 12, y: view.y + 8 });
    assert.equal(h.heading.hidden, true, 'panning cannot bring the heading back over the drawing');
    assert.equal(h.fitButton.hidden, false, 'panning a zoomed diagram keeps Home available');
    h.resize(390, 844);
    assert.equal(h.heading.hidden, true, 'responsive resizing preserves hidden state while zoomed');
    assert.equal(h.fitButton.hidden, false, 'responsive resizing keeps Home while relatively zoomed');
    h.controls.reset();
    assert.equal(h.heading.hidden, false, 'Home restores the fixed heading');
    assert.equal(h.fitButton.hidden, true, 'Home removes its own button again');
    h.controls.zoom(1.25);
    assert.equal(h.heading.hidden, true);
    assert.equal(h.fitButton.hidden, false);
    h.controls.zoom(0.001);
    assert.equal(h.heading.hidden, false, 'zooming out to the fitted floor restores the heading too');
    assert.equal(h.fitButton.hidden, true, 'zooming out to the fitted floor also hides Home');
  });
}

test('heading and Home visibility compare the whole desired camera and tolerate floating-point noise', () => {
  const heading = { hidden: true }, fitButton = { hidden: false };
  const onChange = createCameraChangeHandler({ heading, fitButton, activationPopover: { reposition() {} } });
  for (const k of [0.1, 0.65, 1.2]) {
    const fitted = { x: 20, y: 40, k };
    onChange({ ...fitted, k: k * (1 + 5e-10) }, fitted);
    assert.equal(heading.hidden, false, 'numerical fit noise does not flicker the title');
    assert.equal(fitButton.hidden, true, 'numerical fit noise does not flicker Home');
    onChange({ ...fitted, k: k * 1.01 }, fitted);
    assert.equal(heading.hidden, true, 'a genuine one-percent zoom hides it at any fitted scale');
    assert.equal(fitButton.hidden, false, 'a genuine zoom reveals Home even below scale 1');
    for (const view of [{ ...fitted, k: k * .8 }, { ...fitted, x: fitted.x + 1 }, { ...fitted, y: fitted.y - 1 }]) {
      onChange(view, fitted);
      assert.equal(heading.hidden, true, 'a retained camera away from Home keeps the title hidden');
      assert.equal(fitButton.hidden, false, 'a smaller or shifted camera still offers the current Home');
    }
  }
});

test('panning and resizing at fitted scale do not reveal Home', t => {
  const h = harness(t, 1200, 800, false, { side: 20, top: 100, bottom: 100 });
  const view = h.controls.getView();
  h.controls.setView({ ...view, x: view.x + 12, y: view.y + 8 });
  assert.equal(h.fitButton.hidden, true, 'the button follows zoom, not arbitrary positional drift');
  h.resize(390, 844);
  assert.equal(h.fitButton.hidden, true, 'a new fitted scale still counts as Home');
});

test('studio modes share one Home baseline and leave the caption to its overlap layout', t => {
  const h = harness(t, 1200, 800, false, { side: 20, top: 100, bottom: 100 }, true);
  const toggle = h.attachMandalaToggle();
  const chartHome = h.controls.getView();
  toggle();
  assert.deepEqual(h.controls.getView(), chartHome, 'opening the ring does not zoom the chart out');
  assert.deepEqual(h.controls.getFittedView(), chartHome, 'the body baseline remains Home with the ring visible');
  assert.equal(h.fitButton.hidden, true, 'a toggle alone cannot reveal Home');
  assert.equal(h.heading.hidden, false, 'mandala leaves the Home title measurable for the overlap layout');
  toggle();
  assert.deepEqual(h.controls.getView(), chartHome);
  assert.equal(h.fitButton.hidden, true);
  assert.equal(h.heading.hidden, false, 'the unchanged normal Home restores its title');
  h.controls.zoom(1.25);
  const zoomedChart = h.controls.getView();
  assert.equal(h.fitButton.hidden, false);
  toggle();
  assert.deepEqual(h.controls.getView(), zoomedChart, 'a zoomed chart also stays in place');
  assert.equal(h.fitButton.hidden, false);
  h.controls.zoom(1.2);
  const latest = h.controls.getView();
  toggle();
  assert.deepEqual(h.controls.getView(), latest, 'closing retains the latest zoom rather than the pre-open view');
  h.send('wheel', { deltaY: 0 });
  assert.deepEqual(h.controls.getView(), latest, 'the next input keeps that retained view');
  toggle();
  h.controls.reset();
  assert.deepEqual(h.controls.getView(), chartHome, 'Home restores the same body scale with the ring enabled');
  assert.equal(h.fitButton.hidden, true);
  assert.equal(h.heading.hidden, false, 'Home restores the caption for overlap measurement');
  toggle();
  assert.deepEqual(h.controls.getView(), chartHome);
  assert.equal(h.fitButton.hidden, true);
  assert.equal(h.heading.hidden, false);
  h.resize(390, 844);
  const rotated = h.controls.getView();
  assert.deepEqual(rotated, h.controls.getFittedView(), 'the shared baseline remains Home after rotation');
  toggle();
  assert.deepEqual(h.controls.getView(), rotated, 'rotation followed by a toggle retains the new live camera');
  assert.equal(h.fitButton.hidden, true);
  assert.equal(h.heading.hidden, false);
  toggle();
  assert.deepEqual(h.controls.getView(), rotated);
  assert.equal(h.fitButton.hidden, true);
  const finalChartHome = h.controls.getView();
  for (let i = 0; i < 10; i++) { toggle(); toggle(); }
  assert.deepEqual(h.controls.getView(), finalChartHome, 'repeated toggles do not accumulate camera drift');
  assert.equal(h.fitButton.hidden, true);
  toggle();
  h.controls.zoom(.0001);
  const minimum = h.controls.getView();
  assert.deepEqual(minimum, h.controls.getFittedView(), 'studio zoom-out stops at the shared Home even with expanded navigation');
  assert.equal(h.fitButton.hidden, true, 'the minimum studio view remains Home');
  assert.equal(h.heading.hidden, false);
  toggle();
  h.send('wheel', { deltaY: 0 });
  assert.deepEqual(h.controls.getView(), minimum, 'hiding the ring retains the shared minimum exactly');
  assert.equal(h.fitButton.hidden, true);
  h.controls.reset();
  assert.deepEqual(h.controls.getView(), finalChartHome);
  assert.equal(h.fitButton.hidden, true);
  assert.equal(h.heading.hidden, false);
});

test('shared Home survives resizing in mandala while moved cameras retain their navigation zoom', t => {
  const safe = { side: 20, top: 100, bottom: 100 };
  const h = harness(t, 1200, 800, false, safe, true), toggle = h.attachMandalaToggle();
  toggle();
  h.resize(390, 844);
  assert.deepEqual(h.controls.getView(), h.controls.getFittedView());
  assert.equal(h.fitButton.hidden, true);
  assert.equal(h.heading.hidden, false);
  h.controls.zoom(1.5);
  const moved = h.controls.getView();
  h.resize(844, 390);
  const rotated = h.controls.getView();
  assert.notDeepEqual(rotated, h.controls.getFittedView(), 'resizing a zoomed view cannot reset it to Home');
  assert.notEqual(rotated.k, moved.k);
  assert.equal(h.fitButton.hidden, false);
  toggle();
  assert.deepEqual(h.controls.getView(), rotated, 'closing after a resize keeps the latest moved camera');
  assert.equal(h.fitButton.hidden, false);
  h.controls.reset();
  assert.deepEqual(h.controls.getView(), h.controls.getFittedView());
  assert.equal(h.fitButton.hidden, true);
  assert.equal(h.heading.hidden, false);
});

test('shared Home does not narrow an existing mandala pan when the ring is hidden', t => {
  const h = harness(t, 1200, 800, false, { side: 20, top: 100, bottom: 100 }, true);
  const toggle = h.attachMandalaToggle();
  for (const [dx, dy] of [[10000, 0], [-10000, 0], [0, 10000], [0, -10000]]) {
    h.controls.reset(); toggle(); h.controls.zoom(2);
    const center = { clientX: h.rect.left + h.rect.width / 2, clientY: h.rect.top + h.rect.height / 2 };
    h.send('pointerdown', center);
    h.send('pointermove', { clientX: center.clientX + dx, clientY: center.clientY + dy });
    h.send('pointerup', { clientX: center.clientX + dx, clientY: center.clientY + dy });
    const edge = h.controls.getView();
    toggle(); h.controls.zoom(1); h.send('wheel', { deltaY: 0 });
    assert.deepEqual(h.controls.getView(), edge, 'the shared Home target cannot clamp a retained outer pan');
    assert.equal(h.fitButton.hidden, false);
  }
});


test('the application supplies the studio canvas insets and keeps only the Home button', () => {
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /createCanvasInsetsReader|readCanvasInsets/, 'the application reuses the layout owner instead of measuring discarded insets');
  assert.match(app, /fitInsets:\s*\(\)\s*=>\s*layout\.insets\(\)/, 'phone safe areas and desktop insets feed the same camera');
  assert.match(app, /getHomeFrame:\s*\(\)\s*=>\s*mandalaMode\?\.homeFrame/, 'the mode supplies the responsive Home baseline');
  assert.match(app, /createCameraChangeHandler\(\{\s*heading:\s*\$\('chartHeader'\)/, 'the real camera controls fixed-heading visibility');
  assert.match(app, /createCameraChangeHandler\(\{[^}]*fitButton:\s*\$\('fitButton'\)/, 'the real camera controls Home visibility');
  assert.match(page, /<header\b[^>]*id="chartHeader"/, 'one header owns both name and date visibility');
  for (const id of ['zoomIn', 'zoomOut', 'zoomValue']) {
    assert.doesNotMatch(page, new RegExp(`\\bid="${id}"`), `${id} is absent from the interface`);
    assert.doesNotMatch(app, new RegExp(`\\$\\('${id}'\\)`), `${id} has no bootstrap binding`);
  }
  assert.match(page, /\bid="fitButton"/);
  assert.match(page, /<button\b[^>]*id="fitButton"[^>]*\bhidden(?:\s|>)/, 'Home starts hidden before camera initialization to prevent a startup flash');
  assert.match(page, /<svg\b[^>]*id="bodygraph"[^>]*tabindex="0"/, 'the drawing remains keyboard focusable for +, − and 0');
  assert.ok(/attachCameraControls\(\{\s*fitButton:\s*\$\('fitButton'\)\s*\}/.test(app), 'the application binds the Home button without obsolete zoom controls');
});
