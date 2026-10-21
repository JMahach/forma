import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelState } from '../src/state/panels.ts';

test('both panels open independently and only real changes notify consumers', () => {
  const panels = createPanelState(), changes: ReturnType<typeof createPanelState>['snapshot'][] = [];
  const stop = panels.subscribe(value => changes.push(value));
  panels.setLeft(true); panels.setRight(true); panels.setRight(true);
  assert.deepEqual(panels.snapshot, { left: true, right: true });
  assert.deepEqual(changes, [{ left: true, right: false }, { left: true, right: true }]);
  const snapshot = panels.snapshot; snapshot.left = false;
  assert.equal(panels.left, true, 'callers cannot mutate the state without notifying its consumers');
  stop(); panels.setLeft(false);
  assert.equal(changes.length, 2);
  assert.equal(panels.right, true);
});

test('restoring both sides is atomic and malformed values cannot open a panel', () => {
  const panels = createPanelState(), changes: ReturnType<typeof createPanelState>['snapshot'][] = [];
  panels.subscribe(value => changes.push(value));
  panels.restore({ left: true, right: true });
  panels.restore({ left: true, right: true });
  assert.deepEqual(changes, [{ left: true, right: true }]);
  panels.restore({ left: 'true', right: 1 } as unknown as Parameters<typeof panels.restore>[0]);
  assert.deepEqual(panels.snapshot, { left: false, right: false });
  panels.restore(null);
  assert.equal(changes.length, 2);
});


test('a manual right-panel request wins over restoration projections without extra layout notifications', () => {
  const panels = createPanelState(), changes = [];
  panels.subscribe(value => changes.push(value));
  panels.beginRestore();
  panels.restore({ left: true, right: true });
  panels.setRight(true);
  panels.setRight(false, { automatic: true });
  assert.equal(panels.right, true);
  assert.equal(panels.rightRequestDuringRestore, true);
  panels.setRight(false);
  panels.setRight(true, { automatic: true });
  assert.equal(panels.right, false);
  assert.equal(panels.rightRequestDuringRestore, false);
  assert.equal(changes.length, 2, 'request bookkeeping does not resize or re-render unchanged panels');
  panels.finishRestore();
  panels.setRight(true, { automatic: true });
  assert.equal(panels.right, true, 'new returns commands work normally after restoration');
  assert.equal(panels.rightRequestDuringRestore, null);
});


for (const opened of [false, true] as const) {
  test(`early panel commands survive another restore start and saved values (opened: ${opened})`, () => {
    const panels = createPanelState(), changes = [];
    panels.restore({ left: !opened, right: !opened });
    panels.beginRestore();
    panels.subscribe(value => changes.push(value));
    panels.setLeft(opened); panels.setRight(opened);
    panels.beginRestore();
    panels.restore({ left: !opened, right: !opened });
    panels.setRight(!opened, { automatic: true });
    assert.deepEqual(panels.snapshot, { left: opened, right: opened });
    assert.equal(panels.rightRequestDuringRestore, opened);
    assert.equal(changes.length, 2, 'the later restore cannot undo commands or cause another layout change');
  });
}

test('a left command protects only the left side while saved and automatic right changes remain available', () => {
  const panels = createPanelState();
  panels.beginRestore();
  panels.setLeft(true);
  panels.setRight(true, { automatic: true });
  panels.beginRestore();
  panels.restore({ left: false, right: false });
  assert.deepEqual(panels.snapshot, { left: true, right: false });
  panels.setRight(true, { automatic: true });
  assert.deepEqual(panels.snapshot, { left: true, right: true });
  assert.equal(panels.rightRequestDuringRestore, null);
});

test('a right command does not pin the left side and the latest explicit request wins', () => {
  const panels = createPanelState();
  panels.beginRestore();
  panels.setRight(true); panels.setRight(false);
  panels.restore({ left: true, right: true });
  assert.deepEqual(panels.snapshot, { left: true, right: false });
  panels.setLeft(false); panels.setLeft(true);
  panels.restore({ left: false, right: true });
  assert.deepEqual(panels.snapshot, { left: true, right: false });
});

test('finishing restoration releases both explicit requests for normal and later restores', () => {
  const panels = createPanelState();
  panels.beginRestore();
  panels.setLeft(true); panels.setRight(true);
  panels.finishRestore();
  assert.equal(panels.restoring, false);
  assert.equal(panels.rightRequestDuringRestore, null);
  panels.restore({ left: false, right: false });
  assert.deepEqual(panels.snapshot, { left: false, right: false });
  panels.beginRestore();
  panels.restore({ left: true, right: true });
  panels.restore({ left: false, right: false });
  assert.deepEqual(panels.snapshot, { left: false, right: false }, 'a later restore has no stale requests');
});


test('exclusive panels switch sides atomically while desktop mode remains independent', () => {
  const panels = createPanelState(), changes: ReturnType<typeof createPanelState>['snapshot'][] = [];
  panels.setExclusive(true);
  panels.subscribe(value => changes.push(value));
  panels.setLeft(true);
  panels.setRight(true);
  panels.setLeft(true);
  panels.setLeft(false);
  assert.deepEqual(changes, [
    { left: true, right: false },
    { left: false, right: true },
    { left: true, right: false },
    { left: false, right: false },
  ]);
  panels.setExclusive(false);
  panels.setLeft(true); panels.setRight(true);
  assert.deepEqual(panels.snapshot, { left: true, right: true });
});

test('entering exclusive mode chooses the last explicit opening and does not resurrect a hidden panel on exit', () => {
  const panels = createPanelState(), changes: ReturnType<typeof createPanelState>['snapshot'][] = [];
  panels.setLeft(true); panels.setRight(true);
  panels.subscribe(value => changes.push(value));
  panels.setExclusive(true);
  panels.setExclusive(true);
  assert.deepEqual(panels.snapshot, { left: false, right: true });
  panels.setExclusive(false);
  assert.deepEqual(changes, [{ left: false, right: true }]);
  panels.setLeft(true);
  panels.setExclusive(true);
  assert.deepEqual(panels.snapshot, { left: true, right: false });
});

test('restoring two saved panels in exclusive mode uses the left panel when neither was explicitly chosen', () => {
  const panels = createPanelState(), changes: ReturnType<typeof createPanelState>['snapshot'][] = [];
  panels.setExclusive(true);
  panels.subscribe(value => changes.push(value));
  panels.restore({ left: true, right: true });
  panels.restore({ left: true, right: true });
  assert.deepEqual(changes, [{ left: true, right: false }]);
  panels.restore({ left: false, right: true });
  assert.deepEqual(panels.snapshot, { left: false, right: true });
  panels.restore(null);
  assert.deepEqual(panels.snapshot, { left: false, right: false });
});

for (const side of ['left', 'right'] as const) {
  test(`early exclusive ${side} opening and closing cannot revive the other saved panel`, () => {
    const panels = createPanelState(), changes = [];
    const set = (value: boolean) => side === 'left' ? panels.setLeft(value) : panels.setRight(value);
    panels.setExclusive(true);
    panels.beginRestore();
    panels.restore({ left: side !== 'left', right: side !== 'right' });
    panels.subscribe(value => changes.push(value));
    set(true);
    panels.beginRestore();
    panels.restore({ left: true, right: true });
    panels.setRight(true, { automatic: true });
    assert.deepEqual(panels.snapshot, { left: side === 'left', right: side === 'right' });
    assert.equal(changes.length, 1, 'only the explicit switch changes the visible panel');
    set(false);
    panels.restore({ left: true, right: true });
    panels.setRight(true, { automatic: true });
    assert.deepEqual(panels.snapshot, { left: false, right: false });
    assert.equal(changes.length, 2, 'closing the chosen sheet keeps both sheets closed through restoration');
    panels.finishRestore();
    panels.setRight(true, { automatic: true });
    assert.deepEqual(panels.snapshot, { left: false, right: true });
  });
}

test('a later explicit selection replaces the first exclusive selection during restoration', () => {
  const panels = createPanelState();
  panels.setExclusive(true);
  panels.beginRestore();
  panels.setLeft(true); panels.setRight(true);
  panels.restore({ left: true, right: false });
  assert.deepEqual(panels.snapshot, { left: false, right: true });
  panels.setLeft(true);
  panels.restore({ left: false, right: true });
  assert.deepEqual(panels.snapshot, { left: true, right: false });
  assert.equal(panels.rightRequestDuringRestore, false, 'return restoration sees the explicit choice to close the right sheet');
});


test('switching to exclusive mode during restoration keeps an earlier explicit choice after it closes', () => {
  const panels = createPanelState();
  panels.beginRestore();
  panels.restore({ left: true, right: true });
  panels.setLeft(true);
  panels.setExclusive(true);
  panels.setRight(true, { automatic: true });
  assert.deepEqual(panels.snapshot, { left: true, right: false });
  panels.setLeft(false);
  panels.restore({ left: true, right: true });
  assert.deepEqual(panels.snapshot, { left: false, right: false });
});


test('late automatic return projection cannot replace a chosen phone menu', () => {
  const panels = createPanelState();
  panels.setExclusive(true);
  panels.setRight(true);
  panels.setLeft(true);
  panels.setRight(true, { automatic: true });
  assert.deepEqual(panels.snapshot, { left: true, right: false });
  panels.setRight(true);
  assert.deepEqual(panels.snapshot, { left: false, right: true }, 'an explicit right opening still switches the sheet');
  panels.setExclusive(false);
  panels.setLeft(true);
  panels.setRight(true, { automatic: true });
  assert.deepEqual(panels.snapshot, { left: true, right: true }, 'desktop panels stay independent');
});
