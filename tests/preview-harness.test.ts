import { transformSync } from 'esbuild';
import { sceneResource } from './benchmarks/scene-server.ts';
import { regressionResource } from './benchmarks/regression-server.ts';
import { renderBodygraph } from '../src/scene/bodygraph-svg.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { preview as activationPreview } from './previews/activation-preview.ts';
import { preview as fixingPreview } from './previews/line-fixing-preview.ts';
import { readPreviewResource, type PreviewConfig } from './previews/preview-server.ts';
import { mountPreview } from './previews/preview-harness.ts';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.ts';
import type { ChartView } from '../src/domain/chart-composition.ts';
import type { RenderOptions } from '../src/scene/render-state.ts';
import type { SelectionTarget } from '../src/selection/selection-targets.ts';

test('both preview pages serve the complete browser module graph without the application entry', async () => {
  for (const config of [activationPreview, fixingPreview] as const) {
    const page = await readPreviewResource('/', config);
    assert.equal(page.status, 200);
    assert.deepEqual(JSON.parse(page.body.match(/<script id="previewData" type="application\/json">([^]*?)<\/script>/)![1]), config);
    const pending = ['/preview-harness.ts'], visited = new Set();
    while (pending.length) {
      const pathname = pending.pop();
      if (visited.has(pathname)) continue;
      visited.add(pathname);
      const resource = await readPreviewResource(pathname, config);
      assert.equal(resource.status, 200, pathname);
      assert.match(resource.type, /javascript/, pathname);
      for (const [, dependency] of resource.body.matchAll(/^\s*(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
        const target = new URL(dependency, `http://preview${pathname}`);
        assert.equal(target.origin, 'http://preview');
        pending.push(target.pathname);
      }
    }
    for (const path of ['/src/scene/mandala.ts', '/src/scene/backdrop.ts', '/src/domain/gate-wheel.ts', '/src/ui/layout/viewport.ts'] as const) {
      assert.ok(visited.has(path), `${path} is reachable`);
    }
    assert.ok(!visited.has('/src/app.ts'));
    assert.ok(!visited.has('/src/data/storage.ts'));
    assert.equal((await readPreviewResource('/styles.css', config)).status, 200);
    for (const path of ['/api/calculate', '/src/app.ts', '/src/startup.ts', '/server/server.ts', '/data/cities.json', '/tests/previews/preview-server.ts', '/.git/config', '/src/../server/server.ts', '/src/%2e%2e/server/server.mjs', '/src/missing.js'] as const) {
      assert.equal((await readPreviewResource(path, config)).status, 404, path);
    }
  }
});

test('synthetic activation and line-fixing cases retain their gates, lines and exact subdivision offsets', () => {
  const activationGates = [41, 20, 1, 29, 20, 41, 1, 29, 20, 41, 1, 29, 20];
  for (const side of ['design', 'personality'] as const) {
    assert.deepEqual(activationPreview.chart.activations[side].map(entry => entry.gate), activationGates);
    assert.deepEqual(activationPreview.chart.activations[side].map(entry => entry.line), activationGates.map((_, index) => index % 6 + 1));
    const pairs = Object.fromEntries(fixingPreview.chart.activations[side].map(entry => [entry.planet, [entry.gate, entry.line]]));
    assert.deepEqual(pairs.sun, [55, 2]);
    assert.deepEqual(pairs.earth, [16, side === 'design' ? 3 : 4]);
    assert.deepEqual(pairs.moon, [23, 4]);
    assert.deepEqual(pairs.venus, [39, 1]);
    assert.deepEqual(pairs.mars, [48, 1]);
    assert.deepEqual(pairs.pluto, [43, 2]);
    for (const config of [activationPreview, fixingPreview] as const) {
      assert.equal(config.chart.activations[side].length, 13);
      for (const entry of config.chart.activations[side]) {
        assert.deepEqual(gatePositionAtLongitude(entry.longitude), { longitude: entry.longitude, gate: entry.gate, line: entry.line });
      }
    }
  }
  assert.ok(Math.abs(activationPreview.chart.activations.design[0].longitude - 302.2345) < 1e-10);
  assert.ok(Math.abs(fixingPreview.chart.activations.design[0].longitude - 331.1855) < 1e-10);
});

function browserHarness(t: test.TestContext, config: PreviewConfig) {
  const original = new Map(['document', 'window', 'DOMPoint', 'PointerEvent', 'localStorage', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const surface = () => {
    const listeners = new Map(), attributes = new Map(), classes = new Set();
    return {
      style: { setProperty() {} } as unknown as CSSStyleDeclaration, dataset: {} as DOMStringMap, hidden: true, innerHTML: '',
      addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
      removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) || []).filter(listener => listener !== callback)); },
      send(type: string, properties = {}) { for (const callback of listeners.get(type) || []) callback({ type, target: this, buttons: 0, pointerType: 'mouse', preventDefault() {}, ...properties }); },
      setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); },
      getBoundingClientRect: () => ({ left: 50, top: 60, right: 150, bottom: 110, width: 100, height: 50 }),
      querySelector: () => null, closest: () => null, contains: () => false,
      classList: { contains: (value: unknown) => classes.has(value), toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); } },
    };
  };
  const nodes = new Map(['previewSurface', 'preview', 'viewport', 'activationPopover', ...config.controls.map(control => control.id)].map(id => [id, surface()]));
  const svg = nodes.get('preview'), viewport = nodes.get('viewport'), panel = nodes.get('activationPopover'), anchors = new Map();
  panel!.id = 'activationPopover';
  const target = (dataset: { type: string; id: string; activation?: string; }, column = null) => ({ ...surface(), dataset,
    closest(selector: string) { return selector === '.activation-column' ? column : this; },
    dispatchEvent(event: {}|undefined) { svg!.send(event!.type, { ...event, target: this }); } });
  for (const [source, columnSide] of [['design', 'left'], ['personality', 'right']] as const) for (const entry of config.chart.activations[source]) {
    anchors.set(`[data-activation="${source}-${entry.planet}"]`, target({ type: 'gate' as const, id: String(entry.gate), activation: `${source}-${entry.planet}` }, { dataset: { columnSide } }));
  }
  anchors.set('[data-type="center"][data-id="throat"]', target({ type: 'center' as const, id: 'throat' }));
  svg!.querySelector = selector => anchors.get(selector) || null;
  svg!.contains = node => [...anchors.values()].includes(node);
  svg!.getScreenCTM = () => ({ inverse: () => ({}) });
  svg!.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 900, width: 1000, height: 900 });
  nodes.get('previewSurface')!.getBoundingClientRect = svg!.getBoundingClientRect;
  const [x, y, width, height] = config.viewBox.split(' ').map(Number);
  svg!.viewBox = { baseVal: { x, y, width, height } };
  svg!.preserveAspectRatio = { baseVal: { align: 6, meetOrSlice: 1 } };
  const document = { ...surface(), activeElement: null, getElementById: (id: string) => nodes.get(id) };
  const window = { ...surface(), innerWidth: 1000, innerHeight: 900 };
  document.defaultView = window;
  for (const node of nodes.values()) node.ownerDocument = document;
  const DOMPoint = class {
    declare x: number; declare y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } matrixTransform() { return this; } };
  const PointerEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  for (const [key, value] of Object.entries({ document, window, DOMPoint, PointerEvent, fetch: () => { throw new Error('Preview must not fetch calculations'); } })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Preview must not read saved charts'); } });
  const controller = mountPreview(config, { scene: { update(chart: ChartView|undefined, selection: SelectionTarget|null|undefined, options: RenderOptions|undefined) { viewport!.innerHTML = renderBodygraph(chart, selection, options); }, clear() { viewport!.innerHTML = ''; } } });
  return { controller, viewport, panel, svg, click: (id: string) => nodes.get(id)!.send('click'), anchor: id => anchors.get(`[data-activation="${id}"]`) };
}

test('activation preview mounts real controllers and preserves hover, selection, popover and keyboard interactions', t => {
  const { controller, viewport, panel, svg, click, anchor } = browserHarness(t, activationPreview);
  assert.match(viewport!.innerHTML, /bodygraph-drawing/);
  assert.match(viewport!.innerHTML, /data-activation="design-sun"/);
  click('pinThroat');
  assert.deepEqual(controller.selectionState.primary, { type: 'center' as const, id: 'throat' });
  for (const [id, selection] of [['hover1', { type: 'gate' as const, id: 1 }], ['hover20', { type: 'gate' as const, id: 20 }], ['hover29', { type: 'gate' as const, id: 29 }], ['hoverNumber', { type: 'gate' as const, id: 41 }], ['hoverCenter', { type: 'center' as const, id: 'throat' }]] as const) {
    click(id);
    assert.deepEqual(controller.hoverPreview.currentSelection, selection);
    assert.deepEqual(controller.selectionState.primary, { type: 'center' as const, id: 'throat' });
  }
  click('leave');
  assert.equal(controller.hoverPreview.currentSelection, null);
  click('pinThroat');
  assert.deepEqual(controller.selectionState.items, []);
  svg!.send('keydown', { key: 'Enter', target: anchor('design-sun') });
  assert.equal(controller.activationPopover.currentId, null);
  assert.equal(panel!.hidden, true, 'the first activation selects without percentages');
  assert.deepEqual(controller.selectionState.items, [{ type: 'gate' as const, id: 41, activation: 'design-sun' }]);
  svg!.send('keydown', { key: 'Enter', target: anchor('design-sun') });
  assert.equal(controller.activationPopover.currentId, 'design-sun');
  assert.equal(panel!.hidden, false);
  svg!.send('keydown', { key: 'Enter', target: anchor('design-sun') });
  assert.equal(panel!.hidden, true);
  assert.deepEqual(controller.selectionState.items, [], 'the third activation clears selection and percentages');
  controller.choose({ type: 'gate' as const, id: 29 });
  controller.clearSelection();
  assert.deepEqual(controller.selectionState.items, []);
});

test('line-fixing preview renders fixation marks and its Home control resets the camera', t => {
  const { controller, viewport, click } = browserHarness(t, fixingPreview);
  const states = new Set([...viewport!.innerHTML.matchAll(/data-fixing="([^"]+)"/g)].map(match => match[1]));
  assert.deepEqual([...states].sort(), ['detriment', 'exalted', 'juxtaposed']);
  controller.gestures.zoom(2);
  click('home');
  assert.deepEqual(controller.gestures.getView(), controller.gestures.getFittedView());
  click('leave');
  assert.equal(controller.hoverPreview.currentSelection, null);
});


test('auxiliary browser pages serve executable JavaScript and the current preview implementation', async () => {
  for (const [resource, entry] of [[sceneResource, '/'], [regressionResource, '/thumbnails'], [regressionResource, '/focus']] as const) {
    const page = await resource(entry);
    assert.equal(page.status, 200);
    const script = page.body.match(/<script type="module" src="([^"]+)"/)?.[1];
    assert.ok(script, 'page exposes its entry module');
    const pending = [script], visited = new Set<string>();
    while (pending.length) {
      const pathname = pending.pop()!;
      if (visited.has(pathname)) continue;
      visited.add(pathname);
      const response = await resource(pathname);
      assert.equal(response.status, 200, pathname);
      assert.match(response.type!, /javascript/, pathname);
      assert.doesNotThrow(() => transformSync(response.body, { loader: 'js', target: 'esnext' }), pathname);
      for (const [, dependency] of response.body.matchAll(/^\s*(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
        pending.push(new URL(dependency, `http://preview${pathname}`).pathname);
      }
    }
    if (entry === '/thumbnails') assert.ok(visited.has('/src/views/chart-preview-canvas.ts'));
  }
});
