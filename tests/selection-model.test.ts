import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionModel } from '../src/selection/selection-model.ts';
import { createSelectionState } from '../src/selection/selection-state.ts';
import { crossAtLongitude, type CrossSource } from '../src/domain/mandala-cross.ts';
import { GATES, getChannel } from '../src/scene/geometry/chart-geometry.ts';
import type { SelectionAction, SelectionTarget } from '../src/selection/selection-targets.ts';

type SelectionState = ReturnType<typeof createSelectionState>;
const gate = (id: number, additive = false, activation?: string): SelectionAction => ({ type: 'gate' as const, id: String(id), additive, ...(activation ? { activation } : {}) });
const cross = (longitude: number, additive = false, source: CrossSource = 'personality') => ({ type: 'mandala-cross' as const, cross: crossAtLongitude(longitude, { source }), additive });
const owned = (item: SelectionTarget): (string | number)[] => item.type === 'gate' ? [item.id]
  : item.type === 'center' ? GATES.filter(g => g.center === item.id).map(g => g.id)
    : item.type === 'channel' ? getChannel(item.id as string)?.gates || []
      : item.type === 'integration' ? [10, 20, 34, 57] : [];
const selected = (state: Pick<SelectionState, 'items'>) => [...new Set(state.items.flatMap(owned))].sort((a, b) => (a as number) - (b as number));
const assertGates = (state: Pick<SelectionState, 'items'>, gates: Iterable<number>, message?: string) => assert.deepEqual(selected(state), [...new Set(gates)].sort((a, b) => a - b), message);
const stateView = (state: SelectionState) => ({ items: state.items, primary: state.primary, activation: state.activation });
test('without crosses the wrapper keeps ordinary selection and metadata behavior identical', () => {
  const actual = createSelectionModel(), expected = createSelectionState();
  type Method = 'choose' | 'clear';
  type Action = { [K in Method]: [K, ...Parameters<SelectionState[K]>] }[Method];
  const actions: Action[] = [
    ['choose', gate(20, false, 'personality-sun')], ['choose', gate(34, true)],
    ['choose', gate(34, true)], ['choose', { type: 'center' as const, id: 'throat' }],
    ['choose', gate(20, true)], ['choose', { type: 'channel' as const, id: '1-8', additive: true }],
    ['choose', gate(46, true)],
    ['choose', gate(15, false, 'design-sun')], ['choose', gate(15, false, 'design-sun')],
    ['clear'],
  ];
  for (const [method, ...args] of actions) {
    Reflect.apply(actual[method], actual, args); Reflect.apply(expected[method], expected, args);
    assert.deepEqual(stateView(actual), stateView(expected), `${method} keeps existing state`);
    assert.deepEqual(actual.crosses, []);
  }
});

test('normal cross click pins four gates and a deeply immutable exact-angle snapshot', () => {
  const state = createSelectionModel(), value = cross(180.123456789);
  state.choose(value);
  assertGates(state, value.cross.gates);
  assert.equal(state.crosses.length, 1);
  assert.deepEqual(state.crosses[0], value.cross);
  assert.equal(state.crosses[0].longitude, 180.123456789);
  assert.equal(state.primary!.type, 'gate');
  assert.equal(state.activation, null);
  for (const object of [state.items, ...state.items, state.crosses, state.crosses[0], state.crosses[0].gates, state.crosses[0].positions, ...state.crosses[0].positions] as const) assert.ok(Object.isFrozen(object));
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
  assert.deepEqual<unknown>(state.crosses, []);
  state.choose(cross(305.7));
  state.choose(cross(305.8));
  assert.equal(state.crosses.length, 1);
  assert.equal(state.crosses[0].type, 'left-angle');
  assertGates(state, crossAtLongitude(305.8).gates);
});

test('a new nonadditive cross replaces ordinary gates and old axes', () => {
  const state = createSelectionModel();
  state.choose(gate(20, true));
  state.choose(cross(180, true));
  state.choose(cross(302));
  assertGates(state, [41, 31, 28, 27]);
  assert.equal(state.crosses.length, 1);
  assert.equal(state.crosses[0].longitude, 302);
});

test('Shift cross addition/removal has independent ownership from a separately pinned overlapping gate', () => {
  const state = createSelectionModel();
  state.choose(gate(46, false, 'personality-sun'));
  state.choose(cross(180, true));
  assertGates(state, [46, 25, 15, 10]);
  assert.equal(state.items.filter(item => item.type === 'gate' && item.id === 46).length, 1);
  assert.equal(state.items.find(item => item.id === 46)!.activation, 'personality-sun');
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
  assert.deepEqual<unknown>(state.crosses, [], 'partial cross cannot keep displaying a complete axis set');
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

test('Shift subtraction removes gate ownership from cross and explicit base gate together', () => {
  const state = createSelectionModel();
  state.choose(gate(46));
  state.choose(gate(29, true));
  state.choose(cross(180, true));
  state.choose(gate(46, true));
  assertGates(state, [29, 25, 15, 10]);
  assertGates(state, [29, 25, 15, 10]);
  assert.equal(state.crosses.length, 0, 'partial cross has no complete axes');
});

test('Shift subtraction expands an overlapping center but preserves all its other gates', () => {
  const state = createSelectionModel(), center = GATES.find(g => g.id === 46)!.center;
  state.choose({ type: 'center' as const, id: center });
  state.choose(cross(180, true));
  state.choose(gate(46, true));
  assertGates(state, GATES.filter(g => g.center === center && g.id !== 46).map(g => g.id));
  assert.equal(state.items.some(item => item.type === 'center'), false);
  assert.equal(state.crosses.length, 0);
});

test('Shift subtraction splits channel ownership without losing its other half when the cross is removed', () => {
  const state = createSelectionModel();
  state.choose({ type: 'channel' as const, id: '29-46', additive: true });
  state.choose(cross(180, true));
  state.choose(gate(46, true));
  assertGates(state, [29, 25, 15, 10]);
  assert.equal(state.items.some(item => item.type === 'channel'), false);
  assertGates(state, [29, 25, 15, 10]);
  state.choose(cross(180.1, true));
  assertGates(state, [29]);
  state.choose(gate(29, true));
  assertGates(state, []);
});

test('Shift subtraction splits integration ownership and never leaves the removed gate selected', () => {
  const state = createSelectionModel();
  state.choose({ type: 'integration' as const, id: 'integration' });
  state.choose(cross(180, true));
  state.choose(gate(10, true));
  assertGates(state, [20, 34, 57, 46, 25, 15]);
  assert.equal(state.items.some(item => item.type === 'integration'), false);
  state.choose(cross(180.1, true));
  assertGates(state, [20, 34, 57]);
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

test('malformed cross input never clears valid selection and derived values are recomputed', () => {
  const state = createSelectionModel();
  state.choose(cross(180));
  const items = state.items;
  for (const bad of [null, {}, { longitude: NaN }, { longitude: Infinity }, { longitude: '180' }, { longitude: 180, source: 'both' as const }, { longitude: 180, source: null }] as const) {
    state.choose({ type: 'mandala-cross' as const, cross: bad } as unknown as Parameters<typeof state.choose>[0]);
    assert.equal(state.items, items);
  }
  state.choose({ type: 'mandala-cross' as const, cross: { longitude: 302, source: 'personality' as const, gates: [1], type: 'wrong' as const, positions: [] } } as unknown as Parameters<typeof state.choose>[0]);
  assertGates(state, [41, 31, 28, 27]);
  assert.equal(state.crosses[0].type, 'right-angle');
});

test('clear discards cross axes, partial exclusions, expanded gates and activation metadata', () => {
  const state = createSelectionModel();
  state.choose({ type: 'channel' as const, id: '29-46' });
  state.choose(cross(180, true));
  state.choose(gate(46, true));
  state.clear();
  assert.deepEqual(stateView(state), { items: [], primary: null, activation: null });
  assert.deepEqual<unknown>(state.crosses, []);
  state.choose(gate(20, false, 'personality-sun'));
  assert.equal(state.activation, 'personality-sun');
  assertGates(state, [20]);
});

test('activation identity survives multi-item cross selection and ordinary replacement', () => {
  const state = createSelectionModel();
  state.choose(cross(180));
  state.choose(gate(20, true, 'personality-sun'));
  state.choose(cross(180.1, true));
  assertGates(state, [20]);
  assert.equal(state.activation, 'personality-sun');
  state.choose(gate(20, false, 'personality-mars'));
  assert.equal(state.activation, 'personality-mars');
  assertGates(state, [20]);
});
