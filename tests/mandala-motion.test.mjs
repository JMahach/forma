import { renderBodygraph } from '../src/scene/bodygraph-svg.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIVATION_COLUMN_REVEAL_DISTANCE as distance } from '../src/scene/geometry/activation-layout.js';
import { createMandalaMotion } from '../src/scene/modes/mandala-motion.js';
import { createGraphController } from '../src/scene/updates.js';
import { DRAWING_TRANSFORM } from '../src/scene/geometry/drawing-presentation.js';
import { attachMandalaMode } from '../src/scene/modes/mandala.js';

const property = '--activation-column-offset', revealProperty = '--mandala-reveal';
function harness(options = {}) {
  const values = new Map([['unrelated', 'preserved']]), frames = new Map(), canceled = [], finishes = [];
  let time = 0, sequence = 0, updates = 0, reduced = false;
  const viewport = {
    innerHTML: '', transform: 'translate(17 31) scale(1.4)',
    style: { setProperty: (key, value) => values.set(key, value), removeProperty: key => values.delete(key) },
    querySelector: () => null, querySelectorAll: () => [],
  };
  const motion = createMandalaMotion({ viewport, now: () => time,
    requestFrame(callback) { const id = sequence++; frames.set(id, callback); return id; },
    cancelFrame(id) { canceled.push(id); frames.delete(id); },
    reducedMotion: () => reduced, onUpdate: () => { updates++; },
    onFinish: expanded => { finishes.push(expanded); }, ...options,
  });
  return {
    motion, viewport, values, frames, canceled, finishes,
    get offset() { return Number.parseFloat(values.get(property)); },
    get reveal() { return Number(values.get(revealProperty)); },
    get updates() { return updates; },
    setReduced(value) { reduced = value; },
    at(value) { time = value; },
    tick(value) {
      time = value;
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(value));
    },
  };
}

function integrationHarness({ reduced = false } = {}) {
  let mode, renders = 0, frameRefreshes = 0;
  const callbacks = {}, attributes = {}, classes = new Set();
  const h = harness({ onFinish: expanded => mode.finishTransition(expanded) });
  h.setReduced(reduced);
  const graph = createGraphController({
    renderChart: renderBodygraph, viewport: h.viewport, getChart: () => ({ personality: [20, 34], design: [10] }), getMandala: () => mode,
    alignHeading() {}, activationPopover: { close() {}, refresh() {} },
  });
  const render = () => { renders++; graph.render(); };
  mode = attachMandalaMode({
    button: {
      setAttribute: (key, value) => { attributes[key] = value; },
      addEventListener: (event, callback) => { callbacks[event] = callback; },
    },
    canvas: { style: { setProperty() {} }, classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } } },
    gestures: { refreshFrame() { frameRefreshes++; } },
    render, motion: h.motion,
  });
  render();
  return {
    ...h, mode, graph, render, attributes, classes, toggle: () => callbacks.click(),
    get markup() { return h.viewport.innerHTML; },
    get reveal() { return h.reveal; },
    get offset() { return h.offset; },
    get renders() { return renders; },
    get frameRefreshes() { return frameRefreshes; },
  };
}
const ringMarkup = markup => markup.includes('<g class="mandala-scene"')
  ? markup.slice(markup.indexOf('<g class="mandala-scene"'), markup.indexOf('<g class="bodygraph-drawing')) : '';
const drawingTransform = markup => markup.match(/class="bodygraph-drawing[^"]*" transform="([^"]+)"/)?.[1];
const between = (markup, start, end) => markup.slice(markup.indexOf(start), markup.indexOf(end));

test('integrated ring closes decoratively across redraws and is removed once without idle work', () => {
  const h = integrationHarness(), original = h.markup;
  assert.equal(ringMarkup(original), '');
  h.toggle();
  assert.equal(h.mode.enabled, true);
  assert.equal(h.mode.visible, true);
  assert.match(ringMarkup(h.markup), /class="mandala-gate bg-interactive"/);
  for (const [start, end] of [
    ['<g class="bodygraph-channels">', '<g class="bodygraph-centers">'],
    ['<g class="bodygraph-centers">', '<g class="bodygraph-gates">'],
  ]) assert.equal(between(h.markup, start, end), between(original, start, end), 'the underlying body paths stay unchanged');
  assert.equal(drawingTransform(original), DRAWING_TRANSFORM);
  assert.equal(drawingTransform(h.markup), drawingTransform(original), 'opening cannot change the body presentation matrix');
  h.tick(100);
  assert.equal(h.renders, 2, 'animation frames do not rebuild SVG');
  h.graph.preview(); h.graph.choose({ type: 'gate', id: 20 });
  assert.equal(h.reveal, 0.5);
  assert.equal(h.frames.size, 1);
  h.tick(200);
  assert.equal(h.renders, 2, 'enter completion does not rebuild SVG');
  h.toggle();
  assert.equal(h.mode.enabled, false);
  assert.equal(h.mode.visible, true);
  assert.equal(h.attributes['aria-checked'], 'false');
  assert.equal(h.classes.has('has-mandala'), false);
  assert.equal(drawingTransform(h.markup), drawingTransform(original), 'closing keeps the exact body matrix before the first animation frame');
  const closing = ringMarkup(h.markup);
  assert.ok(closing);
  assert.match(closing, /class="bodygraph-mandala" aria-hidden="true" pointer-events="none" focusable="false"/);
  assert.doesNotMatch(closing, /data-type=|tabindex=|role=|pointer-events="all"|mandala-gate-hit/);
  h.tick(300); h.graph.preview();
  assert.equal(drawingTransform(h.markup), drawingTransform(original), 'an outgoing redraw cannot reset body geometry');
  assert.equal(h.reveal, 0.5);
  assert.doesNotMatch(ringMarkup(h.markup), /data-type=|tabindex=|pointer-events="all"/);
  h.tick(400);
  assert.equal(h.mode.visible, false);
  assert.equal(ringMarkup(h.markup), '');
  assert.equal(h.renders, 4, 'one closing render plus one final cleanup');
  assert.equal(h.frameRefreshes, 2, 'camera limits only update on toggles');
  assert.equal(h.viewport.transform, 'translate(17 31) scale(1.4)');
  h.graph.render(); h.tick(1000);
  assert.equal(h.frames.size, 0);
  assert.equal(h.reveal, 0);
  assert.equal(h.renders, 4, 'settled motion does not render again');
});

test('integrated reduced-motion toggle renders first, then removes the outgoing layer synchronously', () => {
  const h = integrationHarness({ reduced: true });
  h.toggle();
  assert.equal(h.reveal, 1);
  assert.equal(h.mode.visible, true);
  h.toggle();
  assert.equal(h.mode.visible, false);
  assert.equal(ringMarkup(h.markup), '');
  assert.equal(h.reveal, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.renders, 4);
});

test('integrated close-to-open reversal cannot remove the new interactive ring', () => {
  const h = integrationHarness();
  h.toggle(); h.tick(200);
  h.toggle(); h.tick(300);
  const staleClose = [...h.frames.values()][0];
  h.toggle();
  assert.equal(h.reveal, 0.5);
  assert.equal(h.mode.visible, true);
  assert.match(ringMarkup(h.markup), /class="mandala-gate bg-interactive"/);
  staleClose(400);
  assert.equal(h.mode.visible, true);
  assert.equal(h.renders, 4);
  h.tick(400);
  assert.equal(h.reveal, 1);
  assert.equal(h.mode.visible, true);
  assert.equal(h.renders, 4);
  assert.equal(h.frames.size, 0);
});

test('one inherited progress synchronizes ring and columns without moving the camera', () => {
  const h = harness();
  assert.equal(h.offset, 0);
  assert.equal(h.reveal, 0);
  assert.equal(h.motion.active, false);
  assert.equal(h.motion.expanded, false);
  assert.equal(h.frames.size, 0);
  h.motion.setExpanded(true);
  assert.equal(h.offset, 0, 'the first render keeps the current screen position');
  assert.equal(h.frames.size, 1);
  assert.equal(h.motion.active, true);
  assert.equal(h.motion.expanded, true);
  h.tick(100);
  assert.equal(h.offset, distance / 2);
  assert.equal(h.reveal, 0.5);
  assert.deepEqual(h.finishes, []);
  h.tick(200);
  assert.equal(h.offset, distance);
  assert.equal(h.reveal, 1);
  assert.equal(h.motion.active, false);
  assert.deepEqual(h.finishes, [true]);
  assert.equal(h.frames.size, 0);
  h.motion.setExpanded(false);
  assert.equal(h.motion.expanded, false);
  h.tick(300);
  assert.equal(h.offset, distance / 2);
  h.tick(400);
  assert.equal(h.offset, 0);
  assert.equal(h.reveal, 0);
  assert.equal(h.motion.active, false);
  assert.deepEqual(h.finishes, [true, false]);
  assert.equal(h.frames.size, 0);
  assert.equal(h.viewport.transform, 'translate(17 31) scale(1.4)');
  assert.equal(h.values.get('unrelated'), 'preserved');
  assert.equal(h.updates, 4, 'only actual offset changes notify dependent UI');
});

test('hover, selection and chart redraws inherit the in-flight offset without restarting it', () => {
  const h = harness();
  let chart = { id: 'first', personality: [], design: [] }, enabled = false;
  const graph = createGraphController({
    renderChart: renderBodygraph, viewport: h.viewport, getChart: () => chart, getMandala: () => ({ enabled }),
    renderChart: value => `<g data-chart="${value.id}" class="activation-column"></g>`,
    alignHeading() {}, activationPopover: { close() {}, refresh() {} },
  });
  graph.render();
  enabled = true; h.motion.setExpanded(true); graph.render();
  h.tick(100);
  const frame = [...h.frames.keys()];
  graph.preview();
  graph.choose({ type: 'gate', id: 36 });
  chart = { ...chart, id: 'next-minute' }; graph.render();
  assert.equal(h.offset, distance / 2);
  assert.deepEqual([...h.frames.keys()], frame, 'rendering does not schedule or replace the animation frame');
  assert.match(h.viewport.innerHTML, /next-minute/);
  assert.equal(h.reveal, 0.5);
  h.tick(200);
  assert.equal(h.offset, distance, 'the original animation deadline is retained');
  assert.equal(h.frames.size, 0);
});

test('rapid reversals start at the current offset and use a proportional duration', () => {
  const h = harness();
  h.motion.setExpanded(true);
  h.tick(100);
  h.motion.setExpanded(false);
  assert.equal(h.offset, distance / 2);
  assert.equal(h.frames.size, 1);
  h.tick(150);
  assert.equal(h.offset, distance / 4);
  h.motion.setExpanded(true);
  assert.equal(h.offset, distance / 4);
  h.tick(225);
  assert.equal(h.offset, distance * .625);
  h.tick(300);
  assert.equal(h.offset, distance, 'three quarters of the distance take three quarters of 200ms');
  assert.deepEqual(h.finishes, [true], 'reversed endpoints never notify');
  assert.equal(h.frames.size, 0);
});

test('reversal between frames samples current progress rather than a stale painted position', () => {
  const h = harness();
  h.motion.setExpanded(true); h.tick(50);
  assert.equal(h.reveal, 0.15625);
  h.at(100); h.motion.setExpanded(false);
  assert.equal(h.reveal, 0.5);
  assert.equal(h.offset, distance / 2);
  h.tick(150);
  assert.equal(h.reveal, 0.25);
  h.tick(200);
  assert.equal(h.reveal, 0);
  assert.deepEqual(h.finishes, [false]);
  assert.equal(h.frames.size, 0);
});

test('a repeated target neither restarts motion nor adds animation frames', () => {
  const h = harness();
  h.motion.setExpanded(false);
  assert.equal(h.frames.size, 0);
  h.motion.setExpanded(true);
  h.tick(100);
  const pending = [...h.frames.keys()];
  h.at(150); h.motion.setExpanded(true);
  assert.deepEqual([...h.frames.keys()], pending);
  h.tick(200);
  assert.equal(h.offset, distance);
  h.motion.setExpanded(true);
  assert.equal(h.frames.size, 0);
  assert.deepEqual(h.finishes, [true], 'repeating a settled target does not notify again');
});

test('canceled callbacks cannot overwrite a reversed animation or queue another frame', () => {
  const h = harness();
  h.motion.setExpanded(true);
  const stale = [...h.frames.values()][0];
  h.tick(100); h.motion.setExpanded(false);
  const pending = [...h.frames.keys()];
  stale(200);
  assert.equal(h.offset, distance / 2);
  assert.deepEqual([...h.frames.keys()], pending);
  assert.deepEqual(h.finishes, []);
  h.tick(200);
  assert.equal(h.offset, 0);
  assert.equal(h.frames.size, 0);
  assert.deepEqual(h.finishes, [false]);
});

test('reduced motion snaps directly and can also finish an animation already running', () => {
  const h = harness();
  h.setReduced(true); h.motion.setExpanded(true);
  assert.equal(h.offset, distance);
  assert.equal(h.frames.size, 0);
  h.motion.setExpanded(false);
  assert.equal(h.offset, 0);
  h.setReduced(false); h.motion.setExpanded(true); h.tick(60);
  assert.ok(h.offset > 0 && h.offset < distance);
  h.setReduced(true); h.tick(80);
  assert.equal(h.offset, distance);
  assert.equal(h.frames.size, 0);
  h.setReduced(false); h.motion.setExpanded(false); h.tick(120);
  h.setReduced(true); h.motion.setExpanded(false);
  assert.equal(h.offset, 0, 'repeating a target also honors a new reduced-motion preference');
  assert.equal(h.frames.size, 0);
  assert.deepEqual(h.finishes, [true, false, true, false]);
});

test('missing frame support or zero duration settle synchronously without pending work', () => {
  for (const options of [{ requestFrame: null }, { durationMs: 0 }]) {
    const h = harness(options);
    h.motion.setExpanded(true);
    assert.equal(h.offset, distance);
    assert.equal(h.reveal, 1);
    assert.equal(h.frames.size, 0);
    h.motion.setExpanded(false);
    assert.equal(h.offset, 0);
    assert.deepEqual(h.finishes, [true, false]);
  }
});

test('zero column distance still animates the ring reveal', () => {
  const h = harness({ distance: 0 });
  h.motion.setExpanded(true); h.tick(100);
  assert.equal(h.offset, 0);
  assert.equal(h.reveal, 0.5);
  h.tick(200);
  assert.equal(h.reveal, 1);
  assert.deepEqual(h.finishes, [true]);
  assert.equal(h.frames.size, 0);
});

test('reversing before the first frame settles the closed endpoint immediately', () => {
  const h = harness();
  h.motion.setExpanded(true);
  const stale = [...h.frames.values()][0];
  h.motion.setExpanded(false);
  assert.equal(h.reveal, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.motion.active, false);
  assert.deepEqual(h.finishes, [false]);
  stale(200);
  assert.deepEqual(h.finishes, [false]);
});

test('custom distance retains the timing contract and long frame gaps settle exactly', () => {
  const h = harness({ distance: 140, durationMs: 200 });
  h.motion.setExpanded(true); h.tick(100);
  assert.equal(h.offset, 70);
  h.tick(1000);
  assert.equal(h.offset, 140);
  assert.equal(h.frames.size, 0);
});

test('finish callbacks observe settled styles and can start the next transition safely', () => {
  const finished = [];
  const h = harness({ onFinish(expanded) {
    finished.push(expanded);
    assert.equal(h.motion.active, false);
    assert.equal(h.motion.expanded, expanded);
    assert.equal(h.reveal, expanded ? 1 : 0);
    assert.equal(h.offset, expanded ? distance : 0);
    if (expanded) h.motion.setExpanded(false);
  } });
  h.motion.setExpanded(true); h.tick(200);
  assert.equal(h.motion.active, true);
  assert.equal(h.frames.size, 1);
  h.tick(400);
  assert.deepEqual(finished, [true, false]);
  assert.equal(h.frames.size, 0);
});

test('dispose cancels motion and clears only the two variables owned by this adapter', () => {
  const h = harness();
  h.motion.setExpanded(true);
  const stale = [...h.frames.values()][0];
  h.motion.dispose(); h.motion.dispose();
  assert.deepEqual(h.canceled, [0], 'frame id zero is canceled too');
  assert.equal(h.values.has(property), false);
  assert.equal(h.values.has(revealProperty), false);
  assert.equal(h.values.get('unrelated'), 'preserved');
  assert.equal(h.viewport.transform, 'translate(17 31) scale(1.4)');
  h.motion.setExpanded(true); stale(240);
  assert.equal(h.values.has(property), false);
  assert.equal(h.frames.size, 0);
  assert.equal(h.updates, 0);
  assert.equal(h.motion.active, false);
  assert.deepEqual(h.finishes, []);
});
