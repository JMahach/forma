import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBodygraph } from '../src/bodygraph/bodygraph.js';
import { createSummarySelectionState } from '../src/selection/summary-selection-state.js';
import { GATES } from '../src/bodygraph/graph-data.js';
import { createMandalaSelectionState } from '../src/selection/mandala-selection-state.js';
import { crossAtLongitude } from '../src/bodygraph/mandala-cross.js';

const chart = { id: 'test', personality: [20, 34, 10], design: [57, 20] };
const gate = id => ({ type: 'gate', id: String(id) });
const cell = (svg, id) => svg.match(new RegExp(`<g class="mandala-gate bg-interactive"[^>]*data-id="${id}"[^>]*>`))?.[0];

test('mandala is opt-in and stays beneath all existing channels, centers and activations', () => {
  const plain = renderBodygraph(chart), wheel = renderBodygraph(chart, null, { showMandala: true });
  assert.doesNotMatch(plain, /bodygraph-mandala|mandala-core|mandala-underlay/);
  assert.ok(wheel.indexOf('class="bodygraph-mandala"') < wheel.indexOf('class="bodygraph-drawing'));
  const corePaths = markup => markup.slice(markup.indexOf('<g class="bodygraph-channels">')).match(/<path\b[^>]*>/g);
  assert.deepEqual(corePaths(wheel), corePaths(plain), 'physical geometry and masks are never rewritten');
  assert.match(wheel, /class="mandala-core" transform="translate\(320 398\) scale\(\.84\) translate\(-320 -398\)"/);
  assert.ok(wheel.indexOf('class="mandala-core"') < wheel.indexOf('class="mandala-underlay"'));
  assert.ok(wheel.indexOf('class="mandala-underlay"') < wheel.indexOf('class="bodygraph-channels"'));
});

test('a pinned cross retains all four wheel and bodygraph gates and exact axes after the preview ends', () => {
  const state = createMandalaSelectionState(), cross = crossAtLongitude(355);
  state.choose({ type: 'mandala-cross', cross });
  const options = { showMandala: true, selections: state.items, pinnedCrosses: state.crosses };
  const wheel = renderBodygraph(chart, state.primary, options);
  assert.equal((wheel.match(/class="mandala-cross-pinned"/g) || []).length, 1);
  assert.doesNotMatch(wheel, /class="mandala-cross-preview"/);
  for (const id of cross.gates) {
    assert.match(cell(wheel, id), /aria-pressed="true"/);
    const bodyGate = [...wheel.slice(wheel.indexOf('<g class="bodygraph-gates">')).matchAll(/<g\b[^>]*>/g)].map(match => match[0]).find(tag => tag.includes(`data-id="${id}"`));
    assert.match(bodyGate, /aria-pressed="true"/);
  }
  for (const p of cross.positions) assert.ok(wheel.includes(`data-longitude="${p.longitude}"`));
  const preview = crossAtLongitude(305.7);
  const hovering = renderBodygraph(chart, state.primary, { ...options, previewSelection: { type: 'mandala-cross', cross: preview } });
  assert.match(hovering, /class="mandala-cross-pinned"/);
  assert.match(hovering, /class="mandala-cross-preview"/);
  assert.equal(renderBodygraph(chart, state.primary, options), wheel, 'ending another preview restores exactly the committed cross');
  const duplicate = renderBodygraph(chart, state.primary, { ...options, previewSelection: { type: 'mandala-cross', cross } });
  assert.equal((duplicate.match(/class="mandala-cross-position"/g) || []).length, 4, 'the same exact axes are not painted twice');
});

test('Shift cross addition and removal retain shared gates and only the remaining cross axes', () => {
  const state = createMandalaSelectionState();
  const first = crossAtLongitude(305.7), second = crossAtLongitude(305.9);
  state.choose({ type: 'mandala-cross', cross: first });
  state.choose({ type: 'mandala-cross', cross: second, additive: true });
  const both = renderBodygraph(chart, state.primary, { showMandala: true, selections: state.items, pinnedCrosses: state.crosses });
  assert.equal((both.match(/class="mandala-cross-pinned"/g) || []).length, 2);
  state.choose({ type: 'mandala-cross', cross: first, additive: true });
  const remaining = renderBodygraph(chart, state.primary, { showMandala: true, selections: state.items, pinnedCrosses: state.crosses });
  assert.equal((remaining.match(/class="mandala-cross-pinned"/g) || []).length, 1);
  for (const id of second.gates) assert.match(cell(remaining, id), /aria-pressed="true"/);
  state.choose({ type: 'gate', id: second.gates[0], additive: true });
  const partial = renderBodygraph(chart, state.primary, { showMandala: true, selections: state.items, pinnedCrosses: state.crosses });
  assert.doesNotMatch(partial, /class="mandala-cross-pinned"/);
  assert.match(cell(partial, second.gates[0]), /aria-pressed="false"/);
});

test('wheel reuses gate and Shift state while preview never changes the pinned selection', () => {
  const state = createSummarySelectionState();
  state.choose(gate(20));
  state.choose({ ...gate(34), additive: true });
  const before = JSON.stringify(state.items);
  const wheel = renderBodygraph(chart, state.primary, { showMandala: true, selections: state.items, previewSelection: gate(57) });
  for (const id of [20, 34]) assert.match(cell(wheel, id), /aria-pressed="true"/);
  assert.match(cell(wheel, 57), /data-related="true"/);
  assert.match(cell(wheel, 57), /aria-pressed="false"/);
  assert.equal(JSON.stringify(state.items), before);
  assert.equal((wheel.match(/class="mandala-focus-sector"/g) || []).length, 3);
  state.choose({ ...gate(34), additive: true });
  const reduced = renderBodygraph(chart, state.primary, { showMandala: true, selections: state.items });
  assert.match(cell(reduced, 20), /aria-pressed="true"/);
  assert.match(cell(reduced, 34), /aria-pressed="false"/);
  assert.match(cell(reduced, 57), /data-related="false"/);
});

test('whole-center selection lights exactly the same gates on the wheel', () => {
  const state = createSummarySelectionState();
  state.choose({ type: 'center', id: 'throat' });
  const svg = renderBodygraph(chart, state.primary, { showMandala: true, selections: state.items });
  for (const { id, center } of GATES) {
    assert.match(cell(svg, id), new RegExp(`aria-pressed="${center === 'throat'}"`));
  }
});
