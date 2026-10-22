import type { PanelState } from '../state/panels.ts';
import { createPanelState } from '../state/panels.ts';

interface SummaryOptions {
  panels?: PanelState; initialReturnsVisible?: boolean;
  panel: HTMLElement; summaryScreen: HTMLElement; returnsPanel: HTMLElement;
  switcher: HTMLButtonElement; backdrop: HTMLElement | null;
  returnsButton?: HTMLButtonElement | null; onReturns?: () => void;
  onOpen?: () => void; onClose?: () => void; isAvailable?: () => boolean;
}
export type ChartSummaryPanel = ReturnType<typeof attachChartSummary>;

export function attachChartSummary({ panels = createPanelState(), initialReturnsVisible = false, panel, summaryScreen, returnsPanel, switcher, backdrop, returnsButton = null, onReturns = () => {}, onOpen = () => {}, onClose = () => {}, isAvailable = () => true }: SummaryOptions) {
  const document = panel.ownerDocument;
  const summaryLabel = panel.getAttribute('aria-labelledby');
  let returnsVisible = initialReturnsVisible;
  let appliedScreen: 'closed' | 'summary' | 'returns' | null = null;
  const summaryFocus = () => returnsButton && !returnsButton.hidden && !returnsButton.disabled ? returnsButton : switcher;
  const screen = () => isAvailable() && panels.right ? (returnsVisible ? 'returns' : 'summary') : 'closed';
  function layout() {
    // Camera callbacks read only this cheap projection, never cycle results.
    const next = screen();
    if (appliedScreen === next) return;
    const previous = appliedScreen;
    if (next === 'closed' && panel.contains(document.activeElement)) switcher.focus({ preventScroll: true });
    appliedScreen = next;
    const opened = next !== 'closed';
    // Retain the last screen and its placement throughout the closing slide.
    // The shell becomes inaccessible immediately, without erasing its contents.
    if (opened || previous === null) {
      const shown = opened ? next : returnsVisible ? 'returns' : 'summary';
      panel.dataset.screen = shown;
      if (summaryScreen) summaryScreen.hidden = shown !== 'summary';
      if (returnsPanel) returnsPanel.hidden = shown !== 'returns';
      const label = shown === 'returns' ? returnsPanel?.getAttribute('aria-labelledby') : summaryLabel;
      if (label) panel.setAttribute('aria-labelledby', label);
    }
    panel.hidden = false;
    panel.inert = !opened;
    panel.classList.toggle('open', opened);
    panel.setAttribute('aria-hidden', String(!opened));
    switcher.setAttribute('aria-expanded', String(opened));
    if (backdrop) backdrop.hidden = !opened;
    if (next === 'summary' && returnsPanel.contains(document.activeElement)) summaryFocus().focus({ preventScroll: true });
  }
  function open() {
    if (screen() === 'summary') return;
    returnsVisible = false;
    panels.setRight(true);
    // Closing the returns controller mid-restore would also cancel its moment.
    if (!panels.restoring) onOpen();
    layout();
    if (screen() === 'summary') summaryFocus().focus({ preventScroll: true });
  }
  function close({ focus = false } = {}) {
    const active = screen();
    if (active === 'closed') return;
    if (focus || panel.contains(document.activeElement)) switcher.focus({ preventScroll: true });
    returnsVisible = false;
    panels.setRight(false);
    if (!panels.restoring) onClose();
    layout();
  }
  const toggle = () => screen() === 'closed' ? open() : close();
  function setReturnsVisible(value: boolean) {
    const visible = Boolean(value) && panels.rightRequestDuringRestore == null;
    if (returnsVisible === visible) return;
    // A view projection supplied by app.ts, not another return-opening command.
    returnsVisible = visible;
    if (visible) panels.setRight(true, { automatic: true });
    layout();
  }
  returnsButton?.addEventListener('click', () => {
    if (!returnsButton.hidden && !returnsButton.disabled) onReturns();
  });
  switcher.addEventListener('click', toggle);
  backdrop?.addEventListener('click', () => close());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && screen() !== 'closed' && !event.defaultPrevented && !document.querySelector('dialog[open]') && !document.querySelector('.library.open')) {
      event.preventDefault(); close({ focus: true });
    }
  });
  panels.subscribe(layout);
  layout();
  return { layout, open, close, toggle, setReturnsVisible,
    get opened() { return screen() !== 'closed'; }, get screen() { return screen(); } };
}
