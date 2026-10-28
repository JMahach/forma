type Point = { x: number; y: number };
type Fixture = Omit<typeof fixtures[number], 'name'>;
type StyleWrite = { property: string | symbol; value: string };
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraView } from '../src/scene/camera-view.ts';
import { createCamera } from '../src/scene/camera.ts';
import { attachGestures } from '../src/scene/gestures.ts';
import { STUDIO_FRAME, MANDALA_FRAME } from '../src/scene/geometry/frames.ts';

const close = (actual: number, expected: number, message = '') => assert.ok(Math.abs(actual - expected) < 1e-8,
  `${message}: ${actual} should equal ${expected}`);
const pointClose = (actual: Point, expected: Point, message = '') => {
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

function harness(fixture: Fixture, { left = 37, top = -19, serializeTransform = value => value }: { left?: number; top?: number; serializeTransform?: (value: string) => string } = {}) {
  const writes: StyleWrite[] = [];
  const style = new Proxy({} as Record<string, string>, {
    set(target, property, value) {
      writes.push({ property, value });
      target[property as string] = property === 'transform' ? serializeTransform(value) : value;
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
  } as unknown as SVGSVGElement;
  const cameraView = createCameraView({ svg, surface: surface as HTMLElement });
  return { cameraView, surface, svg, writes, get rect() { return rect; },
    resize(width: number, height: number) { rect = { ...rect, width, height }; },
    move(left: number, top: number) { rect = { ...rect, left, top }; },
  };
}
const local = (f: Fixture, point: Point) => ({ x: f.sx * point.x + f.ox, y: f.sy * point.y + f.oy });
const screen = (f: Fixture, rect: Pick<DOMRect, 'left' | 'top'>, point: Point) => { const p = local(f, point); return { clientX: rect.left + p.x, clientY: rect.top + p.y }; };
function cssMatrix(value: string) {
  assert.match(value, /^matrix3d\(/, 'the root SVG uses a 3D-compatible matrix with a flat projection');
  const values = value.slice(value.indexOf('(') + 1, value.lastIndexOf(')')).trim().split(/[\s,]+/).map(Number);
  assert.equal(values.length, 16); assert.ok(values.every(Number.isFinite));
  return [values[0], values[1], values[4], values[5], values[12], values[13]];
}
const applyMatrix = (m: readonly number[], p: Point) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

for (const fixture of fixtures) {
  test(`camera view preserves pointer coordinates and drawing composition: ${fixture.name}`, () => {
    const h = harness(fixture);
    assert.equal(h.cameraView.surface, h.surface, 'input remains attached to a stationary surface');
    for (const view of [{ x: 0, y: 0, k: 1 }, { x: -763.5, y: -400.125, k: 3.2278 }, { x: 68.75, y: -17, k: .234 }] as const) {
      h.cameraView.paint(view);
      const matrix = cssMatrix(h.svg.style.transform);
      assert.equal(h.svg.style.transformOrigin, '0 0');
      assert.equal(h.svg.style.transformBox, 'border-box');
      for (const point of [{ x: fixture.box.x, y: fixture.box.y }, { x: 320, y: 410 }, { x: -500.75, y: 1900.125 }] as const) {
        pointClose(h.cameraView.point(screen(fixture, h.rect, point)), point, 'input does not include the already painted camera');
        const transformed = applyMatrix(matrix, local(fixture, point));
        const expected = local(fixture, { x: point.x * view.k + view.x, y: point.y * view.k + view.y });
        pointClose(transformed, expected, 'root CSS followed by the viewport mapping equals the old SVG camera');
      }
    }
  });
}

test('all preserveAspectRatio alignments keep the anchored viewBox edge for meet and slice', () => {
  for (const meetOrSlice of [1, 2] as const) for (let align = 2; align <= 10; align++) {
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
  const verify = (fixture: Fixture) => {
    const result = h.cameraView.measureFit(frame, fitInsets);
    pointClose(result.area, { x: (insets.side - fixture.ox) / fixture.sx, y: (insets.top + insets.offsetY - fixture.oy) / fixture.sy });
    close(result.area.width, (h.rect.width - 2 * insets.side) / fixture.sx);
    close(result.area.height, (h.rect.height - insets.top - insets.bottom) / fixture.sy);
    close(result.min, Math.min(.65, result.area.width / 10000, result.area.height / 10000));
    return result;
  };
  const homeFit = verify(fixtures[2]);
  pointClose(homeFit.viewport, { x: -360, y: -300.5 / .3 }, 'full viewport includes letterboxed white space');
  close(homeFit.viewport.width, 1300);
  close(homeFit.viewport.height, 844 / .3);
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
  assert.ok(h.writes.some((write: StyleWrite) => write.property === 'transform'));
  h.writes.length = 0;
  h.resize(1440, 900);
  h.cameraView.paint(view);
  assert.ok(h.writes.some((write: StyleWrite) => write.property === 'transform'), 'resize must invalidate an otherwise identical view');
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


test('the loading mirror receives the same projection before becoming visible, including saved zoom and resize', () => {
  for (const fixture of fixtures) {
    const h = harness(fixture), writes: unknown[] = [];
    const mirror = { style: new Proxy({} as Record<string, string>, { set(target, property, value) {
      if (property === 'visibility') assert.ok(target.transform?.startsWith('matrix3d('), 'paint precedes reveal');
      writes.push([property, value]); target[property as string] = value; return true;
    } }) };
    const cameraView = createCameraView({ svg: h.svg, surface: h.surface as HTMLElement, mirrors: [mirror as unknown as SVGSVGElement] });
    for (const view of [{ x: 0, y: 0, k: 1 }, { x: -763.5, y: -400.125, k: 3.2278 }] as const) {
      cameraView.paint(view);
      assert.equal(mirror.style.transform, h.svg.style.transform);
      assert.equal(mirror.style.transformOrigin, '0 0');
      assert.equal(mirror.style.transformBox, 'border-box');
      assert.equal(mirror.style.visibility, 'visible');
      writes.length = 0;
      cameraView.paint({ ...view });
      assert.deepEqual(writes, [], 'unchanged camera does not repeatedly write mirror styles');
    }
    h.resize(1031, 767);
    cameraView.paint({ x: -763.5, y: -400.125, k: 3.2278 });
    assert.equal(mirror.style.transform, h.svg.style.transform, 'both drawings follow the changed canvas projection');
  }
});

test('gesture attachment takes over the early camera without resetting its saved pose or navigation ceiling', () => {
  const h = harness(fixtures[1]), earlyPaints: Point[] = [], applicationPaints: unknown[] = [], listeners = new Map<string, EventListenerOrEventListenerObject>();
  (h.surface as typeof h.surface & { addEventListener(name: string, handler: EventListener): unknown }).addEventListener = (name, handler) => listeners.set(name, handler);
  h.svg.addEventListener = () => {};
  (h.svg as unknown as { classList: { toggle(): void } }).classList = { toggle() {} };
  const camera = createCamera({ getFrame: () => MANDALA_FRAME, getHomeFrame: () => STUDIO_FRAME,
    measureFit: frame => h.cameraView.measureFit(frame, { side: 20, top: 74, bottom: 60.8 }),
    onChange(view) { earlyPaints.push(view); h.cameraView.paint(view); } });
  camera.restoreView({ x: -170, y: -240, k: 2.4, maxK: 7 });
  const before = camera.getView(), home = camera.getFittedView(), maximum = camera.maximumScale();
  const earlyCount = earlyPaints.length;
  const controls = attachGestures(h.svg, { camera, cameraView: h.cameraView,
    getFrame() { assert.fail('handed-off camera retains its original geometry owners'); },
    onSelect() {}, onChange: view => applicationPaints.push(view), requestPaint: null });
  assert.deepEqual(controls.getView(), camera.getView());
  assert.deepEqual(camera.getView(), before);
  assert.deepEqual(camera.getFittedView(), home);
  assert.equal(camera.maximumScale(), maximum);
  assert.deepEqual(applicationPaints, [before], 'the new owner receives the current pose immediately');
  camera.restoreView({ x: -170, y: -240, k: 2.4, maxK: 7 });
  assert.deepEqual(camera.getView(), before, 'view-session restoration uses the exact early restore recipe');
  (listeners.get('wheel') as EventListener)({ clientX: 720, clientY: 450, deltaY: -50, preventDefault() {} } as WheelEvent);
  assert.ok(camera.getView().k > before.k, 'interaction continues from the saved scale');
  assert.equal(earlyPaints.length, earlyCount, 'the early paint callback has been handed off, not duplicated');
});


test('3D camera matrix remains an exact flat projection at maximum zoom', () => {
  for (const fixture of fixtures) {
    const h = harness(fixture), view = { x: -763.5, y: -400.125, k: 4.5 };
    h.cameraView.paint(view);
    assert.match(h.svg.style.transform, /^matrix3d\(/);
    const m = h.svg.style.transform.slice(9, -1).split(',').map(Number);
    assert.equal(m.length, 16);
    for (const p of [{ x: 320, y: 410 }, { x: -350.25, y: 1250.5 }]) {
      const input = local(fixture, p);
      pointClose({ x: m[0] * input.x + m[4] * input.y + m[12], y: m[1] * input.x + m[5] * input.y + m[13] },
        local(fixture, { x: p.x * view.k + view.x, y: p.y * view.k + view.y }));
      assert.equal(m[2] * input.x + m[6] * input.y + m[14], 0, 'no depth shift');
      assert.equal(m[3] * input.x + m[7] * input.y + m[15], 1, 'no perspective distortion');
    }
  }
});
