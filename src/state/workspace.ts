export type WorkspaceScreen = 'chart' | 'library' | 'charts' | 'account';
export type WorkspaceState = ReturnType<typeof createWorkspaceState>;
// One owner for the central screen; chart exploration stays with its own owners.
export function createWorkspaceState() {
  const screens = new Set<WorkspaceScreen>(['chart', 'library', 'charts', 'account']);
  const listeners = new Set<(screen: WorkspaceScreen) => void>();
  let screen: WorkspaceScreen = 'chart';
  function setScreen(value: WorkspaceScreen) {
    if (!screens.has(value) || value === screen) return;
    screen = value;
    for (const listener of listeners) listener(screen);
  }
  return {
    get screen() { return screen; },
    get snapshot() { return screen; },
    setScreen,
    restore(value: unknown) { setScreen(screens.has(value as WorkspaceScreen) ? value as WorkspaceScreen : 'chart'); },
    subscribe(listener: (screen: WorkspaceScreen) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
