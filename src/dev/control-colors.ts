// Temporary stand controls. Accepted section colours live in public/styles.css.
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

if (typeof location !== 'undefined' && location.port === '3636') {
  // Keep only the existing menu expansion, discarding retired colour trials.
  const storageKey = 'forma.control-colors.v1';
  let expanded = false;
  try { expanded = Boolean(JSON.parse(sessionStorage.getItem(storageKey) || 'null')?.expanded); } catch {}
  const style = document.createElement('style');
  style.textContent = `
    .control-color-previews { display: flex; flex-wrap: wrap; gap: 8px; flex: 0 0 100%; margin: 4px 0 8px; }
    .stand-connection-options { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: 5px; width: 100%; }
    .stand-connection-options button { min-width: 0; min-height: 32px; padding: 5px 7px; border: 1px solid var(--panel-border); border-radius: 6px; background: transparent; color: var(--panel-ink); font: 11px/16px var(--sans); touch-action: manipulation; }
    .stand-connection-options button[aria-pressed='true'] { border-color: var(--panel-muted); background: var(--panel-surface, #f2f0e9); box-shadow: inset 0 0 0 1px var(--panel-muted); }
    .stand-connection-options button:focus-visible { outline: 1px dashed var(--panel-ink); outline-offset: 3px; }
    @media (hover: hover) and (pointer: fine) { .stand-connection-options button:hover { border-color: var(--panel-muted); } }
  `;
  document.head.append(style);
  const group = document.createElement('div');
  group.className = 'control-color-previews'; group.id = 'controlColorPreviews'; group.hidden = !expanded;
  const connection = document.createElement('div');
  connection.className = 'stand-connection-options'; connection.setAttribute('role', 'group'); connection.setAttribute('aria-label', 'Соединение');
  connection.innerHTML = '<button type="button" data-connection="online">Всё ок</button><button type="button" data-connection="offline">Нет сети</button><button type="button" data-connection="server">Сервер не отвечает</button>';
  connection.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-connection]');
    if (button) standConnection.set(button.dataset.connection as StandConnection);
  });
  standConnection.subscribe(mode => {
    connection.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.connection === mode)));
    document.documentElement.dataset.standConnection = mode;
  });
  group.append(connection);
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.id = 'toggleControlColors'; toggle.className = 'sidebar-tool'; toggle.textContent = 'Палитры';
  toggle.setAttribute('aria-controls', group.id);
  function remember() {
    toggle.setAttribute('aria-expanded', String(!group.hidden)); toggle.setAttribute('aria-pressed', String(!group.hidden));
    try { sessionStorage.setItem(storageKey, JSON.stringify({ expanded: !group.hidden })); } catch {}
  }
  toggle.addEventListener('click', () => { group.hidden = !group.hidden; remember(); });
  const footer = document.querySelector<HTMLElement>('.sidebar-footer');
  footer?.prepend(group); footer?.append(toggle); remember();
}
