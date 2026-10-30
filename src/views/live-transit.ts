import type { LiveTransit, LiveTransitOptions } from '../state/live-transit.ts';
interface LiveTransitViewOptions extends LiveTransitOptions { signal?:AbortSignal; document: Document; button: HTMLButtonElement; isFormOpen?: () => boolean; isChartVisible?: () => boolean }

import { createLiveTransit } from '../state/live-transit.ts';

export function attachTransitNavigation(button: HTMLButtonElement, { onSelect, refresh, signal }: { signal?:AbortSignal; onSelect: (id: string) => void; refresh: LiveTransit['refresh'] }) {
  button.addEventListener('click', () => {
    onSelect('current-transit');
    refresh(true);
  },{signal});
}

// Adapt page visibility and the navigation button without making state own DOM.
export function attachLiveTransit({ signal, document, button, isFormOpen = () => false, isChartVisible = () => true, onStateChange = () => {}, ...options }: LiveTransitViewOptions) {
  const transit = createLiveTransit({
    ...options, isVisible: () => !document.hidden && isChartVisible() && !isFormOpen(),
    // Another workspace keeps its selected/paused state and shared day loads,
    // while the live minute clock waits until the chart is visible again.
    isSuspended: () => document.hidden || !isChartVisible(),
    onStateChange(state) {
      if(signal?.aborted)return;
      if (state.loading) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
      button.title = ''; // The visible label already names this action; failure belongs to the day tool.
      onStateChange(state);
    },
  });
  document.addEventListener('visibilitychange', transit.visibilityChanged,{signal});
  return transit;
}
