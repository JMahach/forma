import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraphController } from '../src/scene/updates.js';
import { attachMandalaMode } from '../src/scene/modes/mandala.js';
import { createMandalaMotion } from '../src/scene/modes/mandala-motion.js';
import { createCamera } from '../src/scene/camera.js';
import { createChartSession } from '../src/state/chart-session.js';
import { STUDIO_FRAME } from '../src/scene/geometry/frames.js';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';
import { SVG_NS, svgDocument } from './helpers/svg-dom.mjs';

test('saved chart navigation keeps the enabled mandala, current reveal and camera while clearing old selection', () => {
  const document = svgDocument(), viewport = document.createElementNS(SVG_NS, 'g');
  const styles = new Map();
  viewport.style = { setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key) };
  const charts = [
    { id: 'one', personality: [20, 34], design: [10, 57] },
    { id: 'two', personality: [4, 63], design: [29, 46] },
  ];
  let graph, mode, time = 0, nextFrame = 0, toggle;
  const frames = new Map(), attributes = new Map(), classes = new Set();
  const session = createChartSession({ store: { get: id => charts.find(chart => chart.id === id), has: id => charts.some(chart => chart.id === id) }, onChange: () => graph?.render() });
  session.select('one');
  const camera = createCamera({ getFrame: () => mode?.frame, getHomeFrame: () => STUDIO_FRAME,
    measureFit: () => ({ area: { x: 0, y: 0, width: 640, height: 820 }, min: .1 }),
    onChange: view => viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`) });
  const motion = createMandalaMotion({ viewport, now: () => time, reducedMotion: () => false,
    requestFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id), onFinish: enabled => mode.finishTransition(enabled) });
  graph = createGraphController({ viewport, getChart: () => session.current, hasChart: () => session.hasCurrent,
    activationPopover: { close() {}, refresh() {} }, getMandala: () => mode,
    onChartChange: session.select });
  mode = attachMandalaMode({
    button: { setAttribute: (key, value) => attributes.set(key, value), addEventListener: (_, callback) => { toggle = callback; } },
    canvas: { classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) } },
    gestures: camera, layout: { frame: () => STUDIO_FRAME }, render: graph.render, motion });
  camera.reset(); camera.zoom(1.7); camera.pan(17, 31);
  graph.render(); toggle();
  const tick = value => { time = value; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  tick(100);
  assert.equal(styles.get('--mandala-reveal'), '0.5');
  graph.choose({ type: 'mandala-cross', cross: crossAtLongitude(305.7) });
  assert.equal(graph.selectionState.crosses.length, 1);
  const view = camera.getView(), transform = viewport.getAttribute('transform');
  const ring = viewport.querySelector('.mandala-scene');
  graph.changeChart('two');
  assert.equal(session.selectedId, 'two');
  assert.equal(mode.enabled, true); assert.equal(mode.visible, true);
  assert.equal(attributes.get('aria-checked'), 'true'); assert.ok(classes.has('has-mandala'));
  assert.equal(viewport.querySelector('.mandala-scene'), ring, 'the real persistent renderer retains the ring');
  assert.deepEqual(graph.selectionState.items, []); assert.deepEqual(graph.selectionState.crosses, []);
  assert.deepEqual(camera.getView(), view); assert.equal(viewport.getAttribute('transform'), transform);
  assert.equal(styles.get('--mandala-reveal'), '0.5'); assert.equal(frames.size, 1);
  tick(200);
  assert.equal(styles.get('--mandala-reveal'), '1'); assert.equal(motion.active, false);
  graph.changeChart('one');
  assert.equal(mode.enabled, true); assert.equal(styles.get('--mandala-reveal'), '1');
  assert.deepEqual(camera.getView(), view);
});
