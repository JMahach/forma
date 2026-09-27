import { createLiveTransit } from '../state/live-transit.js';

export function attachTransitNavigation(button, { closeLibrary, onSelect, refresh }) {
  button.addEventListener('click', () => {
    closeLibrary();
    onSelect('current-transit');
    refresh(true);
  });
}

// Adapt page visibility and the navigation button without making state own DOM.
export function attachLiveTransit({ document, button, isFormOpen = () => false, onStateChange = () => {}, ...options }) {
  const transit = createLiveTransit({
    ...options, isVisible: () => !document.hidden && !isFormOpen(), isSuspended: () => document.hidden,
    onStateChange(state) {
      if (state.loading) button.setAttribute('aria-busy', 'true');
      else button.removeAttribute('aria-busy');
      button.title = state.unavailable ? 'Транзит недоступен. Нажмите, чтобы повторить.' : 'Транзит';
      onStateChange(state);
    },
  });
  document.addEventListener('visibilitychange', transit.visibilityChanged);
  return transit;
}
