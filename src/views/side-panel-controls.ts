import type { PanelState } from '../state/panels.ts';

// One keyboard owner for the tab, shared by early loading and the ready app.
// Window bubbling lets calendars, card menus and dialogs consume Escape first.
export function attachPanelKeyboard(document: Document, panels: PanelState,signal?:AbortSignal) {
  const target = document.defaultView ?? document;
  target.addEventListener('keydown', (event: Event) => {
    const key = event as KeyboardEvent;
    if (key.key !== 'Escape' || key.defaultPrevented || key.isComposing || document.querySelector('dialog[open]')) return;
    const visible = (id: string) => document.getElementById(id)?.classList.contains('open');
    const side = panels.left && visible('library') ? 'left'
      : panels.right && visible('chartSummary') ? 'right' : null;
    if (!side) return;
    key.preventDefault();
    if (side === 'left') panels.setLeft(false); else panels.setRight(false);
    document.getElementById(side === 'left' ? 'openLibrary' : 'summarySwitch')?.focus({ preventScroll: true });
  },{signal});
}
