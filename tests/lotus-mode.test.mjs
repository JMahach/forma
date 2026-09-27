import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachLotusMode } from '../src/scene/modes/lotus.js';
import { createGraphController } from '../src/scene/updates.js';

function harness(storage = null, render = () => {}) {
  const callbacks = {}, attributes = {};
  let renders = 0;
  const mode = attachLotusMode({
    button: {
      setAttribute(key, value) { attributes[key] = value; },
      addEventListener(event, fn) { callbacks[event] = fn; },
    },
    storage, render() { renders++; render(); },
  });
  return { mode, attributes, click: () => callbacks.click(), get renders() { return renders; } };
}

test('Lotus defaults off and a click changes only the displayed preference', () => {
  const h = harness();
  assert.equal(h.mode.enabled, false);
  assert.equal(h.attributes['aria-checked'], 'false');
  assert.equal(h.renders, 0, 'initial page render remains owned by application bootstrap');
  h.click();
  assert.equal(h.mode.enabled, true);
  assert.equal(h.attributes['aria-checked'], 'true');
  assert.equal(h.renders, 1);
  h.click();
  assert.equal(h.mode.enabled, false);
  assert.equal(h.attributes['aria-checked'], 'false');
  assert.equal(h.renders, 2);
});

test('the preference survives reload without writing any chart data', () => {
  const values = new Map(), writes = [];
  const storage = { getItem: key => values.get(key), setItem(key, value) { writes.push([key, value]); values.set(key, value); } };
  const first = harness(storage);
  first.click();
  const second = harness(storage);
  assert.equal(second.mode.enabled, true);
  assert.equal(second.attributes['aria-checked'], 'true');
  assert.equal(second.renders, 0);
  second.click();
  assert.equal(harness(storage).mode.enabled, false);
  assert.deepEqual(writes, [['forma.view.lotus', 'true'], ['forma.view.lotus', 'false']]);
});

test('blocked, unavailable and malformed browser preferences do not break the switch', () => {
  for (const storage of [null,
    { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } },
    { getItem: () => 'lotus', setItem() { throw new Error('quota'); } },
  ]) {
    const h = harness(storage);
    assert.equal(h.mode.enabled, false);
    h.click();
    assert.equal(h.mode.enabled, true);
    assert.equal(h.renders, 1);
    h.click();
    assert.equal(h.mode.enabled, false);
  }
});

test('Lotus redraw preserves the chart, pinned selection and ordinary render arguments', () => {
  const chart = Object.freeze({ personality: Object.freeze([61, 24]), design: Object.freeze([]) });
  const viewport = { innerHTML: '', transform: 'translate(31 -24) scale(1.7)' };
  const calls = [], state = { enabled: false, visible: false };
  let lotus;
  const graph = createGraphController({
    getChart: () => chart, getLotus: () => lotus?.mode, getMandala: () => state,
    viewport, activationPopover: { close() {}, refresh() {} }, alignHeading() {},
    renderChart(value, selection, options) { calls.push({ value, selection, options }); return ''; },
  });
  lotus = harness(null, graph.render);
  graph.choose({ type: 'gate', id: 61 });
  const baseline = calls.at(-1), selected = graph.selectionState.items;
  assert.equal(Object.hasOwn(baseline.options, 'showLotus'), false);
  lotus.click();
  const enabled = calls.at(-1);
  assert.equal(enabled.value, chart);
  assert.equal(enabled.selection, baseline.selection);
  assert.equal(graph.selectionState.items, selected);
  assert.deepEqual(enabled.options, { ...baseline.options, showLotus: true });
  state.enabled = state.visible = true;
  graph.render();
  assert.equal(calls.at(-1).options.showLotus, true, 'Mandala keeps the same preference');
  state.enabled = state.visible = false;
  lotus.click();
  assert.deepEqual(calls.at(-1).options, baseline.options);
  assert.equal(viewport.transform, 'translate(31 -24) scale(1.7)', 'the camera matrix is untouched');
});

test('the Lotus illustration is one named native switch in the chart toolbar', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const button = page.match(/<button\b[^>]*id="lotusSwitch"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(button);
  for (const attribute of ['type="button"', 'role="switch"', 'aria-checked="false"', 'aria-label="Лотос"', 'title="Лотос"', 'aria-controls="bodygraph"']) assert.ok(button.includes(attribute));
  assert.match(button, /<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.doesNotMatch(button, /tabindex="-1"/);
  assert.equal((page.match(/\bid="lotusSwitch"/g) || []).length, 1);
});
