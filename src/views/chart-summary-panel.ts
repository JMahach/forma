import type { PanelState } from '../state/panels.ts';
import { createPanelState } from '../state/panels.ts';
import {createResourceScope} from '../runtime/resource-scope.ts';

interface SummaryOptions {
  panels?: PanelState; initialReturnsVisible?: boolean;
  panel: HTMLElement; summaryScreen: HTMLElement; returnsPanel: HTMLElement;
  switcher: HTMLButtonElement; backdrop: HTMLElement | null;
  returnsButton?: HTMLButtonElement | null; onReturns?: () => void;
  onOpen?: () => void; onClose?: () => void; isAvailable?: () => boolean;
}
export type ChartSummaryPanel = ReturnType<typeof attachChartSummary>;

export function attachChartSummary({ panels = createPanelState(), initialReturnsVisible = false, panel, summaryScreen, returnsPanel, switcher, backdrop, returnsButton = null, onReturns = () => {}, onOpen = () => {}, onClose = () => {}, isAvailable = () => true }: SummaryOptions) {
  const scope=createResourceScope();
  const document = panel.ownerDocument;
  const summaryLabel = panel.getAttribute('aria-labelledby');
  let returnsVisible = initialReturnsVisible;
  let appliedScreen: 'closed' | 'summary' | 'returns' | null = null;
  const summaryFocus = () => returnsButton && !returnsButton.hidden && !returnsButton.disabled ? returnsButton : switcher;
  const screen = () => !scope.stopped && isAvailable() && panels.right ? (returnsVisible ? 'returns' : 'summary') : 'closed';
  function layout() {
    if(scope.stopped)return;
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
    if(scope.stopped)return;
    if (screen() !== 'closed') return;
    panels.setRight(true);
    if (!panels.restoring) onOpen();
    layout();
    if (screen() === 'summary') summaryFocus().focus({ preventScroll: true });
  }
  function close({ focus = false } = {}) {
    const active = screen();
    if (active === 'closed') return;
    if (focus || panel.contains(document.activeElement)) switcher.focus({ preventScroll: true });
    panels.setRight(false);
    if (!panels.restoring) onClose();
    layout();
  }
  const toggle = () => screen() === 'closed' ? open() : close();
  function setReturnsVisible(value: boolean) {
    if(scope.stopped)return;
    const visible = Boolean(value);
    if (returnsVisible === visible) return;
    // A view projection supplied by app.ts, not another return-opening command.
    returnsVisible = visible;
    layout();
  }
  returnsButton?.addEventListener('click', () => {
    if (!returnsButton.hidden && !returnsButton.disabled) onReturns();
  }, {signal:scope.signal});
  switcher.addEventListener('click', toggle, {signal:scope.signal});
  backdrop?.addEventListener('click', () => close(), {signal:scope.signal});
  scope.own(panels.subscribe(layout));
  layout();
  return { dispose:scope.stop, layout, open, close, toggle, setReturnsVisible,
    get opened() { return screen() !== 'closed'; }, get screen() { return screen(); } };
}
