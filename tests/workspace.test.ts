import type { WorkspaceScreen } from '../src/state/workspace.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceState } from '../src/state/workspace.ts';

test('workspace navigation keeps one screen and notifies only real changes', () => {
  const workspace = createWorkspaceState(), changes: WorkspaceScreen[] = [];
  const stop = workspace.subscribe(screen => changes.push(screen));
  assert.equal(workspace.screen, 'chart');
  assert.equal(workspace.snapshot, 'chart');
  for (const screen of ['knowledge', 'charts', 'account', 'chart'] as const) {
    workspace.setScreen(screen); workspace.setScreen(screen);
    assert.equal(workspace.screen, screen); assert.equal(workspace.snapshot, screen);
  }
  assert.deepEqual(changes, ['knowledge', 'charts', 'account', 'chart'] as const);
  stop(); workspace.setScreen('knowledge');
  assert.equal(changes.length, 4);
});

test('unknown navigation commands are ignored while missing or malformed snapshots return to the chart', () => {
  const workspace = createWorkspaceState();
  workspace.setScreen('charts');
  for (const value of [undefined, null, '', 'settings', {}, ['chart'], 1] as const) {
    workspace.setScreen(value as WorkspaceScreen); assert.equal(workspace.screen, 'charts');
  }
  for (const value of [undefined, null, '', 'settings', {}, ['chart'], 1] as const) {
    workspace.restore('account'); workspace.restore(value);
    assert.equal(workspace.screen, 'chart');
  }
  workspace.restore('knowledge'); assert.equal(workspace.screen, 'knowledge');
});
