import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerTarget } from '../src/scene/pointer-target.js';

// Authored screen rectangles model a phone's compressed rows independently of
// SVG geometry. Interleaved columns expose accidental cross-column clipping.
function scene(definitions = [
  { source: 'design', left: 100, centers: [100, 120, 140] },
  { source: 'personality', left: 300, centers: [110, 130, 150] },
]) {
  let measurements = 0, queries = 0;
  const columns = [], hits = [];
  for (const { source, left, centers, width = 12, height = 17, frame = null } of definitions) {
    const column = {}, controls = [];
    centers.forEach((center, index) => {
      const control = { dataset: { type: 'planet-filter', id: `${source}:${index}` },
        querySelector(selector) {
          assert.equal(selector, '.activation-planet-filter-frame');
          return frame ? { getBoundingClientRect() { measurements++; return frame; } } : null;
        },
      };
      controls.push(control);
      hits.push({ parentElement: control,
        closest(selector) { assert.equal(selector, '.activation-column'); return column; },
        getBoundingClientRect() {
          measurements++;
          return { left, right: left + width, top: center - height / 2, bottom: center + height / 2, width, height };
        },
      });
    });
    columns.push(controls);
  }
  const svg = {
    closest: () => null,
    querySelectorAll(selector) { assert.equal(selector, '.activation-planet-filter-hit'); queries++; return hits; },
  };
  return { svg, columns,
    at(x, y, pointerType = 'touch', target = svg, surface) { return pointerTarget(svg, { target, clientX: x, clientY: y, pointerType }, surface); },
    get measurements() { return measurements; }, get queries() { return queries; },
  };
}

test('phone rows 20px apart resolve to their own column on either side of each midpoint', () => {
  const h = scene();
  for (const [column, x, firstCenter] of [[0, 80, 100], [1, 280, 110]]) {
    const controls = h.columns[column];
    for (let row = 0; row < 3; row++) {
      assert.equal(h.at(x, firstCenter + row * 20), controls[row]);
    }
    for (let row = 0; row < 2; row++) {
      const boundary = firstCenter + row * 20 + 10;
      assert.equal(h.at(x, boundary - .01), controls[row]);
      assert.equal(h.at(x, boundary), controls[row], 'an exact tie has one stable target');
      assert.equal(h.at(x, boundary + .01), controls[row + 1]);
    }
  }
});

test('touch width extends into the left margin, stops at the glyph side and has bounded end rows', () => {
  const h = scene();
  for (const [column, left, firstCenter] of [[0, 100, 100], [1, 300, 110]]) {
    const controls = h.columns[column], edge = left + 12 - 44;
    assert.equal(h.at(edge, firstCenter - 22), controls[0]);
    assert.equal(h.at(edge - .01, firstCenter), null);
    assert.equal(h.at(left + 12, firstCenter), controls[0]);
    assert.equal(h.at(left + 12 + .01, firstCenter), null, 'the empty gap toward the glyph is not captured');
    assert.equal(h.at(left - 20, firstCenter - 22 - .01), null);
    assert.equal(h.at(left - 20, firstCenter + 40 + 22), controls[2]);
    assert.equal(h.at(left - 20, firstCenter + 40 + 22 + .01), null);
  }
});

test('a zoomed hit larger than 44px retains its original extent and direct hit identity', () => {
  const h = scene([{ source: 'design', left: 100, centers: [200], width: 72, height: 102 }]);
  const control = h.columns[0][0];
  assert.equal(h.at(100, 149), control);
  assert.equal(h.at(172, 251), control);
  for (const [x, y] of [[99.99, 200], [172.01, 200], [120, 148.99], [120, 251.01]]) assert.equal(h.at(x, y), null);
  const before = h.measurements;
  assert.equal(h.at(120, 200, 'touch', { closest: () => control }), control);
  assert.equal(h.measurements, before, 'native targets require no screen measurement');
});

test('mouse and pen keep native targets without scanning or measuring; direct glyphs and gates win for touch', () => {
  const h = scene();
  const surface = { getBoundingClientRect() { assert.fail('native targets must not measure the canvas'); } };
  for (const pointerType of ['mouse', 'pen']) {
    assert.equal(h.at(80, 100, pointerType, h.svg, surface), null);
    const control = h.columns[0][0];
    assert.equal(h.at(80, 100, pointerType, { closest: () => control }, surface), control);
  }
  for (const type of ['planet', 'gate']) {
    const direct = { dataset: { type, id: type === 'planet' ? 'sun' : '41' } };
    assert.equal(h.at(80, 100, 'touch', { closest: () => direct }, surface), direct);
  }
  assert.equal(h.queries, 0);
  assert.equal(h.measurements, 0);
});

test('missing or collapsed hit rectangles do not create invisible touch targets', () => {
  assert.equal(scene([]).at(80, 100), null);
  const h = scene([
    { source: 'design', left: 100, centers: [100], width: 0 },
    { source: 'personality', left: 100, centers: [100], height: 0 },
  ]);
  assert.equal(h.at(80, 100), null);
  assert.equal(h.at(100, 100), null);
});


test('off-canvas hits cannot reach the visible touch margin; partially visible hits remain accessible', () => {
  const surface = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 390, bottom: 500, width: 390, height: 500 }) };
  for (const [left, center, x, y] of [
    [400, 100, 380, 100], // Right: the expanded margin would otherwise reach the screen.
    [-20, 100, 0, 100],
    [100, 510, 90, 495], // Below: a 44px-tall margin reaches back onto the screen.
    [100, -10, 90, 5],
  ]) {
    const h = scene([{ source: 'design', left, centers: [center] }]);
    assert.equal(h.at(x, y, 'touch', h.svg, surface), null, `hidden hit at ${left}, ${center}`);
  }
  for (const [left, center, x, y, outsideX, outsideY] of [
    [385, 100, 380, 100, 395, 100],
    [-5, 100, 5, 100, -1, 100],
    [100, 497, 90, 495, 90, 501],
    [100, 3, 90, 5, 90, -1],
  ]) {
    const h = scene([{ source: 'design', left, centers: [center] }]);
    assert.equal(h.at(x, y, 'touch', h.svg, surface), h.columns[0][0], 'the visible part keeps its touch margin');
    const before = h.measurements;
    assert.equal(h.at(outsideX, outsideY, 'touch', h.svg, surface), null, 'touch points outside the canvas are excluded');
    assert.equal(h.measurements, before, 'an outside touch does not scan hit geometry');
  }
});


test('a visible empty hit margin cannot activate a fully hidden checkbox frame', () => {
  const surface = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 390, bottom: 500, width: 390, height: 500 }) };
  for (const left of [391, 389]) {
    const frame = { left, right: left + 6, top: 95, bottom: 105, width: 6, height: 10 };
    const h = scene([{ source: 'design', left: 380, centers: [100], frame }]);
    // The hit 380..392 intersects the canvas in both cases. Only the second
    // checkbox frame has visible paint (389..390) and may own this touch.
    assert.equal(h.at(380, 100, 'touch', h.svg, surface), left === 389 ? h.columns[0][0] : null);
  }
});


test('direct touch on a transparent hit still requires visible checkbox paint', () => {
  const surface = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 390, bottom: 500, width: 390, height: 500 }) };
  for (const left of [391, 389]) {
    const frame = { left, right: left + 13, top: 91.5, bottom: 108.5, width: 13, height: 17 };
    const h = scene([{ source: 'design', left: 380, centers: [100], width: 24, frame }]);
    const control = h.columns[0][0], hit = { closest: () => control };
    // Native targeting reaches the transparent hit at x387 even when the
    // checkbox itself begins beyond the canvas at x391.
    assert.equal(h.at(387, 100, 'touch', hit, surface), left === 389 ? control : null);
    assert.equal(h.queries, 0, 'a direct hit does not scan other controls');
    assert.equal(h.measurements, 1, 'only the direct checkbox frame is measured');
  }
});
