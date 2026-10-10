import test from 'node:test';
import * as geometry from '../src/scene/layout.js';
import assert from 'node:assert/strict';
import { computeStudioLayout, computeCameraFit, DAY_CONTROL_HEIGHT, DAY_CONTROL_TOP_CLEARANCE, TIMELINE_BAR_HEIGHT, TIMELINE_WITH_DATES_HEIGHT, returnsPlacement } from '../src/scene/layout.js';
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
const railFor = (layout, width, height, safeBottom = 0) => geometry.computeTimelineDock({
  width, height, safeBottom, mandalaWidth: layout.mandalaRadius * 2,
}).rail;


function layoutHarness(phone = true, width = 390, height = 844) {
  const media = { matches: phone }, rect = { width, height };
  const studio = { dataset: {}, style: { setProperty() {} }, getBoundingClientRect: () => ({ top: 50, bottom: 50 + rect.height, ...rect }) };
  const canvas = { dataset: {}, parentElement: studio, getBoundingClientRect: () => ({ top: 50, left: 20, bottom: 50 + rect.height, ...rect }) };
  const drawing = { style: {} };
  let style = { scrollPaddingTop: '112px', scrollPaddingLeft: '12px' };
  const panels = [0, 1].map(() => ({ hidden: true, dataset: {}, style: { setProperty(name, value) { this[name] = value; } },
    getBoundingClientRect() { assert.fail('panel content and visibility must never determine Home'); },
  }));
  const layout = createStudioLayout({ canvas, drawing, panels, media, viewport: null,
    readStyle: () => ({ getPropertyValue: () => '0px', ...style }) });
  return { layout, media, canvas, drawing, panels, style(value) { style = value; },
    resize(width, height) { Object.assign(rect, { width, height }); return layout.refresh(); } };
}

test('layout positions every rail in the full studio without reading a canvas offset', () => {
  const events = [];
  let offset = 40;
  const writes = () => new Proxy({ setProperty(name, value) { this[name] = value; } }, { set(target, key, value) { events.push('write'); target[key] = value; return true; } });
  const studio = { dataset: {}, style: { setProperty() {} }, getBoundingClientRect: () => ({ width: 1200, height: 800 }) };
  const canvas = { dataset: writes(), parentElement: studio, getBoundingClientRect() { events.push('canvas'); return { left: offset, width: 1000, height: 800 }; },
    get offsetLeft() { assert.fail('studio rails do not use the narrower canvas offset'); } };
  const panels = Array.from({ length: 3 }, () => ({ dataset: writes(), style: writes() }));
  const layout = createStudioLayout({ canvas, panels, art: { style: writes() }, media: { matches: false }, viewport: null,
    readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '12px', getPropertyValue: () => '0px' }) });
  const assertReads = () => {
    assert.equal(events.filter(event => event === 'canvas').length, 1);
    assert.ok(events.indexOf('canvas') < events.indexOf('write'), 'canvas geometry is read before writing panel styles');
  };
  assertReads();
  const initialLeft = parseFloat(panels[0].style.left);
  events.length = 0; offset = 120;
  layout.refresh();
  assertReads();
  for (const panel of panels) {
    assert.equal(parseFloat(panel.style.left), initialLeft, 'canvas offset cannot move the shared rail');
    close(parseFloat(panel.style.left) + parseFloat(panel.style.width) / 2, 600, 'rail remains centered in the studio');
  }
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
  for (const [width, height, top, safeBottom] of [
    [320, 568, 112, 0], [393, 747, 112, 8], [505, 692, 112, 8],
    [759, 747, 64, 0], [1002, 817, 64, 0], [844, 390, 64, 34], [1440, 900, 64, 0],
  ]) {
    const h = layoutHarness(width < 700, width, height);
    h.style({ scrollPaddingTop: `${top}px`, scrollPaddingLeft: '12px',
      getPropertyValue: name => name === '--timeline-safe-bottom' ? `${safeBottom}px` : '0px' });
    const layout = h.layout.refresh();
    for (const glyph of glyphs) {
      const x = layout.center.x + (glyph.x - MANDALA_GEOMETRY.centerX) * MANDALA_SCENE_SCALE * layout.scale;
      const y = layout.center.y + (glyph.y - MANDALA_GEOMETRY.centerY) * MANDALA_SCENE_SCALE * layout.scale;
      const radius = MANDALA_PLANET_LAYOUT.glyphRadius * MANDALA_SCENE_SCALE * layout.scale;
      assert.ok(x - radius >= layout.area.x, `${width}×${height}: left glyph edge stays inside`);
      assert.ok(x + radius <= width - layout.area.x, `${width}×${height}: right glyph edge stays inside`);
      assert.ok(y - radius >= top - 1e-7, `${width}×${height}: the planet clears the top inset`);
      assert.ok(y + radius <= height - safeBottom - TIMELINE_BAR_HEIGHT - 4 + .001, `${width}×${height}: glyph clears the low rail backing`);
      assert.ok(h.layout.mandalaTop <= y - radius + .001, 'caption overlap sees the glyph envelope');
    }
    close(h.layout.mandalaTop, layout.center.y - layout.mandalaRadius, 'caption uses full planet extent');
    assert.ok(h.layout.mandalaTop < layout.center.y - MANDALA_GEOMETRY.outerRadius * MANDALA_SCENE_SCALE * layout.scale, 'the ring edge is insufficient for header overlap');
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
    const rail = railFor(layout, width, height);
    assert.ok(rail.x >= 0 && rail.y >= 0);
    assert.ok(rail.x + rail.width <= width + 1e-7);
    assert.ok(rail.y + rail.height <= height + 1e-7);
  }
  const asymmetric = computeStudioLayout({ width: 1200, height: 800, top: 112, bottom: 64 });
  close(asymmetric.center.y - asymmetric.insets.offsetY, 414,
    'the fitting center accounts for the date heading above the unchanged footer');
});

test('the shared composition stays centered or uses only available headroom for the dates', () => {
  for (const [width, height, top, bottom, side] of [
    [393, 747, 112, 64, 12], [997, 747, 64, 64, 20], [1440, 900, 64, 64, 20],
    [844, 390, 64, 98, 12], [320, 100, 64, 64, 12], [2400, 220, 112, 64, 20],
  ]) {
    const layout = computeStudioLayout({ width, height, top, bottom, side });
    const originalTop = Math.min(top, height * .49), originalBottom = Math.min(bottom, height * .49);
    const cameraBottom = Math.min(originalBottom + DAY_CONTROL_TOP_CLEARANCE, height * .49);
    const originalHeight = Math.max(1, height - originalTop - cameraBottom);
    const originalCenter = originalTop + originalHeight / 2;
    const visibleRadius = MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE * layout.scale;
    const headroom = originalCenter - visibleRadius - originalTop;
    const overlap = Math.max(0, originalCenter + visibleRadius - (height - TIMELINE_WITH_DATES_HEIGHT - 4));
    close(layout.insets.offsetY, -Math.min(headroom, overlap), 'move up only enough to clear dates without crossing the heading');
    close(layout.center.y, originalCenter + layout.insets.offsetY, 'the whole scene has one shifted center');
    close(layout.area.y, originalTop + layout.insets.offsetY, 'the fit area is translated with the scene');
    close(layout.area.height, originalHeight, 'the fitting height reserves the date heading separately from the footer');
    close(layout.scale, Math.min(width - 2 * side, originalHeight) / STUDIO_FRAME.bounds.width, 'Home uses all space above the date heading');
    assert.ok(layout.center.y - visibleRadius >= originalTop - 1e-7, 'the full envelope stays below the heading');
    if (headroom >= overlap) assert.ok(layout.center.y + visibleRadius <= height - TIMELINE_WITH_DATES_HEIGHT - 4 + 1e-7);
    assert.equal(layout.insets.top, originalTop);
    assert.equal(layout.insets.bottom, cameraBottom);
    assert.ok(layout.insets.offsetY <= 1e-7);
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
    assert.equal(railFor(previous, safeWidth - 1, height).y, railFor(safe, safeWidth, height).y);
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
    assert.ok(resting.y + resting.height <= height - TIMELINE_BAR_HEIGHT, 'the enlarged bottom row clears the visible day control');
  }
});

test('the studio rail stays centered within its date edges and clear of the chart across aspect ratios', () => {
  for (const height of [100, 110, 120, 180, 220, 390, 747, 800, 1100]) {
    let previous;
    for (let width = 320; width <= 1440; width += 4) {
      const layout = computeStudioLayout({ width, height, top: 64, bottom: 64, side: 12 });
      const panel = railFor(layout, width, height);
      assert.equal(panel.height, DAY_CONTROL_HEIGHT);
      close(panel.x + panel.width / 2, width / 2, 'timeline center');
      assert.ok(panel.width >= Math.min(width - 48, layout.mandalaRadius * 2), 'rail covers the Home envelope unless the outer date edges cap it');
      assert.ok(panel.x >= 24 && panel.x + panel.width <= width - 24 + 1e-7, 'rail never exceeds the outer date edges');
      close(panel.y, height - DAY_CONTROL_HEIGHT, 'timeline position is independent of the camera reserve');
      assert.ok(height - TIMELINE_BAR_HEIGHT >= layout.center.y + layout.mandalaRadius - 1e-7, 'the full planet envelope clears the backing');
      assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 1e-7);
      assert.ok(panel.y + panel.height <= height + 1e-7);
      const boxes = [{ ...ACTIVATION_BLOCK_BOUNDS,
        x: ACTIVATION_BLOCK_BOUNDS.x - 14, width: ACTIVATION_BLOCK_BOUNDS.width + 28 }];
      if (layout.showMandalaColumns) boxes.push({ ...ACTIVATION_BLOCK_BOUNDS,
        x: ACTIVATION_BLOCK_BOUNDS.x - ACTIVATION_COLUMN_REVEAL_DISTANCE, width: ACTIVATION_BLOCK_BOUNDS.width + 2 * ACTIVATION_COLUMN_REVEAL_DISTANCE });
      for (const box of boxes) {
        const column = project(layout, box);
        assert.ok(column.y + column.height <= height - TIMELINE_BAR_HEIGHT + 1e-7, 'no calculation column in either mode is covered by the visible backing');
      }
      if (previous) {
        assert.deepEqual({ ...layout.insets, offsetY: 0 }, { ...previous.insets, offsetY: 0 });
        close(layout.center.y - layout.insets.offsetY, previous.center.y - previous.insets.offsetY, 'the original vertical fitting center remains unchanged');
        assert.ok(Math.abs(layout.insets.offsetY - previous.insets.offsetY) <= 2 + 1e-7, 'headroom adjustment changes continuously through width and column thresholds');
        // A four-pixel viewport change can grow a width-limited circle by at most four pixels.
        assert.ok(Math.abs(layout.scale - previous.scale) <= 4 / STUDIO_FRAME.bounds.width + 1e-10);
      }
      previous = layout;
    }
  }
});

test('the real camera applies the shared CSS-pixel headroom adjustment without scaling or mode-toggle drift', t => {
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
    close(shiftedHome.k, originalHome.k, 'clearing the date row does not change scale');
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
      assert.deepEqual(h.layout.insets(), { side: 12, top: 112, bottom: TIMELINE_BAR_HEIGHT + DAY_CONTROL_TOP_CLEARANCE, offsetY: before.insets.offsetY });
      assert.equal(h.drawing.style.clipPath, 'none', 'refresh also clears a stale cutoff from an older layout');
      assert.deepEqual(h.panels.map(panel => panel.style), coordinates);
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

test('narrow Home uses a four-pixel outer planet margin without shrinking either mode', () => {
  const planetRadius = MANDALA_PLANET_LAYOUT.visualRadius * MANDALA_SCENE_SCALE;
  for (const width of [320, 375, 390, 393, 505]) {
    const layout = computeStudioLayout({ width, height: 844, side: 4, top: 112, bottom: 52 });
    close(layout.center.x - planetRadius * layout.scale, 4, `${width}px left outer planet edge`);
    close(width - layout.center.x - planetRadius * layout.scale, 4, `${width}px right outer planet edge`);
    assert.ok(layout.center.y + planetRadius * layout.scale <= 844 - TIMELINE_BAR_HEIGHT - 4);
  }
});

test('Home clears the low backing while dates use available headroom and roomy phones keep their scale', () => {
  for (const [width, height, top, safeBottom] of [
    [320, 568, 112, 0], [390, 844, 112, 8], [505, 692, 112, 12],
    [844, 390, 74, 34], [1025, 775, 74, 0], [1366, 400, 74, 0], [1440, 500, 74, 12],
  ]) {
    const bottom = TIMELINE_BAR_HEIGHT + safeBottom, footerHeight = TIMELINE_WITH_DATES_HEIGHT + safeBottom;
    const layout = computeStudioLayout({ width, height, side: 4, top, bottom, footerHeight });
    const rail = railFor(layout, width, height, safeBottom);
    const envelopeBottom = layout.center.y + layout.mandalaRadius;
    close(rail.y, height - safeBottom - DAY_CONTROL_HEIGHT, `${width}×${height}: the timeline does not move`);
    assert.ok(envelopeBottom <= height - bottom - 4, `${width}×${height}: full red and black planet envelope clears the backing`);
    assert.ok(layout.center.y - layout.mandalaRadius >= top - 1e-7, `${width}×${height}: the top cannot be clipped`);
    if (top + 2 * layout.mandalaRadius <= height - footerHeight - 4)
      assert.ok(envelopeBottom <= height - footerHeight - 4 + 1e-7, 'available headroom is used to clear the full date row');
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
    close(railFor(layout, width, height).y, height - DAY_CONTROL_HEIGHT, 'clamping the camera does not shift the rail');
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
    assert.ok(layout.center.y + layout.mandalaRadius <= height - TIMELINE_BAR_HEIGHT - 4 + 1e-7, 'the backing has at least a four-pixel gap');
    if (width >= 1000) close(layout.center.y - layout.mandalaRadius, top, 'height-limited Home does not cross the heading to clear the date row');
  }
});


test('returns measures the mandala without requiring exterior calculation columns', () => {
  const placement = (width, height, phone = false) => returnsPlacement({ width, height, top: 74, bottom: 52, side: 4 }, { reserve: 352, phone });
  for (const [width, height] of [[320,700], [390,844], [1000,910], [1280,1200]]) assert.equal(placement(width,height), 'sheet');
  assert.equal(placement(1280,800), 'side');
  assert.equal(placement(1140,800), 'side', 'columns may disappear while the complete mandala keeps its size');
  assert.equal(placement(844,390,true), 'sheet', 'phones stay bottom sheets even in landscape');
  for (let width = 700; width <= 2400; width += 25) for (let height = 390; height <= 1800; height += 25) {
    if (placement(width,height) !== 'side') continue;
    const options = { height, top: 74, bottom: 52, side: 4 };
    const full = computeStudioLayout({ ...options, width });
    const side = computeStudioLayout({ ...options, width: width - 352 });
    close(side.scale, full.scale, `${width}×${height}: opening returns preserves map size`);

  }
});

test('drawer placement stays stable when opening changes the canvas width', () => {
  const full = { width: 1280, height: 800 }, dataset = {};
  let open = false;
  const studio = { dataset, getBoundingClientRect: () => full };
  const canvas = { dataset: {}, parentElement: studio, getBoundingClientRect: () => ({ ...full, width: full.width - (open && dataset.returnsLayout === 'side' ? 352 : 0) }) };
  const layout = createStudioLayout({ canvas, panels: [], media: { matches: false },
    readStyle: () => ({ scrollPaddingTop: '74px', scrollPaddingBottom: '52px', scrollPaddingLeft: '4px', getPropertyValue: name => name === '--returns-side-space' ? '352px' : '0px' }) });
  const before = layout.refresh();
  open = true;
  for (let i=0; i<3; i++) { close(layout.refresh().scale, before.scale, 'opening preserves scale'); assert.equal(layout.returnsLayout,'side'); }
  full.width = 1000; full.height = 910;
  for (let i=0; i<3; i++) { layout.refresh(); assert.equal(layout.returnsLayout,'sheet'); }
  open = false; layout.refresh(); assert.equal(layout.returnsLayout,'sheet', 'closing does not change the arrow');
});


test('return placement respects actual safe-area insets, including landscape notches', () => {
  for (const width of [844,1100,1280,1440,1800]) for (const height of [390,690,824,910]) {
    for (const insets of [{side:44,top:74,bottom:52},{side:60,top:112,bottom:98}]) {
      const options={width,height,...insets};
      if (returnsPlacement(options,{reserve:352}) !== 'side') continue;
      const full=computeStudioLayout(options), side=computeStudioLayout({...options,width:width-352});
      close(side.scale,full.scale,'actual safe-area preserves map size');

    }
  }
});


test('only visible chronicle dates require a second row; every mode shares one rail', () => {
  for (const [width, mandalaWidth, expectedWidth] of [[390, 382, 342], [1200, 600, 784]]) {
    const rails = [];
    for (const kind of ['day', 'natal-day', 'returns', 'chronicle']) {
      const dock = geometry.computeTimelineDock({ width, height: 844, mandalaWidth, kind });
      assert.equal(dock.rail.width, expectedWidth);
      assert.equal(dock.rail.x, (width - expectedWidth) / 2);
      assert.equal(dock.rail.y, 796);
      const stacked = kind === 'chronicle' && width === 390;
      assert.equal(dock.mode, stacked ? 'stacked' : 'inline');
      assert.equal(dock.height, stacked ? 88.8 : 40.8);
      rails.push(dock.rail);
    }
    for (const rail of rails) assert.deepEqual(rail, rails[0]);
  }
});

test('timeline reaches the Home mandala envelope continuously at the date-wrap boundary', () => {
  // 400px mandala + two 140px dates, 24px safe gutters and 24px target clearances.
  const threshold = 776;
  for (const delta of [-1, -.001, 0, .001, 1]) {
    const dock = geometry.computeTimelineDock({ width: threshold + delta, height: 844,
      mandalaWidth: 400, controlWidth: 140, kind: 'chronicle' });
    close(dock.rail.width, 400 + Math.max(0, delta), 'no jump on date wrapping');
    assert.equal(dock.mode, delta < 0 ? 'stacked' : 'inline');
    if (delta >= 0) assert.ok(dock.rail.x - dock.gutter - dock.controlWidth >= 22,
      'the invisible native thumb target clears the date field');
  }
});

test('safe area extends the shared dock without changing its content height', () => {
  assert.equal(typeof geometry.computeTimelineDock, 'function');
  const normal=geometry.computeTimelineDock({width:390,height:844,mandalaWidth:382,safeBottom:0});
  const safe=geometry.computeTimelineDock({width:390,height:844,mandalaWidth:382,safeBottom:34});
  assert.equal(safe.height, normal.height+34);
  assert.equal(safe.mode, normal.mode);
  assert.equal(safe.rail.y, normal.rail.y-34);
  const scene=computeStudioLayout({width:390,height:844,top:112,bottom:safe.height,footerHeight:safe.height});
  assert.ok(scene.center.y+scene.mandalaRadius <= 844-safe.height-4, 'mandala clears the full solid footer');
});


test('studio reads real DOMRect dimensions, whose properties are not enumerable', () => {
  const rect=Object.create({width:948,height:727});
  const values=new Map();
  const studio={dataset:{},style:{setProperty:(k,v)=>values.set(k,v)},getBoundingClientRect:()=>rect};
  const canvas={dataset:{},parentElement:studio,getBoundingClientRect:()=>rect};
  const panel={dataset:{},style:{setProperty(){}}};
  createStudioLayout({canvas,panels:[panel],media:{matches:false},readStyle:()=>({scrollPaddingTop:'74px',scrollPaddingBottom:'52px',scrollPaddingLeft:'4px',getPropertyValue:()=> '0px'})});
  assert.equal(values.get('--timeline-dock-height'),'40.8px');
  assert.ok(Number.isFinite(Number.parseFloat(panel.style.left)));
  assert.equal(panel.style.top,'679px');
});


test('returns uses the user supplied narrow-window reference before the map becomes cramped', () => {
  const options={width:1126,height:889,top:74,bottom:60,side:4};
  assert.equal(returnsPlacement(options,{reserve:320}),'sheet');
  assert.equal(returnsPlacement({...options,width:1127},{reserve:320}),'side');
  assert.equal(returnsPlacement({...options,width:1400,height:1400},{reserve:320}),'sheet','tall windows must still protect the mandala scale');
});


test('a tall 924px window keeps the full Home envelope and moves dates above', () => {
  const home = computeStudioLayout({ width: 924, height: 889, top: 74, bottom: 40.8, footerHeight: 40.8 });
  const dock = geometry.computeTimelineDock({ width: 924, height: 889, mandalaWidth: 2 * home.mandalaRadius, kind: 'chronicle' });
  assert.equal(dock.mode, 'stacked');
  assert.equal(dock.height, 88.8);
  close(dock.rail.width, 2 * home.mandalaRadius, 'stacked rail is exactly the Home envelope');
});

test('chronicle adapts to measured dates while other modes reserve the same space', () => {
  const options = { width: 700, height: 844, mandalaWidth: 280 };
  for (const kind of ['day', 'natal-day', 'chronicle', 'returns']) {
    const normal = geometry.computeTimelineDock({ ...options, kind, controlWidth: 140 });
    const largeText = geometry.computeTimelineDock({ ...options, kind, controlWidth: 210 });
    assert.equal(normal.mode, 'inline');
    assert.equal(largeText.mode, kind === 'chronicle' ? 'stacked' : 'inline');
    assert.equal(normal.rail.width, 324);
    assert.equal(largeText.rail.width, 280);
  }
});

test('the visible rail stays centered in every mode and inside safe side insets', () => {
  for (const width of [320, 390, 844, 1440]) for (const kind of ['day', 'natal-day', 'chronicle', 'returns']) {
    const mandalaWidth = Math.min(width - 80, 640);
    const dock = geometry.computeTimelineDock({ width, height: 844, kind, side: 40, mandalaWidth });
    close(dock.rail.x, width - dock.rail.x - dock.rail.width, `${kind} equal margins`);
    assert.ok(dock.rail.x >= 40);
    assert.ok(dock.rail.width >= mandalaWidth);
  }
});

function viewportLayoutHarness({ width = 390, height = 844, top = 0, canvasTop = top, safeBottom = 0, edgeSpace = 0, viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 }) } = {}) {
  const rect = { width, height, top, bottom: top + height };
  const values = new Map(), writes = [];
  const frames = new Map(); let nextFrame = 0;
  const document = Object.assign(new EventTarget(), { activeElement: null,
    defaultView: { requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
      cancelAnimationFrame(id) { frames.delete(id); } } });
  const fromDate = { tagName: 'INPUT', type: 'text' }, toDate = { tagName: 'INPUT', type: 'text' }, slider = { tagName: 'INPUT', type: 'range' };
  const studio = { ownerDocument: document, dataset: {}, style: { setProperty(key, value) { values.set(key, value); writes.push([key, value]); } }, getBoundingClientRect: () => rect };
  let canvasReads = 0;
  const canvas = { dataset: {}, parentElement: studio, getBoundingClientRect: () => { canvasReads++; return { ...rect, top: canvasTop }; } };
  const panel = { id: 'lifetimeControls', hidden: false, dataset: {}, style: { setProperty() {} }, contains: node => [fromDate, toDate, slider].includes(node) };
  const layout = createStudioLayout({ canvas, panels: [panel], viewport, media: { matches: true },
    readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingBottom: '52px', scrollPaddingLeft: '4px',
      getPropertyValue: name => `${name === '--timeline-safe-bottom' ? safeBottom : name === '--timeline-edge-space' ? edgeSpace : 0}px` }) });
  function dispatchFocus(type, target, relatedTarget) {
    const event = new Event(type);
    Object.defineProperties(event, { target: { value: target }, relatedTarget: { value: relatedTarget } });
    document.dispatchEvent(event);
  }
  function focus(next, related = next) {
    const previous = document.activeElement;
    if (previous) {
      document.activeElement = null;
      dispatchFocus('focusout', previous, related);
    }
    document.activeElement = next;
    if (next) dispatchFocus('focusin', next, previous);
  }
  function frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); }
  return { viewport, rect, values, writes, layout, panel, fromDate, toDate, slider, focus, frame, canvasReads: () => canvasReads };
}

test('the whole chronicle dock follows the visible bottom without reframing the scene', () => {
  const h = viewportLayoutHarness();
  const before = { insets: h.layout.insets(), top: h.panel.style.top, reads: h.canvasReads() };
  const lift = () => parseFloat(h.values.get('--timeline-viewport-lift'));
  const dockTop = () => parseFloat(h.values.get('--timeline-dock-top'));
  assert.equal(lift(), 0);
  assert.equal(dockTop(), 803.2);
  h.focus(h.fromDate); h.viewport.height = 500;
  h.viewport.dispatchEvent(new Event('resize'));
  assert.equal(lift(), 344, 'keyboard moves every dock control by the same amount');
  assert.equal(dockTop(), 459.2, 'the backing leaves the covered map visible between dates above the keyboard');
  assert.equal(h.values.get('--timeline-dock-height'), '88.8px', 'keyboard does not collapse date content');
  h.viewport.offsetTop = 70;
  h.viewport.dispatchEvent(new Event('scroll'));
  assert.equal(lift(), 274, 'Safari autopan is counted once');
  assert.equal(dockTop(), 529.2);
  assert.equal(h.layout.insets(), before.insets, 'camera fit keeps its original insets object');
  assert.equal(h.panel.style.top, before.top, 'base rail geometry does not change');
  assert.equal(h.canvasReads(), before.reads, 'viewport events do not measure or refresh the scene');
  h.viewport.height = 844; h.viewport.offsetTop = 0;
  h.viewport.dispatchEvent(new Event('resize'));
  assert.equal(lift(), 0, 'closing the keyboard restores the exact baseline');
  assert.equal(dockTop(), 803.2);
});

test('visible dock positioning includes the studio offset and follows full layout changes', () => {
  const h = viewportLayoutHarness({ top: -20 });
  h.focus(h.fromDate); h.viewport.height = 450; h.viewport.offsetTop = 80;
  h.viewport.dispatchEvent(new Event('scroll'));
  assert.equal(parseFloat(h.values.get('--timeline-viewport-lift')), 294);
  assert.equal(parseFloat(h.values.get('--timeline-dock-top')), 489.2);
  h.rect.width = 844; h.rect.height = 390; h.rect.top = 0; h.rect.bottom = 390;
  h.viewport.height = 390; h.viewport.offsetTop = 0;
  h.layout.refresh();
  assert.equal(h.values.get('--timeline-viewport-lift'), '0px');
  assert.equal(h.values.get('--timeline-dock-top'), '349.2px', 'wide chronicle returns to the single row');
});

test('missing or invalid visual viewport metrics leave the normal dock in place', () => {
  for (const viewport of [null, Object.assign(new EventTarget(), { height: NaN, offsetTop: 0 }),
    Object.assign(new EventTarget(), { height: 0, offsetTop: 0 }),
    Object.assign(new EventTarget(), { height: 500, offsetTop: Infinity }),
    Object.assign(new EventTarget(), { height: 900, offsetTop: 0 })]) {
    const h = viewportLayoutHarness({ viewport });
    assert.equal(h.values.get('--timeline-viewport-lift'), '0px');
    assert.equal(h.values.get('--timeline-dock-top'), '803.2px');
  }
});


test('compact controls keep a small edge clearance even when an embedded browser reports no safe inset', () => {
  const mobile = viewportLayoutHarness({ edgeSpace: 8 });
  assert.equal(mobile.panel.style.top, '788px', 'rail and its labels rise above the bottom browser overlap');
  assert.equal(mobile.values.get('--timeline-dock-height'), '96.8px', 'the continuous backing includes the clearance');
  const homeIndicator = viewportLayoutHarness({ edgeSpace: 8, safeBottom: 34 });
  assert.equal(homeIndicator.panel.style.top, '762px', 'a larger native safe area is not padded twice');
  assert.equal(homeIndicator.values.get('--timeline-dock-height'), '122.8px');
  const desktop = viewportLayoutHarness({ edgeSpace: 0 });
  assert.equal(desktop.panel.style.top, '796px', 'desktop has no extra edge allowance');
  mobile.focus(mobile.fromDate); mobile.viewport.height = 500;
  mobile.viewport.dispatchEvent(new Event('resize'));
  assert.equal(mobile.values.get('--timeline-viewport-lift'), '344px');
  assert.equal(mobile.values.get('--timeline-dock-top'), '451.2px', 'keyboard and edge clearance compose once');
});


test('Done lowers the dock before delayed Safari viewport metrics catch up', () => {
  const h = viewportLayoutHarness({ edgeSpace: 8 });
  const before = { insets: h.layout.insets(), top: h.panel.style.top, reads: h.canvasReads() };
  h.focus(h.fromDate); h.viewport.height = 500;
  h.viewport.dispatchEvent(new Event('resize'));
  assert.equal(h.values.get('--timeline-viewport-lift'), '344px');
  h.focus(null); h.frame();
  assert.equal(h.values.get('--timeline-viewport-lift'), '0px', 'Done must not wait for resize');
  assert.equal(h.values.get('--timeline-dock-top'), '795.2px', 'no keyboard-sized grey gap');
  for (const event of ['scroll', 'resize']) {
    h.viewport.dispatchEvent(new Event(event));
    assert.equal(h.values.get('--timeline-viewport-lift'), '0px', 'late metrics cannot lift a closed editor');
  }
  h.viewport.offsetTop = 344; h.viewport.dispatchEvent(new Event('scroll'));
  h.viewport.offsetTop = 0; h.viewport.dispatchEvent(new Event('scroll'));
  assert.equal(h.values.get('--timeline-viewport-lift'), '0px', 'autopan reaching the bottom is not a reopened keyboard');
  h.viewport.height = 600; h.viewport.offsetTop = 40;
  h.viewport.dispatchEvent(new Event('resize'));
  assert.equal(h.values.get('--timeline-viewport-lift'), '0px', 'intermediate closing frame stays dismissed');
  h.viewport.height = 844; h.viewport.offsetTop = 0;
  h.viewport.dispatchEvent(new Event('resize'));
  assert.equal(h.values.get('--timeline-dock-top'), '795.2px');
  assert.equal(h.layout.insets(), before.insets);
  assert.equal(h.panel.style.top, before.top);
  assert.equal(h.canvasReads(), before.reads, 'focus and keyboard never reframe the camera');
});

test('focus moves between dates without dropping the dock and a new edit can reopen it', () => {
  const h = viewportLayoutHarness();
  h.focus(h.fromDate); h.viewport.height = 500;
  h.viewport.dispatchEvent(new Event('resize'));
  h.writes.length = 0;
  for (const relatedTarget of [h.toDate, null]) {
    h.focus(h.fromDate); h.focus(h.toDate, relatedTarget); h.frame();
    assert.equal(h.values.get('--timeline-viewport-lift'), '344px');
  }
  assert.ok(h.writes.filter(([key]) => key === '--timeline-viewport-lift').every(([, value]) => value === '344px'), 'no lowered frame between С and По');
  h.focus(null); h.focus(h.fromDate); h.frame();
  assert.equal(h.values.get('--timeline-viewport-lift'), '344px', 'a queued blur cannot override new focus');
  h.focus(h.slider); h.frame();
  assert.equal(h.values.get('--timeline-viewport-lift'), '0px', 'range focus does not open the keyboard');
  h.focus(h.toDate); h.frame();
  assert.equal(h.values.get('--timeline-viewport-lift'), '344px', 'reopening does not depend on another resize');
  h.viewport.height = 844; h.viewport.dispatchEvent(new Event('resize'));
  assert.equal(h.values.get('--timeline-viewport-lift'), '0px', 'hardware keyboard focus has no lift');
});


test('dismissal does not change non-keyboard viewport handling or other editable fields', () => {
  const h = viewportLayoutHarness();
  h.viewport.height = 500; h.viewport.dispatchEvent(new Event('resize'));
  assert.equal(h.values.get('--timeline-viewport-lift'), '344px', 'non-keyboard viewport changes retain their existing contract');
  h.focus(h.fromDate);
  const search = { tagName: 'INPUT', type: 'search' };
  h.focus(search, null); h.frame();
  assert.equal(h.values.get('--timeline-viewport-lift'), '344px', 'switching to another editor keeps the keyboard clearance');
  h.focus(null); h.frame();
  assert.equal(h.values.get('--timeline-viewport-lift'), '0px');
  h.viewport.height = 844; h.viewport.dispatchEvent(new Event('resize'));
  h.viewport.height = 500; h.viewport.dispatchEvent(new Event('resize'));
  assert.equal(h.values.get('--timeline-viewport-lift'), '344px', 'suppression ends once the closed viewport has caught up');
});

test('closing the keyboard on a zoomed page restores its prior viewport geometry', () => {
  const viewport = Object.assign(new EventTarget(), { height: 844 / 1.5, offsetTop: 0, scale: 1.5 });
  const h = viewportLayoutHarness({ viewport });
  close(parseFloat(h.values.get('--timeline-viewport-lift')), 844 - 844 / 1.5, 'initial zoom clearance');
  h.focus(h.fromDate); viewport.height = 500 / 1.5;
  viewport.dispatchEvent(new Event('resize'));
  h.focus(null); h.frame();
  assert.equal(h.values.get('--timeline-viewport-lift'), '0px');
  viewport.height = (844 - 0.25) / 1.5;
  viewport.dispatchEvent(new Event('resize'));
  close(parseFloat(h.values.get('--timeline-viewport-lift')), 844 - viewport.height, 'closed keyboard at non-unit scale with fractional rounding');
  viewport.offsetTop = 80; viewport.dispatchEvent(new Event('scroll'));
  close(parseFloat(h.values.get('--timeline-viewport-lift')), 844 - viewport.height - 80, 'later page pan is not suppressed');
});

test('hidden period fields reserve their real width in every mode and restore original styles', () => {
  function node(hidden, initial = null) {
    let attribute = initial;
    const properties = new Map();
    return { hidden, inert: hidden, dataset: {},
      getAttribute: () => attribute,
      setAttribute(name, value) { attribute = value; properties.clear(); },
      removeAttribute() { attribute = null; properties.clear(); },
      style: { setProperty(name, value, priority) {
        properties.set(name, value); attribute = `${attribute || ''};${name}:${value}${priority ? '!important' : ''}`;
      } }, properties };
  }
  const rect = { width: 700, height: 440 };
  const studio = { dataset: {}, style: { setProperty() {} }, getBoundingClientRect: () => rect };
  const canvas = { parentElement: studio, dataset: {}, getBoundingClientRect: () => rect };
  const panel = Object.assign(node(true), { id: 'lifetimeControls' });
  const heading = node(true, 'color: inherit');
  let fieldWidth = 210, failMeasurement = false;
  const field = { getBoundingClientRect() {
    if (failMeasurement) throw new Error('measurement failed');
    const laidOut = (!panel.hidden || panel.properties.get('display') === 'block') &&
      (!heading.hidden || heading.properties.get('display') === 'flex');
    if (panel.hidden || heading.hidden) {
      assert.equal(heading.properties.get('visibility'), 'hidden');
      assert.equal(heading.properties.get('width'), 'max-content');
    }
    return { width: laidOut ? fieldWidth : 0 };
  } };
  panel.querySelector = () => heading;
  panel.querySelectorAll = () => [field, field];
  const layout = createStudioLayout({ canvas, panels: [panel], media: { matches: false }, viewport: null,
    readStyle: () => ({ scrollPaddingTop: '112px', scrollPaddingLeft: '4px', getPropertyValue: () => '0px' }) });
  const initialHome = layout.refresh();
  close(Number.parseFloat(panel.style.width), 2 * initialHome.mandalaRadius, 'hidden wide dates already require the Home width');
  const initialRail = [panel.style.left, panel.style.width, panel.style.top];
  for (const [hidden, headingHidden] of [[false, true], [false, false], [true, false], [true, true]]) {
    panel.hidden = hidden; heading.hidden = headingHidden;
    panel.dataset.personalLife = String(headingHidden);
    const home = layout.refresh();
    assert.deepEqual(home, initialHome);
    assert.deepEqual([panel.style.left, panel.style.width, panel.style.top], initialRail);
    assert.equal(panel.hidden, hidden); assert.equal(heading.hidden, headingHidden);
    assert.equal(panel.inert, true); assert.equal(heading.inert, true);
    assert.equal(heading.getAttribute('style'), 'color: inherit');
    assert.equal(panel.properties.has('display'), false);
    assert.equal(panel.properties.has('visibility'), false);
  }
  fieldWidth = 140;
  layout.refresh();
  assert.equal(panel.style.width, '324px', 'responsive field widths are measured again without a cache');
  const originalPanelStyle = panel.getAttribute('style');
  failMeasurement = true;
  assert.throws(() => layout.refresh(), /measurement failed/);
  assert.equal(panel.getAttribute('style'), originalPanelStyle, 'even a failed measurement restores the exact style attribute');
  assert.equal(heading.getAttribute('style'), 'color: inherit');
});

test('Home stays centered when possible and rises only enough for the two-row footer', () => {
  for (const [height, shift] of [[844, 0], [626.8, 0], [618, -4.4], [594.8, -16], [568, -2.6]]) {
    const h = viewportLayoutHarness({ height, edgeSpace: 8, viewport: null });
    const home = h.layout.refresh();
    close(home.insets.offsetY, shift, `${height}: smallest necessary upward shift`);
    const base = computeStudioLayout({ width: 390, height, top: 112, bottom: 48.8, footerHeight: 48.8 });
    close(home.scale, base.scale, 'reserving the potential second row never shrinks the map');
    assert.ok(home.center.y - home.mandalaRadius >= 112 - 1e-7, 'the complete envelope clears the heading');
    close(parseFloat(h.values.get('--timeline-dock-top')), height - 48.8, 'the backing always stays below the date row');
    assert.equal(h.values.get('--timeline-dock-height'), '96.8px', 'date content retains two rows');
    assert.equal(h.panel.style.top, `${height - 56}px`, 'rail stays in place');
    const before = { ...home };
    h.panel.hidden = true;
    assert.deepEqual(h.layout.refresh(), before, 'closing chronicle never changes Home');
    h.panel.hidden = false;
    assert.deepEqual(h.layout.refresh(), before, 'opening chronicle never changes Home');
  }
});

test('Home remains continuous where chronicle dates wrap beside the rail', () => {
  const sizes = [935.199, 935.2, 935.201].map(width => {
    const h = viewportLayoutHarness({ width, height: 700, edgeSpace: 8, viewport: null });
    return { home: h.layout.refresh(), height: h.values.get('--timeline-dock-height') };
  });
  assert.equal(sizes[0].height, '96.8px');
  assert.equal(sizes[2].height, '48.8px');
  for (const { home } of sizes) {
    close(home.center.y, sizes[0].home.center.y, 'wrap cannot move the scene');
    close(home.scale, sizes[0].home.scale, 'wrap cannot change scale');
  }
});

test('every mode keeps one low backing regardless of available space or the canvas offset', () => {
  for (const safeBottom of [0, 8, 34]) for (const [width, height] of [[390, 844], [390, 568], [1080, 930], [1440, 900]]) {
    const h = viewportLayoutHarness({ width, height, safeBottom, top: 20, canvasTop: 32, viewport: null });
    for (const opened of [false, true]) {
      h.panel.hidden = !opened; h.layout.refresh();
      close(height + 20 - parseFloat(h.values.get('--timeline-dock-top')), 40.8 + safeBottom, 'one shared backing height');
    }
  }
});

test('stacked dates fit their whole focus and error frame above the rail backing', () => {
  for (const safeBottom of [0, 8, 34]) {
    const h = viewportLayoutHarness({ width: 1080, height: 930, safeBottom, viewport: null });
    const top = parseFloat(h.values.get('--timeline-heading-top'));
    const fieldBottom = top + 42; // 40px field, centered in the existing 44px heading.
    const backingTop = parseFloat(h.values.get('--timeline-dock-top'));
    assert.ok(fieldBottom + 6 <= backingTop + 1e-7, 'focus frame and inline error have a quiet six-pixel gap');
    assert.equal(h.panel.style.top, `${930 - safeBottom - 48}px`, 'the rail does not move');
  }
});
