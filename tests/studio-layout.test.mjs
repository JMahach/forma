import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeStudioLayout, computeCameraFit, DAY_CONTROL_HEIGHT, DAY_CONTROL_TOP_CLEARANCE, STUDIO_BOTTOM_INSET } from '../src/scene/layout.js';
import { createStudioLayout, PHONE_LAYOUT_QUERY } from '../src/scene/studio-controller.js';
import { STUDIO_FRAME } from '../src/scene/geometry/frames.js';
import { attachMandalaMode } from '../src/scene/modes/mandala.js';
import { MANDALA_FRAME } from '../src/scene/geometry/frames.js';
import { attachGestures } from './fixtures/gesture-harness.js';
import { DRAWING_BOUNDS } from '../src/scene/geometry/frames.js';
import { MANDALA_PLANET_LAYOUT, layoutMandalaPlanets } from '../src/scene/geometry/mandala-planets.js';
import { MANDALA_GEOMETRY, MANDALA_SCENE_SCALE } from '../src/scene/geometry/mandala-geometry.js';
import { renderMandala } from '../src/scene/mandala.js';
import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';
import { createGraphController } from '../src/scene/updates.js';
import { createCameraChangeHandler } from '../src/views/camera-controls.js';
import { ACTIVATION_BLOCK_BOUNDS, ACTIVATION_COLUMN_REVEAL_DISTANCE } from '../src/scene/geometry/activation-layout.js';

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: ${actual} != ${expected}`);
const project = (layout, box) => ({ x: layout.center.x + (box.x - 320) * layout.scale,
  y: layout.center.y + (box.y - 398) * layout.scale, width: box.width * layout.scale, height: box.height * layout.scale });


function layoutHarness(phone = true, width = 390, height = 844) {
  const media = { matches: phone }, rect = { width, height };
  const canvas = { dataset: {}, getBoundingClientRect: () => ({ top: 50, left: 20, bottom: 50 + rect.height, ...rect }) };
  const drawing = { style: {} };
  let style = { scrollPaddingTop: '112px', scrollPaddingBottom: '64px', scrollPaddingLeft: '12px' };
  const panels = [0, 1].map(() => ({ hidden: true, dataset: {}, style: {},
    getBoundingClientRect() { assert.fail('panel content and visibility must never determine Home'); },
  }));
  const layout = createStudioLayout({ canvas, drawing, panels, media, readStyle: () => style });
  return { layout, media, canvas, drawing, panels, style(value) { style = value; },
    resize(width, height) { Object.assign(rect, { width, height }); return layout.refresh(); } };
}

test('layout reads the shared canvas offset once before writing any panel styles', () => {
  const events = [];
  let offset = 40;
  const writes = () => new Proxy({}, { set(target, key, value) { events.push('write'); target[key] = value; return true; } });
  const canvas = { dataset: writes(), getBoundingClientRect: () => ({ width: 1000, height: 800 }),
    get offsetLeft() { events.push('offset'); return offset; } };
  const panels = Array.from({ length: 3 }, () => ({ dataset: writes(), style: writes() }));
  const layout = createStudioLayout({ canvas, panels, art: { style: writes() }, media: { matches: false },
    readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingBottom: '64px', scrollPaddingLeft: '12px' }) });
  const assertReads = () => {
    assert.equal(events.filter(event => event === 'offset').length, 1);
    assert.ok(events.indexOf('offset') < events.indexOf('write'), 'geometry is read before styles or data attributes change');
  };
  assertReads();
  const initialLeft = parseFloat(panels[0].style.left);
  events.length = 0; offset = 120;
  layout.refresh();
  assertReads();
  for (const panel of panels) assert.equal(parseFloat(panel.style.left), initialLeft + 80, 'all timelines follow the changed canvas offset');
});

test('one studio square contains the drawing, ring cursors and full planet lanes', () => {
  const { bounds } = STUDIO_FRAME, { centerX, centerY } = MANDALA_GEOMETRY;
  assert.equal(bounds.width, bounds.height);
  assert.equal(bounds.x + bounds.width / 2, centerX);
  assert.equal(bounds.y + bounds.height / 2, centerY);
  assert.equal(bounds.width / 2, MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE);
  assert.ok(DRAWING_BOUNDS.x >= bounds.x && DRAWING_BOUNDS.y >= bounds.y);
  assert.ok(DRAWING_BOUNDS.x + DRAWING_BOUNDS.width <= bounds.x + bounds.width);
  assert.ok(DRAWING_BOUNDS.y + DRAWING_BOUNDS.height <= bounds.y + bounds.height);
  assert.ok(Object.isFrozen(STUDIO_FRAME) && Object.isFrozen(bounds));
  for (let longitude = 0; longitude < 360; longitude += 15) {
    const markup = renderMandala({}, { previewCross: crossAtLongitude(longitude) });
    const cursor = markup.match(/class="mandala-cross-cursor" d="M ([\d. -]+) L ([\d. -]+)"/);
    assert.ok(cursor);
    const [x, y] = cursor[2].trim().split(/\s+/).map(Number);
    const paintedX = centerX + (x - centerX) * MANDALA_SCENE_SCALE;
    const paintedY = centerY + (y - centerY) * MANDALA_SCENE_SCALE;
    const halfStroke = MANDALA_SCENE_SCALE;
    assert.ok(paintedX - halfStroke >= bounds.x - .001 && paintedX + halfStroke <= bounds.x + bounds.width + .001);
    assert.ok(paintedY - halfStroke >= bounds.y - .001 && paintedY + halfStroke <= bounds.y + bounds.height + .001);
  }
});

test('phone detection explicitly includes narrow screens and short coarse-pointer landscape, not desktop or tablets', () => {
  assert.equal(PHONE_LAYOUT_QUERY, '(max-width: 699px), (pointer: coarse) and (max-width: 1099px) and (max-height: 500px)');
  const matches = ({ width, height, coarse }) => PHONE_LAYOUT_QUERY.split(',').some(branch => branch.trim().split(/\s+and\s+/).every(condition => {
    if (condition === '(pointer: coarse)') return coarse;
    const [, dimension, limit] = condition.match(/^\(max-(width|height): (\d+)px\)$/);
    return (dimension === 'width' ? width : height) <= Number(limit);
  }));
  for (const [width, height, coarse, expected] of [
    [390, 844, true, true], [699, 900, false, true], [700, 900, true, false],
    [844, 390, true, true], [844, 390, false, false], [1099, 500, true, true],
    [1100, 500, true, false], [1024, 501, true, false], [1440, 900, false, false],
  ]) assert.equal(matches({ width, height, coarse }), expected, `${width}×${height}, coarse=${coarse}`);
});

test('both modes and both pointer classes use exactly the same Home and control geometry', () => {
  const h = layoutHarness(false, 1000, 800), before = h.layout.refresh();
  for (const phone of [false, true, false]) {
    h.media.matches = phone;
    assert.deepEqual(h.layout.refresh(), before);
    assert.equal(h.canvas.dataset.layout, phone ? 'phone' : 'desktop');
    assert.equal(h.layout.phone, phone);
    assert.equal(h.layout.frame(false), STUDIO_FRAME);
    assert.equal(h.layout.frame(true), STUDIO_FRAME);
  }
});

test('outside planet glyphs fit every Home and leave the entire day touch target clear', () => {
  const entries = ['design', 'personality'].flatMap(source => Array.from({ length: 13 }, (_, index) => ({
    source, planet: `planet-${index}`, longitude: (index % 4) * 90 + index * .01,
  })));
  const glyphs = layoutMandalaPlanets(entries);
  for (const [width, height, top, bottom] of [
    [320, 568, 112, 64], [393, 747, 112, 64], [505, 692, 112, 64],
    [759, 747, 64, 64], [1002, 817, 64, 64], [844, 390, 64, 98], [1440, 900, 64, 64],
  ]) {
    const h = layoutHarness(width < 700, width, height);
    h.style({ scrollPaddingTop: `${top}px`, scrollPaddingBottom: `${bottom}px`, scrollPaddingLeft: '12px' });
    const layout = h.layout.refresh();
    for (const glyph of glyphs) {
      const x = layout.center.x + (glyph.x - MANDALA_GEOMETRY.centerX) * MANDALA_SCENE_SCALE * layout.scale;
      const y = layout.center.y + (glyph.y - MANDALA_GEOMETRY.centerY) * MANDALA_SCENE_SCALE * layout.scale;
      const radius = MANDALA_PLANET_LAYOUT.glyphRadius * MANDALA_SCENE_SCALE * layout.scale;
      assert.ok(x - radius >= layout.area.x, `${width}×${height}: left glyph edge stays inside`);
      assert.ok(x + radius <= width - layout.area.x, `${width}×${height}: right glyph edge stays inside`);
      assert.ok(y - radius >= top - 1e-7, `${width}×${height}: the planet clears the top inset`);
      assert.ok(y + radius <= layout.panel.y - 17 - 4 + .001, `${width}×${height}: glyph clears the date fields above the slider`);
      assert.ok(h.layout.mandalaTop <= y - radius + .001, 'caption overlap sees the glyph envelope');
    }
    close(h.layout.mandalaTop, layout.center.y - layout.mandalaRadius, 'caption uses full planet extent');
    assert.ok(h.layout.mandalaTop < layout.center.y - layout.panel.width / 2, 'the ring edge is insufficient for header overlap');
    if (layout.showMandalaColumns) {
      // Conservative inner edges of the actual row hit areas after scale and travel.
      const leftInner = project(layout, { x: -62.68 - ACTIVATION_COLUMN_REVEAL_DISTANCE, y: 49.56, width: 126.004, height: 712.86 });
      const rightInner = project(layout, { x: 589.32 + ACTIVATION_COLUMN_REVEAL_DISTANCE, y: 49.56, width: 126.004, height: 712.86 });
      assert.ok(leftInner.x + leftInner.width < layout.center.x - layout.mandalaRadius, 'Design rows never enter the outer glyph lane');
      assert.ok(rightInner.x > layout.center.x + layout.mandalaRadius, 'Personality rows never enter the outer glyph lane');
    }
  }
});

test('Home preserves its fitted square size within the translated studio area', () => {
  for (const [width, height] of [[393, 852], [700, 1100], [844, 390], [1440, 900], [320, 180], [2400, 220]]) {
    const layout = computeStudioLayout({ width, height, side: 12, top: 64, bottom: 64 });
    const box = project(layout, STUDIO_FRAME.bounds), area = layout.area;
    close(box.x + box.width / 2, area.x + area.width / 2, 'horizontal center');
    close(box.y + box.height / 2, area.y + area.height / 2, 'vertical center');
    assert.ok(box.x >= area.x - 1e-7 && box.y >= area.y - 1e-7);
    assert.ok(box.x + box.width <= area.x + area.width + 1e-7);
    assert.ok(box.y + box.height <= area.y + area.height + 1e-7);
    assert.ok(Math.abs(box.width - area.width) < 1e-7 || Math.abs(box.height - area.height) < 1e-7,
      'one edge must limit Home; optional columns must never shrink it');
    assert.ok(layout.panel.x >= 0 && layout.panel.y >= 0);
    assert.ok(layout.panel.x + layout.panel.width <= width + 1e-7);
    assert.ok(layout.panel.y + layout.panel.height <= height + 1e-7);
  }
  const asymmetric = computeStudioLayout({ width: 1200, height: 800, top: 112, bottom: 64 });
  close(asymmetric.center.y - asymmetric.insets.offsetY, 414,
    'the fitting center accounts for the date heading above the unchanged footer');
});

test('the shared composition moves toward the day line while protecting the full touch target', () => {
  for (const [width, height, top, bottom, side] of [
    [393, 747, 112, 64, 12], [997, 747, 64, 64, 20], [1440, 900, 64, 64, 20],
    [844, 390, 64, 98, 12], [320, 100, 64, 64, 12], [2400, 220, 112, 64, 20],
  ]) {
    const layout = computeStudioLayout({ width, height, top, bottom, side });
    const originalTop = Math.min(top, height * .49), originalBottom = Math.min(bottom, height * .49);
    const cameraBottom = Math.min(originalBottom + DAY_CONTROL_TOP_CLEARANCE, height * .49);
    const reserved = cameraBottom - originalBottom;
    const originalHeight = Math.max(1, height - originalTop - cameraBottom);
    const originalCenter = originalTop + originalHeight / 2;
    const lineY = layout.panel.y + 26;
    const visibleRadius = MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE * layout.scale;
    const originalGap = lineY - originalCenter - visibleRadius;
    const expectedShift = Math.max(0, Math.min(originalGap / 4, layout.panel.y - reserved - 4 - originalCenter - visibleRadius));
    close(layout.insets.offsetY, expectedShift, 'translation is a quarter-gap shift capped by the control clearance');
    close(layout.center.y, originalCenter + expectedShift, 'the whole scene has one shifted center');
    close(layout.area.y, originalTop + expectedShift, 'the fit area is translated with the scene');
    close(layout.area.height, originalHeight, 'the fitting height reserves the date heading separately from the footer');
    close(layout.scale, Math.min(width - 2 * side, originalHeight) / STUDIO_FRAME.bounds.width, 'Home uses all space above the date heading');
    assert.ok(lineY - layout.center.y - visibleRadius >= originalGap * .75 - 1e-7, 'at least three quarters of the original gap remain');
    assert.equal(layout.insets.top, originalTop);
    assert.equal(layout.insets.bottom, cameraBottom);
    assert.ok(layout.insets.offsetY >= 0);
  }
});

test('columns follow real side room and do not reduce scale when crossing their width threshold', () => {
  for (const [width, height, expected] of [[393, 852, false], [700, 1100, false], [844, 390, true], [1440, 900, true]]) {
    const layout = computeStudioLayout({ width, height, top: 64, bottom: 64, side: 12 });
    assert.equal(layout.showMandalaColumns, expected, `${width}×${height}`);
    if (!expected) continue;
    // Enlarged row hit areas and fixing marks after the shared outward journey.
    // Explicit painted coordinates also check that the shared envelope is conservative.
    for (const box of [{ x: -62.68 - ACTIVATION_COLUMN_REVEAL_DISTANCE, y: 49.56, width: 126.004, height: 712.86 },
      { x: 589.32 + ACTIVATION_COLUMN_REVEAL_DISTANCE, y: 49.56, width: 126.004, height: 712.86 }]) {
      const column = project(layout, box), area = layout.area;
      assert.ok(column.x >= area.x && column.y >= area.y);
      assert.ok(column.x + column.width <= area.x + area.width);
      assert.ok(column.y + column.height <= area.y + area.height);
    }
  }
  let width = 700;
  while (!computeStudioLayout({ width, height: 800, top: 64, bottom: 64 }).showMandalaColumns) width++;
  const before = computeStudioLayout({ width: width - 1, height: 800, top: 64, bottom: 64 });
  const after = computeStudioLayout({ width, height: 800, top: 64, bottom: 64 });
  assert.equal(before.showMandalaColumns, false);
  assert.equal(after.showMandalaColumns, true);
  assert.equal(before.scale, after.scale);
  assert.equal(before.center.y, after.center.y);

  // These old thresholds admitted the ordinary columns but clipped the larger
  // left checkbox target. Capacity must include the final content scale.
  for (const [width, height] of [[439, 500], [706, 700], [840, 800], [973, 900], [1214, 1080]]) {
    assert.equal(computeStudioLayout({ width, height }).showMandalaColumns, false);
    let safeWidth = width;
    while (!computeStudioLayout({ width: safeWidth, height }).showMandalaColumns) safeWidth++;
    const safe = computeStudioLayout({ width: safeWidth, height });
    const larger = project(safe, { x: -370.828125, y: 10.96875, width: 1357.2447916666667, height: 749.375 });
    assert.ok(larger.x >= safe.area.x + 4 - 1e-7, 'the complete enlarged left hit target clears the canvas');
    assert.ok(larger.x + larger.width <= safe.area.x + safe.area.width - 4 + 1e-7);
    const previous = computeStudioLayout({ width: safeWidth - 1, height });
    assert.equal(previous.showMandalaColumns, false);
    assert.equal(previous.scale, safe.scale, 'column capacity never shrinks the ring at its threshold');
    assert.equal(previous.center.y, safe.center.y);
    assert.equal(previous.panel.y, safe.panel.y);
  }
});

test('enlarged calculation blocks fit the ring height and keep room at the narrowest phone sizes', () => {
  const ringRadius = MANDALA_GEOMETRY.outerRadius * MANDALA_SCENE_SCALE;
  assert.ok(ACTIVATION_BLOCK_BOUNDS.height <= 2 * ringRadius, 'columns cannot grow taller than the visible mandala');
  assert.ok(ACTIVATION_BLOCK_BOUNDS.y >= MANDALA_GEOMETRY.centerY - ringRadius);
  assert.ok(ACTIVATION_BLOCK_BOUNDS.y + ACTIVATION_BLOCK_BOUNDS.height <= MANDALA_GEOMETRY.centerY + ringRadius);
  for (const [width, height] of [[320, 568], [320, 747], [393, 747]]) {
    const layout = computeStudioLayout({ width, height, side: 8, top: 112, bottom: 64 });
    const resting = project(layout, { ...ACTIVATION_BLOCK_BOUNDS,
      x: ACTIVATION_BLOCK_BOUNDS.x - 14, width: ACTIVATION_BLOCK_BOUNDS.width + 28 });
    assert.ok(resting.x >= layout.area.x, `${width}px leaves the full Design block inside the viewport`);
    assert.ok(resting.x + resting.width <= width - layout.area.x, `${width}px leaves the full Personality block inside the viewport`);
    assert.ok(resting.y + resting.height <= layout.panel.y + 13, 'the enlarged bottom row clears the visible day control');
  }
});

test('the day timeline stays below the chart and spans the visible ring at every aspect ratio', () => {
  for (const height of [100, 110, 120, 180, 220, 390, 747, 800, 1100]) {
    let previous;
    for (let width = 320; width <= 1440; width += 4) {
      const layout = computeStudioLayout({ width, height, top: 64, bottom: 64, side: 12 });
      const { panel } = layout;
      const ring = project(layout, {
        x: MANDALA_GEOMETRY.centerX - MANDALA_GEOMETRY.outerRadius * MANDALA_SCENE_SCALE,
        y: MANDALA_GEOMETRY.centerY - MANDALA_GEOMETRY.outerRadius * MANDALA_SCENE_SCALE,
        width: 2 * MANDALA_GEOMETRY.outerRadius * MANDALA_SCENE_SCALE,
        height: 2 * MANDALA_GEOMETRY.outerRadius * MANDALA_SCENE_SCALE,
      });
      assert.equal(layout.placement, 'bottom', `${width}×${height} never moves the timeline to one side`);
      assert.equal(panel.height, DAY_CONTROL_HEIGHT);
      close(panel.x + panel.width / 2, width / 2, 'timeline center');
      close(panel.x, ring.x, 'left endpoint matches the visible ring');
      close(panel.x + panel.width, ring.x + ring.width, 'right endpoint matches the visible ring');
      assert.ok(panel.width < 2 * layout.radius, 'the outside planet lanes are not part of the visible timeline width');
      close(panel.y, height - DAY_CONTROL_HEIGHT - Math.max(0, Math.min(64, height * .49) - STUDIO_BOTTOM_INSET), 'timeline retains its original safe-area allowance, independently of the camera reserve');
      assert.ok(panel.y + 13 >= layout.center.y + layout.radius - 1e-7, 'the ring and outer cursor clear the visible backing even when the transparent hit area overlaps');
      assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 1e-7);
      assert.ok(panel.y + panel.height <= height + 1e-7);
      const boxes = [{ ...ACTIVATION_BLOCK_BOUNDS,
        x: ACTIVATION_BLOCK_BOUNDS.x - 14, width: ACTIVATION_BLOCK_BOUNDS.width + 28 }];
      if (layout.showMandalaColumns) boxes.push({ ...ACTIVATION_BLOCK_BOUNDS,
        x: ACTIVATION_BLOCK_BOUNDS.x - ACTIVATION_COLUMN_REVEAL_DISTANCE, width: ACTIVATION_BLOCK_BOUNDS.width + 2 * ACTIVATION_COLUMN_REVEAL_DISTANCE });
      for (const box of boxes) {
        const column = project(layout, box);
        assert.ok(column.y + column.height <= panel.y + 13 + 1e-7, 'no calculation column in either mode is covered by the visible backing');
      }
      if (previous) {
        assert.deepEqual({ ...layout.insets, offsetY: 0 }, { ...previous.insets, offsetY: 0 });
        close(layout.center.y - layout.insets.offsetY, previous.center.y - previous.insets.offsetY, 'the original vertical fitting center remains unchanged');
        assert.ok(Math.abs(layout.insets.offsetY - previous.insets.offsetY) <= 2 + 1e-7, 'the quarter-gap shift and its touch-clearance cap change continuously through width and column thresholds');
        // A four-pixel viewport change can grow a width-limited circle by at most four pixels.
        assert.ok(Math.abs(layout.scale - previous.scale) <= 4 / STUDIO_FRAME.bounds.width + 1e-10);
      }
      previous = layout;
    }
  }
});

test('the real camera applies a CSS-pixel quarter-gap shift without scaling or mode-toggle drift', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMPoint');
  globalThis.DOMPoint = class {
    constructor(x, y) { this.x = x; this.y = y; }
    matrixTransform(matrix) { return { x: matrix.a * this.x + matrix.e, y: matrix.d * this.y + matrix.f }; }
  };
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'DOMPoint', previous); else delete globalThis.DOMPoint; });
  for (const [width, height] of [[393, 852], [997, 852], [844, 390], [320, 100]]) {
    const h = layoutHarness(width < 700, width, height), listeners = new Map(), captures = new Set();
    const rect = { left: 37, top: 84, width, height, right: 37 + width, bottom: 84 + height };
    const svg = {
      addEventListener: (name, handler) => listeners.set(name, handler),
      getBoundingClientRect: () => rect,
      getScreenCTM: () => ({ inverse() {
        const scale = Math.min(width / 640, height / 820);
        return { a: 1 / scale, d: 1 / scale, e: -(rect.left + (width - 640 * scale) / 2) / scale,
          f: -(rect.top + (height - 820 * scale) / 2) / scale };
      } }),
      classList: { toggle() {} }, closest: () => null,
      setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id),
    };
    let mode, click, transform, offsetEnabled = false;
    const gestures = attachGestures(svg, { setAttribute(name, value) { transform = value; } }, {
      fitInsets: () => ({ ...h.layout.insets(), ...(offsetEnabled ? {} : { offsetY: 0 }) }), getFrame: () => mode?.frame, getHomeFrame: () => mode?.homeFrame,
      onSelect() {}, onChange() {},
    });
    mode = attachMandalaMode({ layout: h.layout, gestures, render() {},
      canvas: { style: { setProperty() {} }, classList: { toggle() {} } },
      button: { setAttribute() {}, addEventListener(name, handler) { click = handler; } },
    });
    const send = (type, extra = {}) => listeners.get(type)({ type, pointerId: 1, pointerType: 'touch', button: 0,
      clientX: rect.left + width / 2, clientY: rect.top + height / 2, target: svg, preventDefault() {}, ...extra });
    gestures.reset();
    const originalHome = gestures.getFittedView();
    offsetEnabled = true;
    gestures.reset();
    const shiftedHome = gestures.getFittedView(), svgScale = Math.min(width / 640, height / 820);
    close(shiftedHome.k, originalHome.k, 'moving toward the timeline does not change scale');
    close(shiftedHome.x, originalHome.x, 'horizontal camera position stays fixed');
    close((shiftedHome.y - originalHome.y) * svgScale, h.layout.insets().offsetY, 'offset is applied in CSS pixels after the SVG aspect-ratio transform');
    for (const zoom of [1, 1.8]) {
      gestures.reset();
      if (zoom > 1) {
        gestures.zoom(zoom);
        send('pointerdown'); send('pointermove', { clientX: rect.left + width / 2 + 70 });
        send('pointerup', { clientX: rect.left + width / 2 + 70 });
      }
      const before = gestures.getView(), home = gestures.getFittedView(), originalTransform = transform;
      for (let i = 0; i < 6; i++) {
        click();
        assert.deepEqual(gestures.getView(), before, `${width}px, zoom ${zoom}, toggle ${i}`);
        assert.deepEqual(gestures.getFittedView(), home);
        assert.equal(transform, originalTransform);
        assert.equal(h.drawing.style.clipPath, 'none', 'the day control cannot crop a strip from the zoomed or fitted drawing');
        send('wheel', { deltaY: 0 });
        assert.deepEqual(gestures.getView(), before, 'the next gesture must not reveal deferred constraint drift');
      }
    }
  }
});

test('hidden, loading, error and differently sized panels retain the frame without clipping a canvas strip', () => {
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    const h = layoutHarness(false, width, height), before = h.layout.refresh();
    const coordinates = h.panels.map(panel => ({ ...panel.style }));
    assert.equal(h.drawing.style.clipPath, 'none');
    for (const state of ['loading', 'ready', 'error', 'hidden']) {
      for (const [index, panel] of h.panels.entries()) {
        panel.hidden = state === 'hidden' || index === 1;
        panel.dataset.status = state;
        panel.contentHeight = state === 'error' ? 140 : 48;
      }
      h.drawing.style.clipPath = 'inset(0 0 80px 0)';
      assert.deepEqual(h.layout.refresh(), before);
      assert.deepEqual(h.layout.insets(), { side: 12, top: 112, bottom: 64 + DAY_CONTROL_TOP_CLEARANCE, offsetY: before.insets.offsetY });
      assert.equal(h.drawing.style.clipPath, 'none', 'refresh also clears a stale cutoff from an older layout');
      assert.deepEqual(h.panels.map(panel => panel.style), coordinates);
      assert.equal(h.panels[0].dataset.placement, h.panels[1].dataset.placement);
    }
  }
});

test('every Studio screen keeps one Home without remeasuring the camera on either toggle', () => {
  const h = layoutHarness(false), calls = [], attributes = {};
  let click, mode;
  mode = attachMandalaMode({
    layout: h.layout,
    button: { addEventListener(type, callback) { assert.equal(type, 'click'); click = callback; }, setAttribute(name, value) { attributes[name] = value; } },
    canvas: { style: { setProperty() {} }, classList: { toggle() {} } },
    beforeChange: () => calls.push('close'), render: () => calls.push(`render ${mode.enabled}`),
    gestures: {
      refreshFrame() { assert.fail('the permanent Studio frame does not need a new measurement'); }, transitionHome() { assert.fail('a mode toggle must not animate the camera'); },
      reset() { assert.fail('a mode toggle is not an explicit Home reset'); },
    },
    motion: { setExpanded: enabled => calls.push(`ring ${enabled}`) },
  });
  for (const phone of [false, true]) {
    h.media.matches = phone; h.layout.refresh();
    for (const enabled of [true, false]) {
      const before = h.layout.refresh();
      calls.length = 0; click();
      assert.deepEqual(calls, ['close', `render ${enabled}`, `ring ${enabled}`]);
      assert.equal(mode.homeFrame, STUDIO_FRAME);
      assert.equal(mode.frame, MANDALA_FRAME, 'navigation bounds also stay independent of the visible layer');
      assert.equal(attributes['aria-checked'], String(enabled));
      assert.deepEqual(h.layout.refresh(), before);
    }
  }
});

test('space-dependent columns retain every ring/body gate, exact core markup and committed selection', () => {
  const h = layoutHarness(false, 700, 1100), state = { enabled: false, visible: false };
  const chart = { id: 'phone-test', source: 'calculated', personality: [20, 34], design: [57],
    activations: { personality: [{ planet: 'sun', gate: 20, line: 3 }], design: [{ planet: 'sun', gate: 57, line: 2 }] } };
  const viewport = { innerHTML: '', querySelector: () => null };
  const graph = createGraphController({
    viewport, scene: { update(chart, selection, options) { viewport.innerHTML = renderBodygraph(chart, selection, options); }, clear() { viewport.innerHTML = ''; } }, getChart: () => chart, getMandala: () => state,
    getShowActivations: () => !(state.enabled && !h.layout.showMandalaColumns),
    activationPopover: { close() {}, refresh() {}, show() {} },
  });
  graph.choose({ type: 'gate', id: '20' });
  const normal = viewport.innerHTML, selected = graph.selectionState.items;
  assert.match(normal, /class="activation-columns"/);
  h.media.matches = true; h.layout.refresh(); graph.render();
  assert.equal(viewport.innerHTML, normal, 'normal phone mode keeps the existing columns and core markup');
  state.enabled = state.visible = true; graph.render();
  const phoneMandala = viewport.innerHTML;
  assert.doesNotMatch(phoneMandala, /class="activation-column(?:s)?"|data-activation=/);
  const body = phoneMandala.slice(phoneMandala.indexOf('<g class="bodygraph-gates">'));
  const gates = [...body.matchAll(/data-type="gate" data-id="(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(gates.sort((a, b) => a - b), Array.from({ length: 64 }, (_, index) => index + 1));
  assert.equal((phoneMandala.match(/class="mandala-gate bg-interactive"/g) || []).length, 64);
  assert.equal(graph.selectionState.items, selected);
  h.resize(844, 390); graph.render();
  assert.equal(h.layout.phone, true, 'a landscape phone can have enough room for columns');
  assert.match(viewport.innerHTML, /class="activation-columns"/);
  const core = markup => markup.slice(markup.indexOf('<g class="bodygraph-channels">'));
  assert.equal(core(phoneMandala), core(viewport.innerHTML), 'column visibility never edits channels, centers or gate controls');
  assert.equal(graph.selectionState.items, selected);
});

test('Home leaves the caption measurable at every fitted scale; zoom and pan hide it', () => {
  const heading = {}, fitButton = {};
  const update = createCameraChangeHandler({ heading, fitButton, activationPopover: { reposition() {} } });
  for (const k of [.25, .55, 1.2]) {
    const home = { x: 120, y: 210, k };
    update(home, home);
    assert.equal(heading.hidden, false, 'the overlap layout decides caption visibility at Home');
    assert.equal(fitButton.hidden, true);
    for (const view of [{ ...home, k: home.k * 1.2 }, { ...home, x: home.x + 20 }]) {
      update(view, home);
      assert.equal(heading.hidden, true);
      assert.equal(fitButton.hidden, false);
    }
    update(home, home);
    assert.equal(heading.hidden, false);
  }
});

test('application rerenders geometric column changes without imposing a phone-only caption policy', () => {
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /getShowActivations:\s*\(\)\s*=>\s*!\(mandalaMode\?\.enabled && !layout\.showMandalaColumns\)/);
  assert.doesNotMatch(app, /showMandalaHeading/, 'camera controls do not own the caption overlap policy');
  assert.match(app, /attachMandalaMode\(\{[\s\S]*?motion: mandalaMotion, layout,/);
  assert.match(app, /mandalaColumns !== layout\.showMandalaColumns[\s\S]*?graph\.render\(\)[\s\S]*?gestures\.resize\(\)/);
  assert.match(app, /layoutObserver\.observe\(\$\('canvasWrap'\)\)/);
  assert.doesNotMatch(app, /\[\$\('bodygraph'\), \$\('transitControls'\), \$\('chartDayControls'\)\]/, 'day panel content is not a camera resize source');
});

test('narrow Home uses a four-pixel outer planet margin without shrinking either mode', () => {
  const planetRadius = MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE;
  for (const width of [320, 375, 390, 393, 505]) {
    const layout = computeStudioLayout({ width, height: 844, side: 4, top: 112, bottom: 52 });
    close(layout.center.x - planetRadius * layout.scale, 4, `${width}px left outer planet edge`);
    close(width - layout.center.x - planetRadius * layout.scale, 4, `${width}px right outer planet edge`);
    assert.ok(layout.center.y + planetRadius * layout.scale <= layout.panel.y - 4);
  }
});

test('Home clears both date fields while the footer stays fixed and roomy phones keep their scale', () => {
  for (const [width, height, top, bottom] of [
    [320, 568, 112, 52], [390, 844, 112, 52], [505, 692, 112, 64],
    [844, 390, 74, 98], [1025, 775, 74, 52], [1366, 400, 74, 52], [1440, 500, 74, 64],
  ]) {
    const layout = computeStudioLayout({ width, height, side: 4, top, bottom });
    const footerY = height - DAY_CONTROL_HEIGHT - Math.max(0, bottom - STUDIO_BOTTOM_INSET);
    const dateFieldTop = footerY - 13 + (22 - 30) / 2;
    const envelopeBottom = layout.center.y + layout.mandalaRadius;
    close(layout.panel.y, footerY, `${width}×${height}: the timeline does not move`);
    assert.ok(envelopeBottom <= dateFieldTop - 4, `${width}×${height}: full red and black planet envelope clears the input boxes`);
    assert.ok(layout.center.y - layout.mandalaRadius >= top - 1e-7, `${width}×${height}: the top cannot be clipped`);
    if (width - 8 <= height - top - bottom - DAY_CONTROL_TOP_CLEARANCE) {
      close(layout.scale, (width - 8) / STUDIO_FRAME.bounds.width, `${width}×${height}: width-limited Home is unchanged`);
    }
  }
});

test('camera and loading-area bounds agree when the extra date clearance is clamped on tiny screens', () => {
  for (const width of [320, 844, 1440]) for (const height of [60, 80, 100, 120, 140, 180, 220, 390, 844]) {
    const layout = computeStudioLayout({ width, height, side: 4, top: 112, bottom: 64 });
    const rect = { left: 23, top: 47, right: 23 + width, bottom: 47 + height, width, height };
    const fit = computeCameraFit(STUDIO_FRAME, rect, layout.insets, (x, y) => ({ x: x - rect.left, y: y - rect.top }));
    for (const key of ['x', 'y', 'width', 'height']) close(fit.area[key], layout.area[key], `${width}×${height}: shared ${key}`);
    assert.ok(layout.insets.bottom <= height * .49);
    assert.ok(layout.area.y >= 0 && layout.area.y + layout.area.height <= height + 1e-7);
    assert.ok(Number.isFinite(layout.scale) && layout.scale > 0);
    close(layout.panel.y, height - DAY_CONTROL_HEIGHT - Math.max(0, Math.min(64, height * .49) - STUDIO_BOTTOM_INSET), 'clamping does not shift the footer');
  }
});

test('compact exterior spacing preserves width-limited phone Home while reserving room for the date heading', () => {
  // Previous live geometry: 1006.67 SVG units with duplicated outer clearance,
  // 8–20px side gutters and a 64px footer reserve. Compare at equal viewports.
  const previousDiameter = 1006.6666666666666;
  for (const [width, height, oldSide, oldTop, top] of [
    [390, 844, 8, 112, 112], [505, 692, 10.1, 112, 112],
    [1002, 817, 20, 64, 74], [1228, 705, 20, 64, 74], [1440, 900, 20, 64, 74],
  ]) {
    const previousScale = Math.min(width - 2 * oldSide, height - oldTop - 64) / previousDiameter;
    const layout = computeStudioLayout({ width, height, side: 4, top, bottom: 52 });
    if (width < 700) assert.ok(layout.scale > previousScale, `${width}×${height}: phone Home retains its established width`);
    assert.ok(layout.center.y - layout.mandalaRadius >= top - 1e-7, 'the heading keeps its protected area');
    assert.ok(layout.center.y + layout.mandalaRadius <= layout.panel.y - 17 - 4 + 1e-7, 'the date fields have at least a four-pixel gap');
    if (width >= 1000) close(layout.panel.y - layout.center.y - layout.mandalaRadius, DAY_CONTROL_TOP_CLEARANCE + 4, 'height-limited Home uses the space above the date heading');
  }
});
