import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraView } from '../src/scene/camera-view.js';

const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${message}: ${actual} should equal ${expected}`);
const pointClose = (actual, expected, message = '') => {
  close(actual.x, expected.x, `${message} x`);
  close(actual.y, expected.y, `${message} y`);
};
const normal = { x: 0, y: 0, width: 640, height: 820 };
const wide = { x: -360, y: 0, width: 1300, height: 810 };

// Explicit reference matrices for SVG's viewport mapping, independent of the
// camera transport implementation. Coordinates are CSS pixels before scrolling.
const fixtures = [
  { name: 'mobile normal meet', box: normal, width: 390, height: 844, align: 6, meetOrSlice: 1, sx: 39 / 64, sy: 39 / 64, ox: 0, oy: 172.15625 },
  { name: 'desktop normal meet', box: normal, width: 1440, height: 900, align: 6, meetOrSlice: 1, sx: 45 / 41, sy: 45 / 41, ox: 15120 / 41, oy: 0 },
  { name: 'mobile negative-origin meet', box: wide, width: 390, height: 844, align: 6, meetOrSlice: 1, sx: .3, sy: .3, ox: 108, oy: 300.5 },
  { name: 'desktop negative-origin meet', box: wide, width: 1440, height: 900, align: 6, meetOrSlice: 1, sx: 72 / 65, sy: 72 / 65, ox: 25920 / 65, oy: 18 / 13 },
  { name: 'mobile normal none', box: normal, width: 390, height: 844, align: 1, meetOrSlice: 1, sx: 39 / 64, sy: 211 / 205, ox: 0, oy: 0 },
  { name: 'mobile negative-origin none', box: wide, width: 390, height: 844, align: 1, meetOrSlice: 2, sx: .3, sy: 422 / 405, ox: 108, oy: 0 },
  { name: 'mobile normal slice', box: normal, width: 390, height: 844, align: 6, meetOrSlice: 2, sx: 211 / 205, sy: 211 / 205, ox: 195 - 320 * 211 / 205, oy: 0 },
  { name: 'desktop negative-origin slice', box: wide, width: 1440, height: 900, align: 6, meetOrSlice: 2, sx: 10 / 9, sy: 10 / 9, ox: 3580 / 9, oy: 0 },
];

function harness(fixture, { left = 37, top = -19, serializeTransform = value => value } = {}) {
  const writes = [];
  const style = new Proxy({}, {
    set(target, property, value) {
      writes.push({ property, value });
      target[property] = property === 'transform' ? serializeTransform(value) : value;
      return true;
    },
  });
  let rect = { left, top, width: fixture.width, height: fixture.height };
  const surface = { getBoundingClientRect() { return { ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }; } };
  const svg = {
    viewBox: { baseVal: { ...fixture.box } },
    preserveAspectRatio: { baseVal: { align: fixture.align, meetOrSlice: fixture.meetOrSlice } },
    style,
    getScreenCTM() { throw new Error('Camera input must not measure its moving SVG'); },
    getBoundingClientRect() { throw new Error('Camera input must use the stationary surface'); },
  };
  const cameraView = createCameraView({ svg, surface });
  return { cameraView, surface, svg, writes, get rect() { return rect; },
    resize(width, height) { rect = { ...rect, width, height }; },
    move(left, top) { rect = { ...rect, left, top }; },
  };
}
const local = (f, point) => ({ x: f.sx * point.x + f.ox, y: f.sy * point.y + f.oy });
const screen = (f, rect, point) => { const p = local(f, point); return { clientX: rect.left + p.x, clientY: rect.top + p.y }; };
function cssMatrix(value) {
  assert.match(value, /^matrix\(/, 'the root SVG uses a two-dimensional CSS matrix');
  const values = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')')).trim().split(/[\s,]+/).map(Number);
  assert.equal(values.length, 6); assert.ok(values.every(Number.isFinite));
  return values;
}
const applyMatrix = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

for (const fixture of fixtures) {
  test(`camera view preserves pointer coordinates and drawing composition: ${fixture.name}`, () => {
    const h = harness(fixture);
    assert.equal(h.cameraView.surface, h.surface, 'input remains attached to a stationary surface');
    for (const view of [{ x: 0, y: 0, k: 1 }, { x: -763.5, y: -400.125, k: 3.2278 }, { x: 68.75, y: -17, k: .234 }]) {
      h.cameraView.paint(view);
      const matrix = cssMatrix(h.svg.style.transform);
      assert.equal(h.svg.style.transformOrigin, '0 0');
      assert.equal(h.svg.style.transformBox, 'border-box');
      for (const point of [{ x: fixture.box.x, y: fixture.box.y }, { x: 320, y: 410 }, { x: -500.75, y: 1900.125 }]) {
        pointClose(h.cameraView.point(screen(fixture, h.rect, point)), point, 'input does not include the already painted camera');
        const transformed = applyMatrix(matrix, local(fixture, point));
        const expected = local(fixture, { x: point.x * view.k + view.x, y: point.y * view.k + view.y });
        pointClose(transformed, expected, 'root CSS followed by the viewport mapping equals the old SVG camera');
      }
    }
  });
}

test('all preserveAspectRatio alignments keep the anchored viewBox edge for meet and slice', () => {
  for (const meetOrSlice of [1, 2]) for (let align = 2; align <= 10; align++) {
    const column = (align - 2) % 3, row = Math.floor((align - 2) / 3);
    const fixture = { box: { x: -10, y: 20, width: 100, height: 100 }, width: 300, height: 100, align, meetOrSlice,
      sx: meetOrSlice === 1 ? 1 : 3, sy: meetOrSlice === 1 ? 1 : 3,
      ox: meetOrSlice === 1 ? 100 * column + 10 : 30,
      oy: meetOrSlice === 1 ? -20 : -100 * row - 60 };
    const h = harness(fixture);
    const view = { x: -80, y: 20, k: 2.3 }, point = { x: 30, y: 75 };
    h.cameraView.paint(view);
    pointClose(h.cameraView.point(screen(fixture, h.rect, point)), point, `alignment ${align}, ${meetOrSlice}`);
    pointClose(applyMatrix(cssMatrix(h.svg.style.transform), local(fixture, point)),
      local(fixture, { x: view.x + point.x * view.k, y: view.y + point.y * view.k }));
  }
});

test('scroll, responsive resize and live viewBox changes update coordinates without stale geometry', () => {
  const h = harness(fixtures[0]), point = { x: 211.25, y: 603.75 }, view = { x: -520, y: -800, k: 2.5 };
  h.cameraView.paint(view);
  h.move(-120, 270);
  pointClose(h.cameraView.point(screen(fixtures[0], h.rect, point)), point, 'scroll translation');
  const previousTransform = h.svg.style.transform;
  h.cameraView.paint(view);
  assert.equal(h.svg.style.transform, previousTransform, 'scroll changes the input origin, not the CSS-local camera');
  h.resize(1440, 900);
  pointClose(h.cameraView.point(screen(fixtures[1], h.rect, point)), point, 'orientation or responsive resize');
  h.cameraView.paint(view);
  assert.notEqual(h.svg.style.transform, previousTransform, 'the same camera receives the new letterboxing correction');
  pointClose(applyMatrix(cssMatrix(h.svg.style.transform), local(fixtures[1], point)),
    local(fixtures[1], { x: point.x * view.k + view.x, y: point.y * view.k + view.y }));
  Object.assign(h.svg.viewBox.baseVal, wide);
  pointClose(h.cameraView.point(screen(fixtures[3], h.rect, point)), point, 'live viewBox with a negative minimum');
  h.cameraView.paint(view);
  pointClose(applyMatrix(cssMatrix(h.svg.style.transform), local(fixtures[3], point)),
    local(fixtures[3], { x: point.x * view.k + view.x, y: point.y * view.k + view.y }));
});

test('fit reads the stationary screen area and responsive insets, independently of current camera scale', () => {
  const h = harness(fixtures[2]);
  const frame = { bounds: { x: -360, y: 0, width: 10000, height: 10000 }, minScale: .65 };
  let insets = { side: 12, top: 112, bottom: 64, offsetY: 15 }, reads = 0;
  const fitInsets = () => { reads++; return insets; };
  const verify = fixture => {
    const result = h.cameraView.measureFit(frame, fitInsets);
    pointClose(result.area, { x: (insets.side - fixture.ox) / fixture.sx, y: (insets.top + insets.offsetY - fixture.oy) / fixture.sy });
    close(result.area.width, (h.rect.width - 2 * insets.side) / fixture.sx);
    close(result.area.height, (h.rect.height - insets.top - insets.bottom) / fixture.sy);
    close(result.min, Math.min(.65, result.area.width / 10000, result.area.height / 10000));
    return result;
  };
  const homeFit = verify(fixtures[2]);
  h.cameraView.paint({ x: -1200, y: 1000, k: 4.5 });
  assert.deepEqual(verify(fixtures[2]), homeFit, 'Home measurement cannot inherit the transformed root scale');
  h.move(200, -300);
  assert.deepEqual(verify(fixtures[2]), homeFit, 'scroll does not change the available Home area');
  h.resize(1440, 900); insets = { side: 40, top: 86, bottom: 72, offsetY: 7 };
  verify(fixtures[3]);
  assert.equal(reads, 4, 'responsive insets are read once for each fit');
});

test('an identical paint performs no style writes but real camera or geometry changes still paint', () => {
  const h = harness(fixtures[0]), view = { x: -30, y: -40, k: 2 };
  h.cameraView.paint(view);
  h.writes.length = 0;
  for (let i = 0; i < 20; i++) h.cameraView.paint({ ...view });
  assert.deepEqual(h.writes, [], 'stable transforms and origin settings do not dirty style on every camera update');
  h.cameraView.paint({ ...view, x: view.x + 1 });
  assert.ok(h.writes.some(write => write.property === 'transform'));
  h.writes.length = 0;
  h.resize(1440, 900);
  h.cameraView.paint(view);
  assert.ok(h.writes.some(write => write.property === 'transform'), 'resize must invalidate an otherwise identical view');
});

test('CSSOM number serialization cannot turn identical camera poses into repeated style writes', () => {
  // Real Chrome evidence from the earlier browser experiment: assigning
  // matrix(3.2278207632211533,...) reads back matrix(3.22782,...).
  const h = harness(fixtures[0], { serializeTransform: value => value.replace(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi,
    token => String(Number(Number(token).toPrecision(6)))) });
  const view = { x: -712.902644230769, y: -310.41535988832106, k: 3.2278207632211533 };
  h.cameraView.paint(view);
  h.writes.length = 0;
  h.cameraView.paint({ ...view });
  assert.deepEqual(h.writes, [], 'remember the last authored transform rather than comparing it with CSSOM rounded serialization');
});
