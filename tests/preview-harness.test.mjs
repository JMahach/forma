import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { preview as activationPreview } from './previews/activation-preview.mjs';
import { preview as fixingPreview } from './previews/line-fixing-preview.mjs';
import { readPreviewResource } from './previews/preview-server.mjs';
import { mountPreview } from './previews/preview-harness.js';
import { gatePositionAtLongitude } from '../src/domain/gate-wheel.js';

test('both preview pages serve the complete browser module graph without the application entry', async () => {
  for (const config of [activationPreview, fixingPreview]) {
    const page = await readPreviewResource('/', config);
    assert.equal(page.status, 200);
    assert.deepEqual(JSON.parse(page.body.match(/<script id="previewData" type="application\/json">([^]*?)<\/script>/)[1]), config);
    const pending = ['/preview-harness.js'], visited = new Set();
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
    for (const path of ['/src/scene/mandala.js', '/src/scene/backdrop.js', '/src/domain/gate-wheel.js']) {
      assert.ok(visited.has(path), `${path} is reachable`);
    }
    assert.ok(!visited.has('/src/app.js'));
    assert.ok(!visited.has('/src/data/storage.js'));
    assert.equal((await readPreviewResource('/styles.css', config)).status, 200);
    for (const path of ['/api/calculate', '/src/app.js', '/src/startup.js', '/server/server.mjs', '/data/cities.json', '/tests/previews/preview-server.mjs', '/.git/config', '/src/../server/server.mjs', '/src/%2e%2e/server/server.mjs', '/src/missing.js']) {
      assert.equal((await readPreviewResource(path, config)).status, 404, path);
    }
  }
});

test('synthetic activation and line-fixing cases retain their gates, lines and exact subdivision offsets', () => {
  const activationGates = [41, 20, 1, 29, 20, 41, 1, 29, 20, 41, 1, 29, 20];
  for (const side of ['design', 'personality']) {
    assert.deepEqual(activationPreview.chart.activations[side].map(entry => entry.gate), activationGates);
    assert.deepEqual(activationPreview.chart.activations[side].map(entry => entry.line), activationGates.map((_, index) => index % 6 + 1));
    const pairs = Object.fromEntries(fixingPreview.chart.activations[side].map(entry => [entry.planet, [entry.gate, entry.line]]));
    assert.deepEqual(pairs.sun, [55, 2]);
    assert.deepEqual(pairs.earth, [16, side === 'design' ? 3 : 4]);
    assert.deepEqual(pairs.moon, [23, 4]);
    assert.deepEqual(pairs.venus, [39, 1]);
    assert.deepEqual(pairs.mars, [48, 1]);
    assert.deepEqual(pairs.pluto, [43, 2]);
    for (const config of [activationPreview, fixingPreview]) {
      assert.equal(config.chart.activations[side].length, 13);
      for (const entry of config.chart.activations[side]) {
        assert.deepEqual(gatePositionAtLongitude(entry.longitude), { longitude: entry.longitude, gate: entry.gate, line: entry.line });
      }
    }
  }
  assert.ok(Math.abs(activationPreview.chart.activations.design[0].longitude - 302.2345) < 1e-10);
  assert.ok(Math.abs(fixingPreview.chart.activations.design[0].longitude - 331.1855) < 1e-10);
});

function browserHarness(t, config) {
  const original = new Map(['document', 'window', 'DOMPoint', 'PointerEvent', 'localStorage', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const surface = () => {
    const listeners = new Map(), attributes = new Map(), classes = new Set();
    return {
      style: { setProperty() {} }, dataset: {}, hidden: true, innerHTML: '',
      addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
      send(type, properties = {}) { for (const callback of listeners.get(type) || []) callback({ type, target: this, buttons: 0, pointerType: 'mouse', preventDefault() {}, ...properties }); },
      setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); },
      getBoundingClientRect: () => ({ left: 50, top: 60, right: 150, bottom: 110, width: 100, height: 50 }),
      querySelector: () => null, closest: () => null, contains: () => false,
      classList: { contains: value => classes.has(value), toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); } },
    };
  };
  const nodes = new Map(['previewSurface', 'preview', 'viewport', 'activationPopover', ...config.controls.map(control => control.id)].map(id => [id, surface()]));
  const svg = nodes.get('preview'), viewport = nodes.get('viewport'), panel = nodes.get('activationPopover'), anchors = new Map();
  panel.id = 'activationPopover';
  const target = dataset => ({ ...surface(), dataset, closest() { return this; }, dispatchEvent(event) { svg.send(event.type, { ...event, target: this }); } });
  for (const side of ['design', 'personality']) for (const entry of config.chart.activations[side]) {
    anchors.set(`[data-activation="${side}-${entry.planet}"]`, target({ type: 'gate', id: String(entry.gate), activation: `${side}-${entry.planet}` }));
  }
  anchors.set('[data-type="center"][data-id="throat"]', target({ type: 'center', id: 'throat' }));
  svg.querySelector = selector => anchors.get(selector) || null;
  svg.contains = node => [...anchors.values()].includes(node);
  svg.getScreenCTM = () => ({ inverse: () => ({}) });
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 900, width: 1000, height: 900 });
  nodes.get('previewSurface').getBoundingClientRect = svg.getBoundingClientRect;
  const [x, y, width, height] = config.viewBox.split(' ').map(Number);
  svg.viewBox = { baseVal: { x, y, width, height } };
  svg.preserveAspectRatio = { baseVal: { align: 6, meetOrSlice: 1 } };
  const document = { ...surface(), activeElement: null, getElementById: id => nodes.get(id) };
  const window = { ...surface(), innerWidth: 1000, innerHeight: 900 };
  const DOMPoint = class { constructor(x, y) { this.x = x; this.y = y; } matrixTransform() { return this; } };
  const PointerEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
  for (const [key, value] of Object.entries({ document, window, DOMPoint, PointerEvent, fetch: () => { throw new Error('Preview must not fetch calculations'); } })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Preview must not read saved charts'); } });
  const controller = mountPreview(config, { renderChart: renderBodygraph });
  return { controller, viewport, panel, svg, click: id => nodes.get(id).send('click'), anchor: id => anchors.get(`[data-activation="${id}"]`) };
}

test('activation preview mounts real controllers and preserves hover, selection, popover and keyboard interactions', t => {
  const { controller, viewport, panel, svg, click, anchor } = browserHarness(t, activationPreview);
  assert.match(viewport.innerHTML, /bodygraph-drawing/);
  assert.match(viewport.innerHTML, /data-activation="design-sun"/);
  click('pinThroat');
  assert.deepEqual(controller.selectionState.primary, { type: 'center', id: 'throat' });
  for (const [id, selection] of [['hover1', { type: 'gate', id: 1 }], ['hover20', { type: 'gate', id: 20 }], ['hover29', { type: 'gate', id: 29 }], ['hoverNumber', { type: 'gate', id: 41 }], ['hoverCenter', { type: 'center', id: 'throat' }]]) {
    click(id);
    assert.deepEqual(controller.hoverPreview.currentSelection, selection);
    assert.deepEqual(controller.selectionState.primary, { type: 'center', id: 'throat' });
  }
  click('leave');
  assert.equal(controller.hoverPreview.currentSelection, null);
  click('pinThroat');
  assert.deepEqual(controller.selectionState.items, []);
  svg.send('keydown', { key: 'Enter', target: anchor('design-sun') });
  assert.equal(controller.activationPopover.currentId, 'design-sun');
  assert.equal(panel.hidden, false);
  svg.send('keydown', { key: 'Enter', target: anchor('design-sun') });
  assert.equal(panel.hidden, true);
  controller.choose({ type: 'gate', id: 29 });
  controller.clearSelection();
  assert.deepEqual(controller.selectionState.items, []);
});

test('line-fixing preview renders fixation marks and its Home control resets the camera', t => {
  const { controller, viewport, click } = browserHarness(t, fixingPreview);
  const states = new Set([...viewport.innerHTML.matchAll(/data-fixing="([^"]+)"/g)].map(match => match[1]));
  assert.deepEqual([...states].sort(), ['detriment', 'exalted', 'juxtaposed']);
  controller.gestures.zoom(2);
  click('home');
  assert.deepEqual(controller.gestures.getView(), controller.gestures.getFittedView());
  click('leave');
  assert.equal(controller.hoverPreview.currentSelection, null);
});
