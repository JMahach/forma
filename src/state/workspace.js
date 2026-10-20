// One owner for the central screen; chart exploration stays with its own owners.
export function createWorkspaceState() {
  const screens = new Set(['chart', 'library', 'charts', 'account']);
  const listeners = new Set();
  let screen = 'chart';
  function setScreen(value) {
    if (!screens.has(value) || value === screen) return;
    screen = value;
    for (const listener of listeners) listener(screen);
  }
  return {
    get screen() { return screen; },
    get snapshot() { return screen; },
    setScreen,
    restore(value) { setScreen(screens.has(value) ? value : 'chart'); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
