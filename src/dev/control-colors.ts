// Temporary stand controls. Accepted section colours live in public/styles.css.
import { isDevelopmentPort } from '../../shared/development.ts';
import { standConnection } from './stand-connection.ts';
import { createCalculationPreview } from './calculation-preview.ts';
export { createStandConnection, standConnection } from './stand-connection.ts';
export type { StandConnection } from './stand-connection.ts';
import type { StandConnection } from './stand-connection.ts';

export let standTransport: {connection: typeof standConnection; fetch: typeof globalThis.fetch} | null = null;

if (typeof location !== 'undefined' && isDevelopmentPort(location.port)) {
  // Keep the stand mode across reloads, alongside the existing menu expansion.
  const storageKey = 'forma.control-colors.v1';
  const calculation = createCalculationPreview(undefined, () => Boolean(document.querySelector<HTMLDialogElement>('#chartDialog')?.open));
  let expanded = false;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    expanded = Boolean(saved?.expanded);
    calculation.setWaiting(saved?.calculation === 'waiting');
    const requested = saved?.connection ?? new URL(location.href).searchParams.get('connection');
    if (requested === 'offline' || requested === 'server') standConnection.set(requested);
  } catch {}
  standTransport = {connection: standConnection, fetch: calculation.fetch};
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
    try { sessionStorage.setItem(storageKey, JSON.stringify({ expanded: !group.hidden, connection: mode, ...(calculation.waiting ? {calculation:'waiting'} : {}) })); } catch {}
  });
  group.append(connection);
  const calculationLabel = document.createElement('label');
  calculationLabel.className = 'stand-calculation-setting'; calculationLabel.textContent = 'Расчёт';
  const calculationChoice = document.createElement('select');
  calculationChoice.id = 'calculationPreviewMode'; calculationChoice.setAttribute('aria-label', 'Режим расчёта');
  calculationChoice.innerHTML = '<option value="ordinary">Обычный</option><option value="waiting">Ожидание</option>';
  calculationChoice.value = calculation.waiting ? 'waiting' : 'ordinary';
  calculationChoice.addEventListener('change', () => { calculation.setWaiting(calculationChoice.value === 'waiting'); remember(); });
  calculationLabel.append(calculationChoice); group.append(calculationLabel);
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.id = 'toggleControlColors'; toggle.className = 'sidebar-tool'; toggle.textContent = 'Палитры';
  toggle.setAttribute('aria-controls', group.id);
  function remember() {
    toggle.setAttribute('aria-expanded', String(!group.hidden)); toggle.setAttribute('aria-pressed', String(!group.hidden));
    try { sessionStorage.setItem(storageKey, JSON.stringify({ expanded: !group.hidden, connection: standConnection.current, ...(calculation.waiting ? {calculation:'waiting'} : {}) })); } catch {}
  }
  toggle.addEventListener('click', () => { group.hidden = !group.hidden; remember(); });
  const footer = document.querySelector<HTMLElement>('.sidebar-footer');
  footer?.prepend(group);
  footer?.insertBefore(toggle, footer.querySelector('#randomChartButton'));
  remember();
}
