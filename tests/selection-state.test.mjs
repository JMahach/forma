import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionState } from '../src/selection/selection-state.js';

test('selection snapshots cannot be mutated by their consumers', () => {
  const state = createSelectionState();
  const input = { type: 'gate', id: '20', activation: 'personality-sun' };
  state.choose(input);
  const items = state.items, primary = state.primary;
  assert.equal(state.items, items);
  assert.equal(state.primary, primary, 'reads preserve focus/hover reference stability');
  assert.throws(() => items.push({ type: 'gate', id: 34 }), TypeError);
  assert.throws(() => { items[0].id = 34; }, TypeError);
  assert.throws(() => { primary.id = 34; }, TypeError);
  assert.equal(Object.isFrozen(input), false, 'the caller does not surrender ownership of input events');
  input.id = '34';
  assert.deepEqual(state.items, [{ type: 'gate', id: 20, activation: 'personality-sun' }]);
  state.choose({ type: 'gate', id: 34, additive: true });
  assert.deepEqual(items, [{ type: 'gate', id: 20, activation: 'personality-sun' }], 'earlier snapshots remain intact');
  assert.deepEqual(state.primary, { type: 'gate', id: 34 });
  state.clear();
  assert.deepEqual(state.items, []);
  assert.equal(state.primary, null);
  assert.equal(state.activation, null);
});
