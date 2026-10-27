import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibrarySelection } from '../src/state/library-selection.ts';
const ids = ['a', 'b', 'c', 'd', 'e'];

test('Shift accumulates only clicked cards; plain click replaces the group', () => {
  const selection = createLibrarySelection(); selection.sync(ids, 'a');
  assert.equal(selection.choose('d', true, 'a'), 'd'); selection.sync(ids, 'd');
  assert.equal(selection.choose('b', true, 'd'), 'b'); selection.sync(ids, 'b');
  assert.deepEqual(selection.snapshot, ['a', 'd', 'b']);
  assert.equal(selection.choose('c', false, 'b'), 'c'); selection.sync(ids, 'c');
  assert.deepEqual(selection.snapshot, ['c']);
});

test('arrows skip unselected cards in list order and stop at group boundaries', () => {
  const selection = createLibrarySelection(['e', 'a', 'c']); selection.sync(ids, 'c');
  assert.equal(selection.adjacent('c', -1), 'a');
  assert.equal(selection.adjacent('c', 1), 'e');
  assert.equal(selection.adjacent('a', -1), 'a');
  assert.equal(selection.adjacent('e', 1), 'e');
  selection.sync(ids, 'e');
  assert.deepEqual(selection.snapshot, ['e', 'a', 'c']);
  selection.sync(['c', 'a', 'e'], 'e');
  assert.equal(selection.adjacent('c', 1), 'a');
});

test('Shift deselects one card and falls back to the last remaining choice', () => {
  const selection = createLibrarySelection(['a', 'd', 'b']); selection.sync(ids, 'b');
  assert.equal(selection.choose('d', true, 'b'), 'b');
  assert.equal(selection.choose('b', true, 'b'), 'a'); selection.sync(ids, 'a');
  assert.deepEqual(selection.snapshot, ['a']);
  assert.equal(selection.choose('a', true, 'a'), null); selection.sync(ids, 'a');
  assert.deepEqual(selection.snapshot, []); assert.equal(selection.adjacent('a', 1), null);
});

test('restoration and deletion prune missing cards without changing stored records', () => {
  const selection = createLibrarySelection(['a', 'deleted', 'd', 'a']); selection.sync(ids, 'd');
  assert.deepEqual(selection.snapshot, ['a', 'd']);
  selection.sync(['a', 'b', 'c', 'e'], 'a'); assert.deepEqual(selection.snapshot, ['a']);
  selection.sync(ids, 'c'); assert.deepEqual(selection.snapshot, ['c'], 'an external chart becomes a single selection');
  selection.sync(ids, 'current-transit'); assert.deepEqual(selection.snapshot, []);
  const empty = createLibrarySelection([]); empty.sync(ids, 'a'); assert.deepEqual(empty.snapshot, []);
});
