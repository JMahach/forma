import type { LiveTransit, LiveTransitOptions } from '../state/live-transit.ts';
interface LiveTransitViewOptions extends LiveTransitOptions { document: Document; button: HTMLButtonElement; isFormOpen?: () => boolean }

import { createLiveTransit } from '../state/live-transit.ts';

export function attachTransitNavigation(button: HTMLButtonElement, { onSelect, refresh }: { onSelect: (id: string) => void; refresh: LiveTransit['refresh'] }) {
  button.addEventListener('click', () => {
    onSelect('current-transit');
    refresh(true);
  });
}

// Adapt page visibility and the navigation button without making state own DOM.
export function attachLiveTransit({ document, button, isFormOpen = () => false, onStateChange = () => {}, ...options }: LiveTransitViewOptions) {
  const transit = createLiveTransit({
    ...options, isVisible: () => !document.hidden && !isFormOpen(), isSuspended: () => document.hidden,
    onStateChange(state) {
      if (state.loading) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
      button.title = ''; // The visible label already names this action; failure belongs to the day tool.
      onStateChange(state);
    },
  });
  document.addEventListener('visibilitychange', transit.visibilityChanged);
  return transit;
}
