import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceState } from '../src/state/workspace.js';

test('workspace navigation keeps one screen and notifies only real changes', () => {
  const workspace = createWorkspaceState(), changes = [];
  const stop = workspace.subscribe(screen => changes.push(screen));
  assert.equal(workspace.screen, 'chart');
  assert.equal(workspace.snapshot, 'chart');
  for (const screen of ['library', 'charts', 'account', 'chart']) {
    workspace.setScreen(screen); workspace.setScreen(screen);
    assert.equal(workspace.screen, screen); assert.equal(workspace.snapshot, screen);
  }
  assert.deepEqual(changes, ['library', 'charts', 'account', 'chart']);
  stop(); workspace.setScreen('library');
  assert.equal(changes.length, 4);
});

test('unknown navigation commands are ignored while missing or malformed snapshots return to the chart', () => {
  const workspace = createWorkspaceState();
  workspace.setScreen('charts');
  for (const value of [undefined, null, '', 'settings', {}, ['chart'], 1]) {
    workspace.setScreen(value); assert.equal(workspace.screen, 'charts');
  }
  for (const value of [undefined, null, '', 'settings', {}, ['chart'], 1]) {
    workspace.restore('account'); workspace.restore(value);
    assert.equal(workspace.screen, 'chart');
  }
  workspace.restore('library'); assert.equal(workspace.screen, 'library');
});
