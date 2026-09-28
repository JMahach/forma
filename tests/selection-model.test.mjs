import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionModel } from '../src/selection/selection-model.js';
import { createSummarySelectionState } from '../src/selection/summary-selection-state.js';
import { crossAtLongitude } from '../src/domain/mandala-cross.js';
import { GATES, getChannel } from '../src/scene/geometry/chart-geometry.js';

const gate = (id, additive = false, activation) => ({ type: 'gate', id: String(id), additive, ...(activation ? { activation } : {}) });
const cross = (longitude, additive = false, source = 'personality') => ({ type: 'mandala-cross', cross: crossAtLongitude(longitude, { source }), additive });
const owned = item => item.type === 'gate' ? [item.id]
  : item.type === 'center' ? GATES.filter(g => g.center === item.id).map(g => g.id)
    : item.type === 'channel' ? getChannel(item.id)?.gates || []
      : item.type === 'integration' ? [10, 20, 34, 57] : [];
const selected = state => [...new Set(state.items.flatMap(owned))].sort((a, b) => a - b);
const assertGates = (state, gates) => assert.deepEqual(selected(state), [...new Set(gates)].sort((a, b) => a - b));
const stateView = state => ({ items: state.items, primary: state.primary, activation: state.activation, activationFilter: state.activationFilter });
const lineFilter = { line: 2, source: 'design' };
const chart = (gates = [46, 29, 8]) => ({
  source: 'calculated', personality: [20], design: gates,
  activations: { design: gates.map((gate, i) => ({ planet: ['sun', 'earth', 'moon'][i], gate, line: 2 })), personality: [] },
});

test('without crosses the wrapper keeps ordinary selection, metadata, effects and line-group behavior identical', () => {
  const actual = createSelectionModel(), expected = createSummarySelectionState();
  const actions = [
    ['choose', gate(20, false, 'personality-sun')], ['choose', gate(34, true)],
    ['choose', gate(34, true)], ['choose', { type: 'center', id: 'throat' }],
    ['choose', gate(20, true)], ['choose', { type: 'channel', id: '1-8', additive: true }],
    ['chooseSummary', [46, 29, 8], lineFilter, { additive: true }],
    ['choose', gate(46, true)], ['refresh', chart([46, 29, 10])],
    ['chooseSummary', [46, 29, 10], lineFilter, { additive: true }],
    ['choose', gate(15, false, 'design-sun')], ['choose', gate(15, false, 'design-sun')],
    ['clear'],
  ];
  for (const [method, ...args] of actions) {
    assert.deepEqual(actual[method](...args), expected[method](...args), `${method} returns existing effects`);
    assert.deepEqual(stateView(actual), stateView(expected), `${method} keeps existing state`);
    assert.deepEqual(actual.crosses, []);
  }
});

test('normal cross click pins four gates and a deeply immutable exact-angle snapshot', () => {
  const state = createSelectionModel(), value = cross(180.123456789);
  assert.deepEqual(state.choose(value), { popoverActivation: null });
  assertGates(state, value.cross.gates);
  assert.equal(state.crosses.length, 1);
  assert.deepEqual(state.crosses[0], value.cross);
  assert.equal(state.crosses[0].longitude, 180.123456789);
  assert.equal(state.primary.type, 'gate');
  assert.equal(state.activation, null);
  for (const object of [state.items, ...state.items, state.crosses, state.crosses[0], state.crosses[0].gates, state.crosses[0].positions, ...state.crosses[0].positions]) assert.ok(Object.isFrozen(object));
  value.cross.positions[0].gate = 64;
  value.cross.gates.push(1);
  assert.equal(state.crosses[0].positions[0].gate, 46);
  assert.equal(state.crosses[0].gates.length, 4);
});

test('same category and ordered quartet toggle off despite small cursor drift; a different category replaces it', () => {
  const state = createSelectionModel();
  state.choose(cross(180));
  state.choose(cross(180.1));
  assertGates(state, []);
  assert.deepEqual(state.crosses, []);
  state.choose(cross(305.7));
  state.choose(cross(305.8));
  assert.equal(state.crosses.length, 1);
  assert.equal(state.crosses[0].type, 'left-angle');
  assertGates(state, crossAtLongitude(305.8).gates);
});

test('a new nonadditive cross replaces ordinary gates, line groups and old axes', () => {
  const state = createSelectionModel();
  state.chooseSummary([46, 29], lineFilter);
  state.choose(gate(20, true));
  state.choose(cross(180, true));
  state.choose(cross(302));
  assertGates(state, [41, 31, 28, 27]);
  assert.equal(state.crosses.length, 1);
  assert.equal(state.crosses[0].longitude, 302);
  assert.equal(state.activationFilter, null);
});

test('Shift cross addition/removal has independent ownership from a separately pinned overlapping gate', () => {
  const state = createSelectionModel();
  state.choose(gate(46, false, 'personality-sun'));
  state.choose(cross(180, true));
  assertGates(state, [46, 25, 15, 10]);
  assert.equal(state.items.filter(item => item.type === 'gate' && item.id === 46).length, 1);
  assert.equal(state.items.find(item => item.id === 46).activation, 'personality-sun');
  state.choose(cross(180.1, true));
  assertGates(state, [46]);
  assert.equal(state.activation, 'personality-sun');
  assert.equal(state.crosses.length, 0);
});

test('two overlapping Shift crosses preserve each other when either group is toggled off', () => {
  const state = createSelectionModel();
  state.choose(cross(180));
  state.choose(cross(182, true));
  assertGates(state, [46, 25, 15, 10, 52, 58]);
  assert.equal(state.crosses.length, 2);
  state.choose(cross(180.1, true));
  assertGates(state, [46, 25, 52, 58]);
  assert.equal(state.crosses.length, 1);
  assert.equal(state.crosses[0].longitude, 182);
  state.choose(cross(182.1, true));
  assertGates(state, []);
});

test('Shift subtraction removes a cross-only gate rather than accidentally adding a base gate', () => {
  const state = createSelectionModel();
  state.choose(cross(180));
  state.choose(gate(46, true));
  assertGates(state, [25, 15, 10]);
  assert.deepEqual(state.crosses, [], 'partial cross cannot keep displaying a complete axis set');
  state.choose(cross(180.1, true));
  assertGates(state, []);
  assert.equal(state.crosses.length, 0);
});

test('Shift subtraction affects every overlapping cross; readding the gate restores original exact axes', () => {
  const state = createSelectionModel();
  state.choose(cross(180.123));
  state.choose(cross(182.234, true));
  const saved = state.crosses;
  state.choose(gate(46, true));
  assertGates(state, [25, 15, 10, 52, 58]);
  assert.equal(state.crosses.length, 0);
  state.choose(gate(46, true));
  assertGates(state, [46, 25, 15, 10, 52, 58]);
  assert.deepEqual(state.crosses, saved);
  state.choose(cross(180.1, true));
  state.choose(cross(182.1, true));
  assertGates(state, [46], 'explicit re-add owns the gate independently of the crosses');
});

test('Shift subtraction removes gate ownership from cross, explicit base gate, and line group together', () => {
  const state = createSelectionModel();
  state.choose(gate(46));
  state.chooseSummary([46, 29], lineFilter, { additive: true });
  state.choose(cross(180, true));
  state.choose(gate(46, true));
  assertGates(state, [29, 25, 15, 10]);
  assert.deepEqual(state.activationFilter.groups[0].gates, [29]);
  assert.equal(state.activationFilter.unfilteredGates.includes(46), false);
  state.refresh(chart([46, 29]));
  assertGates(state, [29, 25, 15, 10]);
  assert.equal(state.crosses.length, 0, 'refresh never resurrects an explicitly excluded gate');
});

test('Shift subtraction expands an overlapping center but preserves all its other gates', () => {
  const state = createSelectionModel(), center = GATES.find(g => g.id === 46).center;
  state.choose({ type: 'center', id: center });
  state.choose(cross(180, true));
  state.choose(gate(46, true));
  assertGates(state, GATES.filter(g => g.center === center && g.id !== 46).map(g => g.id));
  assert.equal(state.items.some(item => item.type === 'center'), false);
  assert.equal(state.crosses.length, 0);
});

test('Shift subtraction splits channel ownership without losing its other half when an overlapping line group is removed', () => {
  const state = createSelectionModel();
  state.chooseSummary([29], lineFilter);
  state.choose({ type: 'channel', id: '29-46', additive: true });
  state.choose(cross(180, true));
  state.choose(gate(46, true));
  assertGates(state, [29, 25, 15, 10]);
  assert.equal(state.items.some(item => item.type === 'channel'), false);
  state.chooseSummary([29], lineFilter, { additive: true });
  assertGates(state, [29, 25, 15, 10]);
  state.choose(cross(180.1, true));
  assertGates(state, [29]);
  state.choose(gate(29, true));
  assertGates(state, []);
});

test('Shift subtraction splits integration ownership and never leaves the removed gate selected', () => {
  const state = createSelectionModel();
  state.choose({ type: 'integration', id: 'integration' });
  state.choose(cross(180, true));
  state.choose(gate(10, true));
  assertGates(state, [20, 34, 57, 46, 25, 15]);
  assert.equal(state.items.some(item => item.type === 'integration'), false);
  state.choose(cross(180.1, true));
  assertGates(state, [20, 34, 57]);
});

test('line groups remain exact while full cross gates extend the unfiltered activation selection', () => {
  const state = createSelectionModel();
  state.chooseSummary([46, 29], lineFilter);
  state.choose(gate(20, true));
  state.choose(cross(180, true));
  assert.deepEqual(state.activationFilter.groups, [{ ...lineFilter, gates: [46, 29] }]);
  assert.deepEqual(new Set(state.activationFilter.unfilteredGates), new Set([20, 46, 25, 15, 10]));
  assert.ok(Object.isFrozen(state.activationFilter));
  assert.ok(Object.isFrozen(state.activationFilter.unfilteredGates));
  state.choose(cross(180.1, true));
  assert.deepEqual(state.activationFilter.unfilteredGates, [20]);
  assertGates(state, [46, 29, 20]);
});

test('additive summary selections preserve pinned crosses, and nonadditive summary selections replace them', () => {
  const state = createSelectionModel();
  state.choose(cross(180));
  state.chooseSummary([8, 29], lineFilter, { additive: true });
  assertGates(state, [46, 25, 15, 10, 8, 29]);
  assert.equal(state.crosses.length, 1);
  state.chooseSummary([8, 29], lineFilter);
  assertGates(state, [8, 29]);
  assert.equal(state.crosses.length, 0);
  assert.deepEqual(state.activationFilter.unfilteredGates, []);
});

test('normal gate selection replaces all cross state instead of toggling a hidden single base gate', () => {
  const state = createSelectionModel();
  state.choose(gate(20));
  state.choose(cross(180, true));
  state.choose(gate(20));
  assertGates(state, [20]);
  assert.equal(state.crosses.length, 0);
  state.choose(gate(20));
  assertGates(state, []);
});

test('summary refresh updates only line gates while pinned cross positions and no-op identities stay stable', () => {
  const state = createSelectionModel();
  state.chooseSummary([46, 29], lineFilter);
  state.choose(cross(180.123, true));
  const originalCross = state.crosses[0];
  state.refresh(chart([8, 29]));
  assertGates(state, [8, 29, 46, 25, 15, 10]);
  assert.equal(state.crosses[0], originalCross);
  const items = state.items, crosses = state.crosses, filter = state.activationFilter;
  state.refresh(chart([8, 29]));
  assert.equal(state.items, items);
  assert.equal(state.crosses, crosses);
  assert.equal(state.activationFilter, filter);
});

test('malformed cross or summary input never clears valid selection and derived values are recomputed', () => {
  const state = createSelectionModel();
  state.choose(cross(180));
  const items = state.items;
  for (const bad of [null, {}, { longitude: NaN }, { longitude: Infinity }, { longitude: '180' }, { longitude: 180, source: 'both' }, { longitude: 180, source: null }]) {
    assert.deepEqual(state.choose({ type: 'mandala-cross', cross: bad }), { popoverActivation: null });
    assert.equal(state.items, items);
  }
  state.chooseSummary([20], { line: 7, source: 'design' });
  assert.equal(state.items, items);
  state.chooseSummary(null, lineFilter);
  assert.equal(state.items, items);
  state.choose({ type: 'mandala-cross', cross: { longitude: 302, source: 'personality', gates: [1], type: 'wrong', positions: [] } });
  assertGates(state, [41, 31, 28, 27]);
  assert.equal(state.crosses[0].type, 'right-angle');
});

test('clear discards cross axes, partial exclusions, expanded gates, line filters and activation metadata', () => {
  const state = createSelectionModel();
  state.choose({ type: 'channel', id: '29-46' });
  state.chooseSummary([8], lineFilter, { additive: true });
  state.choose(cross(180, true));
  state.choose(gate(46, true));
  state.clear();
  assert.deepEqual(stateView(state), { items: [], primary: null, activation: null, activationFilter: null });
  assert.deepEqual(state.crosses, []);
  assert.deepEqual(state.choose(gate(20, false, 'personality-sun')), { popoverActivation: 'personality-sun' });
});

test('activation popovers remain suppressed for any multi-item cross selection', () => {
  const state = createSelectionModel();
  state.choose(cross(180));
  assert.deepEqual(state.choose(gate(20, true, 'personality-sun')), { popoverActivation: null });
  state.choose(cross(180.1, true));
  assertGates(state, [20]);
  assert.equal(state.activation, 'personality-sun');
  assert.deepEqual(state.choose(gate(20, false, 'personality-mars')), { popoverActivation: 'personality-mars' });
});
