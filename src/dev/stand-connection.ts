export type StandConnection = 'online' | 'offline' | 'server';

export function createStandConnection() {
  let current: StandConnection = 'online';
  const listeners = new Set<(mode: StandConnection) => void>();
  return {
    get current() { return current; },
    set(mode: StandConnection) {
      if (mode === current) return;
      current = mode;
      for (const listener of listeners) listener(mode);
    },
    subscribe(listener: (mode: StandConnection) => void) {
      listeners.add(listener);
      listener(current);
      return () => { listeners.delete(listener); };
    },
  };
}
export const standConnection = createStandConnection();
